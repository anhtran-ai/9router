/**
 * QoderExecutor — sends OpenAI-format chat requests to Qoder's COSY-signed
 * inference endpoint at api3.qoder.sh, then unwraps Qoder's `{statusCodeValue,
 * body}` SSE envelope back into plain OpenAI SSE for the rest of the pipeline.
 *
 * Differences vs the previous placeholder:
 *   - URL is api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
 *     with `&Encode=1` so we can ship the body through the WAF-bypass
 *     encoder.
 *   - Authentication is COSY (RSA + AES + MD5 + ~17 Cosy-* headers), not
 *     a static HMAC.
 *   - The request shape Qoder expects is non-trivial (chat_context with
 *     mirrored modelConfig, business block with stable IDs, system text
 *     hoisted out of the messages array). All ported from the reference.
 *   - Model identifier is one of the canonical Qoder keys (auto / ultimate /
 *     performance / efficient / lite + frontier "*model" ids); the
 *     translator layer feeds us "qoder/<key>" so we strip the prefix.
 *   - Per-model `model_config` is fetched live from /algo/api/v2/model/list
 *     and cached. Sending the wrong block silently downgrades to a
 *     different model upstream, so a missing entry is a hard error.
 */

import { qoderEncodeBody } from "../shared/qoder/encoding.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import {
  cancelReaderBestEffort,
  MAX_STREAM_FRAME_CHARS,
  readReaderWithDeadline,
  ReaderDeadlineError,
} from "../utils/reader.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import {
  QODER_CHAT_URL_ENCODED,
  QODER_CHAT_BASE_ALT,
  QODER_CHAT_SIG_PATH,
  QODER_MODEL_MAP,
} from "../shared/qoder/constants.js";
import { getQoderModelConfig, resolveQoderModels, isQoderPat, resolveQoderCredentials } from "../services/qoderModels.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK } from "../translator/schema/blocks.js";
import { encodeDataUri } from "../translator/concerns/image.js";
import { awaitModelCatalogResponse } from "../services/modelCatalogResponse.js";

