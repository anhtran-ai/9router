/**
 * Wrap chat-completions endpoints (with built-in web search) into the unified
 * /v1/search response format. Supports gemini, antigravity, openai, xai, kimi,
 * minimax, perplexity.
 */
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { ANTIGRAVITY_IDE_USER_AGENT } from "../../providers/shared.js";

// Default search model + endpoint derive from registry searchViaChat (single source)
const searchModel = (id) => PROVIDER_MEDIA[id]?.searchViaChat?.defaultModel;
const searchEndpoint = (id, model) =>
  (PROVIDER_MEDIA[id]?.searchViaChat?.endpoint || "").replace("{model}", model || "");

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 10;
const MAX_CHAT_SEARCH_RESPONSE_BYTES = 16 * 1024 * 1024;

function chatSearchBodyTooLargeError() {
  const error = new Error("Upstream chat-search response body is too large");
  error.code = "UPSTREAM_BODY_TOO_LARGE";
  return error;
}

function releaseReader(reader) {
  try { reader?.releaseLock?.(); } catch { /* a pending read releases after cancellation settles */ }
}

function cancelReader(reader, reason) {
  let cancellation;
  try {
    cancellation = reader?.cancel?.(reason);
  } catch {
    releaseReader(reader);
    return;
  }
  Promise.resolve(cancellation).catch(() => {}).finally(() => releaseReader(reader));
}

function discardResponseBody(response, reason) {
  if (!response?.body || response.bodyUsed === true) return;
  try {
    const cancellation = response.body.cancel(reason);
    cancellation?.catch?.(() => {});
  } catch { /* best-effort connection release */ }
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

function hasExpectedChatEnvelope(provider, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (provider === "gemini") return !!data.candidates?.[0]?.content;
  if (provider === "antigravity") {
    const response = data.response || data;
    return !!response?.candidates?.[0]?.content;
  }
  if (["openai", "kimi", "minimax", "perplexity"].includes(provider)) {
    return !!data.choices?.[0]?.message;
  }
  if (["xai", "perplexity-agent"].includes(provider)) {
    return Array.isArray(data.output) && data.output.length > 0;
  }
  return false;
}

function runWithSignal(operation, signal) {
  const reason = () => signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
  if (signal?.aborted) return Promise.reject(reason());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, reason());
    signal?.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve().then(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function readBoundedJson(response, signal) {
  const declaredLength = response?.headers?.get?.("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_CHAT_SEARCH_RESPONSE_BYTES) {
    discardResponseBody(response, chatSearchBodyTooLargeError());
    throw chatSearchBodyTooLargeError();
  }

  if (!response?.body?.getReader) {
    const data = await runWithSignal(() => response.json(), signal);
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_CHAT_SEARCH_RESPONSE_BYTES) {
      throw chatSearchBodyTooLargeError();
    }
    return data;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await runWithSignal(() => reader.read(), signal);
      if (done) break;
      total += value?.byteLength || 0;
      if (total > MAX_CHAT_SEARCH_RESPONSE_BYTES) throw chatSearchBodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader, error);
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: response.ok }).decode(bytes));
}

/**
 * Normalize a citation entry into the unified result shape.
 * @param {{url:string, title?:string, snippet?:string}} c
 * @param {number} index
 * @param {string} provider
 * @param {string} retrievedAt
 */
function toResult(c, index, provider, retrievedAt) {
  return {
    title: c.title || "",
    url: c.url,
    snippet: c.snippet || "",
    position: index + 1,
    score: null,
    published_at: null,
    favicon_url: null,
    content: c.content || null,
    metadata: {},
    citation: { provider, retrieved_at: retrievedAt, rank: index + 1 },
    provider_raw: null
  };
}

// Antigravity search request envelope (mirrors the IDE client)
const AG_CLIENT_NAME = "antigravity";
const AG_SEARCH_GENERATION_CONFIG = { temperature: 1.0, maxOutputTokens: 8192 };
const AG_CONTEXT_BEFORE = 150;
const AG_CONTEXT_AFTER = 250;

