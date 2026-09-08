const XAI_OAUTH_REQUEST_TIMEOUT_MS = 15_000;
export const XAI_OAUTH_MAX_RESPONSE_BYTES = 256 * 1024;

class XaiOAuthBodyTooLargeError extends Error {
  constructor(actualBytes = null) {
    const suffix = Number.isFinite(actualBytes) ? ` (${actualBytes} bytes)` : "";
    super(`xAI OAuth response exceeds ${XAI_OAUTH_MAX_RESPONSE_BYTES} bytes${suffix}`);
    this.name = "XaiOAuthBodyTooLargeError";
    this.code = "ERR_XAI_OAUTH_BODY_TOO_LARGE";
  }
}

function signalError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("xAI OAuth request aborted", "AbortError");
}

function awaitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signalError(signal));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

function cancelBody(body, reason) {
  try {
    const cancellation = body?.cancel?.(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch {
    // Best-effort transport cleanup must not replace the primary failure.
  }
}

function releaseReader(reader) {
  try { reader?.releaseLock?.(); } catch { /* pending read or already released */ }
}

function declaredLength(response) {
  const raw = response?.headers?.get?.("content-length");
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}

async function readBoundedBytes(response, signal) {
  const declared = declaredLength(response);
  if (declared !== null && declared > XAI_OAUTH_MAX_RESPONSE_BYTES) {
    const error = new XaiOAuthBodyTooLargeError(declared);
    cancelBody(response?.body, error);
    throw error;
  }
  if (signal?.aborted) {
    const error = signalError(signal);
    cancelBody(response?.body, error);
    throw error;
  }

  if (!response?.body?.getReader) {
    let bytes;
    if (typeof response?.arrayBuffer === "function") {
      bytes = new Uint8Array(await awaitWithSignal(response.arrayBuffer(), signal));
    } else if (typeof response?.text === "function") {
      bytes = new TextEncoder().encode(await awaitWithSignal(response.text(), signal));
    } else if (typeof response?.json === "function") {
      const value = await awaitWithSignal(response.json(), signal);
      bytes = new TextEncoder().encode(JSON.stringify(value));
    } else {
      throw new TypeError("xAI OAuth response body is not readable");
    }
    if (bytes.byteLength > XAI_OAUTH_MAX_RESPONSE_BYTES) {
      throw new XaiOAuthBodyTooLargeError(bytes.byteLength);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let completed = false;
  let terminalError = null;
  try {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new TypeError("xAI OAuth response returned an invalid stream chunk");
      }
      totalBytes += value.byteLength;
      if (totalBytes > XAI_OAUTH_MAX_RESPONSE_BYTES) {
        throw new XaiOAuthBodyTooLargeError(totalBytes);
      }
      if (value.byteLength) chunks.push(value);
    }
  } catch (error) {
    terminalError = error;
    throw error;
  } finally {
    let cancellation = null;
    if (!completed) {
      try { cancellation = Promise.resolve(reader.cancel(terminalError)).catch(() => {}); }
      catch { /* preserve the primary body failure */ }
    }
    releaseReader(reader);
    cancellation?.finally(() => releaseReader(reader));
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function timeoutError(label) {
  return new DOMException(`${label} timed out`, "TimeoutError");
}

async function withDeadline(label, outerSignal, operation) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(timeoutError(label)),
    XAI_OAUTH_REQUEST_TIMEOUT_MS,
  );
  timer.unref?.();
  let outerAbort = null;
  if (outerSignal) {
    outerAbort = () => controller.abort(outerSignal.reason);
    if (outerSignal.aborted) outerAbort();
    else outerSignal.addEventListener("abort", outerAbort, { once: true });
  }

  const pending = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await awaitWithSignal(pending, controller.signal);
  } finally {
    clearTimeout(timer);
    if (outerSignal && outerAbort) outerSignal.removeEventListener("abort", outerAbort);
  }
}

/**
 * Fetch and consume an xAI OAuth JSON response under one absolute deadline.
 * Error bodies are bounded and parsed only for internal classification; callers
 * must not echo their contents because providers can reflect credentials.
 */
export async function requestXaiOAuthJson(url, init = {}, {
  label = "xAI OAuth request",
  signal = null,
} = {}) {
  return withDeadline(label, signal, async (requestSignal) => {
    let response;
    const fetchPromise = Promise.resolve().then(() => fetch(url, {
      ...init,
      signal: requestSignal,
    }));
    fetchPromise.then(
      lateResponse => {
        if (requestSignal.aborted) cancelBody(lateResponse?.body, requestSignal.reason);
      },
      () => {},
    );

    try {
      response = await awaitWithSignal(fetchPromise, requestSignal);
      const bytes = await readBoundedBytes(response, requestSignal);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (error) {
        if (response.ok) {
          throw new SyntaxError(`${label} returned malformed JSON`, { cause: error });
        }
      }
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      if (requestSignal.aborted) cancelBody(response?.body, requestSignal.reason);
      throw error;
    }
  });
}
