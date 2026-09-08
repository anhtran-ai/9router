import {
  createErrorResult,
  readUpstreamBodyText,
  UpstreamBodyStallError,
  UpstreamBodyTooLargeError,
} from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { refreshTokenByProvider } from "../services/tokenRefresh.js";
import { PROVIDER_MEDIA } from "../providers/index.js";
import { awaitWithSignal } from "../utils/abort.js";

// Upstream fetch deadline for video job submission/polling (the job itself is
// async upstream — this only bounds the HTTP round-trip, not video rendering).
function positiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const VIDEO_FETCH_TIMEOUT_MS = positiveIntegerEnv("VIDEO_FETCH_TIMEOUT_MS", 120_000);
const VIDEO_BODY_STALL_TIMEOUT_MS = positiveIntegerEnv("VIDEO_BODY_STALL_TIMEOUT_MS", 30_000);
const MAX_VIDEO_RESPONSE_BYTES = positiveIntegerEnv("MAX_VIDEO_RESPONSE_BYTES", 1024 * 1024);
const VALID_POLL_STATUSES = new Set(["pending", "processing", "done", "failed", "expired"]);

// POST /videos/* creates a billable upstream job. A network error after the
// request left the socket may still have created the job, so creation is NEVER
// auto-retried (the only re-send is the auth retry after a 401/403 refresh,
// which upstream rejects before job creation).
export const VIDEO_ACTIONS = new Set(["generations", "edits", "extensions"]);

export function getVideoConfig(provider) {
  return PROVIDER_MEDIA[provider]?.videoConfig || null;
}

