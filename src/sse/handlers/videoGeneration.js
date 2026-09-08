import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  beginAccountMutationAttempt,
  endAccountMutationAttempt,
  recordAccountMutationSuccess,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import {
  handleVideoProxyCore,
  getVideoConfig,
  isValidVideoRequestId,
  sanitizeSecrets,
} from "open-sse/handlers/videoCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { readRequestBodyBytes, RequestBodyError } from "open-sse/utils/requestBody.js";
import { awaitWithSignal } from "open-sse/utils/abort.js";
import * as log from "../utils/logger.js";

function observeAccountCleanup(cleanup, connectionId) {
  try {
    Promise.resolve(cleanup()).catch(() => {
      log.warn("VIDEO", `Success cleanup failed for connection ${connectionId}`);
    });
  } catch {
    log.warn("VIDEO", `Success cleanup failed for connection ${connectionId}`);
  }
}

// Video generation is xAI-only today; requests without a provider prefix
// (bare model id, or multipart bodies we deliberately don't parse) land here.
const DEFAULT_VIDEO_PROVIDER = "xai";
const MAX_VIDEO_REQUEST_BYTES = 64 * 1024 * 1024;
const VIDEO_REQUEST_BODY_STALL_MS = 30_000;
const VIDEO_LOCK_KEY = "video:grok-imagine-video";

// Creation POSTs are billable jobs — only rotate to another account for
// errors that upstream rejects BEFORE creating a job (auth/quota). A 5xx may
// have created the job, so it is returned to the caller instead of re-sent.
const CREATE_ROTATION_STATUSES = new Set([
  HTTP_STATUS.UNAUTHORIZED,
  402,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.RATE_LIMITED,
]);
const VIDEO_ACCOUNT_HEALTH_STATUSES = CREATE_ROTATION_STATUSES;

async function requireValidApiKey(request) {
  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }
  return null;
}

/**
 * Read the request body once, byte-preserving.
 * JSON bodies are additionally parsed so the `model` provider prefix can be
 * resolved (and stripped) — everything else is forwarded exactly as received.
 */
async function readForwardableBody(request) {
  const contentType = request.headers.get("content-type") || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  let bytes;
  try {
    bytes = await readRequestBodyBytes(request, {
      maxBytes: MAX_VIDEO_REQUEST_BYTES,
      stallMs: VIDEO_REQUEST_BODY_STALL_MS,
      label: "Video request body",
      requireBody: true,
    });
  } catch (error) {
    const status = request.signal?.aborted
      ? HTTP_STATUS.CLIENT_CLOSED_REQUEST
      : (error instanceof RequestBodyError ? error.status : HTTP_STATUS.BAD_REQUEST);
    const message = status === HTTP_STATUS.CLIENT_CLOSED_REQUEST
      ? "Request aborted"
      : (error?.message || "Invalid request body");
    return { error: errorResponse(status, message) };
  }

  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    let raw;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid UTF-8 JSON body") };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
    }
    return { raw, parsed, contentType };
  }
  // Multipart (or any other content type): forward the exact bytes — parsing
  // and re-encoding FormData would change the multipart boundary.
  const buf = Buffer.from(bytes);
  return { raw: buf, parsed: null, contentType };
}

