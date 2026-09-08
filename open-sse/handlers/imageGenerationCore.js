import { createErrorResult, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  MAX_IMAGE_RESPONSE_BYTES,
  MAX_IMAGE_SSE_EVENTS,
} from "../config/mediaConfig.js";
import { awaitWithSignal, throwIfAborted } from "../utils/abort.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { getExecutor } from "../executors/index.js";
import { getImageAdapter } from "./imageProviders/index.js";
import {
  cancelResponseBody,
  createImageOperation,
  fetchWithSignal,
  readJsonResponse,
  readResponseBytes,
  readResponseText,
  sleep,
  urlToBase64,
} from "./imageProviders/_base.js";

function serializeRequestBody(requestBody) {
  if (typeof FormData !== "undefined" && requestBody instanceof FormData) return requestBody;
  if (typeof requestBody === "string") return requestBody;
  return JSON.stringify(requestBody);
}

function timeoutLike(error) {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  return error?.name === "TimeoutError" || code.includes("TIMEOUT");
}

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isNonEmptyBase64(value) {
  if (typeof value !== "string" || value.length < 2 || value.length % 4 === 1) return false;
  // Provider JSON uses standard base64 without whitespace. Padding is optional,
  // but may only appear at the end.
  return /^(?:[A-Za-z0-9+/]+={0,2})$/.test(value);
}

function isImageUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeAndValidateImageResult(adapter, responseBody, prompt) {
  const normalized = adapter.normalize(responseBody, prompt);
  if (!normalized || typeof normalized !== "object" || !Array.isArray(normalized.data)) {
    throw new Error("Image provider returned an invalid response envelope");
  }
  if (normalized.data.length === 0) {
    throw new Error("Image provider returned no generated image");
  }
  for (const item of normalized.data) {
    if (!item || typeof item !== "object") {
      throw new Error("Image provider returned an invalid image item");
    }
    if (!isNonEmptyBase64(item.b64_json) && !isImageUrl(item.url)) {
      throw new Error("Image provider returned an empty or invalid image payload");
    }
  }
  return normalized;
}

async function buildImageResponse(finalBody, binaryOutput, outputFormat, signal) {
  if (!binaryOutput) return jsonSuccess(finalBody);

  const first = finalBody.data[0];
  let b64 = first.b64_json;
  if (!b64 && first.url) {
    b64 = await urlToBase64(first.url, { signal });
  }
  if (!isNonEmptyBase64(b64)) {
    throw new Error("Image provider returned an invalid binary image payload");
  }
  return binaryResponse(b64, outputFormat);
}

function exceptionResult(error, provider, model, callerSignal, log, phase = "Image generation") {
  if (
    error?.status === HTTP_STATUS.GATEWAY_TIMEOUT ||
    timeoutLike(error) ||
    (callerSignal?.aborted && timeoutLike(callerSignal.reason))
  ) {
    return createErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, error?.message || "Image generation timed out");
  }
  if (callerSignal?.aborted || error?.status === HTTP_STATUS.CLIENT_CLOSED_REQUEST) {
    return createErrorResult(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  }
  const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
  log?.debug?.("IMAGE", `${phase} error: ${errMsg}`);
  return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
}

async function parseBoundedUpstreamError(response, options) {
  let bodyText = "";
  try {
    bodyText = await readResponseText(response, options);
  } catch (error) {
    if (error?.status || timeoutLike(error)) throw error;
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    message = json?.error?.message || json?.message || json?.error || bodyText;
  } catch {
    message = bodyText;
  }
  if (typeof message !== "string") {
    try { message = JSON.stringify(message); } catch { message = String(message); }
  }
  return {
    statusCode: response.status,
    message: message || `Upstream error: ${response.status}`,
  };
}

async function runHook(hook, value, signal) {
  if (!hook) return;
  throwIfAborted(signal);
  await awaitWithSignal(hook(value), signal);
}

