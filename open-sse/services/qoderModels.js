/**
 * Qoder model catalog fetcher.
 *
 * Calls /algo/api/v2/model/list (COSY-signed) on the inference host to get
 * the live catalog for an authenticated Qoder account, then caches the
 * per-model `model_config` blocks by key. Chat requests later look up the
 * exact server-published metadata for the model they want — Qoder's chat
 * endpoint silently downgrades to a different model when the wrong
 * model_config is sent.
 *
 * On any error the live cache stays empty and chatExecuteCall surfaces the
 * problem to the user as "model config not yet fetched, retry shortly".
 *
 * PAT (Personal Access Token, pt-...) connections: a PAT cannot sign COSY
 * requests directly, so we exchange it for a short-lived job token (jt-...)
 * via openapi.qoder.sh/api/v1/jobToken/exchange (plain JSON POST), then use
 * that job token for signing. Job-token traffic must hit api2.qoder.sh —
 * api3 rejects jt- with "Login expired" (403).
 */

import { createHash } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import {
  cancelModelCatalogBody,
  readModelCatalogJson,
  readModelCatalogText,
} from "./modelCatalogResponse.js";
import {
  QODER_MODEL_LIST_URL,
  QODER_CHAT_BASE_ALT,
  QODER_JOB_TOKEN_EXCHANGE_URL,
  QODER_USERINFO_URL,
  QODER_IDE_VERSION,
  QODER_CLIENT_TYPE,
} from "../shared/qoder/constants.js";

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h, same as the Kiro catalog

const PAT_PREFIX = "pt-";

// PAT → job-token cache: a job token is short-lived (24h), so we keep it per
// PAT and re-exchange once it is within 5 minutes of expiry.
const PAT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PAT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

async function withQoderResponse(url, init, proxyOptions, outerSignal, consume) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Qoder model request timed out", "TimeoutError")),
    FETCH_TIMEOUT_MS,
  );
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, controller.signal])
    : controller.signal;
  let response;
  try {
    response = await proxyAwareFetch(url, { ...init, signal }, proxyOptions);
    return await consume(response, signal);
  } catch (error) {
    if (signal.aborted) {
      cancelModelCatalogBody(response, error);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function isQoderPat(token) {
  return typeof token === "string" && token.startsWith(PAT_PREFIX);
}

/** @type {Map<string, { accessToken: string, userId: string, expiresAt: number }>} */
const patJobCache = new Map();

/** @type {Map<string, { expiresAt: number, models: any[], rawConfigs: Map<string, object>, fetched: boolean }>} */
const catalogCache = new Map();

/**
 * In-flight fetch promises keyed by cacheKey. Concurrent first-time
 * callers (parallel chat windows) all observe the same Promise so we
 * fan-out exactly one upstream request per credential per miss.
 * @type {Map<string, {
 *   controller: AbortController,
 *   promise: Promise<{ expiresAt: number, models: any[], rawConfigs: Map<string, object>, fetched: boolean } | null>,
 *   waiters: number,
 *   settled: boolean,
 * }>}
 */
const inflight = new Map();

function callerAbortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException(
    signal?.reason == null ? "Qoder catalog request aborted" : String(signal.reason),
    "AbortError",
  );
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(callerAbortReason(signal));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, callerAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function waitForCatalog(entry, signal) {
  entry.waiters += 1;
  try {
    return await awaitWithSignal(entry.promise, signal);
  } finally {
    entry.waiters -= 1;
    if (entry.waiters === 0 && !entry.settled && !entry.controller.signal.aborted) {
      entry.controller.abort(new DOMException("Qoder catalog has no active callers", "AbortError"));
    }
  }
}

/**
 * Exchange a Qoder PAT (pt-...) for a short-lived job token (jt-...).
 * This endpoint is plain JSON POST — NOT COSY-signed.
 */
async function exchangeJobToken(pat, proxyOptions = null, signal = null) {
  return withQoderResponse(
    QODER_JOB_TOKEN_EXCHANGE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "qodercli/1.0.0",
        "Cosy-Version": QODER_IDE_VERSION,
        "Cosy-ClientType": QODER_CLIENT_TYPE,
      },
      body: JSON.stringify({ personal_token: pat }),
    },
    proxyOptions,
    signal,
    async (res, requestSignal) => {
      if (!res.ok) {
        const text = await readModelCatalogText(res, { signal: requestSignal }).catch((error) => {
          if (requestSignal.aborted) throw error;
          return "";
        });
        throw new Error(`qoder PAT exchange failed: ${res.status} ${text.slice(0, 200)}`);
      }
      const data = await readModelCatalogJson(res, { signal: requestSignal });
      if (!data.token) throw new Error("qoder PAT exchange returned no job token");

      let expiresAt = Date.now() + PAT_DEFAULT_TTL_MS;
      if (data.expires_at) {
        const parsed = Date.parse(data.expires_at);
        if (!Number.isNaN(parsed)) expiresAt = parsed;
      } else if (typeof data.expires_in === "number" && data.expires_in > 0) {
        // OAuth-style expires_in values are seconds (QoderService.parseExpiry
        // follows the same contract). Treating them as milliseconds causes a
        // normal 24-hour token to be re-exchanged on every request.
        expiresAt = Date.now() + data.expires_in * 1000;
      }
      return { jobToken: data.token, jobRefreshToken: data.refresh_token || "", expiresAt };
    },
  );
}

