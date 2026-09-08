/**
 * Search Dispatcher — routes /v1/search requests to dedicated search APIs
 * or chat-based LLM search wrappers, with retry-friendly error envelope.
 *
 * Dependency map:
 *   provider.searchConfig    → dedicated search API (callers + normalizers)
 *   provider.searchViaChat   → wrap chat-completions (chatSearch.js)
 */

import { buildSearchRequest } from "./callers.js";
import { normalizeSearchResponse } from "./normalizers.js";
import { handleChatSearch } from "./chatSearch.js";
import { fetchPublic } from "../../../src/shared/utils/ssrfGuard.js";

const GLOBAL_TIMEOUT_MS = 15000;
const MAX_SEARCH_RESPONSE_BYTES = 16 * 1024 * 1024;
const NON_RETRIABLE = new Set([400, 401, 403, 404, 499]);

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/** Normalize and validate query string. */
function sanitizeQuery(query) {
  if (CONTROL_CHAR_RE.test(query)) return { error: "Query contains invalid control characters" };
  const clean = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!clean) return { error: "Query is empty after normalization" };
  return { clean };
}

// Strip non-ASCII chars from header values (HTTP headers must be ByteString).
function sanitizeHeaders(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = typeof v === "string" ? v.replace(/[^\x00-\xFF]/g, "").trim() : v;
  }
  return out;
}

function discardResponseBody(response) {
  if (!response?.body || response.bodyUsed === true) return;
  try {
    const cancellation = response.body.cancel();
    cancellation?.catch?.(() => {});
  } catch { /* best-effort connection release */ }
}

function cancelReader(reader) {
  let cancellation;
  try {
    cancellation = reader.cancel();
  } catch {
    releaseReader(reader);
    return;
  }
  Promise.resolve(cancellation).catch(() => {}).finally(() => releaseReader(reader));
}

function releaseReader(reader) {
  try { reader.releaseLock?.(); } catch { /* a pending read releases after cancellation settles */ }
}

function runWithSignal(operation, signal) {
  const getAbortReason = () => signal.reason instanceof Error
    ? signal.reason
    : new DOMException("aborted", "AbortError");
  if (signal.aborted) return Promise.reject(getAbortReason());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, getAbortReason());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function responseTooLargeError() {
  const error = new Error("Upstream search response body is too large");
  error.code = "UPSTREAM_BODY_TOO_LARGE";
  return error;
}

function upstreamErrorMessage(data) {
  if (!data || typeof data !== "object") return null;
  const failedStatus = typeof data.status === "string"
    && ["error", "failed", "failure", "cancelled", "canceled"].includes(data.status.toLowerCase());
  const explicitFailure = data.success === false || data.ok === false || failedStatus;
  const error = data.error;
  if (error != null && error !== false && error !== "") {
    if (typeof error === "string") return error;
    if (typeof error?.message === "string" && error.message.trim()) return error.message;
    try { return JSON.stringify(error); } catch { return "Upstream returned an error payload"; }
  }
  if (explicitFailure) {
    return typeof data.message === "string" && data.message.trim()
      ? data.message
      : "Upstream reported an unsuccessful search";
  }
  return null;
}

