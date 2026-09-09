/**
 * Shared combo (model combo) handling with fallback support
 */

import {
  checkFallbackError,
  formatRetryAfter,
  isModelCompatibilityError,
} from "./accountFallback.js";
import {
  errorResponse,
  readUpstreamBodyText,
  rebuildUpstreamResponse,
  unavailableResponse,
} from "../utils/error.js";
import { isAbortError, throwIfAborted, waitWithSignal } from "../utils/abort.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";
const COMBO_ERROR_BODY_MAX_BYTES = 256 * 1024;
const COMBO_ERROR_BODY_STALL_TIMEOUT_MS = 5000;
const FUSION_PANEL_BODY_MAX_BYTES = 8 * 1024 * 1024;
const FUSION_PANEL_BODY_STALL_TIMEOUT_MS = 15_000;
const FUSION_JUDGE_TEXT_MAX_CHARS = 16 * 1024 * 1024;

function discardResponseBody(response, reason) {
  if (!response?.body || response.bodyUsed === true) return;
  try {
    const cancellation = response.body.cancel(reason);
    cancellation?.catch?.(() => {});
  } catch { /* best-effort connection release */ }
}

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  return models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime === "application/pdf") required.add("pdf");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput");
    if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput");
    if (t === "file" || t === "document" || t === "input_file") {
      // Infer modality from embedded mime when available; fall back to pdf for generic files.
      let fmime = null;
      if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`;
      else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1];
      if (fmime) addByMime(fmime);
      else required.add("pdf");
    }
    // gemini parts: inlineData/fileData carry a mime
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs
    if (typeof m.content === "string") {
      if (m.content.includes("data:image/")) required.add("vision");
      else if (m.content.includes("data:audio/")) required.add("audioInput");
      else if (m.content.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: temporarily disabled in auto-switch (feature not wired yet).

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

// HTTP Retry-After supports delay-seconds or dates; the legacy JSON field is a
// timestamp. Reject malformed/overflow dates before they enter the minimum.
function parseRetryDeadline(value, receivedAt, allowDelaySeconds = false) {
  // The legacy JSON field may be an epoch timestamp number. HTTP Retry-After
  // remains string-only and may additionally use delay-seconds.
  if (typeof value === "number") {
    return !allowDelaySeconds && Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  let deadline;
  if (allowDelaySeconds && /^\d+$/.test(text)) {
    deadline = receivedAt + Number(text) * 1000;
  } else {
    if (!Number.isNaN(Number(text))) return null;
    deadline = Date.parse(text);
  }
  return Number.isFinite(new Date(deadline).getTime()) ? deadline : null;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {AbortSignal} [options.signal] - Client cancellation signal
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, autoSwitch = true, signal }) {
  if (signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  // Apply rotation strategy if enabled
  let rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastFailure = null;
  let retryableFailure = null;
  let earliestRetryAfter = null;
  let allCredentialsUnavailable = rotatedModels.length > 0;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      throwIfAborted(signal);
      let result = await handleSingleModel(body, modelStr);
      if (signal?.aborted) {
        discardResponseBody(result, "combo request aborted");
        return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      }
      if (result.status === HTTP_STATUS.CLIENT_CLOSED_REQUEST) return result;
      
      // Success (2xx) - return response
      if (result.ok) {
        log.info("COMBO", `Model ${modelStr} succeeded`);
        return result;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let errorCode = null;
      const receivedAt = Date.now();
      let retryAfter = parseRetryDeadline(result.headers?.get?.("Retry-After"), receivedAt, true);
      let errorBodyText = "";
      try {
        errorBodyText = await readUpstreamBodyText(result, {
          signal,
          maxBytes: COMBO_ERROR_BODY_MAX_BYTES,
          stallTimeoutMs: COMBO_ERROR_BODY_STALL_TIMEOUT_MS,
        });
        const errorBody = JSON.parse(errorBodyText);
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        if (typeof errorBody?.error?.code === "string") errorCode = errorBody.error.code;
        const jsonRetryAfter = parseRetryDeadline(errorBody?.retryAfter, receivedAt);
        if (jsonRetryAfter !== null && (retryAfter === null || jsonRetryAfter < retryAfter)) retryAfter = jsonRetryAfter;
      } catch {
        // Ignore malformed, stalled, or oversized diagnostics. Caller abort is
        // checked below; the bounded reader already cancelled failed bodies.
      }
      result = rebuildUpstreamResponse(result, errorBodyText);

      // Track earliest retryAfter across all combo models
      if (retryAfter !== null && (earliestRetryAfter === null || retryAfter < earliestRetryAfter)) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }
      allCredentialsUnavailable &&= result.status === HTTP_STATUS.NOT_FOUND
        && /^no (?:active )?credentials for provider(?::|\s)/i.test(errorText.trim());
      throwIfAborted(signal);

      // Check if should fallback to next model
      const isCompatibilityError = isModelCompatibilityError(result.status, errorText);
      const fallbackDecision = isCompatibilityError
        ? { shouldFallback: true, cooldownMs: 0 }
        : result.status === 400
          ? { shouldFallback: false, cooldownMs: 0 }
          : checkFallbackError(result.status, errorText);
      const { shouldFallback, cooldownMs } = fallbackDecision;

      if (!shouldFallback) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      discardResponseBody(result, "trying next combo model");

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await waitWithSignal(cooldownMs, signal);
      }

      // Fallback to next model
      lastFailure = { status: result.status, message: errorText || String(result.status), ...(errorCode ? { code: errorCode } : {}) };
      if (result.status === HTTP_STATUS.RATE_LIMITED || result.status >= HTTP_STATUS.SERVER_ERROR) {
        retryableFailure = lastFailure;
      }
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      if (isAbortError(error, signal)) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      allCredentialsUnavailable = false;
      // Catch unexpected exceptions to ensure fallback continues
      lastFailure = { status: HTTP_STATUS.SERVER_ERROR, message: String(error?.message || error) };
      retryableFailure = lastFailure;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastFailure.message });
    }
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  // Keep status/message from the same attempt. A temporarily unavailable route
  // remains retryable even if another model rejects this request's tools.
  const failure = retryableFailure || lastFailure;
  const status = allCredentialsUnavailable ? HTTP_STATUS.SERVICE_UNAVAILABLE : (failure?.status || HTTP_STATUS.SERVICE_UNAVAILABLE);
  const msg = failure?.message || "All combo models unavailable";

  if (earliestRetryAfter !== null) {
    const retryAt = new Date(earliestRetryAfter).toISOString();
    const retryHuman = formatRetryAfter(retryAt);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, retryAt, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg, ...(!allCredentialsUnavailable && failure?.code ? { code: failure.code } : {}) } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

// Resolve a Response (or {__error}) within ms and signal the underlying call
// when it loses the timeout race. The promise remains observed so a late abort
// rejection cannot become unhandled.
function withTimeout(promise, ms, onTimeout) {
  let cancel;
  const wrapped = new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const finish = (value) => {
      if (finished) {
        // A provider may ignore the panel abort and resolve after quorum or the
        // hard timeout. Its late Response is no longer observable by callers,
        // so explicitly release the body instead of leaving it to GC.
        discardResponseBody(value, "late fusion panel response");
        return;
      }
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    cancel = () => finish({ __cancelled: true });
    timer = setTimeout(() => {
      try { onTimeout?.(); } finally { finish({ __timeout: true }); }
    }, ms);
    // Keep observing the provider even after cancel() settles this wrapper so
    // an abort-ignoring call cannot produce an unhandled late rejection.
    Promise.resolve(promise).then(
      (value) => finish(value),
      (error) => finish({ __error: error }),
    );
  });
  return { promise: wrapped, cancel: () => cancel?.() };
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs, signal, onFinish }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    let hardTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", finish);
      try { onFinish?.(); } finally { resolve(out); }
    };
    hardTimer = setTimeout(finish, panelHardTimeoutMs);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          // Quorum is based on a fully consumed, semantically valid answer.
          // An HTTP 200 header alone is not success: the body may still stall,
          // be malformed, or contain no assistant content.
          if (out[i]?.__answer) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

async function readFusionPanelAnswer(response, model, signal) {
  if (!response?.ok) {
    discardResponseBody(response, "failed fusion panel response");
    return { __failed: true, status: response?.status };
  }

  try {
    const bodyText = await readUpstreamBodyText(response, {
      signal,
      maxBytes: FUSION_PANEL_BODY_MAX_BYTES,
      stallTimeoutMs: FUSION_PANEL_BODY_STALL_TIMEOUT_MS,
      fatalUtf8: true,
    });
    const json = JSON.parse(bodyText);
    const text = extractPanelText(json);
    if (!text) return { __failed: true, empty: true };
    return { __answer: { model, text } };
  } catch (error) {
    return { __error: error };
  }
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr, isPanel, panelSignal) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning, signal }) {
  if (signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  // Fusion runs panel models non-streaming; drop stream_options too, or providers
  // like DeepSeek reject it with "stream_options should be set along with stream = true".
  // See issue #3024.
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const panelTasks = panel.map((m) => {
    const controller = new AbortController();
    const panelSignal = controller.signal;
    const task = { controller, settled: false, promise: null, cancel: null };
    // Defer invocation into a promise so synchronous provider errors are
    // isolated to that panel member instead of aborting the whole fan-out.
    // Keep header receipt, complete bounded body consumption and semantic
    // validation inside the same per-panel deadline. This also lets quorum
    // count real answers rather than optimistic HTTP 200 responses.
    const call = Promise.resolve()
      .then(() => handleSingleModel(panelBody, m, true, panelSignal))
      .then((response) => readFusionPanelAnswer(response, m, panelSignal));
    const timed = withTimeout(call, cfg.panelHardTimeoutMs, () => controller.abort());
    task.cancel = timed.cancel;
    task.promise = timed.promise
      .finally(() => {
        task.settled = true;
      });
    return task;
  });
  const abortStragglers = () => {
    for (const task of panelTasks) {
      if (!task.settled) {
        task.controller.abort();
        // Do not retain the timeout or wait for providers that ignore abort.
        task.cancel();
      }
    }
  };
  const settled = await collectPanel(panelTasks.map((task) => task.promise), {
    ...cfg,
    minPanel,
    signal,
    onFinish: abortStragglers,
  });
  if (signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  let acceptedAnswerChars = 0;
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} failed validation`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (res.__answer) {
      if (acceptedAnswerChars + res.__answer.text.length > FUSION_JUDGE_TEXT_MAX_CHARS) {
        log.warn("FUSION", `Panel ${model} exceeded the aggregate judge-input limit`);
        continue;
      }
      answers.push(res.__answer);
      acceptedAnswerChars += res.__answer.text.length;
      log.info("FUSION", `Panel ${model} ok (${res.__answer.text.length} chars)`);
      continue;
    }
    log.warn("FUSION", res.empty ? `Panel ${model} returned empty content` : `Panel ${model} failed`, { status: res.status });
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}

// Exposed for regression tests only; not part of the module's runtime contract.
export const __test__ = { parseRetryDeadline };
