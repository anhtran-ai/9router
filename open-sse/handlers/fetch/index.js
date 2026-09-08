// Web Fetch handler — dispatches to firecrawl, jina-reader, tavily, exa, ollama
// Returns normalized shape across all providers

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_FORMAT = "markdown";
const MAX_FETCH_RESPONSE_BYTES = 32 * 1024 * 1024;

class ResponseTooLargeError extends Error {
  constructor(limitBytes) {
    super(`Upstream fetch response exceeds ${Math.floor(limitBytes / (1024 * 1024))} MiB limit`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * @typedef {Object} FetchResult
 * @property {boolean} success
 * @property {number} [status]
 * @property {string} [error]
 * @property {Object} [data]
 */

/**
 * Fetch with timeout abort.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
// Strip non-ASCII chars from header values (HTTP headers must be ByteString).
function sanitizeHeaders(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = typeof v === "string" ? v.replace(/[^\x00-\xFF]/g, "").trim() : v;
  }
  return out;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function runWithSignal(operation, signal) {
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function releaseReader(reader) {
  try { reader?.releaseLock?.(); } catch { /* pending read releases after cancellation settles */ }
}

function cancelReader(reader, reason) {
  let cancellation;
  try { cancellation = reader?.cancel?.(reason); } catch {
    releaseReader(reader);
    return;
  }
  Promise.resolve(cancellation).catch(() => {}).finally(() => releaseReader(reader));
}

function discardResponseBody(res, reason) {
  if (!res?.body || res.bodyUsed === true) return;
  try {
    const cancellation = res.body.cancel(reason);
    cancellation?.catch?.(() => {});
  } catch { /* best-effort connection release */ }
}

async function readTextWithLimit(
  res,
  limitBytes = MAX_FETCH_RESPONSE_BYTES,
  signal = null,
  fatalUtf8 = false,
) {
  const declaredLength = Number(res?.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    const error = new ResponseTooLargeError(limitBytes);
    discardResponseBody(res, error);
    throw error;
  }

  // Real fetch responses expose a web ReadableStream. Keep the fallback for
  // lightweight provider/test doubles while the enclosing AbortController
  // still enforces their deadline.
  if (!res?.body?.getReader) return runWithSignal(() => res.text(), signal);

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: fatalUtf8 });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await runWithSignal(() => reader.read(), signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) throw new ResponseTooLargeError(limitBytes);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    cancelReader(reader, error);
    throw error;
  } finally {
    releaseReader(reader);
  }
}

