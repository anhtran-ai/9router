export class RequestBodyError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

function bodyError(status, label, detail) {
  return new RequestBodyError(status, `${label} ${detail}`);
}

function readChunk(reader, signal, stallMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, bodyError(499, label, "was aborted"));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => finish(reject, bodyError(408, label, "timed out")),
      stallMs,
    );
    timer.unref?.();
    let read;
    try {
      read = reader.read();
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(read).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function cancelBody(body, reason) {
  try {
    const pending = body?.cancel(reason);
    Promise.resolve(pending).catch(() => {});
  } catch { /* best effort */ }
}

/**
 * Read a request body once with a byte cap, per-chunk stall deadline, abort
 * propagation and deterministic reader cleanup. This avoids Request.clone()
 * tee branches retaining an unbounded payload when only one branch advances.
 */
export async function readRequestBodyBytes(
  request,
  {
    maxBytes,
    stallMs = 15_000,
    label = "Request body",
    requireBody = false,
  } = {},
) {
  const limit = Number(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError("readRequestBodyBytes requires a positive maxBytes limit");
  }
  const stall = Number(stallMs);
  if (!Number.isFinite(stall) || stall <= 0) {
    throw new TypeError("readRequestBodyBytes requires a positive stallMs limit");
  }

  const declaredValue = request.headers.get("content-length");
  const normalizedDeclared = declaredValue?.trim?.() || "";
  const declared = /^\d+$/.test(normalizedDeclared) ? Number(normalizedDeclared) : null;
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > limit)) {
    const error = bodyError(413, label, `exceeds the ${limit} byte limit`);
    cancelBody(request.body, error);
    throw error;
  }
  if (!request.body) {
    if (requireBody) throw bodyError(400, label, "is required");
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  let reachedEnd = false;
  let terminalError = null;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, request.signal, stall, label);
      if (done) {
        reachedEnd = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw bodyError(400, label, "contains an invalid stream chunk");
      }
      total += value.byteLength;
      if (total > limit) {
        throw bodyError(413, label, `exceeds the ${limit} byte limit`);
      }
      if (value.byteLength) chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    terminalError = error;
    throw error;
  } finally {
    let cancellation = null;
    if (!reachedEnd) {
      try {
        cancellation = Promise.resolve(reader.cancel(terminalError)).catch(() => {});
      } catch { /* best effort */ }
    }
    const release = () => {
      try { reader.releaseLock(); } catch { /* pending read or already released */ }
    };
    release();
    cancellation?.finally(release);
  }
}

export async function readRequestJson(request, options) {
  const bytes = await readRequestBodyBytes(request, options);
  // JSON is UTF-8 on these HTTP endpoints. Replacement decoding can turn an
  // invalid wire payload into different, syntactically valid application data.
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
