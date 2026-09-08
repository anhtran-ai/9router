import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable, clearAccountError,
  beginAccountMutationAttempt, endAccountMutationAttempt, recordAccountMutationSuccess,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleSttCore, MAX_STT_AUDIO_BYTES, validateSttInput } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { readRequestBodyBytes, RequestBodyError } from "open-sse/utils/requestBody.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";

function observeAccountCleanup(cleanup, connectionId) {
  try {
    Promise.resolve(cleanup()).catch(() => {
      log.warn("STT", `Success cleanup failed for connection ${connectionId}`);
    });
  } catch {
    log.warn("STT", `Success cleanup failed for connection ${connectionId}`);
  }
}

// Leave bounded room for multipart boundaries and optional text fields while
// keeping the audio payload itself at the provider-compatible 25 MiB cap.
export const MAX_STT_REQUEST_BODY_BYTES = MAX_STT_AUDIO_BYTES + (7 * 1024 * 1024);
export const STT_REQUEST_BODY_STALL_MS = 30_000;

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);
const REQUEST_OWNED_ERROR_STATUSES = new Set([400, 413, 415, 422]);

export async function handleStt(request) {
  const abortedResponse = () => errorResponse(
    HTTP_STATUS.CLIENT_CLOSED_REQUEST,
    "Request aborted",
  );

  if (request.signal?.aborted) return abortedResponse();
  const settings = await getSettings();
  if (request.signal?.aborted) return abortedResponse();
  if (settings.requireApiKey) {
    const apiKey = extractApiKey(request);
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (request.signal?.aborted) return abortedResponse();
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  let bodyBytes;
  try {
    bodyBytes = await readRequestBodyBytes(request, {
      maxBytes: MAX_STT_REQUEST_BODY_BYTES,
      stallMs: STT_REQUEST_BODY_STALL_MS,
      label: "STT request body",
      requireBody: true,
    });
  } catch (error) {
    if (request.signal?.aborted) return abortedResponse();
    const status = error instanceof RequestBodyError
      ? error.status
      : HTTP_STATUS.BAD_REQUEST;
    return errorResponse(status, error?.message || "Invalid multipart form data");
  }
  if (request.signal?.aborted) return abortedResponse();

  let formData;
  try {
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const boundedRequest = new Request(request.url, {
      method: "POST",
      headers,
      body: bodyBytes,
      signal: request.signal,
    });
    formData = await boundedRequest.formData();
  } catch {
    if (request.signal?.aborted) return abortedResponse();
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }
  if (request.signal?.aborted) return abortedResponse();

  const modelStr = formData.get("model");
  log.request("POST", `/v1/audio/transcriptions | ${modelStr}`);

  if (typeof modelStr !== "string" || !modelStr.trim()) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }
  if (!formData.get("file")) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const modelInfo = await getModelInfo(modelStr.trim());
  if (request.signal?.aborted) return abortedResponse();
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  const sttConfig = AI_PROVIDERS[provider]?.sttConfig;
  const inputError = validateSttInput({ provider, model, formData, sttConfig });
  if (inputError) return errorResponse(inputError.status, inputError.message);
  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleSttCore({
      provider,
      model,
      formData,
      sttConfig,
      signal: request.signal,
    });
    if (request.signal?.aborted) return abortedResponse();
    if (result.status === HTTP_STATUS.CLIENT_CLOSED_REQUEST) return result.response || abortedResponse();
    if (result.success) return result.response;
    return result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Credentialed — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    if (request.signal?.aborted) return abortedResponse();
    let credentials;
    try {
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted || error?.name === "AbortError") return abortedResponse();
      throw error;
    }
    if (request.signal?.aborted) return abortedResponse();

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
      const result = await handleSttCore({
        provider,
        model,
        formData,
        credentials,
        sttConfig,
        signal: request.signal,
      });

      if (request.signal?.aborted) return abortedResponse();
      if (result.status === HTTP_STATUS.CLIENT_CLOSED_REQUEST) return result.response || abortedResponse();

      if (result.success) {
        recordAccountMutationSuccess(mutationAttempt);
        // Preserve a completed transcription even if local health-state
        // cleanup rejects or never settles; retrying can repeat paid work.
        observeAccountCleanup(
          () => clearAccountError(credentials.connectionId, credentials, model, { mutationAttempt }),
          credentials.connectionId,
        );
        return result.response;
      }

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
