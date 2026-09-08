const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;

class MitmBodyReadError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = "MitmBodyReadError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function declaredContentLength(req) {
  const raw = req?.headers?.["content-length"];
  if (raw === undefined) return null;
  if (Array.isArray(raw) || !/^\d+$/.test(String(raw))) {
    throw new MitmBodyReadError("Invalid Content-Length", "MITM_BODY_INVALID_LENGTH", 400);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new MitmBodyReadError("Invalid Content-Length", "MITM_BODY_INVALID_LENGTH", 400);
  }
  return parsed;
}

function collectBodyRaw(req, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_BODY_TIMEOUT_MS;

  let declared;
  try {
    declared = declaredContentLength(req);
  } catch (error) {
    return Promise.reject(error);
  }
  if (declared !== null && declared > maxBytes) {
    return Promise.reject(new MitmBodyReadError(
      `Request body exceeds ${maxBytes} bytes`,
      "MITM_BODY_TOO_LARGE",
      413,
    ));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new MitmBodyReadError(
        `Request body did not complete within ${timeoutMs}ms`,
        "MITM_BODY_TIMEOUT",
        408,
      ));
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.pause?.();
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length > maxBytes - total) {
        fail(new MitmBodyReadError(
          `Request body exceeds ${maxBytes} bytes`,
          "MITM_BODY_TOO_LARGE",
          413,
        ));
        return;
      }
      chunks.push(buffer);
      total += buffer.length;
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(new MitmBodyReadError(
      "Request body aborted",
      "MITM_BODY_ABORTED",
      400,
    ));

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

module.exports = {
  collectBodyRaw,
  MitmBodyReadError,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_BODY_TIMEOUT_MS,
};
