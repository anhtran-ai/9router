const { log } = require("../logger");

const DEFAULT_LOCAL_ROUTER = "http://localhost:20128";
const ROUTER_BASE = String(process.env.MITM_ROUTER_BASE || DEFAULT_LOCAL_ROUTER)
  .trim()
  .replace(/\/+$/, "") || DEFAULT_LOCAL_ROUTER;
const API_KEY = process.env.ROUTER_API_KEY;
const MAX_SSE_LINE_CHARS = 1024 * 1024;

class InvalidRouterStreamError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidRouterStreamError";
    this.code = "MITM_INVALID_ROUTER_STREAM";
  }
}

// Headers that must not be forwarded to 9Router
const STRIP_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding",
  "content-type", "authorization"
]);

function abortError(message = "Stream aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function signalReason(signal, fallback = "Stream aborted") {
  return signal?.reason instanceof Error ? signal.reason : abortError(fallback);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signalReason(signal);
}

function addListener(target, event, listener) {
  if (typeof target?.once !== "function") return () => {};
  target.once(event, listener);
  return () => {
    if (typeof target.off === "function") target.off(event, listener);
    else target.removeListener?.(event, listener);
  };
}

function createAbortScope(req, res, parentSignal) {
  const controller = new AbortController();
  const removers = [];
  const abort = (reason, fallback) => {
    if (!controller.signal.aborted) {
      controller.abort(reason instanceof Error ? reason : abortError(fallback));
    }
  };

  if (parentSignal) {
    if (parentSignal.aborted) abort(parentSignal.reason, "Upstream operation aborted");
    else {
      const onParentAbort = () => abort(parentSignal.reason, "Upstream operation aborted");
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      removers.push(() => parentSignal.removeEventListener("abort", onParentAbort));
    }
  }

  if (req) {
    removers.push(addListener(req, "aborted", () => abort(null, "Downstream request aborted")));
    removers.push(addListener(req, "error", (error) => abort(error, "Downstream request failed")));
    if (req.aborted) abort(null, "Downstream request aborted");
  }

  if (res) {
    removers.push(addListener(res, "close", () => {
      if (!res.writableEnded) abort(null, "Downstream response closed");
    }));
    removers.push(addListener(res, "error", (error) => abort(error, "Downstream response failed")));
    if (res.destroyed && !res.writableEnded) abort(null, "Downstream response closed");
  }

  return {
    signal: controller.signal,
    cleanup() {
      for (const remove of removers.splice(0)) remove();
    },
  };
}

function createBridgeAbortController(req, res) {
  return createAbortScope(req, res);
}

