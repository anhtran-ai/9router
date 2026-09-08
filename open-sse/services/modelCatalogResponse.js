import { awaitWithSignal } from "../utils/abort.js";

const DEFAULT_MODEL_CATALOG_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export class ModelCatalogBodyTooLargeError extends Error {
  constructor(maxBytes, actualBytes = null) {
    const detail = Number.isFinite(actualBytes) ? ` (${actualBytes} bytes)` : "";
    super(`Model catalog response exceeds the ${maxBytes}-byte limit${detail}`);
    this.name = "ModelCatalogBodyTooLargeError";
    this.code = "ERR_MODEL_CATALOG_BODY_TOO_LARGE";
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const message = signal?.reason == null ? "Model catalog request aborted" : String(signal.reason);
  return new DOMException(message, "AbortError");
}

function cancelBody(body, reason) {
  try {
    const cancellation = body?.cancel?.(reason);
    cancellation?.catch?.(() => {});
  } catch {
    // Best-effort transport cleanup. Preserve the primary body error.
  }
}

export function cancelModelCatalogBody(response, reason) {
  cancelBody(response?.body, reason);
}

function declaredBodyLength(response) {
  const raw = response?.headers?.get?.("content-length");
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

/**
 * Consume a model-catalog response without response.clone()/tee(). The caller's
 * transport AbortSignal remains authoritative for both header and body time.
 */
export async function readModelCatalogText(
  response,
  {
    signal = null,
    maxBytes = DEFAULT_MODEL_CATALOG_BODY_LIMIT_BYTES,
    fatalUtf8 = false,
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }

  const declaredLength = declaredBodyLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = new ModelCatalogBodyTooLargeError(maxBytes, declaredLength);
    cancelBody(response?.body, error);
    throw error;
  }

  if (signal?.aborted) {
    const error = abortReason(signal);
    cancelBody(response?.body, error);
    throw error;
  }

  const body = response?.body;
  if (!body) return "";
  if (typeof body.getReader !== "function") {
    const error = new TypeError("Model catalog response body is not a readable stream");
    cancelBody(body, error);
    throw error;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: fatalUtf8 });
  let text = "";
  let totalBytes = 0;
  let completed = false;
  let abortListener = null;
  let abortPromise = null;

  try {
    if (signal) {
      abortPromise = new Promise((_, reject) => {
        abortListener = () => reject(abortReason(signal));
        if (signal.aborted) abortListener();
        else signal.addEventListener("abort", abortListener, { once: true });
      });
    }

    while (true) {
      const result = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      if (result.done) {
        completed = true;
        break;
      }

      const chunk = result.value instanceof Uint8Array
        ? result.value
        : new Uint8Array(result.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        throw new ModelCatalogBodyTooLargeError(maxBytes, totalBytes);
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (!completed) {
      let cancellation = null;
      try {
        cancellation = Promise.resolve(reader.cancel(error)).catch(() => {});
      } catch {
        // Preserve the primary timeout, abort, transport, or size error.
      }
      const release = () => {
        try { reader.releaseLock(); } catch { /* pending read or already released */ }
      };
      cancellation?.finally(release);
    }
    throw error;
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    try {
      reader.releaseLock();
    } catch {
      // A broken transport may still own a pending read. Cancellation above is
      // best-effort; never replace the primary failure with cleanup failure.
    }
  }
}

export async function readModelCatalogJson(response, options) {
  return JSON.parse(await readModelCatalogText(response, {
    ...(options || {}),
    fatalUtf8: true,
  }));
}

/**
 * Bound a token refresh triggered while loading a live model catalog. Token
 * refreshes are deduplicated, so aborting one catalog caller must only stop
 * that caller's wait; the shared refresh may still serve another caller. The
 * promise remains observed after cancellation to avoid a late unhandled
 * rejection from an abort-ignoring refresh implementation.
 */
export async function runModelCatalogRefresh(
  refresh,
  { signal = null, timeoutMs, label = "Model catalog token refresh" } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`${label} timed out`, "TimeoutError")),
    timeoutMs,
  );
  let abortListener = null;
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else {
      abortListener = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  // Invoke asynchronously so an already-aborted caller cannot start refresh
  // I/O. awaitWithSignal keeps observing a late rejection after the wait ends.
  const operation = Promise.resolve().then(() => {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new DOMException("Request aborted", "AbortError");
    }
    return refresh(controller.signal);
  });

  try {
    return await awaitWithSignal(operation, controller.signal);
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export const MODEL_CATALOG_BODY_LIMIT_BYTES = DEFAULT_MODEL_CATALOG_BODY_LIMIT_BYTES;