/** Widen a grounded segment to its surrounding sentence(s) in the answer text. */
function expandSegment(text, segment) {
  const { startIndex, endIndex } = segment || {};
  if (!text || !Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return "";
  const start = Math.max(0, startIndex - AG_CONTEXT_BEFORE);
  const end = Math.min(text.length, endIndex + AG_CONTEXT_AFTER);
  let out = text.slice(start, end).trim();
  // Drop the partial words the window cut off at either edge
  if (start > 0) out = `...${out.replace(/^\S+/, "")}`;
  if (end < text.length) out = `${out.replace(/\S+$/, "")}...`;
  return out.trim();
}

/** Join deduped grounding pieces, skipping empties. */
function joinPieces(set, sep) {
  return [...(set || [])].filter(Boolean).join(sep).trim();
}

/** Coerce a citation that might be a raw URL string or an object. */
function normalizeCitation(c) {
  if (!c) return null;
  if (typeof c === "string") return { url: c };
  if (typeof c === "object" && c.url) return c;
  return null;
}

/**
 * Provider-specific configuration map. All providers must implement:
 * { endpoint, defaultModel, buildBody, buildHeaders, extractAnswer }
 * Optional: requireCredentials(credentials) → error string when a provider needs
 * more than a token (returns null when satisfied).
 */
const CHAT_SEARCH_CONFIG = {
  gemini: {
    endpoint: (model) => searchEndpoint("gemini", model),
    buildBody: (query) => ({
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ google_search: {} }]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      "x-goog-api-key": token
    }),
    extractAnswer: (data) => {
      const candidate = data?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const text = parts.map((p) => p?.text || "").filter(Boolean).join("");
      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      const citations = chunks
        .map((ch) => ch?.web)
        .filter(Boolean)
        .map((w) => ({ url: w.uri || w.url, title: w.title || "" }))
        .filter((c) => c.url);
      const tokens = data?.usageMetadata?.totalTokenCount || 0;
      return { text, citations, tokens };
    }
  },

  antigravity: {
    endpoint: () => searchEndpoint("antigravity"),
    // Upstream 403s on a missing or fabricated project — surface the real cause
    requireCredentials: (credentials) =>
      credentials?.projectId ? null : "Antigravity account has no projectId — reconnect the account",
    buildBody: (query, model, credentials) => ({
      project: credentials.projectId,
      model,
      userAgent: AG_CLIENT_NAME,
      requestType: "search",
      request: {
        contents: [{ role: "user", parts: [{ text: query }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: AG_SEARCH_GENERATION_CONFIG
      }
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT
    }),
    extractAnswer: (data) => {
      // Antigravity wraps the Gemini payload in { response: {...} }
      const response = data?.response || data;
      const candidate = response?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const text = parts.map((p) => p?.text || "").filter(Boolean).join("");
      const grounding = candidate?.groundingMetadata || {};
      const chunks = grounding.groundingChunks || [];
      const supports = grounding.groundingSupports || [];

      // Upstream repeats the same source across chunks — key by URL so it stays one citation.
      // Map, not a plain object: both the index and the URL come from upstream.
      const sources = new Map();
      const byIndex = chunks.map((ch) => {
        const web = ch?.web;
        const url = web?.uri || web?.url || "";
        if (!url) return null;
        if (!sources.has(url)) sources.set(url, { title: web.title || "", snippets: new Set(), contexts: new Set() });
        return sources.get(url);
      });

      // Each support ties a sentence of the answer back to the chunks that grounded it
      for (const s of supports) {
        const segment = s?.segment;
        const grounded = segment?.text || "";
        const expanded = expandSegment(text, segment) || grounded;
        for (const idx of s?.groundingChunkIndices || []) {
          const source = Number.isInteger(idx) ? byIndex[idx] : null;
          if (!source) continue;
          if (grounded) source.snippets.add(grounded);
          if (expanded) source.contexts.add(expanded);
        }
      }

      const citations = [...sources].map(([url, src]) => {
        const snippet = joinPieces(src.snippets, " | ") || src.title;
        return { url, title: src.title, snippet, content: joinPieces(src.contexts, "\n\n") || snippet };
      });

      const tokens = response?.usageMetadata?.totalTokenCount || 0;
      return { text, citations, tokens };
    }
  },

  openai: {
    endpoint: () => searchEndpoint("openai"),
    buildBody: (query, model) => {
      const body = {
        model,
        messages: [{ role: "user", content: query }]
      };
      // Non-search-preview models need explicit web_search tool
      if (!/search/i.test(model)) {
        body.tools = [{ type: "web_search" }];
      }
      return body;
    },
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
      const fromAnn = annotations
        .map((a) => a?.url_citation)
        .filter(Boolean)
        .map((u) => ({ url: u.url, title: u.title || "" }));
      const fromTop = Array.isArray(data?.citations)
        ? data.citations.map(normalizeCitation).filter(Boolean)
        : [];
      const citations = fromAnn.length ? fromAnn : fromTop;
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  },

  xai: {
    endpoint: () => searchEndpoint("xai"),
    buildBody: (query, model) => ({
      model,
      input: [{ role: "user", content: query }],
      tools: [{ type: "web_search" }]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      // /v1/responses returns output[] array of message/tool blocks
      const output = Array.isArray(data?.output) ? data.output : [];
      let text = "";
      const citations = [];
      for (const item of output) {
        const parts = Array.isArray(item?.content) ? item.content : [];
        for (const p of parts) {
          if (typeof p?.text === "string") text += p.text;
          const anns = Array.isArray(p?.annotations) ? p.annotations : [];
          for (const a of anns) {
            const c = normalizeCitation(a?.url ? a : a?.url_citation);
            if (c) citations.push(c);
          }
        }
      }
      // Fallback: top-level citations array (some response variants)
      if (!citations.length && Array.isArray(data?.citations)) {
        for (const c of data.citations) {
          const n = normalizeCitation(c);
          if (n) citations.push(n);
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  },

  kimi: {
    endpoint: () => searchEndpoint("kimi"),
    buildBody: (query, model) => ({
      model,
      messages: [{ role: "user", content: query }],
      tools: [
        { type: "builtin_function", function: { name: "$web_search" } }
      ]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const citations = [];
      for (const call of calls) {
        const argStr = call?.function?.arguments;
        if (!argStr) continue;
        let parsed;
        try {
          parsed = typeof argStr === "string" ? JSON.parse(argStr) : argStr;
        } catch {
          continue;
        }
        const items =
          parsed?.search_results ||
          parsed?.results ||
          parsed?.references ||
          [];
        if (Array.isArray(items)) {
          for (const it of items) {
            const url = it?.url || it?.link;
            if (!url) continue;
            citations.push({
              url,
              title: it.title || "",
              snippet: it.snippet || it.summary || ""
            });
          }
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  },

  minimax: {
    endpoint: () => searchEndpoint("minimax"),
    buildBody: (query, model) => ({
      model,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search" }]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const citations = [];
      const direct = Array.isArray(data?.web_search_results)
        ? data.web_search_results
        : [];
      for (const it of direct) {
        const url = it?.url || it?.link;
        if (url) {
          citations.push({
            url,
            title: it.title || "",
            snippet: it.snippet || it.summary || ""
          });
        }
      }
      if (!citations.length) {
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const call of calls) {
          const argStr = call?.function?.arguments;
          if (!argStr) continue;
          let parsed;
          try {
            parsed = typeof argStr === "string" ? JSON.parse(argStr) : argStr;
          } catch {
            continue;
          }
          const items = parsed?.results || parsed?.search_results || [];
          if (Array.isArray(items)) {
            for (const it of items) {
              const url = it?.url || it?.link;
              if (!url) continue;
              citations.push({
                url,
                title: it.title || "",
                snippet: it.snippet || ""
              });
            }
          }
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  },

  perplexity: {
    endpoint: () => searchEndpoint("perplexity"),
    buildBody: (query, model) => ({
      model,
      messages: [{ role: "user", content: query }]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const raw = data?.citations || [];
      const citations = Array.isArray(raw)
        ? raw.map(normalizeCitation).filter(Boolean)
        : [];
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  },

  "perplexity-agent": {
    endpoint: () => searchEndpoint("perplexity-agent"),
    buildBody: (query, model) => ({
      model,
      input: query,
      tools: [{ type: "web_search" }]
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }),
    extractAnswer: (data) => {
      const output = Array.isArray(data?.output) ? data.output : [];
      let text = "";
      const citations = [];
      for (const item of output) {
        const parts = Array.isArray(item?.content) ? item.content : [];
        for (const p of parts) {
          if (typeof p?.text === "string") text += p.text;
          const anns = Array.isArray(p?.annotations) ? p.annotations : [];
          for (const a of anns) {
            const c = normalizeCitation(a?.url ? a : a?.url_citation);
            if (c) citations.push(c);
          }
        }
        const results = Array.isArray(item?.results) ? item.results : [];
        for (const r of results) {
          const url = r?.url || r?.link;
          if (!url) continue;
          citations.push({
            url,
            title: r?.title || "",
            snippet: r?.snippet || ""
          });
        }
      }
      if (!citations.length && Array.isArray(data?.citations)) {
        for (const c of data.citations) {
          const n = normalizeCitation(c);
          if (n) citations.push(n);
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    }
  }
};

/**
 * Execute a chat-search request against the chosen provider.
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.query
 * @param {number} [params.maxResults]
 * @param {string} [params.model]
 * @param {{apiKey?:string, accessToken?:string}} params.credentials
 * @param {{info?:Function, warn?:Function, error?:Function}} [params.log]
 * @returns {Promise<{success:boolean, status?:number, error?:string, data?:object}>}
 */
export async function handleChatSearch({
  provider,
  query,
  maxResults,
  model,
  credentials,
  log,
  signal: outerSignal = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const startTime = Date.now();
  const cfg = CHAT_SEARCH_CONFIG[provider];

  if (!cfg) {
    return {
      success: false,
      status: 400,
      error: `Unsupported chat-search provider: ${provider}`
    };
  }

  if (!query || typeof query !== "string") {
    return { success: false, status: 400, error: "Missing query" };
  }

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return {
      success: false,
      status: 401,
      error: "Missing credentials (apiKey or accessToken)"
    };
  }

  const credentialError = cfg.requireCredentials?.(credentials);
  if (credentialError) {
    return { success: false, status: 401, error: credentialError };
  }

  const limit =
    Number.isFinite(maxResults) && maxResults > 0
      ? Math.floor(maxResults)
      : DEFAULT_MAX_RESULTS;
  const useModel = model || searchModel(provider);
  const url = cfg.endpoint(useModel);
  const body = cfg.buildBody(query, useModel, credentials);
  const headers = cfg.buildHeaders(token);

  const controller = new AbortController();
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.floor(timeoutMs))
    : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), boundedTimeout);
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, controller.signal])
    : controller.signal;

  let upstreamStart = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (outerSignal?.aborted) {
      return { success: false, status: 499, error: "Client closed request" };
    }
    if (controller.signal.aborted || err?.name === "AbortError") {
      log?.warn?.(`[chatSearch] timeout provider=${provider}`);
      return { success: false, status: 504, error: "Upstream timeout" };
    }
    log?.error?.(`[chatSearch] network error provider=${provider}: ${err?.message}`);
    return {
      success: false,
      status: 502,
      error: `Network error: ${err?.message || "unknown"}`
    };
  }
  const upstreamLatency = Date.now() - upstreamStart;

  let data;
  try {
    data = await readBoundedJson(resp, signal);
  } catch (err) {
    discardResponseBody(resp, err);
    clearTimeout(timer);
    if (outerSignal?.aborted) {
      return { success: false, status: 499, error: "Client closed request" };
    }
    if (controller.signal.aborted || err?.name === "AbortError") {
      log?.warn?.(`[chatSearch] timeout provider=${provider}`);
      return { success: false, status: 504, error: "Upstream timeout" };
    }
    if (err?.code === "UPSTREAM_BODY_TOO_LARGE") {
      return { success: false, status: 502, error: err.message };
    }
    return {
      success: false,
      status: 502,
      error: `Invalid upstream response (status ${resp.status})`
    };
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const errMsg =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      `Upstream HTTP ${resp.status}`;
    log?.warn?.(`[chatSearch] upstream error provider=${provider} status=${resp.status}`);
    return {
      success: false,
      status: resp.status,
      error: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)
    };
  }

  const embeddedError = upstreamErrorMessage(data);
  if (embeddedError) {
    log?.warn?.(`[chatSearch] semantic upstream error provider=${provider}`);
    return { success: false, status: 502, error: embeddedError };
  }
  if (!hasExpectedChatEnvelope(provider, data)) {
    return {
      success: false,
      status: 502,
      error: `Invalid upstream response envelope for ${provider}`,
    };
  }

  const { text, citations, tokens } = cfg.extractAnswer(data);
  const hasAnswer = typeof text === "string" && text.trim().length > 0;
  const validCitations = Array.isArray(citations)
    ? citations.filter((citation) => typeof citation?.url === "string" && citation.url.trim().length > 0)
    : [];
  if (!hasAnswer && validCitations.length === 0) {
    return {
      success: false,
      status: 502,
      error: `${provider} returned no answer or search citations`,
    };
  }
  const retrievedAt = new Date().toISOString();
  const limited = validCitations.slice(0, limit);
  const results = limited.map((c, i) => toResult(c, i, provider, retrievedAt));

  return {
    success: true,
    status: 200,
    data: {
      provider,
      query,
      results,
      answer: { source: provider, text: text || "", model: useModel },
      usage: { queries_used: 1, search_cost_usd: 0, llm_tokens: tokens || 0 },
      metrics: {
        response_time_ms: Date.now() - startTime,
        upstream_latency_ms: upstreamLatency,
        total_results_available: null
      },
      errors: []
    }
  };
}

export { CHAT_SEARCH_CONFIG };
