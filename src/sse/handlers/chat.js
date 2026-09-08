import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import {
  handleAntigravityQuotaError,
  clearAntigravityStrikes,
  beginAntigravityQuotaAttempt,
  endAntigravityQuotaAttempt,
  isAntigravityQuotaAttemptSuperseded,
  canAntigravityQuotaAttemptClearFailure,
  recordAntigravityQuotaAttemptFailure,
} from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { isAbortError } from "open-sse/utils/abort.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  let body;
  try {
    body = await request.json();
  } catch (error) {
    if (isAbortError(error, request.signal)) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel, panelSignal) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          const callRequest = panelSignal
            ? { url: request?.url, headers: request?.headers, signal: panelSignal }
            : request;
          return handleSingleModelChat(b, m, cleanRawReq, callRequest, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
        signal: request.signal,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      signal: request.signal,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      signal: request.signal,
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  if (request?.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel, panelSignal) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            const callRequest = panelSignal
              ? { url: request?.url, headers: request?.headers, signal: panelSignal }
              : request;
            return handleSingleModelChat(b, m, cleanRawReq, callRequest, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
          signal: request?.signal,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        signal: request?.signal,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    if (request?.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    let credentials;
    try {
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { signal: request?.signal });
    } catch (error) {
      if (isAbortError(error, request?.signal)) {
        return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      }
      throw error;
    }
    if (request?.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        // Preserve the real provider failure for combo arbitration and clients
        // that distinguish quota exhaustion from a generic outage.
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      let pid;
      try {
        pid = await getProjectIdForConnection(
          credentials.connectionId,
          refreshedCredentials.accessToken,
          provider,
          { signal: request?.signal },
        );
      } catch (error) {
        if (isAbortError(error, request?.signal)) {
          return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
        }
        throw error;
      }
      if (request?.signal?.aborted) {
        return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      }
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const pxpipeTransform = chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null;
    if (request?.signal?.aborted) {
      return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    }
    // Capture ordering immediately before dispatch. Assigning an attempt before
    // awaited setup could make a request that dispatches later look older.
    const quotaAttempt = provider === "antigravity"
      ? beginAntigravityQuotaAttempt(credentials.connectionId, model)
      : null;
    try {
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      signal: request?.signal,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        // "Consecutive" strikes: a success clears the breaker for this pair.
        // This must happen before the fallible DB cleanup so a delayed/rejected
        // write cannot let older quota-error evaluators restore stale strikes.
        clearAntigravityStrikes(credentials.connectionId, model, quotaAttempt);
        if (quotaAttempt && !canAntigravityQuotaAttemptClearFailure(quotaAttempt)) return;
        // A verified provider success owns this cleanup even if the client
        // disconnects immediately afterward; keep the DB commit observed.
        const cleanupGuard = quotaAttempt
          ? () => canAntigravityQuotaAttemptClearFailure(quotaAttempt)
          : null;
        await clearAccountError(
          credentials.connectionId,
          credentials,
          model,
          cleanupGuard ? { reloadCurrent: true, shouldCommit: cleanupGuard } : {},
        );
      }
    });

    // Non-streaming success cleanup is normally queued by chatCore. Record the
    // success here as well before releasing the attempt; token-based recording
    // is idempotent and closes the success-before-error-handler race.
    if (result.success && quotaAttempt && body?.stream !== true) {
      clearAntigravityStrikes(credentials.connectionId, model, quotaAttempt);
    }

    if (request?.signal?.aborted) {
      result.response?.body?.cancel().catch(() => {});
      return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    }
    if (result.success || result.status === HTTP_STATUS.CLIENT_CLOSED_REQUEST) return result.response;

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      try {
        quotaResetMs = await handleAntigravityQuotaError(
          credentials.connectionId, result.status, model,
          refreshedCredentials.accessToken, credentials.providerSpecificData,
          request?.signal, quotaAttempt,
        );
      } catch (error) {
        if (isAbortError(error, request?.signal)) {
          return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
        }
        throw error;
      }
      if (request?.signal?.aborted) {
        return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      }
      // A newer success makes this request's provider error historical. Return
      // its own response, but do not persist cooldown or route it elsewhere.
      if (isAntigravityQuotaAttemptSuperseded(quotaAttempt)) {
        return result.response;
      }
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    let shouldFallback;
    if (provider === "antigravity" && quotaResetMs) {
      shouldFallback = true;
    } else {
      try {
        const markResult = await markAccountUnavailable(
          credentials.connectionId, result.status, result.error, provider, model, resetsAtMs,
          {
            signal: request?.signal,
            ...(quotaAttempt ? {
              shouldCommit: () => !isAntigravityQuotaAttemptSuperseded(quotaAttempt),
              // Record ordering at the actual DB boundary for every AG
              // failure that persists a lock, including non-quota 4xx/5xx.
              beforeCommit: () => recordAntigravityQuotaAttemptFailure(quotaAttempt),
            } : {}),
          },
        );
        if (markResult.superseded) return result.response;
        shouldFallback = markResult.shouldFallback;
      } catch (error) {
        if (isAbortError(error, request?.signal)) {
          return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
        }
        throw error;
      }
    }

    if (request?.signal?.aborted) {
      return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    }

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
    } finally {
      endAntigravityQuotaAttempt(quotaAttempt);
    }
  }
}
