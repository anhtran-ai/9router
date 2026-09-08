// Bounded transport and protocol checks for TTS voice-catalog endpoints.
import {
  MAX_TTS_VOICE_LIST_BYTES,
  TTS_VOICE_LIST_STALL_TIMEOUT_MS,
  TTS_VOICE_LIST_TIMEOUT_MS,
} from "../../config/mediaConfig.js";
import {
  UpstreamBodyStallError,
  readUpstreamBodyText,
} from "../../utils/error.js";

export class VoiceListTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Voice-list request timed out after ${timeoutMs}ms`);
    this.name = "VoiceListTimeoutError";
    this.code = "ERR_TTS_VOICE_LIST_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export class VoiceListInvalidResponseError extends Error {
  constructor(message = "Voice-list upstream returned an invalid response") {
    super(message);
    this.name = "VoiceListInvalidResponseError";
    this.code = "ERR_TTS_VOICE_LIST_INVALID_RESPONSE";
  }
}

export class VoiceListUpstreamError extends Error {
  constructor(provider, status) {
    super(`${provider} voices fetch failed: ${status}`);
    this.name = "VoiceListUpstreamError";
    this.code = "ERR_TTS_VOICE_LIST_UPSTREAM";
    this.status = status;
  }
}

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function cancelResponse(response, reason) {
  try {
    const pending = response?.body?.cancel?.(reason);
    pending?.catch?.(() => {});
  } catch {
    // Cleanup must never replace the protocol or timeout error.
  }
}

function createDeadline(callerSignal, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = new VoiceListTimeoutError(timeoutMs);
  const onCallerAbort = () => controller.abort(
    callerSignal?.reason instanceof Error
      ? callerSignal.reason
      : new DOMException("Request aborted", "AbortError"),
  );

  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener?.("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.("abort", onCallerAbort);
    },
  };
}

function awaitWithSignal(value, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      callback(result);
    };
    const onAbort = () => finish(
      reject,
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("Request aborted", "AbortError"),
    );

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      result => finish(resolve, result),
      error => finish(reject, error),
    );
  });
}

function isJsonContentType(response) {
  const mediaType = String(response?.headers?.get?.("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export function assertVoiceListSuccessEnvelope(data, provider = "TTS") {
  const failedStatus = typeof data?.status === "string" &&
    ["error", "failed", "failure", "cancelled", "canceled", "expired"]
      .includes(data.status.trim().toLowerCase());
  if (data?.error != null || data?.errors != null || data?.success === false || failedStatus) {
    throw new VoiceListInvalidResponseError(
      `${provider} voice-list upstream returned an error envelope with HTTP 200`,
    );
  }
}

/**
 * Fetch and parse one JSON voice catalog. The absolute deadline covers both
 * response headers and the complete bounded body. A fetch implementation that
 * ignores AbortSignal cannot keep the caller pending because the wait itself is
 * raced against the same signal; its eventual settlement remains observed.
 */
export async function fetchVoiceListJson(
  url,
  init = {},
  {
    signal: callerSignal = init.signal || null,
    timeoutMs = TTS_VOICE_LIST_TIMEOUT_MS,
    stallTimeoutMs = TTS_VOICE_LIST_STALL_TIMEOUT_MS,
    maxBytes = MAX_TTS_VOICE_LIST_BYTES,
    expectedRoot = "object",
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const deadlineMs = positiveLimit(timeoutMs, TTS_VOICE_LIST_TIMEOUT_MS);
  const bodyStallMs = positiveLimit(stallTimeoutMs, TTS_VOICE_LIST_STALL_TIMEOUT_MS);
  const byteLimit = positiveLimit(maxBytes, MAX_TTS_VOICE_LIST_BYTES);
  const deadline = createDeadline(callerSignal, deadlineMs);
  let response = null;

  try {
    if (typeof fetchImpl !== "function") throw new TypeError("fetch is not available");
    let pendingFetch;
    try {
      pendingFetch = fetchImpl(url, { ...init, signal: deadline.signal });
    } catch (error) {
      throw error;
    }
    response = await awaitWithSignal(pendingFetch, deadline.signal);
    if (!isJsonContentType(response)) {
      const error = new VoiceListInvalidResponseError(
        "Voice-list upstream returned a non-JSON content type",
      );
      cancelResponse(response, error);
      throw error;
    }

    const text = await readUpstreamBodyText(response, {
      signal: deadline.signal,
      maxBytes: byteLimit,
      stallTimeoutMs: bodyStallMs,
      fatalUtf8: true,
    });
    if (!text.trim()) {
      throw new VoiceListInvalidResponseError("Voice-list upstream returned an empty JSON response");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new VoiceListInvalidResponseError("Voice-list upstream returned malformed JSON");
    }
    const isObject = data !== null && typeof data === "object";
    const validRoot = expectedRoot === "array"
      ? Array.isArray(data)
      : isObject && !Array.isArray(data);
    if (!validRoot) {
      throw new VoiceListInvalidResponseError(
        `Voice-list upstream returned an invalid JSON ${expectedRoot}`,
      );
    }
    return { response, data };
  } catch (error) {
    if (deadline.signal.aborted && deadline.signal.reason instanceof VoiceListTimeoutError) {
      cancelResponse(response, deadline.signal.reason);
      throw deadline.signal.reason;
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

export function voiceListErrorStatus(error) {
  return error instanceof VoiceListTimeoutError || error instanceof UpstreamBodyStallError
    ? 504
    : 502;
}