async function resolveVideoProvider(parsedBody) {
  if (!parsedBody?.model) return { provider: DEFAULT_VIDEO_PROVIDER, model: null };

  const modelStr = String(parsedBody.model);
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Combos are not supported for video generation") };
  }
  if (!getVideoConfig(modelInfo.provider)) {
    // Bare model ids (no explicit "provider/" prefix) fall back to the default
    // video provider — the prefix-less inference targets chat providers only.
    if (!modelStr.includes("/")) {
      return { provider: DEFAULT_VIDEO_PROVIDER, model: modelStr };
    }
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider '${modelInfo.provider}' does not support video generation`) };
  }
  return { provider: modelInfo.provider, model: modelInfo.model };
}

function withConnectionHeader(response, connectionId) {
  if (!connectionId) return response;
  const headers = new Headers(response.headers);
  // Video jobs are account-bound upstream — clients echo this back as
  // `x-connection-id` on GET polls so the same account is used.
  headers.set("x-9router-connection-id", String(connectionId));
  const exposed = new Set(
    (headers.get("access-control-expose-headers") || "")
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  );
  exposed.add("x-9router-connection-id");
  headers.set("Access-Control-Expose-Headers", [...exposed].join(", "));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * POST /v1/videos/{generations|edits|extensions} — async job creation proxy.
 */
export async function handleVideoCreate(request, action) {
  if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  const authError = await requireValidApiKey(request);
  if (authError) return authError;
  if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");

  const bodyInfo = await readForwardableBody(request);
  if (bodyInfo.error) return bodyInfo.error;
  if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");

  const resolved = await resolveVideoProvider(bodyInfo.parsed);
  if (resolved.error) return resolved.error;
  const { provider, model } = resolved;

  // Strip the provider prefix (e.g. "xai/grok-imagine-video") before forwarding;
  // otherwise forward the original bytes untouched.
  let forwardBody = bodyInfo.raw;
  if (bodyInfo.parsed && model && bodyInfo.parsed.model !== model) {
    forwardBody = JSON.stringify({ ...bodyInfo.parsed, model });
  }

  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const idempotencyKey = request.headers.get("idempotency-key") || null;

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    let credentials;
    try {
      credentials = await getProviderCredentials(provider, excludeConnectionIds, VIDEO_LOCK_KEY, {
        preferredConnectionId,
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted || error?.name === "AbortError") {
        return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      }
      throw error;
    }

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model || "video"}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    let refreshedCredentials;
    try {
      refreshedCredentials = await awaitWithSignal(
        checkAndRefreshToken(provider, credentials),
        request.signal,
      );
    } catch (error) {
      if (request.signal?.aborted || error?.name === "AbortError") {
        return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      }
      throw error;
    }
    if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");

    const mutationAttempt = beginAccountMutationAttempt(credentials.connectionId, VIDEO_LOCK_KEY);
    try {
      const result = await handleVideoProxyCore({
        provider,
        action,
        rawBody: forwardBody,
        contentType: bodyInfo.contentType || null,
        idempotencyKey,
        credentials: refreshedCredentials,
        signal: request.signal,
        log,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            accessToken: newCreds.accessToken,
            refreshToken: newCreds.refreshToken,
            providerSpecificData: newCreds.providerSpecificData,
            testStatus: "active",
          });
        },
      });

      if (request.signal?.aborted || result.status === HTTP_STATUS.CLIENT_CLOSED_REQUEST) {
        return result.response || errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
      }
      if (result.success) {
        recordAccountMutationSuccess(mutationAttempt);
        // The upstream may already have accepted a billable job. Observe local
        // bookkeeping without delaying the id or inviting a duplicate POST.
        observeAccountCleanup(
          () => clearAccountError(credentials.connectionId, credentials, VIDEO_LOCK_KEY, { mutationAttempt }),
          credentials.connectionId,
        );
        log.info("VIDEO", `${provider.toUpperCase()} | ${action} accepted (connection ${credentials.connectionId})`);
        return withConnectionHeader(result.response, credentials.connectionId);
      }

      // Only auth/quota failures are evidence against an account. Client
      // validation, job semantics and ambiguous 5xx creation failures must not
      // poison credentials or trigger a second billable submission.
      if (CREATE_ROTATION_STATUSES.has(result.status)) {
        const { shouldFallback } = await markAccountUnavailable(
          credentials.connectionId,
          result.status,
          sanitizeSecrets(result.error, refreshedCredentials),
          provider,
          VIDEO_LOCK_KEY,
          null,
          { mutationAttempt },
        );
        if (shouldFallback) {
          excludeConnectionIds.add(credentials.connectionId);
          lastError = result.error;
          lastStatus = result.status;
          continue;
        }
      }

      return result.response;
    } finally {
      endAccountMutationAttempt(mutationAttempt);
    }
  }
}

/**
 * GET /v1/videos/{request_id} — poll job status.
 * Jobs are account-bound upstream, so no cross-account rotation here: the
 * caller pins the creating account via `x-connection-id` (returned on create).
 */
export async function handleVideoGet(request, requestId) {
  if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  const authError = await requireValidApiKey(request);
  if (authError) return authError;
  if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");

  if (!requestId) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing video request id");
  if (!isValidVideoRequestId(requestId)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid video request id");
  }

  const provider = DEFAULT_VIDEO_PROVIDER;
  const preferredConnectionId = request.headers.get("x-connection-id") || null;

  let credentials;
  try {
    credentials = await getProviderCredentials(provider, null, VIDEO_LOCK_KEY, {
      preferredConnectionId,
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal?.aborted || error?.name === "AbortError") {
      return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    }
    throw error;
  }
  if (!credentials || credentials.allRateLimited) {
    if (preferredConnectionId) {
      return errorResponse(409, "Pinned video connection is unavailable");
    }
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
  }
  // `preferredConnectionId` is only a preference to the shared selector: when
  // that account is locked or missing it deliberately falls back to another
  // account. Video jobs are account-bound, so polling with any other account
  // can never be correct and may disclose the opaque job id to that account.
  if (preferredConnectionId && credentials.connectionId !== preferredConnectionId) {
    return errorResponse(409, "Pinned video connection is unavailable");
  }

  let refreshedCredentials;
  try {
    refreshedCredentials = await awaitWithSignal(
      checkAndRefreshToken(provider, credentials),
      request.signal,
    );
  } catch (error) {
    if (request.signal?.aborted || error?.name === "AbortError") {
      return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    }
    throw error;
  }
  if (request.signal?.aborted) return errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");

  const mutationAttempt = beginAccountMutationAttempt(credentials.connectionId, VIDEO_LOCK_KEY);
  try {
    const result = await handleVideoProxyCore({
      provider,
      requestId,
      credentials: refreshedCredentials,
      signal: request.signal,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        });
      },
    });

    if (request.signal?.aborted || result.status === HTTP_STATUS.CLIENT_CLOSED_REQUEST) {
      return result.response || errorResponse(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    }
    if (result.success) {
      recordAccountMutationSuccess(mutationAttempt);
      observeAccountCleanup(
        () => clearAccountError(credentials.connectionId, credentials, VIDEO_LOCK_KEY, { mutationAttempt }),
        credentials.connectionId,
      );
      return withConnectionHeader(result.response, credentials.connectionId);
    }

    if (VIDEO_ACCOUNT_HEALTH_STATUSES.has(result.status)) {
      await markAccountUnavailable(
        credentials.connectionId,
        result.status,
        sanitizeSecrets(result.error, refreshedCredentials),
        provider,
        VIDEO_LOCK_KEY,
        null,
        { mutationAttempt },
      );
    }
    return result.response;
  } finally {
    endAccountMutationAttempt(mutationAttempt);
  }
}