/** Strip bearer tokens / obvious secrets from text destined for clients or logs. */
export function sanitizeSecrets(text, credentials = null) {
  if (!text) return text;
  let out = String(text).replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  for (const key of ["accessToken", "refreshToken", "apiKey"]) {
    const secret = credentials?.[key];
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

function buildUpstreamUrl(config, action, requestId) {
  const base = config.baseUrl.replace(/\/$/, "");
  return requestId ? `${base}/${encodeURIComponent(requestId)}` : `${base}/${action}`;
}

function buildHeaders({ token, contentType, idempotencyKey }) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (contentType) headers["Content-Type"] = contentType;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return headers;
}

function combineSignals(signal, timeoutMs) {
  const timeoutSignal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : null;
  if (signal && timeoutSignal && typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal || timeoutSignal || undefined;
}

function cancelBody(body, reason) {
  try {
    const pending = body?.cancel?.(reason);
    Promise.resolve(pending).catch(() => {});
  } catch {
    // Cleanup must never replace the response or cancellation error.
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isValidVideoRequestId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function isValidErrorShape(error) {
  if (typeof error === "string") return error.trim().length > 0;
  if (!isPlainObject(error)) return false;
  const codeValid = error.code === undefined || (typeof error.code === "string" && error.code.trim().length > 0);
  const messageValid = error.message === undefined || (typeof error.message === "string" && error.message.trim().length > 0);
  return codeValid && messageValid && (error.code !== undefined || error.message !== undefined);
}

function isValidVideoUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validateVideoPayload(body, { requestId }) {
  if (!isPlainObject(body)) return "response must be a JSON object";

  if (!requestId) {
    if (body.error !== undefined) return "creation response contains an error";
    if (body.success === false) return "creation response reports failure";
    if (typeof body.status === "string" &&
        ["error", "failed", "expired", "cancelled", "canceled"].includes(body.status.toLowerCase())) {
      return "creation response contains a terminal failure status";
    }
    const hasRequestId = body.request_id !== undefined;
    const hasAlternateId = body.id !== undefined;
    if (!hasRequestId && !hasAlternateId) {
      return "creation response is missing a valid request_id or id";
    }
    if (hasRequestId && !isValidVideoRequestId(body.request_id)) {
      return "creation response contains an invalid request_id";
    }
    if (hasAlternateId && !isValidVideoRequestId(body.id)) {
      return "creation response contains an invalid id";
    }
    if (hasRequestId && hasAlternateId && body.request_id !== body.id) {
      return "creation response contains conflicting request identifiers";
    }
    return null;
  }

  if (typeof body.status !== "string" || !VALID_POLL_STATUSES.has(body.status)) {
    return "poll response contains an unknown status";
  }
  if (body.success !== undefined && typeof body.success !== "boolean") {
    return "poll response contains an invalid success flag";
  }
  const failedStatus = body.status === "failed" || body.status === "expired";
  if ((body.success === false && !failedStatus) || (body.success === true && failedStatus)) {
    return "poll response contains a contradictory success flag";
  }
  if (body.status === "done") {
    if (body.error !== undefined) return "completed poll response contains an error";
    if (!isPlainObject(body.video) || !isValidVideoUrl(body.video.url)) {
      return "completed poll response is missing a valid HTTPS video URL";
    }
  } else if (body.status === "failed") {
    if (!isValidErrorShape(body.error)) return "failed poll response is missing a valid error";
  } else if (body.status === "expired") {
    if (body.error !== undefined && !isValidErrorShape(body.error)) {
      return "expired poll response contains an invalid error";
    }
  } else if (body.error !== undefined) {
    return "non-terminal poll response contains an error";
  }
  return null;
}

function upstreamErrorMessage(bodyText, status) {
  try {
    const parsed = JSON.parse(bodyText);
    const value = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof value === "string" && value.trim()) return value;
  } catch {
    // A bounded plain-text upstream error is still useful to the operator.
  }
  return bodyText.trim() || `HTTP ${status}`;
}

function operationFailure(error, { provider, method, credentials, callerSignal, operationSignal }) {
  if (callerSignal?.aborted) {
    return createErrorResult(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  }
  if (error instanceof UpstreamBodyTooLargeError) {
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      sanitizeSecrets(`[${provider}] video response exceeds ${error.maxBytes} bytes`, credentials),
      undefined,
      "invalid_upstream_response",
    );
  }
  if (operationSignal?.aborted || error instanceof UpstreamBodyStallError || error?.name === "TimeoutError") {
    return createErrorResult(
      HTTP_STATUS.GATEWAY_TIMEOUT,
      `[${provider}] video ${method} timed out`,
      undefined,
      "video_upstream_timeout",
    );
  }
  return createErrorResult(
    HTTP_STATUS.BAD_GATEWAY,
    sanitizeSecrets(`[${provider}] video upstream response was interrupted or invalid`, credentials),
    undefined,
    "invalid_upstream_response",
  );
}

/**
 * Transparent proxy for async video jobs (xAI Grok Imagine shape).
 *
 * - Forwards the raw body byte-for-byte (JSON or multipart) — no reshaping.
 * - Passes upstream JSON (request_id, status, video.url, error) back verbatim.
 * - 401/403 with a refresh token: refresh ONCE, retry ONCE. No other retry.
 * - Upstream error text is sanitized before it reaches the client.
 *
 * @param {object} options
 * @param {string} options.provider - Provider id (must have registry videoConfig)
 * @param {"generations"|"edits"|"extensions"|null} options.action - Creation action (POST)
 * @param {string|null} [options.requestId] - Poll target (GET /videos/{id})
 * @param {Buffer|string|null} [options.rawBody] - Exact body to forward
 * @param {string|null} [options.contentType] - Original Content-Type header
 * @param {string|null} [options.idempotencyKey] - Forwarded Idempotency-Key
 * @param {object} options.credentials - { accessToken?, apiKey?, refreshToken?, authType? }
 * @param {AbortSignal} [options.signal] - Client cancellation signal
 * @param {number} [options.timeoutMs]
 * @param {number} [options.bodyStallTimeoutMs]
 * @param {number} [options.maxResponseBytes]
 * @param {object} [options.log]
 * @param {function} [options.onCredentialsRefreshed]
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleVideoProxyCore({
  provider,
  action = null,
  requestId = null,
  rawBody = null,
  contentType = null,
  idempotencyKey = null,
  credentials,
  signal,
  timeoutMs = VIDEO_FETCH_TIMEOUT_MS,
  bodyStallTimeoutMs = VIDEO_BODY_STALL_TIMEOUT_MS,
  maxResponseBytes = MAX_VIDEO_RESPONSE_BYTES,
  log,
  onCredentialsRefreshed,
}) {
  const config = getVideoConfig(provider);
  if (!config) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support video generation`);
  }
  if (!requestId && !VIDEO_ACTIONS.has(action)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Unknown video action: ${action}`);
  }
  if (requestId && !isValidVideoRequestId(requestId)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Invalid video request id");
  }
  if (signal?.aborted) {
    return createErrorResult(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  }

  const method = requestId ? "GET" : "POST";
  const url = buildUpstreamUrl(config, action, requestId);
  const fetchSignal = combineSignals(signal, timeoutMs);

  const doFetch = (token) =>
    fetch(url, {
      method,
      headers: buildHeaders({ token, contentType: method === "POST" ? contentType : null, idempotencyKey: method === "POST" ? idempotencyKey : null }),
      body: method === "POST" ? rawBody : undefined,
      signal: fetchSignal,
    });

  let upstream;
  try {
    upstream = await doFetch(credentials?.accessToken || credentials?.apiKey);
  } catch (error) {
    // Never re-send a creation POST on network error — the job may already exist upstream.
    return operationFailure(error, { provider, method, credentials, callerSignal: signal, operationSignal: fetchSignal });
  }

  // 401/403 → refresh once → retry once (OAuth accounts only; API keys can't refresh)
  if (
    (upstream.status === HTTP_STATUS.UNAUTHORIZED || upstream.status === HTTP_STATUS.FORBIDDEN) &&
    credentials?.refreshToken
  ) {
    if (signal?.aborted) {
      cancelBody(upstream.body, signal.reason);
      return createErrorResult(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    }
    let refreshed = null;
    try {
      refreshed = await awaitWithSignal(refreshTokenByProvider(provider, credentials, log), fetchSignal);
    } catch (error) {
      if (signal?.aborted || fetchSignal?.aborted) {
        cancelBody(upstream.body, error);
        return operationFailure(error, { provider, method, credentials, callerSignal: signal, operationSignal: fetchSignal });
      }
      log?.warn?.("TOKEN", `${provider} | video refresh error: ${sanitizeSecrets(error.message, credentials)}`);
    }
    if (refreshed?.accessToken) {
      if (signal?.aborted || fetchSignal?.aborted) {
        cancelBody(upstream.body, signal?.reason || fetchSignal?.reason);
        return operationFailure(fetchSignal?.reason, { provider, method, credentials, callerSignal: signal, operationSignal: fetchSignal });
      }
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for video ${method}`);
      Object.assign(credentials, refreshed);
      if (onCredentialsRefreshed) {
        try {
          await awaitWithSignal(onCredentialsRefreshed(refreshed), fetchSignal);
        } catch (error) {
          cancelBody(upstream.body, error);
          return operationFailure(error, { provider, method, credentials, callerSignal: signal, operationSignal: fetchSignal });
        }
      }
      cancelBody(upstream.body);
      try {
        upstream = await doFetch(credentials.accessToken || credentials.apiKey);
      } catch (error) {
        return operationFailure(error, { provider, method, credentials, callerSignal: signal, operationSignal: fetchSignal });
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | video refresh failed — account needs re-auth`);
    }
  }

  let bodyText;
  try {
    bodyText = await readUpstreamBodyText(upstream, {
      signal: fetchSignal,
      maxBytes: maxResponseBytes,
      stallTimeoutMs: Math.min(bodyStallTimeoutMs, timeoutMs),
      fatalUtf8: upstream.ok,
    });
  } catch (error) {
    return operationFailure(error, { provider, method, credentials, callerSignal: signal, operationSignal: fetchSignal });
  }

  if (!upstream.ok) {
    const message = sanitizeSecrets(upstreamErrorMessage(bodyText, upstream.status), credentials);
    return createErrorResult(upstream.status, `[${provider}] ${message.slice(0, 2000)}`);
  }

  const mediaType = String(upstream.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType && mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      `[${provider}] invalid video response content type`,
      undefined,
      "invalid_upstream_response",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      `[${provider}] invalid or empty video JSON response`,
      undefined,
      "invalid_upstream_response",
    );
  }
  const contractError = validateVideoPayload(parsed, { requestId });
  if (contractError) {
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      `[${provider}] invalid video response: ${contractError}`,
      undefined,
      "invalid_upstream_response",
    );
  }

  // Success: pass the validated upstream JSON through untouched.
  return {
    success: true,
    response: new Response(bodyText, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
