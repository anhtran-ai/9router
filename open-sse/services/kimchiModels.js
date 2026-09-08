import { createHash } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  awaitModelCatalogResponse,
  cancelModelCatalogBody,
  readModelCatalogJson,
} from "./modelCatalogResponse.js";

export const KIMCHI_API = "https://llm.kimchi.dev";
export const KIMCHI_USER_AGENT = "kimchi/0.1.40";

const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** @type {Map<string, { expiresAt: number, models: object[], rawModels: object[] }>} */
const catalogCache = new Map();
/** @type {Map<string, { controller: AbortController, promise: Promise<object | null>, waiters: number, settled: boolean }>} */
const catalogInflight = new Map();
let catalogCacheEpoch = 0;
/** @type {Map<string, object>} */
const metadataByModelId = new Map();

function callerAbortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Kimchi catalog request aborted", "AbortError");
}

function awaitWithCallerSignal(promise, signal) {
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
    return await awaitWithCallerSignal(entry.promise, signal);
  } finally {
    entry.waiters -= 1;
    if (entry.waiters === 0 && !entry.settled && !entry.controller.signal.aborted) {
      entry.controller.abort(new DOMException("Kimchi catalog has no active callers", "AbortError"));
    }
  }
}

function normalizeKimchiEndpoint(endpoint) {
  const raw = typeof endpoint === "string" ? endpoint.trim() : "";
  return (raw || KIMCHI_API).replace(/\/+$/, "");
}

export function buildKimchiModelsUrl(endpoint) {
  return `${normalizeKimchiEndpoint(endpoint)}/v1/models/metadata?include_in_cli=true`;
}

function readToken(credentials) {
  return (
    credentials?.accessToken
    || credentials?.apiKey
    || credentials?.providerSpecificData?.apiKey
    || null
  );
}

function cacheKey(credentials, endpoint) {
  const psd = credentials?.providerSpecificData || {};
  const seed = psd.userId || psd.username || credentials?.refreshToken || readToken(credentials) || "anonymous";
  return createHash("sha256")
    .update(`kimchi:${normalizeKimchiEndpoint(endpoint)}:${seed}`)
    .digest("hex");
}

function toModelKind(inputModalities) {
  return Array.isArray(inputModalities) && inputModalities.includes("image")
    ? "imageToText"
    : "llm";
}

