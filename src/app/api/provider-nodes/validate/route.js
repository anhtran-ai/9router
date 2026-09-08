import { NextResponse } from "next/server";
import { assertPublicUrl, fetchPublic } from "@/shared/utils/ssrfGuard.js";
import { isLocalRequest } from "@/dashboardGuard";

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

// Run one complete provider probe under a single deadline. The consumer stays
// inside the wrapper so a peer cannot send response headers and then hold the
// JSON/text body open forever after the fetch promise has resolved.
const fetchWithTimeout = async (fetchImpl, url, options, consume, timeout = 10000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal });
    const result = await runWithSignal(() => consume(response, signal), signal);
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Request aborted", "AbortError");
    }
    return result;
  } catch (error) {
    if (signal.aborted) await discardResponseBody(response);
    if (controller.signal.aborted) throw new Error("Request timeout", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const runWithSignal = (operation, signal) => {
  const getAbortReason = () => signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Request aborted", "AbortError");
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
};

const discardResponseBody = (response) => {
  if (!response?.body || response.bodyUsed === true) return;
  try {
    const cancellation = response.body.cancel();
    cancellation?.catch?.(() => {});
  } catch { /* best-effort connection release */ }
};

const cancelReader = (reader) => {
  let cancellation;
  try {
    cancellation = reader.cancel();
  } catch {
    releaseReader(reader);
    return;
  }
  Promise.resolve(cancellation).catch(() => {}).finally(() => releaseReader(reader));
};

const releaseReader = (reader) => {
  try { reader.releaseLock?.(); } catch { /* a pending read releases after cancellation settles */ }
};

const providerBodyTooLargeError = () => {
  const error = new Error("Provider response body is too large");
  error.code = "UPSTREAM_BODY_TOO_LARGE";
  return error;
};

const readBoundedText = async (response, signal, { fatalUtf8 = false } = {}) => {
  if (!response?.body?.getReader) {
    let text = "";
    if (typeof response?.text === "function") {
      text = await runWithSignal(() => response.text(), signal);
    } else if (typeof response?.json === "function") {
      text = JSON.stringify(await runWithSignal(() => response.json(), signal));
    }
    if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw providerBodyTooLargeError();
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
      if (total > MAX_PROVIDER_RESPONSE_BYTES) throw providerBodyTooLargeError();
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
  return new TextDecoder("utf-8", { fatal: fatalUtf8 }).decode(bytes);
};

// Validate URL format
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

// Parse error details for user-friendly messages
const getErrorMessage = (error) => {
  if (error.cause?.code === "ECONNREFUSED") return "Connection refused - provider node offline or unreachable";
  if (error.cause?.code === "ENOTFOUND") return "DNS lookup failed - invalid domain or network issue";
  if (error.cause?.code === "ETIMEDOUT") return "Connection timeout - provider node too slow";
  if (error.message.includes("timeout")) return "Request timeout (>10s) - provider node not responding";
  if (error.cause?.code === "CERT_HAS_EXPIRED") return "SSL certificate expired";
  if (error.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "SSL certificate verification failed";
  if (error.cause?.code) return `Network error: ${error.cause.code}`;
  return "Network connection failed - check URL and network connectivity";
};

// Get status-specific error message for /models endpoint
const getModelsErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 404) return "/models endpoint not found - try chat validation with model ID";
  if (status >= 500) return "Server error - try again later";
  return `Unexpected response (${status})`;
};

// Get status-specific error message for /chat/completions endpoint
const getChatErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 400) return "Invalid model or bad request";
  if (status === 404) return "Chat endpoint not found";
  if (status >= 500) return "Server error - try again later";
  return `Chat request failed (${status})`;
};

