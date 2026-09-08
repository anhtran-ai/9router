import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { ToolCompatibilityError } from "../concerns/hostedToolPolicy.js";

/**
 * Normalize Responses API input to array format.
 * Accepts string or array, returns array of message items.
 * An empty array is treated like an empty string — providers require at least one user
 * message, so we inject a placeholder rather than forwarding an empty messages[].
 * @param {string|Array} input - raw input from Responses API body
 * @returns {Array|null} normalized array or null if invalid
 */
export function normalizeResponsesInput(input) {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text }] }];
  }
  if (Array.isArray(input)) {
    // Empty input[] would produce messages:[] which all providers reject (#389)
    if (input.length === 0) {
      return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "..." }] }];
    }
    return input;
  }
  return null;
}

// Strict Responses upstreams reject overlong call_ids with InputValidationError (#393).
export const MAX_RESPONSES_CALL_ID_LEN = 64;

// Fallback ids share one Date.now() when a batch of items is sanitized in a tight
// loop — a per-process sequence keeps same-millisecond ids unique so
// function_call ↔ function_call_output correlation never collides.
let responsesCallIdSeq = 0;

function hashResponsesCallId(value) {
  // 64-bit FNV-1a keeps the mapping synchronous and runtime-portable while
  // making ids with the same long prefix distinguishable.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function clampResponsesCallId(id) {
  if (typeof id !== "string" || !id) return `call_${Date.now()}_${(responsesCallIdSeq += 1)}`;
  if (id.length <= MAX_RESPONSES_CALL_ID_LEN) return id;
  const suffix = `_${hashResponsesCallId(id)}`;
  return `${id.substring(0, MAX_RESPONSES_CALL_ID_LEN - suffix.length)}${suffix}`;
}

// Single-stringify: objects → JSON once; valid JSON strings pass through untouched;
// anything else (partial fragments, empty) falls back to "{}" instead of
// double-encoding and tripping upstream InputValidationError.
export function coerceResponsesArguments(value) {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value !== "string") {
    try {
      return JSON.stringify(value);
    } catch {
      return "{}";
    }
  }
  try {
    JSON.parse(value);
    return value;
  } catch {
    return "{}";
  }
}

// function_call_output.output must be a string — never null/object.
export function coerceResponsesOutput(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value.map((c) => {
      try {
        return c?.text ?? JSON.stringify(c);
      } catch {
        return String(c);
      }
    }).join("");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Convert a Responses input_image block for a Chat Completions target.
 * Chat-compatible providers accept an image URL/data URI, but cannot resolve an
 * OpenAI-managed file_id. Reject that constraint instead of emitting the file id
 * as a URL and silently sending a different request.
 */
export function responsesInputImageToChatBlock(content) {
  if (typeof content?.image_url === "string" && content.image_url) {
    return {
      type: OPENAI_BLOCK.IMAGE_URL,
      image_url: { url: content.image_url, detail: content.detail || "auto" }
    };
  }
  if (content?.file_id) {
    throw new ToolCompatibilityError("Chat targets cannot resolve Responses input_image.file_id");
  }
  throw new ToolCompatibilityError("Chat targets require Responses input_image.image_url");
}

/** Convert inline Responses file data without leaking unresolved OpenAI file ids. */
export function responsesInputFileToChatBlock(content) {
  if (typeof content?.file_data === "string" && content.file_data) {
    return {
      type: OPENAI_BLOCK.FILE,
      file: {
        file_data: content.file_data,
        ...(typeof content.filename === "string" && content.filename ? { filename: content.filename } : {}),
      },
    };
  }
  if (content?.file_id) {
    throw new ToolCompatibilityError("Chat targets cannot resolve Responses input_file.file_id");
  }
  throw new ToolCompatibilityError("Chat targets require inline Responses input_file.file_data");
}

/**
 * Convert OpenAI Responses API format to standard chat completions format
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
export function convertResponsesApiFormat(body) {
  if (body?.input === undefined || body?.input === null) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolCalls = [];
  let pendingToolResults = [];
  let pendingReasoning = "";
  let pendingReasoningEncrypted = "";

  const attachPendingReasoning = (message) => {
    if (pendingReasoning) message.reasoning_content = pendingReasoning;
    if (pendingReasoningEncrypted) message.encrypted_content = pendingReasoningEncrypted;
    pendingReasoning = "";
    pendingReasoningEncrypted = "";
  };

  const flushPendingReasoning = () => {
    if (!pendingReasoning && !pendingReasoningEncrypted) return;
    const message = { role: ROLE.ASSISTANT, content: "" };
    attachPendingReasoning(message);
    result.messages.push(message);
  };

  const flushPendingToolResults = () => {
    if (pendingToolResults.length === 0) return;
    result.messages.push(...pendingToolResults);
    pendingToolResults = [];
  };

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      flushPendingToolResults();

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            return responsesInputImageToChatBlock(c);
          }
          if (c.type === RESPONSES_ITEM.INPUT_FILE) return responsesInputFileToChatBlock(c);
          return c;
        })
        : item.content;
      const message = { role: item.role, content };
      if (item.role === ROLE.ASSISTANT) attachPendingReasoning(message);
      else flushPendingReasoning();
      result.messages.push(message);
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Skip items with empty/missing name — upstream APIs reject nameless tool calls (#444)
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) continue;
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
        attachPendingReasoning(currentAssistantMsg);
      }
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name,
          arguments: coerceResponsesArguments(item.arguments)
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      flushPendingReasoning();
      // Add tool result
      pendingToolResults.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: coerceResponsesOutput(item.output)
      });
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      flushPendingToolResults();
      const text = Array.isArray(item.summary)
        ? item.summary.map((entry) => entry?.text || "").filter(Boolean).join("\n")
        : "";
      if (text) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${text}` : text;
      if (typeof item.encrypted_content === "string" && item.encrypted_content) {
        pendingReasoningEncrypted = item.encrypted_content;
      }
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  flushPendingToolResults();
  flushPendingReasoning();

  // Cleanup Responses API specific fields
  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;

  return result;
}