async function tryFetch(url, init, timeoutMs, readResponse, outerSignal = null) {
  const ctrl = new AbortController();
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.floor(timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), boundedTimeout);
  const signal = outerSignal ? AbortSignal.any([outerSignal, ctrl.signal]) : ctrl.signal;
  let res;
  try {
    const fetchPromise = Promise.resolve().then(() => fetch(url, {
      ...init,
      headers: sanitizeHeaders(init.headers),
      signal,
    }));
    fetchPromise.then(
      (lateResponse) => {
        if (signal.aborted) discardResponseBody(lateResponse, signal.reason);
      },
      () => {},
    );
    res = await runWithSignal(() => fetchPromise, signal);
    const body = await readResponse(res, signal);
    return { ok: true, res, body };
  } catch (err) {
    discardResponseBody(res, err);
    const clientAborted = outerSignal?.aborted === true;
    const isTimeout = !clientAborted && (ctrl.signal.aborted || err?.name === "AbortError");
    return {
      ok: false,
      clientAborted,
      timeout: isTimeout,
      error: clientAborted ? "Client closed request" : err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text, max) {
  if (!text || typeof text !== "string") return text || "";
  if (!max || max <= 0) return text;
  return text.length > max ? text.slice(0, max) : text;
}

function parseJinaTitle(text) {
  const source = String(text || "");
  const metadataTitle = source.match(/^\s*Title:\s*(.+)$/mi);
  if (metadataTitle) return metadataTitle[1].trim();
  const m = source.match(/^\s*#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function buildData({ provider, url, title, format, text, links, costUsd, responseMs, upstreamMs }) {
  const data = {
    provider,
    url,
    title: title || null,
    content: { format, text: text || "", length: (text || "").length },
    metadata: { author: null, published_at: null, language: null },
    usage: { fetch_cost_usd: costUsd ?? null },
    metrics: { response_time_ms: responseMs, upstream_latency_ms: upstreamMs }
  };
  if (Array.isArray(links)) data.links = links;
  return data;
}

async function readJsonOrText(res, signal) {
  const ct = res.headers.get("content-type") || "";
  const isJson = ct.toLowerCase().includes("application/json")
    || ct.toLowerCase().split(";", 1)[0].trim().endsWith("+json");
  const text = await readTextWithLimit(
    res,
    MAX_FETCH_RESPONSE_BYTES,
    signal,
    res.ok && isJson,
  );
  if (isJson) {
    try { return { json: JSON.parse(text), text }; } catch { return { text, invalidJson: true }; }
  }
  return { text };
}

function explicitUpstreamError(json) {
  if (!json || typeof json !== "object") return null;
  const error = json.error;
  if (error != null && error !== false && error !== "") {
    if (typeof error === "string") return error;
    if (typeof error?.message === "string" && error.message.trim()) return error.message;
    try { return JSON.stringify(error); } catch { return "Upstream returned an error payload"; }
  }
  const failedStatus = typeof json.status === "string"
    && ["error", "failed", "failure", "cancelled", "canceled"].includes(json.status.toLowerCase());
  if (json.success === false || json.ok === false || failedStatus) {
    return typeof json.message === "string" && json.message.trim()
      ? json.message
      : "Upstream reported an unsuccessful fetch";
  }
  return null;
}

function failedFetch(result, provider) {
  const status = result.clientAborted ? 499 : result.timeout ? 504 : 502;
  return { success: false, status, error: result.error || `${provider} fetch failed` };
}

function invalidPayload(provider, detail = "empty or invalid response") {
  return { success: false, status: 502, error: `${provider} returned an ${detail}` };
}

export const __test__ = { readTextWithLimit, MAX_FETCH_RESPONSE_BYTES };

/**
 * Main handler.
 * @param {Object} params
 * @param {string} params.url
 * @param {string} [params.format]
 * @param {number} [params.maxCharacters]
 * @param {string} params.provider
 * @param {Object} [params.providerConfig]
 * @param {Object} [params.credentials]
 * @param {Function} [params.log]
 * @returns {Promise<FetchResult>}
 */
export async function handleFetchCore({ url, format, maxCharacters, provider, providerConfig, credentials, log, signal = null }) {
  if (!url || typeof url !== "string") {
    return { success: false, status: 400, error: "url is required" };
  }
  if (!provider) {
    return { success: false, status: 400, error: "provider is required" };
  }

  const fmt = format || DEFAULT_FORMAT;
  const timeoutMs = providerConfig?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const apiKey = credentials?.apiKey || credentials?.key || credentials?.token || "";
  const costPerQuery = providerConfig?.costPerQuery ?? null;
  const startedAt = Date.now();

  try {
    if (provider === "firecrawl") {
      return await runFirecrawl({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, signal });
    }
    if (provider === "jina-reader") {
      return await runJina({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, signal });
    }
    if (provider === "tavily") {
      return await runTavily({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, signal });
    }
    if (provider === "exa") {
      return await runExa({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, signal });
    }
    if (provider === "ollama") {
      return await runOllama({
        url,
        fmt,
        timeoutMs,
        apiKey,
        maxCharacters,
        costPerQuery,
        startedAt,
        baseUrl: providerConfig?.baseUrl,
        signal,
      });
    }
    return { success: false, status: 400, error: `Unsupported provider: ${provider}` };
  } catch (err) {
    log?.("fetch handler error:", err?.message || err);
    return { success: false, status: 502, error: err?.message || "Internal fetch error" };
  }
}

async function runFirecrawl({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, signal }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ url, formats: [fmt] })
  }, timeoutMs, readJsonOrText, signal);

  if (!r.ok) {
    return failedFetch(r, "Firecrawl");
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = r.body;
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Firecrawl error: ${r.res.status}` };
  }
  const semanticError = explicitUpstreamError(json);
  if (r.body.invalidJson || semanticError) return invalidPayload("Firecrawl", semanticError || "invalid JSON response");
  const d = json?.data;
  if (!d || typeof d !== "object") return invalidPayload("Firecrawl", "invalid response envelope");
  const text = truncate(d.markdown || d.html || d.text || "", maxCharacters);
  if (!text.trim()) return invalidPayload("Firecrawl", "empty content response");
  const title = d.metadata?.title || null;
  return {
    success: true,
    data: buildData({
      provider: "firecrawl", url, title, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runJina({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, signal }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://r.jina.ai/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ url })
  }, timeoutMs, (res, readSignal) => readTextWithLimit(res, MAX_FETCH_RESPONSE_BYTES, readSignal), signal);

  if (!r.ok) {
    return failedFetch(r, "Jina");
  }
  const upstreamMs = Date.now() - upstreamStart;
  const body = r.body;
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: body?.slice(0, 500) || `Jina error: ${r.res.status}` };
  }
  const text = truncate(body, maxCharacters);
  if (!text.trim()) return invalidPayload("Jina", "empty content response");
  return {
    success: true,
    data: buildData({
      provider: "jina-reader", url, title: parseJinaTitle(body), format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runTavily({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, signal }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ urls: [url], extract_depth: "basic" })
  }, timeoutMs, readJsonOrText, signal);

  if (!r.ok) {
    return failedFetch(r, "Tavily");
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = r.body;
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Tavily error: ${r.res.status}` };
  }
  const semanticError = explicitUpstreamError(json);
  if (r.body.invalidJson || semanticError) return invalidPayload("Tavily", semanticError || "invalid JSON response");
  const first = Array.isArray(json?.results) ? json.results[0] : null;
  if (!first || typeof first !== "object") return invalidPayload("Tavily", "invalid response envelope");
  const text = truncate(first.raw_content || "", maxCharacters);
  if (!text.trim()) return invalidPayload("Tavily", "empty content response");
  return {
    success: true,
    data: buildData({
      provider: "tavily", url, title: null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runExa({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, signal }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {})
    },
    body: JSON.stringify({ ids: [url], text: true })
  }, timeoutMs, readJsonOrText, signal);

  if (!r.ok) {
    return failedFetch(r, "Exa");
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = r.body;
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Exa error: ${r.res.status}` };
  }
  const semanticError = explicitUpstreamError(json);
  if (r.body.invalidJson || semanticError) return invalidPayload("Exa", semanticError || "invalid JSON response");
  const first = Array.isArray(json?.results) ? json.results[0] : null;
  if (!first || typeof first !== "object") return invalidPayload("Exa", "invalid response envelope");
  const text = truncate(first.text || "", maxCharacters);
  if (!text.trim()) return invalidPayload("Exa", "empty content response");
  return {
    success: true,
    data: buildData({
      provider: "exa", url, title: first.title || null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runOllama({
  url,
  fmt,
  timeoutMs,
  apiKey,
  maxCharacters,
  costPerQuery,
  startedAt,
  baseUrl,
  signal,
}) {
  const upstreamStart = Date.now();
  const r = await tryFetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ url })
  }, timeoutMs, readJsonOrText, signal);

  if (!r.ok) {
    return failedFetch(r, "Ollama");
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json, text: responseText } = r.body;
  if (!r.res.ok) {
    const error = json?.error
      || json?.message
      || responseText?.slice(0, 500)
      || `Ollama error: ${r.res.status}`;
    return { success: false, status: r.res.status, error };
  }
  const semanticError = explicitUpstreamError(json);
  if (r.body.invalidJson || semanticError || !json || typeof json.content !== "string" || !json.content.trim()) {
    return { success: false, status: 502, error: "Ollama returned an empty or invalid web fetch response" };
  }

  const text = truncate(json.content, maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "ollama",
      url,
      title: json.title || null,
      format: fmt,
      text,
      links: json.links,
      costUsd: costPerQuery,
      responseMs: Date.now() - startedAt,
      upstreamMs
    })
  };
}