const MAX_NON_EMITTING_LINES = 1024;

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system in messages) and flatten multipart content arrays — EXCEPT image
 * blocks, which are preserved (see normalizeContent).
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "system") {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    cloned.content = normalizeContent(msg.content);
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

/**
 * Normalize one message's content for Qoder.
 *
 * Text-only content is flattened to a plain string (Qoder's historical
 * shape). When images are present the content stays an array and image
 * blocks are kept as OpenAI-style `image_url` parts — verified against the
 * upstream: it accepts both http(s) URLs and inline base64 data: URIs
 * directly, no pre-upload to the /image/upload OSS flow required (that is
 * a qodercli client-side choice, not a protocol requirement). The legacy
 * top-level `image_urls` / `chat_context.imageUrls` slots stay null —
 * qodercli leaves them null too.
 *
 * Claude-style `{type:"image", source:{...}}` blocks are converted to
 * `image_url` so claude-format clients also round-trip.
 */
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);

  const blocks = [];
  const textParts = [];
  let hasImage = false;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === OPENAI_BLOCK.IMAGE_URL && typeof item.image_url?.url === "string" && item.image_url.url) {
      blocks.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: item.image_url.url } });
      hasImage = true;
    } else if (item.type === CLAUDE_BLOCK.IMAGE && item.source) {
      // Claude base64/url image → OpenAI image_url equivalent.
      const src = item.source;
      const url = src.type === "base64" && src.data
        ? encodeDataUri(src.media_type || "image/png", src.data)
        : typeof src.url === "string" && src.url ? src.url : null;
      if (url) {
        blocks.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url } });
        hasImage = true;
      }
    } else if (typeof item.text === "string" && item.text) {
      if (hasImage || blocks.length) {
        // Keep ordering faithful once images are in play.
        blocks.push({ type: OPENAI_BLOCK.TEXT, text: item.text });
      } else {
        textParts.push(item.text);
      }
    }
  }

  if (!hasImage) return textParts.join("\n");
  // Prepend any text collected before the first image block.
  if (textParts.length) blocks.unshift({ type: OPENAI_BLOCK.TEXT, text: textParts.join("\n") });
  return blocks;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return extractText(m.content);
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(model, messages, tools, maxTokens) {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    if (typeof m.content === "string" && m.content) {
      h.update("\0"); h.update(m.content);
    } else if (Array.isArray(m.content)) {
      // Include image refs so the same prompt with a different image gets
      // a distinct chat_record_id.
      h.update("\0");
      try { h.update(JSON.stringify(m.content)); } catch {}
    }
  }
  if (tools) {
    h.update("\0");
    try { h.update(JSON.stringify(tools)); } catch {}
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects.
 */
async function buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }) {
  const qoderKey = String(model || "").replace(/^qoder\//, "");
  
  // Fetch model config from dynamic API instead of relying on static QODER_MODEL_MAP.
  // This allows support for new Qoder models (e.g., qmodel_latest) without code changes.
  let modelConfig = await getQoderModelConfig(credentials, qoderKey, { log, proxyOptions, signal });
  if (!modelConfig) {
    // Try a forced refresh once before giving up — the cache may simply
    // not be populated yet on first ever call for this credential.
    const refreshed = await resolveQoderModels(credentials, { forceRefresh: true, log, proxyOptions, signal });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (!retried) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`,
      );
    }
    modelConfig = { ...retried, key: qoderKey };
  }

  const { messages, systemText } = normalizeMessages(body.messages || []);
  const tools = body.tools;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens < maxTokens) {
    maxTokens = body.max_completion_tokens;
  }

  const lastUser = lastUserText(messages);
  const psd = credentials.providerSpecificData || {};
  const sessionId = stableHash("qoder-session", psd.userId, qoderKey);
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens);

  return {
    qoderKey,
    payload: {
      request_id: uuidv4(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: isReasoning },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: uuidv4(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
    modelConfig,
  };
}

/**
 * Check if a qoder error message indicates a billing/quota block.
 * Signatures: code 112 (quota exhausted), code 10605 (queue throttle), pricingUrl field.
 */
function isBillingBlock(inner) {
  return billingBlockCode(inner) !== null;
}

function billingBlockCode(inner) {
  if (!inner || typeof inner !== "string") return null;
  const lowerMsg = inner.toLowerCase();
  const match = inner.match(/\"code\"\s*:\s*\"(112|10605)\"/);
  if (match) return match[1];
  return lowerMsg.includes("pricingurl") ? "billing_required" : null;
}

/**
 * Peek the first SSE frame to detect billing errors before piping.
 * Returns { isBilling, statusVal, message, consumed } — `consumed` is every
 * byte read so far (including the peeked line) so the caller can re-process
 * it and nothing is dropped from the stream.
 */
async function peekFirstQoderFrame(reader, decoder, { signal, deadlineAt } = {}) {
  let consumed = "";
  let scanOffset = 0;
  const inspectLine = rawLine => {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line.startsWith("data:")) return null;

    const data = line.slice(5).trimStart();
    if (data === "[DONE]") return { isBilling: false, consumed };

    let envelope;
    try { envelope = JSON.parse(data); } catch { return { isBilling: false, consumed }; }

    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    const billingCode = billingBlockCode(inner);
    if (statusVal !== 200 && billingCode) {
      return { isBilling: true, statusVal, billingCode };
    }
    return { isBilling: false, consumed };
  };

  while (true) {
    let nl;
    while ((nl = consumed.indexOf("\n", scanOffset)) !== -1) {
      const inspected = inspectLine(consumed.slice(scanOffset, nl));
      scanOffset = nl + 1;
      if (inspected) return inspected;
    }

    const { done, value } = await readReaderWithDeadline(reader, { signal, deadlineAt, label: "Qoder first stream frame" });
    if (done) {
      consumed += decoder.decode();
      if (consumed.length > MAX_STREAM_FRAME_CHARS) {
        const error = new Error("Qoder first stream frame exceeds size limit");
        error.code = "upstream_stream_frame_too_large";
        throw error;
      }
      const inspected = scanOffset < consumed.length ? inspectLine(consumed.slice(scanOffset)) : null;
      return inspected || { isBilling: false, consumed, upstreamDone: true };
    }

    consumed += decoder.decode(value, { stream: true });
    if (consumed.length > MAX_STREAM_FRAME_CHARS) {
      const error = new Error("Qoder first stream frame exceeds size limit");
      error.code = "upstream_stream_frame_too_large";
      throw error;
    }
  }
}

/**
 * Wrap the upstream's `{statusCodeValue, body}` SSE envelope into plain
 * OpenAI SSE chunks the rest of the chatCore pipeline understands.
 *
 * Each upstream line looks like:
 *   data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{...}}]}"}
 * The inner body is an OpenAI streaming chunk (or "[DONE]"). We unwrap it
 * and re-emit as `data: <inner>\n\n`. Errors become a synthetic OpenAI error
 * chunk + [DONE].
 *
 * Critical: Qoder's SSE often keeps the socket open after the terminal
 * [DONE]/error frame (agent keepalive). Non-streaming clients drain via
 * response.text() which hangs until the socket closes — so on terminal
 * events we cancel the upstream reader and close our stream immediately.
 *
 * NEW: Peek first frame to detect billing blocks (code 112/10605/pricingUrl).
 * If detected, return 403 response so chatCore marks connection unavailable
 * and triggers combo fallback instead of leaking error text into chat.
 */
async function wrapQoderSSE(response, model, { signal, firstFrameTimeoutMs = FETCH_CONNECT_TIMEOUT_MS } = {}) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = response.body.getReader();

  // Peek first frame to detect billing block
  let peek;
  try {
    peek = await peekFirstQoderFrame(reader, decoder, {
      signal,
      deadlineAt: Date.now() + firstFrameTimeoutMs,
    });
  } catch (error) {
    cancelReaderBestEffort(reader, "Qoder first stream frame rejected");
    if (signal?.aborted) throw error;
    const timedOut = error instanceof ReaderDeadlineError;
    return new Response(
      JSON.stringify({ error: {
        message: timedOut ? "Qoder first stream frame timed out" : "Invalid Qoder stream prelude",
        code: timedOut ? "upstream_stream_timeout" : "invalid_upstream_response",
      } }),
      { status: timedOut ? 504 : 502, headers: { "Content-Type": "application/json" } },
    );
  }
  if (peek?.isBilling) {
    // Billing block detected — return 403 so chatCore fails this connection
    cancelReaderBestEffort(reader, "Qoder billing block");
    return new Response(
      JSON.stringify({
        error: {
          message: peek.billingCode === "billing_required"
            ? "Qoder billing action is required"
            : `Qoder quota or billing limit reached (${peek.billingCode})`,
          code: peek.billingCode || "qoder_billing_block",
        },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  // Normal flow: re-process every byte the peek consumed, then continue.
  let buffer = peek.consumed || "";
  let upstreamDone = peek.upstreamDone === true;
  let decoderFlushed = upstreamDone;
  const encoder = new TextEncoder();
  let doneEmitted = false;
  let terminalSeen = false;
  let closed = false;
  let readerCancelled = false;
  let consecutiveIgnoredLines = 0;

  const cancelUpstream = reason => {
    if (readerCancelled) return;
    readerCancelled = true;
    cancelReaderBestEffort(reader, reason);
  };

  const closeStream = (controller, reason) => {
    if (closed) return;
    closed = true;
    try { controller.close(); } catch { /* downstream already cancelled */ }
    cancelUpstream(reason);
  };

  const emitFailure = (controller, code, reason) => {
    if (doneEmitted) return false;
    const error = {
      error: {
        message: `Invalid upstream response: ${reason}`,
        type: "upstream_error",
        code,
      },
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(error)}\n\n`));
    controller.enqueue(encoder.encode(SSE_DONE));
    doneEmitted = true;
    return true;
  };

  // Process one already-extracted SSE line (no trailing newline).
  const processLine = (line, controller) => {
    if (line.length > MAX_STREAM_FRAME_CHARS) {
      return emitFailure(controller, "qoder_frame_too_large", "Qoder stream event exceeds size limit");
    }
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return false;
    if (trimmed.startsWith(":")) {
      // Preserve SSE heartbeats as real queued output so an upstream that only
      // sends comments remains governed by downstream backpressure.
      controller.enqueue(encoder.encode(`${trimmed}\n\n`));
      return true;
    }
    if (!trimmed.startsWith("data:")) return false;
    if (doneEmitted) return false;

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      terminalSeen = true;
      doneEmitted = true;
      return true;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch {
      return emitFailure(controller, "qoder_malformed_stream", "malformed Qoder envelope");
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      return emitFailure(controller, "qoder_malformed_stream", "invalid Qoder envelope");
    }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      return emitFailure(controller, "qoder_upstream_error", `Qoder returned status ${statusVal}`);
    }
    if (!inner) {
      return emitFailure(controller, "qoder_malformed_stream", "Qoder envelope had no response body");
    }
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      terminalSeen = true;
      doneEmitted = true;
      return true;
    }
    // Strip embedded newlines so the SSE frame stays a single event.
    const sanitized = inner.replace(/\r?\n/g, "");
    let innerEvent;
    try { innerEvent = JSON.parse(sanitized); } catch {
      return emitFailure(controller, "qoder_malformed_stream", "malformed Qoder response event");
    }
    if (!innerEvent || typeof innerEvent !== "object" || Array.isArray(innerEvent)) {
      return emitFailure(controller, "qoder_malformed_stream", "invalid Qoder response event");
    }
    if (innerEvent.error) {
      return emitFailure(controller, "qoder_upstream_error", "Qoder returned an error event");
    }
    const hasTerminalChoice = innerEvent.choices?.some?.(
      choice => typeof choice?.finish_reason === "string" && choice.finish_reason,
    );
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
    if (hasTerminalChoice) {
      // Qoder can keep the socket open after the logical final chunk without
      // sending its outer [DONE] envelope. Complete the client protocol here
      // so non-streaming drains and streaming clients cannot wait forever.
      controller.enqueue(encoder.encode(SSE_DONE));
      terminalSeen = true;
      doneEmitted = true;
    }
    return true;
  };

  const stream = new ReadableStream({
    // Keep reading inside one pull until a complete outward frame is available.
    // Returning immediately after that enqueue lets downstream demand govern how
    // quickly the upstream reader is drained, while comments and partial lines
    // cannot leave a pending consumer stuck waiting for another pull callback.
    async pull(controller) {
      if (closed) return;

      try {
        while (!closed) {
          const nl = buffer.indexOf("\n");
          if (nl !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const emitted = processLine(line, controller);
            if (doneEmitted) {
              closeStream(controller, "Qoder terminal frame");
              return;
            }
            if (emitted) {
              consecutiveIgnoredLines = 0;
              return;
            }
            consecutiveIgnoredLines += 1;
            if (consecutiveIgnoredLines >= MAX_NON_EMITTING_LINES) {
              emitFailure(controller, "qoder_non_emitting_stream", "Qoder stream sent too many non-data lines");
              closeStream(controller, "non-emitting Qoder stream");
              return;
            }
            continue;
          }

          if (upstreamDone) {
            if (buffer.length > 0) {
              const trailingLine = buffer;
              buffer = "";
              const emitted = processLine(trailingLine, controller);
              if (doneEmitted) {
                closeStream(controller, "Qoder terminal frame");
                return;
              }
              if (emitted) return;
            }

            if (!terminalSeen) {
              emitFailure(controller, "qoder_missing_terminal", "Qoder stream ended without a terminal event");
            }
            closeStream(controller, "Qoder stream finished");
            return;
          }

          const { done, value } = await reader.read();
          if (closed) return;
          if (done) {
            upstreamDone = true;
            if (!decoderFlushed) {
              buffer += decoder.decode();
              decoderFlushed = true;
            }
            continue;
          }

          buffer += decoder.decode(value, { stream: true });
          if (!buffer.includes("\n") && buffer.length > MAX_STREAM_FRAME_CHARS) {
            emitFailure(controller, "qoder_frame_too_large", "Qoder stream event exceeds size limit");
            closeStream(controller, "oversized Qoder stream event");
            return;
          }
        }
      } catch {
        if (closed) return;
        try {
          emitFailure(controller, "qoder_stream_interrupted", "Qoder stream was interrupted");
        } catch { /* downstream already cancelled */ }
        closeStream(controller, "Qoder stream finished");
      }
    },
    cancel(reason) {
      closed = true;
      cancelUpstream(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export class QoderExecutor extends BaseExecutor {
  constructor() {
    super("qoder", PROVIDERS.qoder);
  }

  buildUrl(credentials) {
    // Job-token (jt-...) traffic must hit api2.qoder.sh — api3 rejects jt-
    // with "Login expired" (403). Device tokens (dt-...) stay on api3.
    const raw = credentials?.apiKey || credentials?.accessToken;
    if (typeof raw === "string" && !raw.startsWith("pt-") && (raw.startsWith("jt-") || (credentials?.accessToken || "").startsWith("jt-"))) {
      return `${QODER_CHAT_BASE_ALT}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
    }
    return QODER_CHAT_URL_ENCODED;
  }

  // Override execute entirely — Qoder needs:
  //   - body built from translated chat completion payload
  //   - body encoded with QoderEncodeBody before signing
  //   - COSY headers built from the *encoded* body bytes
  //   - response stream re-wrapped from {statusCodeValue, body} to OpenAI SSE
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    // PAT (pt-...) → exchange for short-lived job token + resolve userId so
    // downstream COSY signing + catalog fetch work. Device tokens (dt-...) and
    // job tokens (jt-...) skip this and are used directly.
    const rawToken = credentials?.apiKey || credentials?.accessToken;
    if (isQoderPat(rawToken)) {
      try {
        credentials = await resolveQoderCredentials(credentials, proxyOptions, signal);
      } catch (err) {
        const details = Number.isInteger(err?.status) ? { status: err.status } : undefined;
        log?.error?.("QODER", "PAT exchange failed", details);
        const fakeResp = new Response(
          JSON.stringify({ error: { message: "qoder PAT exchange failed; reconnect the account" } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
        return { response: fakeResp, url: this.buildUrl(credentials), headers: {}, transformedBody: body };
      }
    }

    const url = this.buildUrl(credentials);
    const psd = credentials?.providerSpecificData || {};
    if (!psd.userId) {
      // No user id → no way to sign. Surface a 401 so the dashboard nudges
      // the user back to OAuth.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing userId; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }
    if (!credentials?.accessToken) {
      // Same shape as the userId guard — clean 401 so chatCore reports
      // "reconnect" rather than bubbling cosy.js's synchronous throw as 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing accessToken; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    let qoderKey;
    let payload;
    try {
      ({ qoderKey, payload } = await buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }));
    } catch (err) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "Qoder model configuration is unavailable" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
    const encodedBodyStr = qoderEncodeBody(plainBody);
    const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

    let cosyHeaders;
    try {
      cosyHeaders = buildCosyHeaders(
        encodedBodyBuf,
        url,
        {
          userId: psd.userId,
          authToken: credentials.accessToken,
          name: credentials.displayName || "",
          email: credentials.email || "",
          machineId: psd.machineId || "",
        },
      );
    } catch (err) {
      // cosy.js throws synchronously on missing userId/authToken — surface
      // as 401 so chatCore prompts re-auth instead of returning a 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder request signing failed; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    const modelSource = (payload.model_config && payload.model_config.source) || "system";
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Model-Key": qoderKey,
      "X-Model-Source": modelSource,
      // gzip triggers signature validation on Qoder's CDN; force identity.
      "Accept-Encoding": "identity",
      ...cosyHeaders,
    };

    // Abort if upstream doesn't return response headers within connect timeout.
    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
    const connectCtrl = new AbortController();
    const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
    const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

    let response;
    try {
      response = await awaitModelCatalogResponse(
        proxyAwareFetch(
          url,
          { method: "POST", headers, body: encodedBodyBuf, signal: mergedSignal },
          proxyOptions,
        ),
        mergedSignal,
      );
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok) {
      // Pass error response through unchanged so chatCore can capture it.
      return { response, url, headers, transformedBody: payload };
    }

    const wrapped = await wrapQoderSSE(response, `qoder/${qoderKey}`, {
      signal,
      firstFrameTimeoutMs: timeoutMs,
    });
    return { response: wrapped, url, headers, transformedBody: payload };
  }

  // Qoder device tokens don't refresh through OAuth — the upstream returns
  // 403 for our flow. Surfacing failure via 401-on-chat is enough; the
  // dashboard tells users to re-login when their token expires (~30 days).
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default QoderExecutor;

// Internals exposed for unit tests. Not part of the public API — callers
// should import QoderExecutor and use its public methods.
export const __test__ = {
  normalizeMessages,
  wrapQoderSSE,
  buildQoderRequestBody,
  isBillingBlock,
};
