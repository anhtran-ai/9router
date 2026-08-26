/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */
import { InvalidResponseError, validateResponseEnvelope } from "../translator/concerns/responseContract.js";
import { FORMATS } from "../translator/formats.js";

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataStr = msg.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (!dataStr) return;
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { throw new InvalidResponseError("invalid Responses SSE data"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidResponseError("invalid Responses SSE event");
  }
  const eventName = eventMatch?.[1].trim();
  if (eventName && parsed.type !== undefined && parsed.type !== eventName) {
    throw new InvalidResponseError("conflicting Responses SSE event and data type");
  }
  const eventType = eventName || parsed.type;

  if (eventType === "error" || parsed.error || parsed.response?.error || eventType === "response.failed") {
    state.failed = true;
  }

  if (eventType === "response.created") {
    state.response = parsed.response || {};
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (["response.completed", "response.done", "response.incomplete"].includes(eventType)) {
    if (!parsed.response || typeof parsed.response !== "object" || Array.isArray(parsed.response)) {
      throw new InvalidResponseError("missing Responses terminal payload");
    }
    state.terminal = parsed.response;
    state.status = state.terminal.status || (eventType === "response.incomplete" ? "incomplete" : "completed");
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    throw new InvalidResponseError("missing Responses SSE body");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    response: {}, terminal: null, status: "in_progress", failed: false, items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (state.failed || !state.terminal || !["completed", "incomplete"].includes(state.status)) {
    throw new InvalidResponseError("Responses SSE ended without a successful terminal event");
  }

  // Build output array from accumulated items (ordered by index)
  const collectedOutput = [];
  if (state.terminal.output !== undefined && !Array.isArray(state.terminal.output)) {
    throw new InvalidResponseError("invalid Responses terminal output");
  }
  const responseId = state.terminal.id || state.response.id;
  if (typeof responseId !== "string" || responseId.length === 0) {
    throw new InvalidResponseError("missing Responses identity");
  }
  // The final native envelope is authoritative; earlier item events may be
  // sparse (e.g. an unfinished reasoning item), and need no reconstruction.
  const maxIndex = !Array.isArray(state.terminal.output) && state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    if (!state.items.has(i)) throw new InvalidResponseError("Responses SSE output item is missing");
    collectedOutput.push(state.items.get(i));
  }

  const result = {
    ...state.response,
    ...state.terminal,
    id: responseId,
    object: "response",
    created_at: state.terminal.created_at || state.response.created_at || Math.floor(Date.now() / 1000),
    status: state.status,
    output: Array.isArray(state.terminal.output) ? state.terminal.output : collectedOutput,
    usage: state.terminal.usage || state.response.usage || { ...EMPTY_RESPONSE }
  };
  validateResponseEnvelope(result, FORMATS.OPENAI_RESPONSES);
  return result;
}
