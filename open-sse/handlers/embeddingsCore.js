import {
  createErrorResult,
  parseUpstreamError,
  formatProviderError,
  readUpstreamBodyText,
} from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { getExecutor } from "../executors/index.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { getEmbeddingAdapter } from "./embeddingProviders/index.js";

const DEFAULT_EMBEDDINGS_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_EMBEDDINGS_BODY_STALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_EMBEDDINGS_RESPONSE_BYTES = 64 * 1024 * 1024;

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createFullResponseDeadline(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = new DOMException("Embeddings upstream request timed out", "TimeoutError");
  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason ?? new DOMException("Request aborted", "AbortError"));
  };

  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener?.("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.("abort", onCallerAbort);
    },
  };
}

function abortedResult(error, callerSignal, deadline, provider, model) {
  if (callerSignal?.aborted) {
    return createErrorResult(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  }
  if (deadline.didTimeOut()) {
    return createErrorResult(
      HTTP_STATUS.GATEWAY_TIMEOUT,
      `[${provider}/${model}] Embeddings upstream request timed out`,
    );
  }
  const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
  return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
}

function cancelResponseBody(response, reason) {
  try {
    Promise.resolve(response?.body?.cancel?.(reason)).catch(() => {});
  } catch {
    // Best-effort transport cleanup; preserve the primary result.
  }
}

function isCanonicalBase64(value) {
  return typeof value === "string" && value.length > 0 && value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function validateNormalizedEmbeddings(normalized, raw, input, encodingFormat) {
  if (raw?.error) throw new TypeError("Provider returned an error envelope with HTTP 200");
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError("Embeddings response must be an object");
  }
  if (normalized.object !== "list" || !Array.isArray(normalized.data)) {
    throw new TypeError("Embeddings response must contain an object=list data array");
  }

  const expectedCount = Array.isArray(input) ? input.length : 1;
  if (normalized.data.length === 0 || normalized.data.length !== expectedCount) {
    throw new TypeError("Embeddings response count does not match the request input count");
  }

  const acceptsBase64 = encodingFormat === "base64";
  for (const item of normalized.data) {
    const embedding = item?.embedding;
    if (acceptsBase64 && isCanonicalBase64(embedding)) continue;
    if (!Array.isArray(embedding) || embedding.length === 0 ||
        embedding.some(value => typeof value !== "number" || !Number.isFinite(value))) {
      throw new TypeError("Each embedding must be a non-empty finite numeric vector");
    }
  }
}

/**
 * Core embeddings handler — orchestrator only. Provider-specific URL/headers/body/normalize
 * live in `./embeddingProviders/{id}.js`.
 *
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleEmbeddingsCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
  signal: callerSignal = null,
  requestTimeoutMs = DEFAULT_EMBEDDINGS_RESPONSE_TIMEOUT_MS,
  responseStallTimeoutMs = DEFAULT_EMBEDDINGS_BODY_STALL_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_EMBEDDINGS_RESPONSE_BYTES,
}) {
  const { provider, model } = modelInfo;

  // Validate input
  const input = body.input;
  if (!input) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }
  if (typeof input !== "string" && !Array.isArray(input)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "input must be a string or array of strings");
  }
  if (Array.isArray(input) && (input.length === 0 || input.some(value => typeof value !== "string"))) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "input must be a non-empty array of strings");
  }

  const adapter = getEmbeddingAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support embeddings.`
    );
  }

  const ctx = { input };
  // buildUrl/buildHeaders/buildBody were called bare. An adapter that rejects a
  // misconfigured connection — selfhosted-embedding throws when no baseUrl is set
  // rather than silently falling back to api.openai.com — would have escaped this
  // function uncaught, surfacing as a 500 or a request that never settles. A
  // configuration mistake is a 400 with the reason in it.
  let url, headers, requestBody;
  try {
    url = adapter.buildUrl(model, credentials, ctx);
    headers = adapter.buildHeaders(credentials, ctx);
    requestBody = adapter.buildBody(model, {
      input,
      encoding_format: body.encoding_format || "float",
      dimensions: body.dimensions,
    });
  } catch (error) {
    log?.debug?.("EMBEDDINGS", `Request build failed: ${error.message}`);
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `[${provider}/${model}] ${error.message}`);
  }

  log?.debug?.("EMBEDDINGS", `${provider.toUpperCase()} | ${model} | input_type=${Array.isArray(input) ? `array[${input.length}]` : "string"}`);

  const fullResponseTimeoutMs = positiveLimit(
    requestTimeoutMs,
    DEFAULT_EMBEDDINGS_RESPONSE_TIMEOUT_MS,
  );
  const bodyStallTimeoutMs = positiveLimit(
    responseStallTimeoutMs,
    DEFAULT_EMBEDDINGS_BODY_STALL_TIMEOUT_MS,
  );
  const responseByteLimit = positiveLimit(
    maxResponseBytes,
    DEFAULT_MAX_EMBEDDINGS_RESPONSE_BYTES,
  );
  const deadline = createFullResponseDeadline(callerSignal, fullResponseTimeoutMs);

  try {
    let providerResponse;
    try {
      providerResponse = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: deadline.signal,
      });
    } catch (error) {
      const result = abortedResult(error, callerSignal, deadline, provider, model);
      log?.debug?.("EMBEDDINGS", `Fetch error: ${result.error}`);
      return result;
    }

  // Handle 401/403 — try token refresh (skip for noAuth providers)
  const executor = getExecutor(provider);
  if (
    !executor?.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
      let newCredentials;
      try {
        newCredentials = await refreshWithRetry(
          () => executor.refreshCredentials(credentials, log),
          3,
          log,
          deadline.signal,
        );
      } catch (error) {
        cancelResponseBody(providerResponse, error);
        const result = abortedResult(error, callerSignal, deadline, provider, model);
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh interrupted: ${result.error}`);
        return result;
      }

    if (newCredentials?.accessToken || newCredentials?.apiKey) {
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for embeddings`);
      Object.assign(credentials, newCredentials);
      if (onCredentialsRefreshed) {
        try {
          await onCredentialsRefreshed(newCredentials);
        } catch (error) {
          log?.warn?.("TOKEN", `${provider.toUpperCase()} | failed to persist refreshed embeddings credentials: ${error.message}`);
        }
      }

      try {
        const retryHeaders = adapter.buildHeaders(credentials, ctx);
        const retryUrl = adapter.buildUrl(model, credentials, ctx);
        const retryResponse = await fetch(retryUrl, {
          method: "POST",
          headers: retryHeaders,
          body: JSON.stringify(requestBody),
          signal: deadline.signal,
        });
        // The original auth-error body is no longer needed once a retry has a
        // response. Cancel it before replacing the reference so its transport
        // can be reclaimed without buffering the unread payload.
        cancelResponseBody(providerResponse);
        providerResponse = retryResponse;
      } catch (error) {
        if (callerSignal?.aborted || deadline.didTimeOut()) {
          cancelResponseBody(providerResponse, error);
          return abortedResult(error, callerSignal, deadline, provider, model);
        }
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
    }
  }

  if (!providerResponse.ok) {
    let parsedError;
    try {
      parsedError = await parseUpstreamError(providerResponse, executor, {
        signal: deadline.signal,
        stallTimeoutMs: bodyStallTimeoutMs,
      });
    } catch (error) {
      return abortedResult(error, callerSignal, deadline, provider, model);
    }
    const { statusCode, message } = parsedError;
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("EMBEDDINGS", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    const responseText = await readUpstreamBodyText(providerResponse, {
      signal: deadline.signal,
      maxBytes: responseByteLimit,
      stallTimeoutMs: bodyStallTimeoutMs,
      fatalUtf8: true,
    });
    responseBody = JSON.parse(responseText);
  } catch (error) {
    if (callerSignal?.aborted || deadline.didTimeOut()) {
      return abortedResult(error, callerSignal, deadline, provider, model);
    }
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      `Invalid or oversized JSON response from ${provider}`,
      undefined,
      "invalid_upstream_response",
    );
  }

  let normalized;
  try {
    normalized = adapter.normalize(responseBody, model);
    validateNormalizedEmbeddings(normalized, responseBody, input, body.encoding_format || "float");
  } catch {
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      `Invalid embeddings response from ${provider}`,
      undefined,
      "invalid_upstream_response",
    );
  }

  // Account state is only cleared after the provider payload is fully read and
  // provider-specific normalization has accepted it.
  deadline.dispose();
  if (onRequestSuccess) {
    try {
      Promise.resolve(onRequestSuccess()).catch(error => {
        log?.warn?.("EMBEDDINGS", `Success cleanup failed: ${error?.message || error}`);
      });
    } catch (error) {
      log?.warn?.("EMBEDDINGS", `Success cleanup failed: ${error?.message || error}`);
    }
  }
  log?.debug?.("EMBEDDINGS", `Success | usage=${JSON.stringify(normalized.usage || {})}`);

  return {
    success: true,
    usage: normalized.usage || null,
    response: new Response(JSON.stringify(normalized), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
  } finally {
    deadline.dispose();
  }
}

export const EMBEDDINGS_RESPONSE_TIMEOUT_MS = DEFAULT_EMBEDDINGS_RESPONSE_TIMEOUT_MS;
export const EMBEDDINGS_BODY_STALL_TIMEOUT_MS = DEFAULT_EMBEDDINGS_BODY_STALL_TIMEOUT_MS;
export const MAX_EMBEDDINGS_RESPONSE_BYTES = DEFAULT_MAX_EMBEDDINGS_RESPONSE_BYTES;