export function normalizeKimchiModel(item) {
  if (!item || typeof item !== "object") return null;
  const id = item.slug || item.id || item.model || item.name;
  if (typeof id !== "string" || id.trim() === "") return null;

  const inputModalities = Array.isArray(item.input_modalities)
    ? item.input_modalities.filter((value) => value === "text" || value === "image")
    : [];
  const limits = item.limits && typeof item.limits === "object" ? item.limits : {};
  const contextLength = Number(limits.context_window || item.contextLength || item.context_length) || undefined;
  const maxOutputTokens = Number(limits.max_output_tokens || item.maxOutputTokens || item.max_output_tokens) || undefined;
  const upstreamProvider = typeof item.provider === "string" ? item.provider : "";
  const reasoning = item.reasoning === true;
  const kind = toModelKind(inputModalities);

  const model = {
    ...item,
    id: id.trim(),
    name: String(item.display_name || item.displayName || item.name || id).trim(),
    provider: upstreamProvider,
    upstreamProvider,
    reasoning,
    inputModalities,
    kind,
    type: kind,
    capabilities: {
      vision: inputModalities.includes("image"),
      reasoning,
      ...(contextLength ? { contextWindow: contextLength } : {}),
      ...(maxOutputTokens ? { maxOutput: maxOutputTokens } : {}),
      ...(upstreamProvider ? { upstreamProvider } : {}),
    },
    ...(contextLength ? { contextLength } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };

  if (upstreamProvider === "anthropic") {
    model.compat = { supportsReasoningEffort: false, cacheControlFormat: "anthropic" };
  }

  return model;
}

function rememberModels(models) {
  for (const model of models || []) {
    if (!model?.id) continue;
    metadataByModelId.set(model.id, model);
    metadataByModelId.set(model.id.toLowerCase(), model);
  }
}

export function getCachedKimchiModelMetadata(modelId) {
  if (typeof modelId !== "string" || modelId.trim() === "") return null;
  const raw = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  return metadataByModelId.get(raw) || metadataByModelId.get(raw.toLowerCase()) || null;
}

async function fetchKimchiCatalogRaw(token, endpoint, options = {}) {
  const url = buildKimchiModelsUrl(endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Kimchi models fetch timeout")), FETCH_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    const response = await awaitModelCatalogResponse(proxyAwareFetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": KIMCHI_USER_AGENT,
      },
      cache: "no-store",
      signal,
    }, options.proxyOptions || null), signal);

    if (!response.ok) {
      cancelModelCatalogBody(response);
      const error = new Error(`Kimchi models returned HTTP ${response.status}`);
      error.status = response.status;
      error.retryable = RETRYABLE_STATUSES.has(response.status);
      throw error;
    }

    const data = await readModelCatalogJson(response, { signal });
    return Array.isArray(data?.models) ? data.models : [];
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveKimchiModelsUncached(token, endpoint, options) {
  let rawModels;
  try {
    rawModels = await fetchKimchiCatalogRaw(token, endpoint, options);
  } catch (error) {
    options.log?.warn?.("KIMCHI_MODELS", "Kimchi catalog request failed");
    return null;
  }

  const models = rawModels.map(normalizeKimchiModel).filter(Boolean);
  if (models.length === 0) return null;

  return {
    expiresAt: Date.now() + CACHE_TTL_MS,
    models,
    rawModels,
  };
}

export async function resolveKimchiModels(credentials, options = {}) {
  const token = readToken(credentials);
  if (!token) return null;

  const endpoint = credentials?.providerSpecificData?.kimchiEndpoint || options.endpoint || KIMCHI_API;
  const key = cacheKey(credentials, endpoint);
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;
  }

  const existing = catalogInflight.get(key);
  if (existing && !existing.controller.signal.aborted && !options.forceRefresh) {
    try {
      return await waitForCatalog(existing, options.signal);
    } catch (error) {
      if (!options.signal?.aborted) {
        options.log?.warn?.("KIMCHI_MODELS", "Kimchi catalog request failed");
      }
      return null;
    }
  }

  const controller = new AbortController();
  const requestEpoch = catalogCacheEpoch;
  const entry = {
    controller,
    promise: null,
    waiters: 0,
    settled: false,
  };
  entry.promise = Promise.resolve()
    .then(() => resolveKimchiModelsUncached(token, endpoint, {
      ...options,
      signal: controller.signal,
    }))
    .then((result) => {
      if (
        result
        && requestEpoch === catalogCacheEpoch
        && catalogInflight.get(key) === entry
        && !controller.signal.aborted
      ) {
        rememberModels(result.models);
        catalogCache.set(key, result);
      }
      return result;
    });
  catalogInflight.set(key, entry);
  entry.promise.then(
    () => {
      entry.settled = true;
      if (catalogInflight.get(key) === entry) catalogInflight.delete(key);
    },
    () => {
      entry.settled = true;
      if (catalogInflight.get(key) === entry) catalogInflight.delete(key);
    },
  );

  try {
    return await waitForCatalog(entry, options.signal);
  } catch (error) {
    if (!options.signal?.aborted) {
      options.log?.warn?.("KIMCHI_MODELS", "Kimchi catalog request failed");
    }
    return null;
  }
}

export function clearKimchiCatalog() {
  catalogCacheEpoch += 1;
  if (!Number.isSafeInteger(catalogCacheEpoch)) catalogCacheEpoch = 1;
  catalogCache.clear();
  metadataByModelId.clear();
  catalogInflight.clear();
}
