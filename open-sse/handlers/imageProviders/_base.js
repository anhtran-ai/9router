// Shared helpers for image provider adapters
import { fetchImageAsBase64 } from "../../translator/concerns/image.js";
import { awaitWithSignal, throwIfAborted, waitWithSignal } from "../../utils/abort.js";
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  MAX_IMAGE_RESPONSE_BYTES,
} from "../../config/mediaConfig.js";

export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 120000;

export const sleep = (ms, signal) => waitWithSignal(ms, signal);

function operationError(status, message, name) {
  const error = new Error(message);
  error.name = name;
  error.status = status;
  return error;
}

export function imageClientAbortError() {
  return operationError(499, "Request aborted", "AbortError");
}

export function imageTimeoutError() {
  return operationError(504, "Image generation timed out", "TimeoutError");
}

/**
 * One lifecycle controller for submit, polling, body reads and an optional
 * downstream SSE response. `finish()` must be called by the lifecycle owner.
 */
export function createImageOperation(signal, timeoutMs = IMAGE_GENERATION_TIMEOUT_MS) {
  const controller = new AbortController();
  const duration = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : IMAGE_GENERATION_TIMEOUT_MS;
  let finished = false;

  const abort = (reason = imageClientAbortError()) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onCallerAbort = () => {
    const reason = signal?.reason;
    abort(reason?.name === "TimeoutError" || reason?.status === 504
      ? imageTimeoutError()
      : imageClientAbortError());
  };
  if (signal?.aborted) onCallerAbort();
  else signal?.addEventListener("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => abort(imageTimeoutError()), duration);
  timer.unref?.();

  return {
    signal: controller.signal,
    abort,
    finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function cancelResponseBody(response, reason) {
  try {
    const pending = response?.body?.cancel(reason);
    Promise.resolve(pending).catch(() => {});
  } catch { /* best effort */ }
}

/** Fetch that settles on abort even when a test double ignores AbortSignal. */
export async function fetchWithSignal(url, init = {}, signal) {
  throwIfAborted(signal);
  const pending = Promise.resolve()
    .then(() => fetch(url, { ...init, ...(signal ? { signal } : {}) }))
    .then((response) => {
      if (signal?.aborted) {
        void cancelResponseBody(response, signal.reason);
        throw signal.reason ?? imageClientAbortError();
      }
      return response;
    });
  return await awaitWithSignal(pending, signal);
}

export async function readResponseBytes(
  response,
  { signal, maxBytes = MAX_IMAGE_RESPONSE_BYTES } = {},
) {
  throwIfAborted(signal);
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(`Image provider response exceeds ${maxBytes} byte limit`);
  }
  if (!response?.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let reachedEnd = false;
  try {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) {
        reachedEnd = true;
        break;
      }
      total += value?.byteLength || 0;
      if (total > maxBytes) {
        throw new Error(`Image provider response exceeds ${maxBytes} byte limit`);
      }
      if (value?.byteLength) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    let cancellation = null;
    if (!reachedEnd) {
      try { cancellation = Promise.resolve(reader.cancel(signal?.reason)).catch(() => {}); } catch { /* best effort */ }
    }
    const release = () => {
      try { reader.releaseLock(); } catch { /* pending read or already released */ }
    };
    release();
    // Some stream implementations settle the pending read only after cancel().
    // Retry release then without making request completion depend on cancel().
    cancellation?.finally(release);
  }
}

export async function readResponseText(response, options = {}) {
  const bytes = await readResponseBytes(response, options);
  return new TextDecoder().decode(bytes);
}

export async function readJsonResponse(response, options = {}) {
  const bytes = await readResponseBytes(response, options);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

// Async providers may return poll/result URLs. Restrict those server-provided
// URLs to the configured HTTPS origin before attaching provider credentials.
export function requireProviderUrl(value, configuredBaseUrl, label = "provider URL") {
  let candidate;
  let configured;
  try {
    candidate = new URL(value);
    configured = new URL(configuredBaseUrl);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (candidate.protocol !== "https:" || candidate.origin !== configured.origin) {
    throw new Error(`Untrusted ${label}`);
  }
  return candidate.href;
}

// Map OpenAI size to provider-specific aspect ratio
export function sizeToAspectRatio(size) {
  if (!size || typeof size !== "string") return "1:1";
  const map = {
    "1024x1024": "1:1",
    "1024x1792": "9:16",
    "1792x1024": "16:9",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
  };
  return map[size] || "1:1";
}

// Fetch URL → base64 (for request images and providers returning image URLs).
// Reuse the central remote-image boundary so these secondary fetches cannot
// reach loopback/metadata services, follow redirects, or buffer an unbounded
// response merely because a provider returned (or a caller supplied) a URL.
export async function urlToBase64(url, options = {}) {
  const fetched = await awaitWithSignal(fetchImageAsBase64(url, options), options.signal);
  if (!fetched?.url) throw new Error("Failed to fetch a safe image payload");
  const separator = fetched.url.indexOf(",");
  if (separator < 0) throw new Error("Failed to decode fetched image payload");
  return fetched.url.slice(separator + 1);
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
