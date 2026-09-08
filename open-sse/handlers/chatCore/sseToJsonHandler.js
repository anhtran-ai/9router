import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult, readUpstreamBodyText } from "../../utils/error.js";
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { InvalidResponseError, normalizeNonStreamingResponse } from "../../translator/concerns/responseContract.js";
import { saveRequestDetail } from "@/lib/usageDb.js";

const isResponsesProvider = provider => PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
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
      () => finish(reject, new InvalidResponseError("upstream Chat SSE body stalled")),
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

function parseSSEFrameFields(frame) {
  const lines = frame.split("\n");
  const eventLine = lines.find(line => line === "event" || line.startsWith("event:"));
  return {
    event: eventLine ? (eventLine === "event" ? "" : eventLine.slice(6).replace(/^ /, "").trim()) : null,
    payload: lines
      .filter(line => line === "data" || line.startsWith("data:"))
      .map(line => line === "data" ? "" : line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim(),
  };
}

function isChatCollectionGlobalTerminalFrame(frame) {
  const { event, payload } = parseSSEFrameFields(frame);
  if (event === "error") return true;
  if (payload === "[DONE]") return true;
  if (!payload) return false;
  try {
    const parsed = JSON.parse(payload);
    // A choice-level finish_reason is not the end of the Chat SSE protocol:
    // include_usage streams send a choices:[] usage trailer after it, followed
    // by [DONE]. Keep collecting until the global terminal so that trailer is
    // not discarded. EOF remains a valid fallback for providers that omit
    // [DONE], and every further read stays bounded by the same caps/deadline.
    return Boolean(parsed?.error);
  } catch {
    // A malformed complete data frame already makes the buffered response
    // invalid, so waiting for transport EOF cannot recover it.
    return true;
  }
}

/** Collect Chat SSE without inventing success for unrelated JSON or truncated data. */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const chunks = [];
  let streamError = null;
  let hasChoice = false;
  let terminalSeen = false;

  // SSE data belongs to a complete frame, not to an individual data: line.
  // The response is already buffered; normalize all allowed line separators
  // before joining a frame's data values exactly as a streaming reader does.
  const frames = String(rawSSE || "").replace(/\r\n|\r/g, "\n").split("\n\n");
  for (const frame of frames) {
    const { event, payload } = parseSSEFrameFields(frame);
    if (payload === "[DONE]") { terminalSeen = true; continue; }
    if (!payload) {
      if (event === "error") streamError ||= { message: "Upstream SSE error", code: "invalid_upstream_response" };
      continue;
    }
    try {
      const chunk = JSON.parse(payload);
      if (event === "error") {
        streamError = chunk?.error || (chunk && typeof chunk === "object" ? chunk : {
          message: "Upstream SSE error", code: "invalid_upstream_response"
        });
      } else if (chunk?.error) streamError = chunk.error;
      else if (Array.isArray(chunk?.choices)) {
        chunks.push(chunk);
        hasChoice ||= chunk.choices.some(choice => choice && (choice.delta || choice.message));
        terminalSeen ||= chunk.choices.some(choice => choice?.finish_reason != null);
      }
    } catch {
      streamError ||= { message: "Invalid upstream SSE data", code: "invalid_upstream_response" };
    }
  }

  if (streamError) return { error: streamError };
  if (!hasChoice) return null;
  if (!terminalSeen) return { error: { message: "Upstream SSE stream ended without a terminal event", code: "invalid_upstream_response" } };

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || choice?.message || {};
    if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoningParts.push(delta.reasoning_content);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  const message = { role: "assistant", content: contentParts.join("") || (toolCallMap.size > 0 ? null : "") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
  if (usage) result.usage = usage;
  return result;
}

/** Collect Chat SSE until its protocol terminal, without waiting for HTTP EOF. */
export async function convertChatStreamToOpenAIResponse(stream, fallbackModel, options = {}) {
  if (!stream || typeof stream.getReader !== "function") {
    throw new InvalidResponseError("missing Chat SSE body");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const rawParts = [];
  let buffer = "";
  let skipLeadingLF = false;
  let reachedEof = false;
  let reachedTerminal = false;
  let collectedBytes = 0;
  let collectedEvents = 0;
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_COLLECTED_SSE_BYTES);
  const maxEvents = positiveLimit(options.maxEvents, DEFAULT_MAX_COLLECTED_SSE_EVENTS);
  const stallTimeoutMs = positiveLimit(options.stallTimeoutMs, STREAM_STALL_TIMEOUT_MS);
  const signal = options.signal || null;

  // Count a bare CR immediately (it is a complete SSE line ending), but skip
  // one LF if the next transport chunk proves that CR was half of CRLF.
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
        throw new InvalidResponseError(`upstream Chat SSE exceeded ${maxBytes} bytes`);
      }

      appendDecoded(decoder.decode(value, { stream: true }));
      let separatorIndex;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        collectedEvents += 1;
        if (collectedEvents > maxEvents) {
          throw new InvalidResponseError(`upstream Chat SSE exceeded ${maxEvents} events`);
        }
        rawParts.push(frame, "\n\n");
        if (isChatCollectionGlobalTerminalFrame(frame)) {
          reachedTerminal = true;
          break readLoop;
        }
      }
    }

    if (reachedEof && buffer) rawParts.push(buffer);
    if (reachedTerminal && !reachedEof) {
      cancelReader(reader, "terminal event received");
    }
  } catch (error) {
    cancelReader(reader, error);
    throw error;
  } finally {
    releaseReader(reader);
  }

  return parseSSEToOpenAIResponse(rawParts.join(""), fallbackModel);
}

