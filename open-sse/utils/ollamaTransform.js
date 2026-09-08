import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";

const MAX_OLLAMA_JSON_BYTES = 64 * 1024 * 1024;
const MAX_OLLAMA_SSE_EVENTS = 100_000;
const MAX_OLLAMA_ERROR_MESSAGE_CHARS = 4_096;
const STALE_REPRESENTATION_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "digest",
  "content-digest",
  "repr-digest",
  "content-md5",
  "etag",
  "content-range",
  "trailer",
];

function sanitizedOllamaHeaders(response) {
  const headers = new Headers(response.headers);
  for (const name of STALE_REPRESENTATION_HEADERS) headers.delete(name);
  return headers;
}

function forwardOllamaResponse(response) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: sanitizedOllamaHeaders(response),
  });
}

function ollamaBodyError(message) {
  const error = new Error(message);
  error.code = "invalid_upstream_response";
  return error;
}

function ollamaSignalError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Ollama response read aborted", "AbortError");
}

function readOllamaStreamChunk(reader, signal = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, ollamaSignalError(signal));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(
      () => finish(reject, ollamaBodyError("Upstream Ollama response body stalled")),
      STREAM_STALL_TIMEOUT_MS,
    );
    timer.unref?.();

    let read;
    try { read = reader.read(); }
    catch (error) {
      finish(reject, error);
      return;
    }
    // Keep observing the transport promise after timeout/abort wins.
    Promise.resolve(read).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