/**
 * Resolve the Qoder userId for a job token (needed for COSY signing).
 * Returns "" on any failure — callers fall back to the stored userId.
 */
async function fetchUserIdForJobToken(jobToken, proxyOptions = null, signal = null) {
  try {
    return await withQoderResponse(
      QODER_USERINFO_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jobToken}`,
          Accept: "application/json",
          "User-Agent": "qodercli/1.0.0",
        },
      },
      proxyOptions,
      signal,
      async (res, requestSignal) => {
        if (!res.ok) {
          cancelModelCatalogBody(res);
          return "";
        }
        const data = await readModelCatalogJson(res, { signal: requestSignal }).catch((error) => {
          if (requestSignal.aborted) throw error;
          return {};
        });
        return data.id || data.userId || data.user_id || "";
      },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return "";
  }
}

/**
 * Resolve a PAT to a job-token credential, cached per-PAT.
 */
async function resolvePatCredential(pat, proxyOptions = null, signal = null) {
  const cached = patJobCache.get(pat);
  if (cached && cached.expiresAt - Date.now() > PAT_REFRESH_BUFFER_MS) {
    if (cached.userId) return cached;
    // A transient userinfo failure must not poison the PAT cache for the
    // entire job-token lifetime. Reuse the token but retry only userinfo.
    const userId = await fetchUserIdForJobToken(cached.accessToken, proxyOptions, signal);
    if (userId) {
      const recovered = { ...cached, userId };
      patJobCache.set(pat, recovered);
      return recovered;
    }
    return cached;
  }

  const { jobToken, expiresAt } = await exchangeJobToken(pat, proxyOptions, signal);
  const userId = await fetchUserIdForJobToken(jobToken, proxyOptions, signal);
  const resolved = { accessToken: jobToken, userId, expiresAt };
  patJobCache.set(pat, resolved);
  return resolved;
}

/**
 * Resolve connection credentials to COSY-signable form:
 *   - PAT (pt-...) connections → exchanged to a job token (jt-...) + userId
 *   - everything else → passed through unchanged
 */
export async function resolveQoderCredentials(credentials, proxyOptions = null, signal = null) {
  const raw = credentials?.apiKey || credentials?.accessToken;
  if (isQoderPat(raw)) {
    const resolved = await resolvePatCredential(raw, proxyOptions, signal);
    return {
      ...credentials,
      accessToken: resolved.accessToken,
      apiKey: undefined,
      providerSpecificData: {
        authMethod: "pat",
        ...(credentials?.providerSpecificData || {}),
        userId: resolved.userId || credentials?.providerSpecificData?.userId || "",
        machineId: credentials?.providerSpecificData?.machineId || "",
      },
    };
  }
  return credentials;
}

/**
 * Stable cache key per credential (so different login sessions for the same
 * account share an entry).
 */
function cacheKey(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const seed = psd.userId || credentials?.refreshToken || credentials?.accessToken || "anonymous";
  return createHash("sha256").update(`qoder:${seed}`).digest("hex");
}

/**
 * Strip credential -> COSY creds for buildCosyHeaders.
 */
function cosyCredsFromConnection(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return {
    userId: psd.userId,
    authToken: credentials.accessToken,
    name: credentials.displayName || "",
    email: credentials.email || "",
    machineId: psd.machineId || "",
  };
}

/**
 * Fetch the live model list for this credential. Returns:
 *   { models: [{ id, name, contextLength, isVL, isReasoning, ... }, ...],
 *     rawConfigs: Map<modelKey, modelConfigObject> }
 * or `null` on any error.
 */
async function fetchQoderCatalogRaw(credentials, signal, proxyOptions = null) {
  const creds = cosyCredsFromConnection(credentials);
  if (!creds.userId || !creds.authToken) return null;

  // Job-token traffic is rejected by api3 ("Login expired" 403) — the
  // official qodercli serves it from api2 instead.
  const modelListUrl = String(creds.authToken).startsWith("jt-")
    ? `${QODER_CHAT_BASE_ALT}/algo/api/v2/model/list`
    : QODER_MODEL_LIST_URL;

  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    ...buildCosyHeaders(Buffer.alloc(0), modelListUrl, creds),
  };

  const controller = new AbortController();
  let timer = null;
  let abortListener = null;
  let response;
  try {
    timer = setTimeout(
      () => controller.abort(new DOMException("Qoder model catalog timed out", "TimeoutError")),
      FETCH_TIMEOUT_MS,
    );
    if (signal && typeof signal.addEventListener === "function") {
      // If the parent signal already aborted before we got here, the
      // 'abort' event has already fired and addEventListener won't
      // re-trigger it. Propagate the cancellation immediately.
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        abortListener = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abortListener);
      }
    }
    response = await proxyAwareFetch(
      modelListUrl,
      {
        method: "GET",
        headers,
        signal: controller.signal,
      },
      proxyOptions,
    );
    if (!response.ok) {
      cancelModelCatalogBody(response);
      return null;
    }

    // Keep the same deadline active while consuming the body. A peer can send
    // headers immediately and otherwise hold this first-use catalog lookup
    // open forever.
    const body = await readModelCatalogJson(response, { signal: controller.signal }).catch((error) => {
      if (controller.signal.aborted) throw error;
      return null;
    });
    if (!body || !Array.isArray(body.chat)) return null;

    const models = [];
    const rawConfigs = new Map();
    for (const entry of body.chat) {
      if (!entry || typeof entry !== "object") continue;
      const key = entry.key;
      if (!key) continue;

      // Always cache the config — chat needs model_config even for UI-hidden
      // models (enable:false). Upstream still accepts chat for these keys.
      rawConfigs.set(key, entry);
      if (entry.enable === false) continue;

      const display = entry.display_name || key;
      const ctx = Number(entry.max_input_tokens) || 131_072;
      models.push({
        id: key,
        name: `${display}`,
        contextLength: ctx,
        isVL: !!entry.is_vl,
        isReasoning: !!entry.is_reasoning,
        maxOutputTokens: Number(entry.max_output_tokens) || 0,
        description: entry.description || "",
      });
    }

    return { models, rawConfigs };
  } catch (error) {
    if (controller.signal.aborted) {
      cancelModelCatalogBody(response, error);
    }
    if (signal?.aborted) throw error;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

/**
 * Get the cached model_config block for a given model key, fetching the
 * catalog first if needed. Returns null when the catalog can't be fetched
 * (so callers can fall back to the static registry).
 */
export async function getQoderModelConfig(credentials, modelKey, options = {}) {
  const cached = await resolveQoderModels(credentials, options);
  if (!cached) return null;
  const config = cached.rawConfigs.get(modelKey);
  if (!config) return null;
  // Defensive copy — chat code may mutate `key` to align with the alias path.
  return { ...config, key: modelKey };
}

/**
 * Resolve the live model catalog + raw configs for a credential. Caches
 * results for CACHE_TTL_MS so repeated chat requests don't re-fetch, and
 * deduplicates concurrent misses so parallel chat windows fan-out exactly
 * one upstream request per credential.
 */
export async function resolveQoderModels(credentials, options = {}) {
  let resolved;
  try {
    resolved = await resolveQoderCredentials(credentials, options.proxyOptions, options.signal);
  } catch (error) {
    options.log?.warn?.("QODER", `PAT exchange failed: ${error.message}`);
    return null;
  }
  if (!resolved?.accessToken || !(resolved.providerSpecificData || {}).userId) return null;

  const key = cacheKey(resolved);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached;
    }
  }

  // Coalesce concurrent misses on the same credential into one upstream call.
  // forceRefresh callers still get their own fetch (they wanted fresh data).
  const existing = inflight.get(key);
  if (existing && !existing.controller.signal.aborted && !options.forceRefresh) {
    return waitForCatalog(existing, options.signal);
  }

  // The shared transport has its own signal. Each caller races the shared
  // Promise against its own signal; one disconnected caller must not cancel a
  // catalog fetch still needed by another waiter.
  const controller = new AbortController();
  const entry = {
    controller,
    waiters: 0,
    settled: false,
    promise: null,
  };
  entry.promise = (async () => {
    const fetched = await fetchQoderCatalogRaw(resolved, controller.signal, options.proxyOptions);
    if (!fetched) return null;
    const cachedEntry = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      models: fetched.models,
      rawConfigs: fetched.rawConfigs,
      fetched: true,
    };
    // A later forceRefresh may supersede this transport. Do not let the older
    // response finish last and overwrite the fresher cache entry.
    if (inflight.get(key) === entry) catalogCache.set(key, cachedEntry);
    return cachedEntry;
  })();

  inflight.set(key, entry);
  entry.promise.then(
    () => {
      entry.settled = true;
      if (inflight.get(key) === entry) inflight.delete(key);
    },
    () => {
      entry.settled = true;
      if (inflight.get(key) === entry) inflight.delete(key);
    },
  );

  try {
    return await waitForCatalog(entry, options.signal);
  } finally {
    // A forceRefresh may have replaced an older entry while it was running.
    // Only the entry currently registered for this key may clear the map.
    if (entry.settled && inflight.get(key) === entry) {
      inflight.delete(key);
    }
  }
}

export function invalidateQoderCatalog(credentials) {
  if (!credentials) return;
  const key = cacheKey(credentials);
  catalogCache.delete(key);
  // Existing callers may finish normally, but the identity guard above keeps
  // this invalidated response from repopulating the cache.
  inflight.delete(key);
}

export function clearQoderCatalog() {
  catalogCache.clear();
  patJobCache.clear();
  // Do not fail callers already awaiting a response. Detaching the entries is
  // enough to stop those older responses from repopulating the cleared cache.
  inflight.clear();
}