function hasExpectedDedicatedEnvelope(providerId, data, searchType) {
  if (providerId === "ollama-search") {
    return Array.isArray(data) || (!!data && typeof data === "object" && Array.isArray(data.results));
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  switch (providerId) {
    case "serper":
      return Array.isArray(searchType === "news" ? data.news : data.organic)
        || !!data.searchParameters;
    case "brave-search":
      return !!(searchType === "news" ? data.news || data.results : data.web);
    case "perplexity":
    case "exa":
    case "tavily":
    case "linkup":
    case "searxng":
      return Array.isArray(data.results);
    case "google-pse":
      return Array.isArray(data.items) || !!data.searchInformation || !!data.queries;
    case "searchapi":
      return Array.isArray(data.organic_results)
        || Array.isArray(data.top_stories)
        || !!data.search_information;
    case "youcom":
      return !!data.results && typeof data.results === "object";
    case "xquik":
      return Array.isArray(data.tweets);
    case "glm":
      return Array.isArray(data.results)
        || Array.isArray(data.news)
        || Array.isArray(data.result?.content);
    default:
      return false;
  }
}

async function readBoundedText(response, signal) {
  if (!response?.body?.getReader) {
    const text = typeof response?.text === "function"
      ? await runWithSignal(() => response.text(), signal)
      : JSON.stringify(await runWithSignal(() => response.json(), signal));
    if (new TextEncoder().encode(text).byteLength > MAX_SEARCH_RESPONSE_BYTES) {
      throw responseTooLargeError();
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await runWithSignal(() => reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SEARCH_RESPONSE_BYTES) {
        throw responseTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    releaseReader(reader);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: response.ok }).decode(bytes);
}

/** Build a JSON Response wrapper used by the auth layer. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

/** Wrap an error result with a Response object so the auth wrapper can return it directly. */
function errorResult(status, error) {
  return {
    success: false,
    status,
    error,
    response: jsonResponse({ error: { message: error, code: status } }, status)
  };
}

/** Wrap a success payload. */
function successResult(data) {
  return { success: true, data, response: jsonResponse(data, 200) };
}

/**
 * Run a single dedicated search provider attempt.
 * @returns {Promise<{success:boolean, status?:number, error?:string, data?:object}>}
 */
async function tryDedicatedProvider({ provider, providerConfig, body, credentials, log, globalStartTime, signal: outerSignal }) {
  const startTime = Date.now();
  const token = credentials?.apiKey || credentials?.accessToken || undefined;

  if (providerConfig.authType !== "none" && !token) {
    return { success: false, status: 401, error: `No credentials for provider: ${provider.id}` };
  }

  const params = {
    query: body.query,
    searchType: body.search_type || (providerConfig.searchTypes?.[0] || "web"),
    maxResults: Math.min(body.max_results || providerConfig.defaultMaxResults || 5, providerConfig.maxMaxResults || 100),
    token,
    country: body.country,
    language: body.language,
    timeRange: body.time_range,
    offset: body.offset,
    domainFilter: body.domain_filter,
    contentOptions: body.content_options,
    providerOptions: body.provider_options,
    providerSpecificData: credentials?.providerSpecificData
  };

  let url, init;
  try {
    ({ url, init } = buildSearchRequest({ id: provider.id, ...providerConfig }, params));
  } catch (err) {
    return { success: false, status: 400, error: err?.message || `Invalid request for ${provider.id}` };
  }

  // Timeout = min(provider timeout, remaining global)
  const remaining = GLOBAL_TIMEOUT_MS - (Date.now() - globalStartTime);
  if (remaining <= 0) return { success: false, status: 504, error: `${provider.id} timeout: global search deadline exceeded` };
  const timeout = Math.min(providerConfig.timeoutMs || 10000, Math.max(remaining, 1));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, controller.signal])
    : controller.signal;

  log?.info?.("SEARCH", `${provider.id} | "${params.query.slice(0, 80)}" | type=${params.searchType}`);

  let resp;
  try {
    resp = await fetchPublic(url, { ...init, headers: sanitizeHeaders(init.headers), signal });
    if (!resp.ok) {
      let errText = "";
      try {
        errText = await readBoundedText(resp, signal);
      } catch (error) {
        // A timeout while reading an error body is still a timeout. Swallowing
        // it would report the upstream status and leave the body deadline
        // unenforced.
        if (signal.aborted || error?.code === "UPSTREAM_BODY_TOO_LARGE") throw error;
      }
      log?.error?.("SEARCH", `${provider.id} ${resp.status}: ${errText.slice(0, 200)}`);
      return { success: false, status: resp.status, error: `${provider.id} returned ${resp.status}: ${errText.slice(0, 200)}` };
    }
    const responseText = await readBoundedText(resp, signal);
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error("Upstream search response is not valid JSON");
    }
    const embeddedError = upstreamErrorMessage(data);
    if (embeddedError) {
      throw new Error(`Upstream search error: ${embeddedError}`);
    }
    if (!hasExpectedDedicatedEnvelope(provider.id, data, params.searchType)) {
      throw new Error(`Invalid upstream search response envelope for ${provider.id}`);
    }
    const normalized = normalizeSearchResponse(provider.id, data, params.query, params.searchType);
    if (!normalized || !Array.isArray(normalized.results)) {
      throw new Error(`Invalid normalized search response for ${provider.id}`);
    }
    const results = normalized.results.slice(0, params.maxResults);
    const duration = Date.now() - startTime;
    const usage = {
      queries_used: 1,
      search_cost_usd: providerConfig.costPerQuery ?? null,
    };
    if (Number.isFinite(providerConfig.creditsPerResult)) {
      usage.provider_credits_used = results.length * providerConfig.creditsPerResult;
    }

    return {
      success: true,
      data: {
        provider: provider.id,
        query: params.query,
        results,
        answer: null,
        usage,
        ...(normalized.pagination ? { pagination: normalized.pagination } : {}),
        metrics: { response_time_ms: duration, upstream_latency_ms: duration, total_results_available: normalized.totalResults },
        errors: []
      }
    };
  } catch (err) {
    await discardResponseBody(resp);
    const clientAborted = outerSignal?.aborted;
    const isTimeout = !clientAborted && (controller.signal.aborted || err.name === "AbortError");
    const status = clientAborted ? 499 : isTimeout ? 504 : 502;
    log?.error?.("SEARCH", `${provider.id} ${isTimeout ? "timeout" : "error"}: ${err.message}`);
    return { success: false, status, error: `${provider.id} ${isTimeout ? "timeout" : "error"}: ${err.message}` };
  } finally {
    // Keep the deadline active through response-body consumption and parsing,
    // not only until the upstream response headers arrive.
    clearTimeout(timer);
  }
}