/** Provider forces streaming while the client requests one JSON response. */
export async function handleForcedSSEToJson({ providerResponse, sourceFormat, targetFormat, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, customToolNames, trackDone, appendLog, reqTag, log, signal = null }) {
  const contentType = (providerResponse.headers.get("content-type") || "").toLowerCase();
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider));
  const isJson = contentType.includes("application/json") || contentType.includes("+json");
  if (!isSSE && !isJson) return null;
  trackDone();

  try {
    let responseBody;
    let responseFormat = targetFormat;
    if (isJson) {
      // A provider may honor stream:false despite its registry forceStream flag.
      const responseText = await readUpstreamBodyText(providerResponse, {
        signal,
        maxBytes: DEFAULT_MAX_COLLECTED_SSE_BYTES,
        stallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
        fatalUtf8: true,
      });
      if (!responseText.trim()) throw new InvalidResponseError("empty upstream JSON response");
      try { responseBody = JSON.parse(responseText); }
      catch { throw new InvalidResponseError("invalid upstream JSON response"); }
    } else if (isResponsesProvider(provider) || targetFormat === FORMATS.OPENAI_RESPONSES) {
      responseBody = await convertResponsesStreamToJson(providerResponse.body, { signal });
      responseFormat = FORMATS.OPENAI_RESPONSES;
    } else {
      responseBody = await convertChatStreamToOpenAIResponse(providerResponse.body, model, { signal });
      responseFormat = FORMATS.OPENAI;
      if (responseBody?.error) {
        throw new InvalidResponseError("upstream SSE reported an error");
      }
    }
    const clientBody = normalizeNonStreamingResponse(responseBody, responseFormat, sourceFormat, customToolNames, {
      allowBackground: isJson && body?.background === true && body?.stream !== true,
    });

    // No account-success callback or usage record until collection, terminal
    // validation and the client-format conversion have all succeeded.
    if (onRequestSuccess) {
      try {
        Promise.resolve(onRequestSuccess()).catch(err => {
          log?.warn?.("ChatCore", `Success cleanup failed: ${err?.message || err}`);
        });
      } catch (err) {
        log?.warn?.("ChatCore", `Success cleanup failed: ${err?.message || err}`);
      }
    }
    const usage = extractUsageFromResponse(responseBody) || {};
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));
    const totalLatency = Date.now() - requestStartTime;
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, latency: { ttft: totalLatency, total: totalLatency }, tokens: usage,
      request: extractRequestConfig(body, stream), providerRequest: finalBody || translatedBody || null,
      response: { content: clientBody.choices?.[0]?.message?.content || clientBody.content || clientBody.output || null,
        thinking: clientBody.choices?.[0]?.message?.reasoning_content || null,
        finish_reason: clientBody.choices?.[0]?.finish_reason || clientBody.stop_reason || clientBody.status || "unknown" },
      status: "success",
    }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});
    return { success: true, response: new Response(JSON.stringify(clientBody), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }) };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY,
      error instanceof InvalidResponseError ? error.message : "Invalid upstream streaming response",
      undefined, "invalid_upstream_response");
  }
}