function readWithSignal(reader, signal) {
  throwIfAborted(signal);
  if (!signal) return reader.read();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signalReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    let read;
    try {
      read = reader.read();
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(read).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function cancelAndReleaseReader(reader) {
  let cancellation;
  try {
    cancellation = reader.cancel();
  } catch {
    try { reader.releaseLock?.(); } catch { /* best effort */ }
    return;
  }
  Promise.resolve(cancellation).catch(() => {}).finally(() => {
    try { reader.releaseLock?.(); } catch { /* best effort */ }
  });
  releaseReader(reader);
}

function releaseReader(reader) {
  try { reader.releaseLock?.(); } catch { /* cancellation will release a pending read */ }
}

function writeWithBackpressure(res, chunk, signal) {
  throwIfAborted(signal);
  if (res.destroyed && !res.writableEnded) throw abortError("Downstream response closed");
  if (res.write(chunk) !== false || typeof res.once !== "function") return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (typeof res.off === "function") {
        res.off("drain", onDrain);
        res.off("close", onClose);
        res.off("error", onError);
      } else {
        res.removeListener?.("drain", onDrain);
        res.removeListener?.("close", onClose);
        res.removeListener?.("error", onError);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onDrain = () => finish(resolve);
    const onClose = () => finish(reject, abortError("Downstream response closed"));
    const onError = (error) => finish(reject, error);
    const onAbort = () => finish(reject, signalReason(signal));
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Send body to 9Router at the given path and return the fetch Response object.
 * Optionally forwards client headers (stripped of hop-by-hop / overridden keys).
 */
async function fetchRouter(openaiBody, path = "/v1/chat/completions", clientHeaders = {}, signal) {
  const forwarded = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) forwarded[k] = v;
  }

  const response = await fetch(`${ROUTER_BASE}${path}`, {
    method: "POST",
    headers: {
      ...forwarded,
      "Content-Type": "application/json",
      ...(API_KEY && { "Authorization": `Bearer ${API_KEY}` })
    },
    body: JSON.stringify(openaiBody),
    signal,
  });

  // Forward response as-is (status + body). pipeSSE will propagate status.
  return response;
}

/**
 * Pipe SSE stream from router directly to client response.
 * Optional dumper tees the stream into a debug file.
 */
async function pipeSSE(routerRes, res, dumper, parentSignal) {
  const scope = createAbortScope(null, res, parentSignal);
  const ct = routerRes.headers.get("content-type") || "application/json";
  const status = routerRes.status || 200;
  const resHeaders = { "Content-Type": ct, "Cache-Control": "no-cache", "Connection": "keep-alive" };
  if (ct.includes("text/event-stream")) resHeaders["X-Accel-Buffering"] = "no";
  let reader;
  let reachedEof = false;
  try {
    if (routerRes.body) reader = routerRes.body.getReader();
    throwIfAborted(scope.signal);
    res.writeHead(status, resHeaders);
    if (dumper) dumper.writeHeader(routerRes.status, Object.fromEntries(routerRes.headers));

    if (!routerRes.body) {
      const text = await routerRes.text().catch(() => "");
      if (dumper) dumper.writeChunk(text);
      if (!res.writableEnded && !res.destroyed) res.end(text);
      return;
    }

    while (true) {
      const { done, value } = await readWithSignal(reader, scope.signal);
      if (done) {
        reachedEof = true;
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      if (dumper) dumper.writeChunk(value);
      await writeWithBackpressure(res, Buffer.from(value), scope.signal);
    }
  } finally {
    if (reader) {
      if (!reachedEof) cancelAndReleaseReader(reader);
      else releaseReader(reader);
    }
    if (dumper) dumper.end();
    scope.cleanup();
  }
}

/**
 * Pipe SSE stream from router, transforming each chunk through a user function.
 * Reads SSE data: lines, parses JSON, calls transformFn(parsed, state),
 * and writes returned SSE strings to the client response.
 *
 * @param {Response} routerRes - Fetch Response from 9Router
 * @param {http.ServerResponse} res - Client response
 * @param {Function} transformFn - (parsedChunk, state) => string|string[]|null
 * @param {object} state - Mutable state object shared across chunks and flush
 */
async function pipeTransformedSSE(routerRes, res, transformFn, state, parentSignal) {
  const ct = routerRes.headers.get("content-type") || "application/json";
  return pipeTransformedStream(routerRes, res, transformFn, state, {
    contentType: ct,
    addNoBufferHeader: ct.includes("text/event-stream"),
  }, parentSignal);
}

/**
 * Pipe SSE stream from router, transforming each chunk through a user function,
 * and writing binary EventStream frames to the client.
 *
 * Reads SSE data: lines, parses JSON, calls transformFn(parsed, state),
 * and writes returned Uint8Array frames to the client response.
 *
 * @param {Response} routerRes - Fetch Response from 9Router
 * @param {http.ServerResponse} res - Client response
 * @param {Function} transformFn - (parsedChunk, state) => Uint8Array|Uint8Array[]|null
 * @param {object} state - Mutable state object shared across chunks and flush
 */
async function pipeTransformedEventStream(routerRes, res, transformFn, state, parentSignal) {
  return pipeTransformedStream(routerRes, res, transformFn, state, {
    contentType: "application/vnd.amazon.eventstream",
    addNoBufferHeader: false,
  }, parentSignal);
}

async function pipeTransformedStream(routerRes, res, transformFn, state, options, parentSignal) {
  const scope = createAbortScope(null, res, parentSignal);
  const resHeaders = {
    "Content-Type": options.contentType,
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };
  if (options.addNoBufferHeader) resHeaders["X-Accel-Buffering"] = "no";

  let reader;
  let reachedEof = false;
  const requireOpenAIStreamContract = routerRes.status >= 200 && routerRes.status < 300;
  const decoder = new TextDecoder("utf-8", { fatal: requireOpenAIStreamContract });
  let buffer = "";
  let validDataEvents = 0;
  let terminalSeen = false;
  let doneMarkerSeen = false;

  const decodeRouterBytes = (value, options) => {
    try {
      return decoder.decode(value, options);
    } catch {
      throw new InvalidRouterStreamError("Router SSE contains invalid UTF-8");
    }
  };

  const writeOutputs = async (result) => {
    if (result == null) return;
    const outputs = Array.isArray(result) ? result : [result];
    for (const output of outputs) {
      if (process.env.DEBUG_MITM) {
        const len = output.length || output.byteLength || 0;
        log(`[write binary frame] (${len}B) first 20B: ${Array.from(output.slice(0, 20)).join(',')}`);
      }
      await writeWithBackpressure(res, Buffer.from(output), scope.signal);
    }
  };

  const processLine = async (line) => {
    if (line.length > MAX_SSE_LINE_CHARS) {
      throw new Error("Router SSE line exceeds maximum size");
    }
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      terminalSeen = true;
      doneMarkerSeen = true;
      return;
    }

    if (process.env.DEBUG_MITM) log(`[SSE in] ${data.slice(0, 200)}`);
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new InvalidRouterStreamError("Router SSE contains malformed JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InvalidRouterStreamError("Router SSE contains an invalid data envelope");
    }
    if (parsed.error) {
      throw new InvalidRouterStreamError("Router SSE reported an error event");
    }

    if (requireOpenAIStreamContract) {
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      const validChoices = choices.filter((choice) => (
        choice
        && typeof choice === "object"
        && (
          (choice.delta && typeof choice.delta === "object" && !Array.isArray(choice.delta))
          || choice.finish_reason != null
        )
      ));
      if (validChoices.length > 0) {
        validDataEvents += 1;
        if (validChoices.some((choice) => choice.finish_reason != null)) {
          terminalSeen = true;
        }
      } else if (!(Array.isArray(parsed.choices) && parsed.choices.length === 0 && parsed.usage)) {
        throw new InvalidRouterStreamError("Router SSE contains an unexpected data event");
      }
    }

    const result = transformFn(parsed, state);
    await writeOutputs(result);
  };

  const processBufferedLines = async (flush = false) => {
    let consumed = 0;
    while (true) {
      const lfIndex = buffer.indexOf("\n", consumed);
      const crIndex = buffer.indexOf("\r", consumed);
      let breakIndex;
      if (lfIndex === -1) breakIndex = crIndex;
      else if (crIndex === -1) breakIndex = lfIndex;
      else breakIndex = Math.min(lfIndex, crIndex);
      if (breakIndex === -1) break;
      if (!flush && buffer[breakIndex] === "\r" && breakIndex === buffer.length - 1) break;

      const line = buffer.slice(consumed, breakIndex);
      const delimiterLength = buffer[breakIndex] === "\r" && buffer[breakIndex + 1] === "\n" ? 2 : 1;
      consumed = breakIndex + delimiterLength;
      await processLine(line);
      if (doneMarkerSeen) break;
    }

    if (consumed > 0) buffer = buffer.slice(consumed);

    if (buffer.length > MAX_SSE_LINE_CHARS) {
      throw new Error("Router SSE line exceeds maximum size");
    }
    if (flush && buffer) {
      const trailingLine = buffer;
      buffer = "";
      await processLine(trailingLine);
    }
  };

  try {
    if (routerRes.body) reader = routerRes.body.getReader();
    throwIfAborted(scope.signal);
    res.writeHead(routerRes.status || 200, resHeaders);
    if (!routerRes.body) {
      if (requireOpenAIStreamContract) {
        throw new InvalidRouterStreamError("Router SSE ended without a response body");
      }
      const text = await routerRes.text().catch(() => "");
      if (!res.writableEnded && !res.destroyed) res.end(text);
      return;
    }

    while (true) {
      const { done, value } = await readWithSignal(reader, scope.signal);
      if (done) {
        reachedEof = true;
        buffer += decodeRouterBytes();
        await processBufferedLines(true);
        break;
      }
      buffer += decodeRouterBytes(value, { stream: true });
      await processBufferedLines();
      if (doneMarkerSeen) break;
    }

    if (requireOpenAIStreamContract) {
      if (validDataEvents === 0) {
        throw new InvalidRouterStreamError("Router SSE ended without a valid response event");
      }
      if (!terminalSeen) {
        throw new InvalidRouterStreamError("Router SSE ended before a terminal event");
      }
    }

    let flushed;
    try {
      flushed = transformFn(null, state);
    } catch (error) {
      throw new InvalidRouterStreamError(`Router SSE transformer flush failed: ${error?.message || error}`);
    }
    await writeOutputs(flushed);
    if (!res.writableEnded && !res.destroyed) res.end();
  } finally {
    if (reader) {
      if (!reachedEof) cancelAndReleaseReader(reader);
      else releaseReader(reader);
    }
    scope.cleanup();
  }
}

module.exports = {
  fetchRouter,
  pipeSSE,
  pipeTransformedSSE,
  pipeTransformedEventStream,
  createBridgeAbortController,
  InvalidRouterStreamError,
};
