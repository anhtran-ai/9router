/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */
import { InvalidResponseError, validateResponseEnvelope } from "../translator/concerns/responseContract.js";
import { FORMATS } from "../translator/formats.js";
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";

const DEFAULT_MAX_COLLECTED_SSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_COLLECTED_SSE_EVENTS = 100_000;

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function signalReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Request aborted", "AbortError");
}

function releaseReader(reader) {
  try { reader?.releaseLock?.(); } catch { /* pending read releases after cancellation settles */ }
}

function cancelReader(reader, reason) {
  let cancellation;
  try { cancellation = reader?.cancel?.(reason); } catch {
    releaseReader(reader);
    return;
  }
  releaseReader(reader);
  Promise.resolve(cancellation).catch(() => {}).finally(() => releaseReader(reader));
}

async function readWithStallDeadline(reader, timeoutMs, signal = null) {
  if (signal?.aborted) throw signalReason(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signalReason(signal));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => finish(reject, new InvalidResponseError("upstream Responses SSE body stalled")),
      timeoutMs,
    );
    timer.unref?.();
    let read;
    try { read = reader.read(); } catch (error) { finish(reject, error); return; }
    Promise.resolve(read).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return false;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataStr = msg.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (!dataStr) return false;
  if (dataStr === "[DONE]") return false;

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

  if (eventType === "error" || parsed.error || parsed.response?.error || eventType === "response.failed" ||
      parsed.response?.status === "failed" || parsed.response?.status === "cancelled") {
    state.failed = true;
    return true;
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
    return true;
  }

  return false;
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream, options = {}) {
  if (!stream || typeof stream.getReader !== "function") {
    throw new InvalidResponseError("missing Responses SSE body");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let skipLeadingLF = false;

  const state = {
    response: {}, terminal: null, status: "in_progress", failed: false, items: new Map()
  };
  let reachedEof = false;
  let reachedTerminal = false;
  let collectedBytes = 0;
  let collectedEvents = 0;
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_COLLECTED_SSE_BYTES);
  const maxEvents = positiveLimit(options.maxEvents, DEFAULT_MAX_COLLECTED_SSE_EVENTS);
  const stallTimeoutMs = positiveLimit(options.stallTimeoutMs, STREAM_STALL_TIMEOUT_MS);
  const signal = options.signal || null;

  const appendDecoded = (text) => {
    if (skipLeadingLF && text) {
      if (text.startsWith("\n")) text = text.slice(1);
      skipLeadingLF = false;
    }
    if (!text) return;
    skipLeadingLF = text.endsWith("\r");
    buffer += text.replace(/\r\n|\r/g, "\n");
  };

  try {
    readLoop: while (true) {
      const { done, value } = await readWithStallDeadline(reader, stallTimeoutMs, signal);
      if (done) {
        reachedEof = true;
        appendDecoded(decoder.decode());
        break;
      }

      collectedBytes += value?.byteLength || 0;
      if (collectedBytes > maxBytes) {
        throw new InvalidResponseError(`upstream Responses SSE exceeded ${maxBytes} bytes`);
      }

      appendDecoded(decoder.decode(value, { stream: true }));
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        collectedEvents += 1;
        if (collectedEvents > maxEvents) {
          throw new InvalidResponseError(`upstream Responses SSE exceeded ${maxEvents} events`);
        }
        if (processSSEMessage(msg, state)) {
          reachedTerminal = true;
          break readLoop;
        }
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (!reachedTerminal && buffer.trim()) {
      reachedTerminal = processSSEMessage(buffer, state);
    }

    // A valid Responses terminal ends the protocol message even when the
    // transport remains open. Discard only bytes after that terminal and
    // release the upstream reader instead of waiting indefinitely for EOF.
    if (reachedTerminal && !reachedEof) {
      cancelReader(reader, "terminal event received");
    }
  } catch (error) {
    cancelReader(reader, error);
    throw error;
  } finally {
    releaseReader(reader);
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