function observeSuccessHook(hook, log) {
  if (!hook) return;
  try {
    Promise.resolve(hook()).catch(error => {
      log?.warn?.("IMAGE", `Success cleanup failed: ${error?.message || error}`);
    });
  } catch (error) {
    log?.warn?.("IMAGE", `Success cleanup failed: ${error?.message || error}`);
  }
}

/**
 * Core image generation handler — orchestrator only.
 * Provider-specific URL/headers/body/parse/normalize live in `./imageProviders/{id}.js`.
 *
 * @param {object} options
 * @param {object} options.body - Request body { model, prompt, n, size, ... }
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} [options.log] - Logger
 * @param {boolean} [options.streamToClient] - Pipe SSE to client (codex)
 * @param {boolean} [options.binaryOutput] - Return raw image bytes
 * @param {AbortSignal} [options.signal] - Client cancellation signal
 * @param {number} [options.timeoutMs] - Absolute submit/poll/read deadline
 * @param {number} [options.maxResponseBytes] - Provider response/SSE byte cap
 * @param {number} [options.maxSseEvents] - Provider SSE event cap
 * @param {function} [options.onCredentialsRefreshed]
 * @param {function} [options.onRequestSuccess]
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleImageGenerationCore({
  body,
  modelInfo,
  credentials,
  log,
  streamToClient = false,
  binaryOutput = false,
  signal: callerSignal,
  timeoutMs = IMAGE_GENERATION_TIMEOUT_MS,
  maxResponseBytes = MAX_IMAGE_RESPONSE_BYTES,
  maxSseEvents = MAX_IMAGE_SSE_EVENTS,
  onCredentialsRefreshed,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;

  if (!body.prompt) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }

  const adapter = getImageAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support image generation`,
    );
  }

  maxResponseBytes = positiveLimit(maxResponseBytes, MAX_IMAGE_RESPONSE_BYTES);
  maxSseEvents = positiveLimit(maxSseEvents, MAX_IMAGE_SSE_EVENTS);

  const operation = createImageOperation(callerSignal, timeoutMs);
  const signal = operation.signal;
  let streamOwnsOperation = false;

  const readOptions = { signal, maxBytes: maxResponseBytes };
  const adapterContext = {
    signal,
    maxResponseBytes,
    maxSseEvents,
    abortOperation: operation.abort,
    finishOperation: operation.finish,
    fetch: (url, init = {}) => fetchWithSignal(url, init, signal),
    sleep: (ms) => sleep(ms, signal),
    readBytes: (response) => readResponseBytes(response, readOptions),
    readText: (response) => readResponseText(response, readOptions),
    readJson: (response) => readJsonResponse(response, readOptions),
  };

  try {
    throwIfAborted(signal);

    // Executor-delegating adapters skip manual URL/headers/body and use their
    // proven executor flow, but still share this request's abort/deadline.
    if (adapter.useExecutor && adapter.executeViaExecutor) {
      try {
        log?.debug?.("IMAGE", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..." (executor)`);
        const responseBody = await awaitWithSignal(
          adapter.executeViaExecutor(model, body, credentials, log, adapterContext),
          signal,
        );
        const finalBody = normalizeAndValidateImageResult(adapter, responseBody, body.prompt);
        const response = await buildImageResponse(
          finalBody,
          binaryOutput,
          body.output_format,
          signal,
        );
        observeSuccessHook(onRequestSuccess, log);
        return response;
      } catch (error) {
        return exceptionResult(error, provider, model, callerSignal, log, "Executor");
      }
    }

    let url;
    let headers;
    let requestBody;

    try {
      url = adapter.buildUrl(model, credentials);
      requestBody = await awaitWithSignal(adapter.buildBody(model, body, adapterContext), signal);
      headers = adapter.buildHeaders(credentials, requestBody, model, body);
    } catch (error) {
      if (signal.aborted) return exceptionResult(error, provider, model, callerSignal, log, "Request build");
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, error.message || `Invalid ${provider} image request`);
    }

    log?.debug?.("IMAGE", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..."`);

    let providerResponse;
    try {
      providerResponse = await fetchWithSignal(url, {
        method: "POST",
        headers,
        body: serializeRequestBody(requestBody),
      }, signal);
    } catch (error) {
      return exceptionResult(error, provider, model, callerSignal, log, "Fetch");
    }

    // Handle 401/403 — try token refresh (skipped for noAuth providers).
    const executor = getExecutor(provider);
    if (
      !executor?.noAuth &&
      !adapter.noAuth &&
      (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
        providerResponse.status === HTTP_STATUS.FORBIDDEN)
    ) {
      try {
        const newCredentials = await refreshWithRetry(
          () => executor.refreshCredentials(credentials, log),
          3,
          log,
          signal,
        );

        if (newCredentials?.accessToken || newCredentials?.apiKey) {
          log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for image generation`);
          Object.assign(credentials, newCredentials);
          await runHook(onCredentialsRefreshed, newCredentials, signal);

          const retryBody = await awaitWithSignal(adapter.buildBody(model, body, adapterContext), signal);
          const retryHeaders = adapter.buildHeaders(credentials, retryBody, model, body);
          const retryUrl = adapter.buildUrl(model, credentials);
          const retryResponse = await fetchWithSignal(retryUrl, {
            method: "POST",
            headers: retryHeaders,
            body: serializeRequestBody(retryBody),
          }, signal);
          cancelResponseBody(providerResponse);
          providerResponse = retryResponse;
          headers = retryHeaders;
          requestBody = retryBody;
          url = retryUrl;
        } else {
          log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
        }
      } catch (error) {
        if (signal.aborted || error?.status || timeoutLike(error)) {
          cancelResponseBody(providerResponse, error);
          return exceptionResult(error, provider, model, callerSignal, log, "Token refresh");
        }
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
      }
    }

    if (!providerResponse.ok) {
      try {
        const { statusCode, message } = await parseBoundedUpstreamError(providerResponse, readOptions);
        const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
        log?.debug?.("IMAGE", `Provider error: ${errMsg}`);
        return createErrorResult(statusCode, errMsg);
      } catch (error) {
        return exceptionResult(error, provider, model, callerSignal, log, "Error response");
      }
    }

    // Parse provider response — adapter may override (Codex SSE, async polling,
    // or binary). Every adapter receives the same bounded lifecycle context.
    let parsed;
    try {
      if (adapter.parseResponse) {
        parsed = await adapter.parseResponse(providerResponse, {
          ...adapterContext,
          headers,
          log,
          streamToClient,
          onRequestSuccess,
          url,
          requestBody,
          model,
          body,
        });
        if (parsed?.sseResponse) {
          streamOwnsOperation = true;
          return { success: true, response: parsed.sseResponse };
        }
      } else {
        parsed = await readJsonResponse(providerResponse, readOptions);
      }
    } catch (error) {
      cancelResponseBody(providerResponse, error);
      return exceptionResult(error, provider, model, callerSignal, log, "Response parse");
    }

    const finalBody = normalizeAndValidateImageResult(adapter, parsed, body.prompt);
    const response = await buildImageResponse(
      finalBody,
      binaryOutput,
      body.output_format,
      signal,
    );
    observeSuccessHook(onRequestSuccess, log);
    return response;
  } catch (error) {
    return exceptionResult(error, provider, model, callerSignal, log);
  } finally {
    if (!streamOwnsOperation) operation.finish();
  }
}

function binaryResponse(base64, outputFormat) {
  const buf = Buffer.from(base64, "base64");
  const fmt = (outputFormat || "png").toLowerCase();
  const mime = fmt === "jpeg" || fmt === "jpg"
    ? "image/jpeg"
    : fmt === "webp" ? "image/webp" : "image/png";
  return {
    success: true,
    response: new Response(buf, {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `inline; filename="image.${fmt === "jpeg" ? "jpg" : fmt}"`,
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}

function jsonSuccess(body) {
  return {
    success: true,
    response: new Response(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
