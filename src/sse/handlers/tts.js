import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable, clearAccountError,
  beginAccountMutationAttempt, endAccountMutationAttempt, recordAccountMutationSuccess,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { isAbortError } from "open-sse/utils/abort.js";
import { readRequestBodyBytes, RequestBodyError } from "open-sse/utils/requestBody.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";

function observeAccountCleanup(cleanup, connectionId) {
  try {
    Promise.resolve(cleanup()).catch(() => {
      log.warn("TTS", `Success cleanup failed for connection ${connectionId}`);
    });
  } catch {
    log.warn("TTS", `Success cleanup failed for connection ${connectionId}`);
  }
}

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none")
    .map(([id]) => id)
);

export const MAX_TTS_REQUEST_BODY_BYTES = 1024 * 1024;
export const TTS_REQUEST_BODY_STALL_MS = 15_000;
const TTS_RESPONSE_FORMATS = new Set(["mp3", "opus", "ogg", "aac", "flac", "wav", "pcm", "m4a", "json"]);
const REQUEST_OWNED_ERROR_STATUSES = new Set([400, 413, 415, 422]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function handleTts(request) {
  if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");

  const url = new URL(request.url);
  const settings = await getSettings();
  if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  if (settings.requireApiKey) {
    const apiKey = extractApiKey(request);
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  let body;
  try {
    const bodyBytes = await readRequestBodyBytes(request, {
      maxBytes: MAX_TTS_REQUEST_BODY_BYTES,
      stallMs: TTS_REQUEST_BODY_STALL_MS,
      label: "TTS request body",
      requireBody: true,
    });
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    body = JSON.parse(bodyText);
  } catch (error) {
    if (isAbortError(error, request.signal) || request.signal?.aborted) {
      return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    }
    const status = error instanceof RequestBodyError ? error.status : HTTP_STATUS.BAD_REQUEST;
    return errorResponse(status, error?.message || "Invalid JSON body");
  }
  if (!isPlainObject(body)) return errorResponse(HTTP_STATUS.BAD_REQUEST, "JSON body must be an object");
  if (typeof body.model !== "string" || !body.model.trim()) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }
  if (typeof body.input !== "string" || !body.input.trim()) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }
  if (body.language !== undefined && typeof body.language !== "string") {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "language must be a string");
  }
  if (body.style !== undefined && typeof body.style !== "string") {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "style must be a string");
  }

  const modelStr = body.model.trim();
  const responseFormat = (url.searchParams.get("response_format") || "mp3").toLowerCase();
  if (!TTS_RESPONSE_FORMATS.has(responseFormat)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Unsupported response_format");
  }
  const language = body.language || "";
  const style = body.style || "";
  log.request("POST", `${url.pathname} | ${modelStr} | format=${responseFormat}${language ? ` | lang=${language}` : ""}`);

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("TTS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelTts(b, m, responseFormat, language, style, request.signal),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      signal: request.signal,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language, style, request.signal);
}

async function handleSingleModelTts(body, modelStr, responseFormat, language, style, signal) {
  if (signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  const modelInfo = await getModelInfo(modelStr);
  if (signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleTtsCore({ provider, model, input: body.input, responseFormat, language, style, signal });
    if (result.success) return result.response;
    return result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // Credentialed providers — fallback loop (same pattern as embeddings)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    if (signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    let credentials;
    try {
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { signal });
    } catch (error) {
      if (isAbortError(error, signal)) {
        return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      }
      throw error;
    }
    if (signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const mutationAttempt = beginAccountMutationAttempt(credentials.connectionId, model);
    try {
      const result = await handleTtsCore({
        provider,
        model,
        input: body.input,
        credentials,
        responseFormat,
        language,
        style,
        signal,
      });

      if (result.success) {
        if (signal?.aborted) {
          return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
        }
        recordAccountMutationSuccess(mutationAttempt);
        // Account-health cleanup is secondary to a fully validated, possibly
        // billable synthesis. Observe it without holding the client response.
        observeAccountCleanup(
          () => clearAccountError(credentials.connectionId, credentials, model, { mutationAttempt }),
          credentials.connectionId,
        );
        return result.response;
      }

      // Client cancellation is not evidence that provider credentials failed.
      if (signal?.aborted || result.status === HTTP_STATUS.CLIENT_CLOSED_REQUEST) {
        return result.response || errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      }

      // Invalid request parameters say nothing about account health and must
      // never rotate through or cool down otherwise healthy credentials.
      if (REQUEST_OWNED_ERROR_STATUSES.has(result.status)) {
        return result.response || errorResponse(result.status, result.error);
      }

      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId,
        result.status,
        result.error,
        provider,
        model,
        null,
        { mutationAttempt },
      );
      if (shouldFallback) {
        excludeConnectionIds.add(credentials.connectionId);
        lastError = result.error;
        lastStatus = result.status;
        continue;
      }
      return result.response || errorResponse(result.status, result.error);
    } finally {
      endAccountMutationAttempt(mutationAttempt);
    }
  }
}