/**
 * Core search handler. Dispatches to dedicated API or chat-based LLM.
 * Same calling convention as handleEmbeddingsCore: returns `{success, response, status?, error?}`.
 *
 * @param {object}   options
 * @param {object}   options.body            Sanitized body from auth wrapper
 * @param {object}   options.provider        Provider entry from AI_PROVIDERS
 * @param {object}   [options.providerConfig] Provider's searchConfig (if dedicated)
 * @param {object|null} options.credentials  Provider credentials
 * @param {object}   [options.log]           Logger
 */
export async function handleSearchCore({ body, provider, providerConfig, credentials, log, signal = null }) {
  const globalStartTime = Date.now();

  // 1. Sanitize query
  const { clean, error: sanitizeError } = sanitizeQuery(body.query || "");
  if (sanitizeError) return errorResult(400, sanitizeError);
  const normalizedBody = { ...body, query: clean };

  // 2. Route: dedicated search API takes priority over chat-based
  let result;
  if (providerConfig) {
    result = await tryDedicatedProvider({
      provider,
      providerConfig,
      body: normalizedBody,
      credentials,
      log,
      globalStartTime,
      signal,
    });
  } else if (provider.searchViaChat) {
    result = await handleChatSearch({
      provider: provider.id,
      query: clean,
      maxResults: normalizedBody.max_results,
      model: provider.searchViaChat.defaultModel,
      credentials,
      log,
      signal,
      timeoutMs: Math.max(1, GLOBAL_TIMEOUT_MS - (Date.now() - globalStartTime)),
    });
  } else {
    return errorResult(400, `Provider ${provider.id} does not support web search`);
  }

  if (result.success) return successResult(result.data);

  // 3. Failover within global timeout for retriable errors
  if (
    !NON_RETRIABLE.has(result.status || 0) &&
    Date.now() - globalStartTime < GLOBAL_TIMEOUT_MS &&
    provider.searchViaChat &&
    providerConfig
  ) {
    log?.warn?.("SEARCH", `${provider.id} dedicated failed (${result.status}), falling back to chat-based search`);
    const remaining = GLOBAL_TIMEOUT_MS - (Date.now() - globalStartTime);
    if (remaining <= 0) return errorResult(504, "Global search deadline exceeded");
    const fallback = await handleChatSearch({
      provider: provider.id,
      query: clean,
      maxResults: normalizedBody.max_results,
      model: provider.searchViaChat.defaultModel,
      credentials,
      log,
      signal,
      timeoutMs: remaining,
    });
    if (fallback.success) return successResult(fallback.data);
  }

  return errorResult(result.status || 502, result.error || "Search failed");
}