async function readOllamaJsonBody(response, signal = null) {
  if (signal?.aborted) {
    const error = ollamaSignalError(signal);
    try { Promise.resolve(response.body?.cancel(error)).catch(() => {}); } catch { /* best effort */ }
    throw error;
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_OLLAMA_JSON_BYTES) {
    try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
    throw ollamaBodyError(`Upstream Ollama response exceeds ${MAX_OLLAMA_JSON_BYTES} bytes`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let cancellation = null;
  try {
    while (true) {
      const record = await readOllamaStreamChunk(reader, signal);
      if (record.done) break;
      if (!(record.value instanceof Uint8Array)) {
        throw ollamaBodyError("Invalid upstream Ollama response chunk");
      }
      total += record.value?.byteLength || 0;
      if (total > MAX_OLLAMA_JSON_BYTES) {
        throw ollamaBodyError(`Upstream Ollama response exceeds ${MAX_OLLAMA_JSON_BYTES} bytes`);
      }
      chunks.push(record.value);
    }
  } catch (error) {
    try { cancellation = Promise.resolve(reader.cancel(error)).catch(() => {}); }
    catch { cancellation = null; }
    throw error;
  } finally {
    const release = () => {
      try { reader.releaseLock(); } catch { /* pending read or already released */ }
    };
    release();
    cancellation?.finally(release);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseToolArguments(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object") return value;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("Ollama tool arguments must decode to an object");
  }
  return parsed;
}

function formatToolCalls(toolCalls) {
  return (toolCalls || []).map((toolCall) => ({
    function: {
      name: toolCall?.function?.name || "",
      arguments: parseToolArguments(toolCall?.function?.arguments),
    },
  }));
}

function usageFields(usage) {
  if (!usage || typeof usage !== "object") return {};
  return {
    prompt_eval_count: Number(usage.prompt_tokens) || 0,
    eval_count: Number(usage.completion_tokens) || 0,
  };
}

function upstreamErrorDetails(value, fallback = "Invalid upstream streaming response") {
  const source = value?.error ?? value;
  const isSafeLocalError = value instanceof Error && value.code === "invalid_upstream_response";
  const rawMessage = value instanceof Error && !isSafeLocalError
    ? fallback
    : (typeof source === "string" ? source : (source?.message || value?.message || fallback));
  const rawCode = value instanceof Error && !isSafeLocalError
    ? "invalid_upstream_response"
    : (source?.code || value?.code || "invalid_upstream_response");
  return {
    error: String(rawMessage || fallback).slice(0, MAX_OLLAMA_ERROR_MESSAGE_CHARS),
    code: String(rawCode || "invalid_upstream_response").slice(0, 128),
    status: 502,
  };
}

function invalidOllamaResponse(message) {
  return Response.json(upstreamErrorDetails(null, message), {
    status: 502,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

function transformStreaming(response, model, signal = null) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_OLLAMA_JSON_BYTES) {
    try { response.body?.cancel()?.catch?.(() => {}); } catch { /* best effort */ }
    return invalidOllamaResponse(`Upstream Ollama response exceeds ${MAX_OLLAMA_JSON_BYTES} bytes`);
  }

  let reader;
  try {
    reader = response.body.getReader();
  } catch {
    return invalidOllamaResponse("Invalid upstream Ollama response body");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const pendingToolCalls = new Map();
  const outputQueue = [];
  let buffer = "";
  let skipLeadingLF = false;
  let dataLines = [];
  let eventName = "";
  let latestUsage = null;
  let latestFinishReason = null;
  let semanticSeen = false;
  let terminalSeen = false;
  let stopped = false;
  let released = false;
  let totalBytes = 0;
  let eventCount = 0;
  let upstreamEnded = false;
  let downstreamCancelled = false;
  let abortHandler = null;

  const cleanupAbortListener = () => {
    if (!abortHandler) return;
    signal?.removeEventListener?.("abort", abortHandler);
    abortHandler = null;
  };

  const releaseReader = () => {
    if (released) return;
    try {
      reader.releaseLock();
      released = true;
    } catch {
      // A timed-out read may still be pending. Its cancellation completion
      // retries the release without replacing the primary stream failure.
    }
  };

  const cancelAndRelease = (reason) => {
    cleanupAbortListener();
    let cancellation;
    try { cancellation = Promise.resolve(reader.cancel(reason)).catch(() => {}); }
    catch { cancellation = null; }
    releaseReader();
    cancellation?.finally(releaseReader);
  };

  const queue = value => outputQueue.push(encoder.encode(`${JSON.stringify(value)}\n`));

  const buildTerminal = () => {
    const message = { role: "assistant", content: "" };
    if (pendingToolCalls.size > 0) {
      message.tool_calls = formatToolCalls([...pendingToolCalls.values()]);
      pendingToolCalls.clear();
    }
    return {
      model,
      message,
      done: true,
      ...(latestFinishReason ? { done_reason: latestFinishReason } : {}),
      ...usageFields(latestUsage),
    };
  };

  const stopWithSuccess = () => {
    if (stopped) return;
    const terminal = buildTerminal();
    stopped = true;
    queue(terminal);
    // [DONE] is protocol-terminal. Do not leave an intermediary/proxy body
    // unread if it keeps the HTTP connection open or appends unrelated bytes.
    cancelAndRelease();
  };

  const stopWithError = (error, fallback) => {
    if (stopped) return;
    stopped = true;
    queue(upstreamErrorDetails(error, fallback));
    cancelAndRelease(error instanceof Error ? error : undefined);
  };

  if (signal) {
    abortHandler = () => {
      if (stopped) return;
      stopped = true;
      outputQueue.length = 0;
      cancelAndRelease(ollamaSignalError(signal));
    };
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  }

  const processEvent = () => {
    const data = dataLines.join("\n").trim();
    const event = eventName.trim();
    dataLines = [];
    eventName = "";
    if (!data && !event) return;
    eventCount += 1;
    if (eventCount > MAX_OLLAMA_SSE_EVENTS) {
      throw ollamaBodyError(`Upstream Ollama response exceeds ${MAX_OLLAMA_SSE_EVENTS} events`);
    }
    if (event === "error" && !data) {
      stopWithError(null, "Upstream SSE reported an error");
      return;
    }
    if (!data) return;
    if (data === "[DONE]") {
      if (event === "error") {
        stopWithError(null, "Upstream SSE reported an error");
        return;
      }
      if (!semanticSeen) {
        stopWithError(null, "Upstream SSE ended before any response data");
        return;
      }
      terminalSeen = true;
      stopWithSuccess();
      return;
    }

    let parsed;
    try { parsed = JSON.parse(data); }
    catch { throw ollamaBodyError("Invalid upstream SSE data"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw ollamaBodyError("Invalid upstream SSE event envelope");
    }
    if (event === "error" || parsed.error || parsed.type === "error") {
      stopWithError(parsed, "Upstream SSE reported an error");
      return;
    }

    if (parsed.usage && typeof parsed.usage === "object") latestUsage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (typeof choice !== "object" || Array.isArray(choice)) {
      throw ollamaBodyError("Invalid upstream SSE choice");
    }
    if (choice.delta != null && (typeof choice.delta !== "object" || Array.isArray(choice.delta))) {
      throw ollamaBodyError("Invalid upstream SSE delta");
    }
    const delta = choice.delta || {};
    if (delta.content != null && typeof delta.content !== "string") {
      throw ollamaBodyError("Invalid upstream SSE content delta");
    }
    if (delta.reasoning_content != null && typeof delta.reasoning_content !== "string") {
      throw ollamaBodyError("Invalid upstream SSE reasoning delta");
    }
    if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) {
      throw ollamaBodyError("Invalid upstream SSE tool-call delta");
    }
    semanticSeen = true;
    const hasDelta = Boolean(
      delta.content || delta.reasoning_content ||
      (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
    );
    if (terminalSeen && (hasDelta || choice.finish_reason == null)) {
      throw ollamaBodyError("Upstream SSE sent data after its terminal choice");
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const key = Number.isInteger(toolCall.index)
          ? toolCall.index
          : (toolCall.id || pendingToolCalls.size);
        if (!pendingToolCalls.has(key)) {
          pendingToolCalls.set(key, { function: { name: "", arguments: "" } });
        }
        const pending = pendingToolCalls.get(key);
        if (toolCall.function?.name) pending.function.name += toolCall.function.name;
        if (toolCall.function?.arguments) pending.function.arguments += toolCall.function.arguments;
      }
    }

    if (delta.content || delta.reasoning_content) {
      const message = { role: "assistant", content: delta.content || "" };
      if (delta.reasoning_content) message.thinking = delta.reasoning_content;
      queue({ model, message, done: false });
    }

    if (choice.finish_reason != null) {
      if (typeof choice.finish_reason !== "string") {
        throw ollamaBodyError("Invalid upstream SSE finish reason");
      }
      latestFinishReason = choice.finish_reason;
      terminalSeen = true;
    }
  };

  const processLine = (line) => {
    if (!line) {
      processEvent();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
  };

  const appendDecoded = (text) => {
    if (skipLeadingLF && text) {
      if (text.startsWith("\n")) text = text.slice(1);
      skipLeadingLF = false;
    }
    if (!text) return;
    skipLeadingLF = text.endsWith("\r");
    buffer += text.replace(/\r\n|\r/g, "\n");
  };

  const drainLines = (eof = false) => {
    let start = 0;
    let newline;
    while ((newline = buffer.indexOf("\n", start)) !== -1) {
      const queuedBefore = outputQueue.length;
      processLine(buffer.slice(start, newline));
      start = newline + 1;
      // Parse at most one client-visible result per pull. An upstream fetch
      // chunk can contain thousands of SSE events; retaining the unparsed tail
      // keeps downstream backpressure effective instead of duplicating it all
      // into an output queue.
      if (stopped || outputQueue.length > queuedBefore) break;
    }
    buffer = stopped ? "" : buffer.slice(start);
    if (eof && !stopped && outputQueue.length === 0) {
      if (buffer) processLine(buffer);
      buffer = "";
      if (!stopped && (dataLines.length > 0 || eventName)) processEvent();
    }
  };

  const stream = new ReadableStream({
    async pull(controller) {
      if (downstreamCancelled) return;
      if (outputQueue.length > 0) {
        controller.enqueue(outputQueue.shift());
        if (stopped && outputQueue.length === 0) controller.close();
        return;
      }
      if (stopped) {
        controller.close();
        return;
      }

      while (!stopped && outputQueue.length === 0) {
        try {
          if (buffer.includes("\n") || (upstreamEnded && (buffer || dataLines.length > 0 || eventName))) {
            drainLines(upstreamEnded);
            if (stopped || outputQueue.length > 0) break;
          }

          if (upstreamEnded) {
            if (terminalSeen) {
              // A non-null finish_reason is a protocol terminal even when an
              // intermediary drops the optional OpenAI [DONE] sentinel.
              const terminal = buildTerminal();
              stopped = true;
              queue(terminal);
              cleanupAbortListener();
              releaseReader();
            } else {
              stopWithError(null, "Upstream SSE stream ended without a terminal event");
            }
            break;
          }

          const { done, value } = await readOllamaStreamChunk(reader, signal);
          if (downstreamCancelled) return;
          if (done) {
            appendDecoded(decoder.decode());
            upstreamEnded = true;
            continue;
          }
          if (!(value instanceof Uint8Array)) {
            throw ollamaBodyError("Invalid upstream Ollama response chunk");
          }
          totalBytes += value.byteLength;
          if (totalBytes > MAX_OLLAMA_JSON_BYTES) {
            throw ollamaBodyError(`Upstream Ollama response exceeds ${MAX_OLLAMA_JSON_BYTES} bytes`);
          }
          appendDecoded(decoder.decode(value, { stream: true }));
          drainLines();
        } catch (error) {
          stopWithError(error, "Invalid upstream streaming response");
        }
      }

      if (downstreamCancelled) return;
      if (outputQueue.length > 0) controller.enqueue(outputQueue.shift());
      if (stopped && outputQueue.length === 0) controller.close();
    },

    cancel(reason) {
      downstreamCancelled = true;
      stopped = true;
      outputQueue.length = 0;
      cancelAndRelease(reason);
    },
  });

  const headers = sanitizedOllamaHeaders(response);
  headers.set("Content-Type", "application/x-ndjson");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function transformNonStreaming(response, model, signal = null) {
  const bytes = await readOllamaJsonBody(response, signal);
  const original = () => {
    const headers = sanitizedOllamaHeaders(response);
    // Fetch exposes decoded response bytes; forwarding transport metadata from
    // the upstream representation can make the client decode them twice or
    // trust a stale length after reconstruction.
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw ollamaBodyError("Upstream Ollama JSON response is malformed");
  }
  if (body?.error) {
    return Response.json(upstreamErrorDetails(body, "Upstream returned an error with HTTP 200"), {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
  if (body?.message && typeof body.done === "boolean") {
    if (body.done) return original();
    throw ollamaBodyError("Upstream Ollama JSON response ended before completion");
  }

  const choice = body?.choices?.[0];
  if (body && Object.prototype.hasOwnProperty.call(body, "choices") && !choice?.message) {
    throw ollamaBodyError("Upstream OpenAI JSON response is missing a completed choice");
  }
  if (!choice?.message) return original();
  const message = {
    role: "assistant",
    content: choice.message.content || "",
  };
  if (choice.message.reasoning_content) message.thinking = choice.message.reasoning_content;
  if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0) {
    message.tool_calls = formatToolCalls(choice.message.tool_calls);
  }

  return Response.json({
    model: body.model || model,
    message,
    done: true,
    ...(choice.finish_reason ? { done_reason: choice.finish_reason } : {}),
    ...usageFields(body.usage),
  }, {
    status: response.status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

// Transform OpenAI Chat Completions output to Ollama /api/chat output.
export async function transformToOllama(response, model, signal = null) {
  if (!response?.ok) return response ? forwardOllamaResponse(response) : response;
  if (!response.body) return invalidOllamaResponse("Missing upstream Ollama response body");

  const mediaType = String(response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType === "application/json") {
    try {
      return await transformNonStreaming(response, model, signal);
    } catch (error) {
      const message = error?.code === "invalid_upstream_response"
        ? error.message
        : "Invalid upstream Ollama response";
      return invalidOllamaResponse(message);
    }
  }
  if (mediaType && mediaType !== "text/event-stream") return forwardOllamaResponse(response);

  return transformStreaming(response, model, signal);
}
