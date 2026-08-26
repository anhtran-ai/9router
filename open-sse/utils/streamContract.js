import { FORMATS } from "../translator/formats.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { buildErrorBody } from "./error.js";
import { formatSSE } from "./streamHelpers.js";
import { SSE_DONE } from "./sseConstants.js";
import { validateResponseEnvelope } from "../translator/concerns/responseContract.js";

const encoder = new TextEncoder();
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const GEMINI_FORMATS = new Set([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY, FORMATS.VERTEX]);
const DECODED_CHAT_FORMATS = new Set([FORMATS.KIRO, FORMATS.CURSOR, FORMATS.COMMANDCODE]);

// Reasons are internal constants, never provider payloads or transport diagnostics.
export class InvalidStreamResponseError extends Error {
  constructor(reason) {
    super(`Invalid upstream response: ${reason}`);
    this.name = "InvalidStreamResponseError";
    this.status = HTTP_STATUS.BAD_GATEWAY;
    this.code = "invalid_upstream_response";
  }
}

export function hasStreamingContentType(response, format) {
  const mediaType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!response.body) return false;
  if (format === FORMATS.OLLAMA) return ["application/x-ndjson", "application/ndjson", "application/json"].includes(mediaType);
  return mediaType === "text/event-stream";
}

export function formatStreamFailure(error, clientFormat) {
  const message = error instanceof InvalidStreamResponseError ? error.message : "Invalid upstream response: stream interrupted";
  const body = buildErrorBody(HTTP_STATUS.BAD_GATEWAY, message, "invalid_upstream_response");
  if (clientFormat === FORMATS.OPENAI_RESPONSES) {
    return encoder.encode(formatSSE({ event: "response.failed", data: {
      type: "response.failed", response: { id: `resp_${Date.now()}`, object: "response", status: "failed", output: [], error: body.error },
    } }, clientFormat) + SSE_DONE);
  }
  if (clientFormat === FORMATS.CLAUDE) {
    return encoder.encode(formatSSE({ type: "error", error: { ...body.error, type: "api_error" } }, clientFormat));
  }
  return encoder.encode(formatSSE(body, clientFormat));
}

/**
 * Validate upstream frames before a translator can invent completion at EOF.
 * Memory is one SSE frame plus terminal metadata, not the response. In particular,
 * hold Chat finish/usage and Claude message_delta until their end is confirmed;
 * earlier text, reasoning and tool deltas remain incremental and backpressured.
 */