// POST /api/provider-nodes/validate - Validate API key against base URL
export async function POST(request) {
  try {
    const body = await request.json();
    const { baseUrl, apiKey, type, modelId } = body;

    if (!baseUrl || !apiKey) {
      return NextResponse.json({ error: "Base URL and API key required" }, { status: 400 });
    }

    // Validate URL format
    if (!isValidUrl(baseUrl)) {
      return NextResponse.json({ error: "Invalid URL format" }, { status: 400 });
    }

    // SSRF guard for remote callers; local host keeps self-hosted nodes (e.g. ollama-local)
    const isRemote = !isLocalRequest(request);
    if (isRemote) {
      try {
        // DNS resolution happens inside the timed fetchPublic call below. A
        // separate async preflight would sit outside that deadline and repeat
        // the lookup, reopening an availability/TOCTOU gap.
        assertPublicUrl(baseUrl);
      } catch {
        return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
      }
    }
    const fetchImpl = isRemote ? fetchPublic : fetch;

    // Custom Embedding Validation - test POST /embeddings directly
    if (type === "custom-embedding") {
      const normalizedBase = baseUrl.trim().replace(/\/$/, "");
      if (!modelId?.trim()) {
        return NextResponse.json({ valid: false, error: "Model ID required for embedding validation" });
      }
      return await fetchWithTimeout(fetchImpl, `${normalizedBase}/embeddings`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: modelId.trim(), input: "ping" })
      }, async (embedRes, signal) => {
        if (embedRes.ok) {
          let data;
          try {
            const responseText = await readBoundedText(embedRes, signal, { fatalUtf8: true });
            data = responseText ? JSON.parse(responseText) : null;
          } catch (error) {
            if (error?.code === "UPSTREAM_BODY_TOO_LARGE" || signal.aborted) throw error;
            return NextResponse.json({
              valid: false,
              error: "Invalid embeddings response",
              method: "embeddings",
            }, { status: 502 });
          }
          const embedding = data?.data?.[0]?.embedding;
          if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(Number.isFinite)) {
            return NextResponse.json({
              valid: false,
              error: "Invalid embeddings response",
              method: "embeddings",
            }, { status: 502 });
          }
          const dims = embedding.length;
          return NextResponse.json({ valid: true, method: "embeddings", dimensions: dims });
        }
        if (embedRes.status === 401 || embedRes.status === 403) {
          await discardResponseBody(embedRes);
          return NextResponse.json({ valid: false, error: "API key unauthorized" });
        }
        const errBody = await readBoundedText(embedRes, signal);
        return NextResponse.json({
          valid: false,
          error: `Embeddings request failed (${embedRes.status})${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
          method: "embeddings"
        });
      });
    }

    // Anthropic Compatible Validation
    if (type === "anthropic-compatible") {
      let normalizedBase = baseUrl.trim().replace(/\/$/, "");
      if (normalizedBase.endsWith("/messages")) {
        normalizedBase = normalizedBase.slice(0, -9);
      }

      const modelsUrl = `${normalizedBase}/models`;
      const modelsResult = await fetchWithTimeout(fetchImpl, modelsUrl, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Authorization": `Bearer ${apiKey}`
        }
      }, async (res) => {
        if (res.ok) {
          await discardResponseBody(res);
          return { response: NextResponse.json({ valid: true }) };
        }
        // Auth errors - no point trying chat fallback
        if (res.status === 401 || res.status === 403) {
          await discardResponseBody(res);
          return { response: NextResponse.json({ valid: false, error: "API key unauthorized" }) };
        }
        const status = res.status;
        await discardResponseBody(res);
        return { status };
      });
      if (modelsResult.response) return modelsResult.response;

      // Fallback: Anthropic-compatible servers expose Messages, not OpenAI's
      // chat/completions path.
      if (modelId) {
        return await fetchWithTimeout(fetchImpl, `${normalizedBase}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1
          })
        }, async (chatRes) => {
          if (chatRes.ok) {
            await discardResponseBody(chatRes);
            return NextResponse.json({ valid: true, method: "chat" });
          }
          await discardResponseBody(chatRes);
          return NextResponse.json({
            valid: false,
            error: getChatErrorMessage(chatRes.status),
            method: "chat"
          });
        });
      }

      return NextResponse.json({ valid: false, error: getModelsErrorMessage(modelsResult.status) });
    }

    // OpenAI Compatible Validation (Default)
    const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;
    const modelsResult = await fetchWithTimeout(fetchImpl, modelsUrl, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    }, async (res) => {
      if (res.ok) {
        await discardResponseBody(res);
        return { response: NextResponse.json({ valid: true }) };
      }
      // Auth errors - no point trying chat fallback
      if (res.status === 401 || res.status === 403) {
        await discardResponseBody(res);
        return { response: NextResponse.json({ valid: false, error: "API key unauthorized" }) };
      }
      const status = res.status;
      await discardResponseBody(res);
      return { status };
    });
    if (modelsResult.response) return modelsResult.response;

    // Fallback: try chat/completions if modelId provided
    if (modelId) {
      return await fetchWithTimeout(fetchImpl, `${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        })
      }, async (chatRes) => {
        if (chatRes.ok) {
          await discardResponseBody(chatRes);
          return NextResponse.json({ valid: true, method: "chat" });
        }
        await discardResponseBody(chatRes);
        return NextResponse.json({
          valid: false,
          error: getChatErrorMessage(chatRes.status),
          method: "chat"
        });
      });
    }

    return NextResponse.json({ valid: false, error: getModelsErrorMessage(modelsResult.status) });
  } catch (error) {
    if (String(error?.message || "").startsWith("Blocked URL:")) {
      return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
    }
    if (error?.code === "UPSTREAM_BODY_TOO_LARGE") {
      return NextResponse.json({
        valid: false,
        error: "Provider response too large (>2 MiB)",
      }, { status: 502 });
    }
    const errorMessage = getErrorMessage(error);
    console.error("Error validating provider node:", {
      message: error.message,
      cause: error.cause,
      code: error.cause?.code,
      userMessage: errorMessage
    });
    return NextResponse.json({ 
      valid: false,
      error: errorMessage 
    }, { status: 500 });
  }
}