export function createStreamContract(format) {
  const expected = DECODED_CHAT_FORMATS.has(format) ? FORMATS.OPENAI : format;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = ""; let dataLines = []; let eventName = "";
  let semantic = false; let terminal = false; let stopped = false;
  let claudeStarted = false; let claudeFinish = null;
  const claudeBlocks = new Set();
  const chatChoices = new Set(); const chatFinished = new Set();
  const chatTerminals = []; let chatUsage = null;
  const terminalFrames = [];
  const geminiCandidates = new Set(); const geminiFinished = new Set();
  const responseItems = new Map(); const responseCalls = new Map(); const responseIndexes = new Map();

  const fail = reason => { throw new InvalidStreamResponseError(reason); };
  const observeResponseItem = (item, outputIndex) => {
    if (!isObject(item)) fail("invalid Responses output item");
    const indexed = Number.isInteger(outputIndex) && outputIndex >= 0;
    const matches = new Set([
      item.id && responseItems.get(item.id),
      item.call_id && responseCalls.get(item.call_id),
      indexed && responseIndexes.get(outputIndex),
    ].filter(Boolean));
    if (matches.size > 1) fail("conflicting Responses output item identity");
    const identity = matches.values().next().value || {};
    // Compare raw identity before Chat normalization erases function/custom type
    // and item id. Status, arguments and other completion metadata may change.
    for (const field of ["type", "id", "call_id", "name"]) {
      if (item[field] === undefined) continue;
      if (typeof item[field] !== "string" ||
          (identity[field] !== undefined && identity[field] !== item[field])) fail("conflicting Responses output item identity");
      identity[field] = item[field];
    }
    if (identity.id) responseItems.set(identity.id, identity);
    if (identity.call_id) responseCalls.set(identity.call_id, identity);
    if (indexed) responseIndexes.set(outputIndex, identity);
  };
  const emit = (controller, data, event = "") => {
    controller.enqueue(encoder.encode(expected === FORMATS.OLLAMA
      ? `${JSON.stringify(data)}\n`
      : `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`));
  };
  const flushChatTerminal = controller => {
    for (const item of chatTerminals.splice(0)) {
      emit(controller, chatUsage ? { ...item, usage: chatUsage } : item);
    }
  };
  const finish = controller => {
    if (!semantic || !terminal) fail("stream ended without a valid terminal event");
    flushChatTerminal(controller);
    for (const frame of terminalFrames.splice(0)) emit(controller, frame.data, frame.event);
  };
  const complete = (controller, sentinel = false) => {
    finish(controller);
    if (sentinel) controller.enqueue(encoder.encode(SSE_DONE));
    // A protocol-wide terminal closes the message even when HTTP remains open.
    // Stop reading/cancel the unused upstream remainder; do not claim to validate
    // trailing bytes after the provider has already ended the response.
    stopped = true;
    controller.terminate();
  };

  const consume = (text, event, controller) => {
    if (text === "[DONE]" && expected !== FORMATS.OLLAMA) {
      // Claude/Gemini have their own terminals; never inject a Chat sentinel.
      complete(controller, expected === FORMATS.OPENAI || expected === FORMATS.OPENAI_RESPONSES);
      return;
    }
    let value;
    try { value = JSON.parse(text); } catch { fail("malformed stream data"); }
    if (!isObject(value)) fail("invalid stream event envelope");
    if (value.error || value.response?.error || event === "error" || value.type === "error" || value.type === "response.failed") fail("provider reported a stream error");
    if (event && value.type && event !== value.type) fail("conflicting stream event type");

    if (expected === FORMATS.OPENAI) {
      if (!Array.isArray(value.choices)) return; // Allow extension events, but never count them as a response.
      if (value.choices.length === 0) {
        if (isObject(value.usage)) chatUsage = value.usage;
        // After finish, merge usage into the held finish chunk for translated clients.
        if (chatTerminals.length === 0) emit(controller, value, event);
        return;
      }
      const choices = value.choices.map((choice, i) => ({ ...choice, index: choice?.index ?? i }));
      for (const choice of choices) {
        if (!isObject(choice) || !isObject(choice.delta)) fail("invalid Chat stream choice");
        const index = choice.index;
        if (chatFinished.has(index)) fail("Chat data received after choice completion");
        chatChoices.add(index);
        if (typeof choice.finish_reason === "string" && choice.finish_reason) chatFinished.add(index);
      }
      semantic = true;
      terminal = chatChoices.size === chatFinished.size;
      if (isObject(value.usage)) chatUsage = value.usage;
      const finished = choices.filter(choice => choice.finish_reason);
      if (finished.length) {
        chatTerminals.push({ ...value, choices: finished });
        const ongoing = choices.filter(choice => !choice.finish_reason);
        if (ongoing.length) emit(controller, { ...value, choices: ongoing }, event);
      } else emit(controller, value, event);
      return;
    }

    if (expected === FORMATS.CLAUDE) {
      const type = value.type || event;
      if (type === "ping") { emit(controller, value, event); return; }
      if (type === "message_start") {
        if (claudeStarted || !isObject(value.message) || !Array.isArray(value.message.content) ||
            typeof value.message.id !== "string" || !value.message.id || typeof value.message.model !== "string" ||
            validateResponseEnvelope(value.message, FORMATS.CLAUDE) !== FORMATS.CLAUDE) fail("invalid Claude message_start");
        claudeStarted = semantic = true;
      } else if (["content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"].includes(type)) {
        if (!claudeStarted || terminal) fail("Claude event outside an active message");
        if (type === "content_block_start") {
          if (!isObject(value.content_block) || !Number.isInteger(value.index) || claudeBlocks.has(value.index)) fail("invalid Claude content block");
          claudeBlocks.add(value.index);
        } else if (type === "content_block_delta" || type === "content_block_stop") {
          if (!claudeBlocks.has(value.index)) fail("Claude event outside an active content block");
          if (type === "content_block_delta" && !isObject(value.delta)) fail("invalid Claude content delta");
          if (type === "content_block_stop") claudeBlocks.delete(value.index);
        } else if (type === "message_delta") {
          claudeFinish = claudeFinish ? { ...claudeFinish, ...value, delta: { ...claudeFinish.delta, ...value.delta }, usage: { ...claudeFinish.usage, ...value.usage } } : value;
          return;
        } else {
          if (!claudeFinish?.delta?.stop_reason || claudeBlocks.size) fail("incomplete Claude message");
          terminal = true;
          terminalFrames.push({ data: claudeFinish, event: "message_delta" }, { data: value, event: type });
          complete(controller);
          return;
        }
      } else return;
      emit(controller, value, type);
      return;
    }

    if (expected === FORMATS.OPENAI_RESPONSES) {
      const type = value.type || event;
      if (!type?.startsWith("response.")) return;
      if (terminal) fail("Responses data received after completion");
      if (value.response?.status === "failed" || value.response?.status === "cancelled") fail("provider reported a failed response");
      if (type === "response.output_item.added" || type === "response.output_item.done") observeResponseItem(value.item, value.output_index);
      semantic = true;
      if (["response.completed", "response.done", "response.incomplete"].includes(type)) {
        const response = value.response;
        if (!isObject(response) || typeof response.id !== "string" || !response.id ||
            validateResponseEnvelope(response, FORMATS.OPENAI_RESPONSES) !== FORMATS.OPENAI_RESPONSES) fail("invalid Responses terminal envelope");
        const expectedStatus = type === "response.incomplete" ? "incomplete" : "completed";
        if (response.status !== expectedStatus && type !== "response.done") fail("conflicting Responses terminal status");
        response.output.forEach((item, index) => observeResponseItem(item, index));
        terminal = true;
        terminalFrames.push({ data: value.type ? value : { ...value, type }, event: type });
        complete(controller);
        return;
      }
      emit(controller, value.type ? value : { ...value, type }, type);
      return;
    }

    if (GEMINI_FORMATS.has(expected)) {
      const response = value.response || value;
      if (!Array.isArray(response.candidates) || !response.candidates.length) {
        if (response.promptFeedback?.blockReason) {
          if (semantic || terminal) fail("Gemini prompt feedback received after response output");
          semantic = terminal = true;
          terminalFrames.push({ data: value, event });
          complete(controller);
          return;
        }
        if (isObject(response.usageMetadata) || isObject(value.usageMetadata)) emit(controller, value, event);
        return;
      }
      for (let i = 0; i < response.candidates.length; i++) {
        const candidate = response.candidates[i];
        if (!isObject(candidate)) fail("invalid Gemini candidate");
        if (candidate.content !== undefined && (!isObject(candidate.content) ||
            !Array.isArray(candidate.content.parts) || !candidate.content.parts.every(isObject))) fail("invalid Gemini content parts");
        const index = candidate.index ?? i;
        if (geminiFinished.has(index)) fail("Gemini data received after candidate completion");
        geminiCandidates.add(index);
        if (typeof candidate.finishReason === "string" && candidate.finishReason) geminiFinished.add(index);
      }
      semantic = true;
      terminal = geminiCandidates.size === geminiFinished.size;
      const candidates = response.candidates.map((candidate, i) => ({ ...candidate, index: candidate.index ?? i }));
      const finished = candidates.filter(candidate => candidate.finishReason);
      const withCandidates = selected => value.response
        ? { ...value, response: { ...response, candidates: selected } } : { ...value, candidates: selected };
      if (finished.length) {
        terminalFrames.push({ data: withCandidates(finished), event });
        const ongoing = candidates.filter(candidate => !candidate.finishReason);
        if (ongoing.length) emit(controller, withCandidates(ongoing), event);
      } else emit(controller, value, event);
      return;
    }

    if (expected === FORMATS.OLLAMA) {
      if (!isObject(value.message) && value.done !== true) return;
      if (terminal) fail("Ollama data received after completion");
      semantic = true;
      if (value.done === true) {
        terminal = true;
        terminalFrames.push({ data: value, event: "" });
        complete(controller);
      }
      else emit(controller, value);
      return;
    }
    fail("unsupported upstream stream format");
  };

  const dispatch = controller => {
    const text = dataLines.join("\n"); const event = eventName;
    const hasData = dataLines.length > 0;
    dataLines = []; eventName = "";
    if (hasData) consume(text, event, controller);
  };
  const line = (text, controller) => {
    if (expected === FORMATS.OLLAMA) { if (text.trim()) consume(text.trim(), "", controller); return; }
    if (!text) { dispatch(controller); return; }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    // SSE extension/unknown fields are ignored, including fields with no colon.
    // Raw JSON mislabeled as SSE still fails because it never establishes a
    // semantic event and valid terminal.
  };
  const drain = (controller, eof = false) => {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== "\n" && buffer[i] !== "\r") continue;
      if (!eof && buffer[i] === "\r" && i === buffer.length - 1) break;
      line(buffer.slice(start, i), controller);
      if (stopped) { buffer = ""; return; }
      if (buffer[i] === "\r" && buffer[i + 1] === "\n") i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    if (eof) {
      if (buffer) line(buffer, controller);
      buffer = "";
      if (!stopped) dispatch(controller);
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (stopped) return;
      try { buffer += decoder.decode(chunk, { stream: true }); }
      catch { fail("invalid stream encoding"); }
      drain(controller);
    },
    flush(controller) {
      if (stopped) return;
      try { buffer += decoder.decode(); } catch { fail("invalid stream encoding"); }
      drain(controller, true);
      if (!stopped) finish(controller);
    },
  });
}
