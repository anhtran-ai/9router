import { handleChat } from "@/sse/handlers/chat.js";
import {
  clearAccountError,
  beginAccountMutationAttempt,
  endAccountMutationAttempt,
  getProviderCredentials,
  isValidApiKey,
  markAccountUnavailable,
  recordAccountMutationSuccess,
} from "@/sse/services/auth.js";
import { getSettings } from "@/lib/localDb";
import { PROVIDER_MODELS } from "@/shared/constants/models";
import { GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS } from "open-sse/config/runtimeConfig.js";
import { initTranslators } from "open-sse/translator/index.js";
import { readRequestBodyBytes, RequestBodyError } from "open-sse/utils/requestBody.js";
import { awaitWithSignal } from "open-sse/utils/abort.js";

let initialized = false;
const GEMINI_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_NATIVE_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const GEMINI_NATIVE_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
// Gemini model id charset (matches sanitizeGeminiFunctionName); blocks path traversal in upstream URL.
const GEMINI_NATIVE_MODEL_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1beta/models/{model}:generateContent        — non-streaming
 * POST /v1beta/models/{model}:streamGenerateContent  — streaming (SSE)
 *
 * Streaming intent is determined by the URL action suffix (canonical Gemini API
 * convention), NOT by a body field. generationConfig.stream is not a real
 * Gemini API field and Gemini CLI never sets it.
 *
 * The @google/genai SDK always uses :streamGenerateContent?alt=sse for chat.
 * The upstream handleChat returns OpenAI SSE format; we transform it to
 * Gemini SSE format on the fly via transformOpenAISSEToGeminiSSE().
 */
export async function POST(request, { params }) {
  await ensureInitialized();

  try {
    const { path } = await params;
    // path = ["provider", "model:action"] or ["model:action"]

    let model;
    let action; // ":generateContent" | ":streamGenerateContent"

    const modelAction = path.length >= 2 ? path[1] : path[0];
    if (typeof modelAction !== "string" || (
      !modelAction.endsWith(":generateContent")
      && !modelAction.endsWith(":streamGenerateContent")
    )) {
      return Response.json({ error: { message: "Unsupported Gemini model action" } }, { status: 400 });
    }

    if (path.length >= 2) {
      // Format: /v1beta/models/provider/model:generateContent
      const provider = path[0];
      action = modelAction.endsWith(":streamGenerateContent")
        ? ":streamGenerateContent"
        : ":generateContent";
      const modelName = modelAction
        .replace(":streamGenerateContent", "")
        .replace(":generateContent", "");
      model = provider + "/" + modelName;
    } else {
      // Format: /v1beta/models/model:generateContent
      action = modelAction.endsWith(":streamGenerateContent")
        ? ":streamGenerateContent"
        : ":generateContent";
      model = modelAction
        .replace(":streamGenerateContent", "")
        .replace(":generateContent", "");
    }

    let rawBody;
    try {
      rawBody = await readRequestBodyBytes(request, {
        maxBytes: GEMINI_NATIVE_MAX_REQUEST_BYTES,
        label: "Gemini request body",
        requireBody: true,
      });
    } catch (error) {
      const status = error instanceof RequestBodyError ? error.status : 400;
      return Response.json(
        { error: { message: error?.message || "Invalid Gemini request body" } },
        { status },
      );
    }

    let body;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: { message: "Gemini request body must be an object" } }, { status: 400 });
    }

    if (isGeminiNativeTtsRequest(model, body)) {
      return await forwardGeminiNativeRequest(request, body, model, action);
    }

    // Streaming is determined by URL action suffix:
    //   :streamGenerateContent => stream: true  (SSE)
    //   :generateContent       => stream: false (plain JSON)
    const stream = action === ":streamGenerateContent";

    // Convert Gemini request format to OpenAI/internal format
    const convertedBody = convertGeminiToInternal(body, model, stream);

    // Create new request with converted body
    const forwardedHeaders = new Headers(request.headers);
    for (const name of ["content-length", "content-encoding", "transfer-encoding", "digest", "content-md5"]) {
      forwardedHeaders.delete(name);
    }
    const newRequest = new Request(request.url, {
      method: "POST",
      headers: forwardedHeaders,
      body: JSON.stringify(convertedBody),
      signal: request.signal,
    });

    const response = await handleChat(newRequest);

    if (stream) {
      // Transform OpenAI SSE => Gemini SSE on the fly.
      // The @google/genai SDK always uses :streamGenerateContent?alt=sse and
      // expects Gemini SSE chunks (no [DONE] sentinel — stream just closes).
      return transformOpenAISSEToGeminiSSE(response, model, request.signal);
    } else {
      // Convert OpenAI JSON response => Gemini GenerateContentResponse
      return await convertOpenAIResponseToGemini(response, model, request.signal);
    }
  } catch (error) {
    console.log("Error handling Gemini request:", error);
    return Response.json(
      { error: { message: error.message, code: 500 } },
      { status: 500 }
    );
  }
}

function extractGeminiClientApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  const googleApiKey = request.headers.get("x-goog-api-key");
  if (googleApiKey) return googleApiKey;

  const url = new URL(request.url);
  return url.searchParams.get("key");
}

function normalizeGeminiNativeModel(model) {
  return String(model || "")
    .replace(/^models\//, "")
    .replace(/^gemini\//, "");
}

function getGeminiTtsModelIds() {
  return new Set([
    ...(PROVIDER_MODELS.gemini || [])
      .filter((model) => (model.kind || model.type) === "tts")
      .map((model) => model.id),
    ...(PROVIDER_MODELS["gemini-tts-models"] || []).map((model) => model.id),
  ]);
}

function hasAudioResponseModality(body) {
  const modalities = body?.generationConfig?.responseModalities;
  return Array.isArray(modalities)
    && modalities.some((modality) => String(modality).toUpperCase() === "AUDIO");
}

function isGeminiNativeTtsRequest(model, body) {
  const rawModel = String(model || "");
  if (rawModel.includes("/") && !rawModel.startsWith("gemini/") && !rawModel.startsWith("models/")) {
    return false;
  }

  const modelId = normalizeGeminiNativeModel(model);
  return hasAudioResponseModality(body) || getGeminiTtsModelIds().has(modelId);
}

function buildGeminiNativeUrl(requestUrl, model, action) {
  const sourceUrl = new URL(requestUrl);
  const upstreamUrl = new URL(`${GEMINI_NATIVE_BASE_URL}/${normalizeGeminiNativeModel(model)}${action}`);

  for (const [key, value] of sourceUrl.searchParams.entries()) {
    if (key === "key") continue;
    upstreamUrl.searchParams.append(key, value);
  }

  return upstreamUrl.toString();
}

async function validateGeminiNativeClientKey(request) {
  const settings = await getSettings();
  if (!settings.requireApiKey) return null;

  const apiKey = extractGeminiClientApiKey(request);
  if (!apiKey) {
    return Response.json({ error: { message: "Missing API key" } }, { status: 401 });
  }

  const valid = await isValidApiKey(apiKey);
  if (!valid) {
    return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
  }

  return null;
}

function buildGeminiNativeAuthHeaders(credentials) {
  if (credentials?.apiKey) return { "x-goog-api-key": credentials.apiKey };
  if (credentials?.accessToken) return { Authorization: `Bearer ${credentials.accessToken}` };
  return null;
}

function corsHeadersFrom(response) {
  const headers = new Headers(response.headers);
  // Node fetch may expose a decoded body while preserving upstream compression
  // headers. Forwarding those headers makes clients decompress plain bytes again.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("digest");
  headers.delete("content-digest");
  headers.delete("repr-digest");
  headers.delete("content-md5");
  headers.delete("etag");
  headers.delete("content-range");
  headers.delete("trailer");
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function getSafeGeminiConnectionLabel(credentials) {
  const connectionId = String(credentials?.connectionId || "unknown");
  const shortId = connectionId.slice(0, 8);
  const connectionName = String(credentials?.connectionName || "");
  if (!connectionName || connectionName.includes("@")) return shortId;
  return `${connectionName}:${shortId}`;
}

function getGeminiNativeErrorCode(error) {
  return error?.cause?.code || error?.code || error?.cause?.name || error?.name || "UNKNOWN";
}

function isGeminiNativeTimeoutError(error, timedOut) {
  if (timedOut) return true;
  const code = getGeminiNativeErrorCode(error);
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "HeadersTimeoutError";
}

function getSafeGeminiNativeErrorText(error) {
  const message = error?.message || String(error);
  const code = getGeminiNativeErrorCode(error);
  return `${message} (${code})`;
}

function abortErrorFromSignal(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function bodyLimitError() {
  const error = new Error(`Gemini upstream response exceeds ${GEMINI_NATIVE_MAX_RESPONSE_BYTES} bytes`);
  error.code = "GEMINI_RESPONSE_TOO_LARGE";
  return error;
}

function releaseBodyReader(reader) {
  try { reader?.releaseLock(); } catch { /* pending read or already released */ }
}

function cancelBodyReader(reader, reason) {
  let cancellation = null;
  try {
    cancellation = Promise.resolve(reader?.cancel(reason)).catch(() => {});
  } catch { /* best effort */ }
  releaseBodyReader(reader);
  cancellation?.finally(() => releaseBodyReader(reader));
}

function cancelUpstreamBody(response, reason) {
  try {
    const cancellation = response?.body?.cancel(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch { /* best effort */ }
}

async function readGeminiNativeBody(response, signal = null) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > GEMINI_NATIVE_MAX_RESPONSE_BYTES) {
    const error = bodyLimitError();
    cancelUpstreamBody(response, error);
    throw error;
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let reachedEnd = false;
  let terminalError = null;
  try {
    while (true) {
      let abortListener;
      const readPromise = reader.read();
      const record = signal
        ? await Promise.race([
            readPromise,
            new Promise((_, reject) => {
              abortListener = () => reject(abortErrorFromSignal(signal));
              if (signal.aborted) abortListener();
              else signal.addEventListener("abort", abortListener, { once: true });
            }),
          ]).finally(() => {
            if (abortListener) signal.removeEventListener("abort", abortListener);
          })
        : await readPromise;
      const { done, value } = record;
      if (done) {
        reachedEnd = true;
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > GEMINI_NATIVE_MAX_RESPONSE_BYTES) {
        throw bodyLimitError();
      }
      chunks.push(value);
    }
  } catch (error) {
    terminalError = error;
    throw error;
  } finally {
    if (!reachedEnd) cancelBodyReader(reader, terminalError);
    else releaseBodyReader(reader);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function invalidGeminiNativeResponse(message) {
  const error = new Error(message);
  error.code = "GEMINI_INVALID_RESPONSE";
  return error;
}

function validateGeminiNativeJson(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidGeminiNativeResponse("Gemini upstream returned malformed JSON with HTTP 200");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidGeminiNativeResponse("Gemini upstream returned an invalid JSON envelope with HTTP 200");
  }
  if (parsed.error) {
    throw invalidGeminiNativeResponse(
      `Gemini upstream returned an error with HTTP 200: ${parsed.error.message || "unknown error"}`
    );
  }
  if (
    !Array.isArray(parsed.candidates)
    && !(parsed.promptFeedback && typeof parsed.promptFeedback === "object")
  ) {
    throw invalidGeminiNativeResponse("Gemini upstream response is missing candidates");
  }
  return parsed;
}

function createGeminiNativeSseValidator() {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let totalBytes = 0;
  let validEvents = 0;

  const processLine = (line) => {
    if (line.length > 1024 * 1024) {
      throw invalidGeminiNativeResponse("Gemini upstream SSE line exceeds 1 MiB");
    }
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") return;
    let parsed;
    try { parsed = JSON.parse(data); }
    catch { throw invalidGeminiNativeResponse("Gemini upstream returned malformed SSE data with HTTP 200"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidGeminiNativeResponse("Gemini upstream returned an invalid SSE envelope with HTTP 200");
    }
    if (parsed.error) {
      throw invalidGeminiNativeResponse(
        `Gemini upstream returned an SSE error with HTTP 200: ${parsed.error.message || "unknown error"}`
      );
    }
    if (
      !Array.isArray(parsed.candidates)
      && !(parsed.promptFeedback && typeof parsed.promptFeedback === "object")
      && !(parsed.usageMetadata && typeof parsed.usageMetadata === "object")
    ) {
      throw invalidGeminiNativeResponse("Gemini upstream SSE event has no Gemini response fields");
    }
    validEvents += 1;
  };

  const consumeLines = () => {
    const lines = pending.split(/\r\n|\r|\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) processLine(line);
    if (pending.length > 1024 * 1024) {
      throw invalidGeminiNativeResponse("Gemini upstream SSE line exceeds 1 MiB");
    }
  };

  return {
    push(value) {
      totalBytes += value?.byteLength || 0;
      if (totalBytes > GEMINI_NATIVE_MAX_RESPONSE_BYTES) throw bodyLimitError();
      try {
        pending += decoder.decode(value, { stream: true });
      } catch {
        throw invalidGeminiNativeResponse("Gemini upstream returned invalid UTF-8 in HTTP 200 SSE");
      }
      consumeLines();
      return validEvents > 0;
    },
    finish() {
      try {
        pending += decoder.decode();
      } catch {
        throw invalidGeminiNativeResponse("Gemini upstream returned invalid UTF-8 in HTTP 200 SSE");
      }
      if (pending) {
        const trailing = pending;
        pending = "";
        processLine(trailing);
      }
      if (validEvents === 0) {
        throw invalidGeminiNativeResponse("Gemini upstream SSE ended without a valid response event");
      }
      return true;
    },
  };
}

/**
 * Keep the native fetch deadline and client cancellation connected until the
 * response body reaches EOF. Fetch resolves at headers, so returning its body
 * directly would otherwise leave a stalled stream unbounded and detached from
 * the original request signal.
 */
function wrapGeminiNativeBody(body, { signal, cleanupTransport, onSuccess, onFailure, onFinished }) {
  const reader = body.getReader();
  const validator = createGeminiNativeSseValidator();
  const encoder = new TextEncoder();
  const prefix = [];
  let validated = false;
  let outputController = null;
  let finishPromise = null;
  let readerEnded = false;

  const finish = (success, reason = null, recordFailure = false) => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      signal?.removeEventListener("abort", abortBody);
      cleanupTransport();
      try {
        if (success) onSuccess();
        else {
          if (!readerEnded) cancelBodyReader(reader, reason);
          if (recordFailure) await onFailure?.(reason);
        }
      } finally {
        if (readerEnded) releaseBodyReader(reader);
        onFinished();
      }
    })();
    return finishPromise;
  };

  const abortBody = () => {
    const error = abortErrorFromSignal(signal);
    // Abort listeners cannot await; finish owns/catches reader cancellation.
    finish(false, error, true).catch(() => {});
    try { outputController?.error(error); } catch { /* stream already settled */ }
  };

  signal?.addEventListener("abort", abortBody, { once: true });

  const emitValidationError = (controller, error) => {
    controller.enqueue(encoder.encode(
      "data: " + JSON.stringify({ error: normalizeGeminiError(error) }) + "\r\n\r\n"
    ));
    controller.close();
  };

  const flushPrefix = (controller) => {
    for (const chunk of prefix.splice(0)) controller.enqueue(chunk);
  };

  return new ReadableStream({
    start(controller) {
      outputController = controller;
      if (signal?.aborted) abortBody();
    },
    async pull(controller) {
      if (finishPromise) return;
      try {
        const { done, value } = await reader.read();
        if (finishPromise) return;
        if (done) {
          readerEnded = true;
          validator.finish();
          if (!validated) {
            validated = true;
            flushPrefix(controller);
          }
          await finish(true);
          controller.close();
          return;
        }
        if (!validated) {
          prefix.push(value);
          if (validator.push(value)) {
            validated = true;
            flushPrefix(controller);
          }
        } else {
          validator.push(value);
          controller.enqueue(value);
        }
      } catch (error) {
        await finish(false, error, true).catch(() => {});
        try {
          if (signal?.aborted) controller.error(error);
          else emitValidationError(controller, error);
        } catch { /* stream already settled */ }
      }
    },
    async cancel(reason) {
      await finish(false, reason, false).catch(() => {});
    },
  });
}

async function forwardGeminiNativeRequest(request, body, model, action) {
  const authError = await validateGeminiNativeClientKey(request);
  if (authError) return authError;
  if (request.signal?.aborted) {
    return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
  }

  const modelId = normalizeGeminiNativeModel(model);
  if (!GEMINI_NATIVE_MODEL_PATTERN.test(modelId)) {
    return Response.json({ error: { message: "Invalid model" } }, { status: 400 });
  }
  const excludeConnectionIds = new Set();
  const bodyText = JSON.stringify(body);
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials("gemini", excludeConnectionIds, modelId);
    if (!credentials || credentials.allRateLimited) {
      console.log(`[GEMINI_NATIVE] exhausted model=${modelId} status=${lastStatus || Number(credentials?.lastErrorCode) || 503} error=${lastError || credentials?.lastError || "No active credentials for provider: gemini"}`);
      return Response.json(
        { error: { message: lastError || credentials?.lastError || "No active credentials for provider: gemini" } },
        { status: lastStatus || Number(credentials?.lastErrorCode) || 503 }
      );
    }

    const authHeaders = buildGeminiNativeAuthHeaders(credentials);
    if (!authHeaders) {
      return Response.json(
        { error: { message: "No Gemini API key configured" } },
        { status: 404 }
      );
    }

    const safeConnection = getSafeGeminiConnectionLabel(credentials);
    if (request.signal?.aborted) {
      console.log(`[GEMINI_NATIVE] client aborted model=${modelId} ms=0 conn=${safeConnection}`);
      return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
    }
    const startedAt = Date.now();
    const upstreamUrl = buildGeminiNativeUrl(request.url, modelId, action);
    const attemptController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS);
    const abortAttempt = () => attemptController.abort();

    request.signal?.addEventListener("abort", abortAttempt, { once: true });
    if (request.signal?.aborted) attemptController.abort(request.signal.reason);
    console.log(`[GEMINI_NATIVE] start model=${modelId} action=${action} conn=${safeConnection} body=${Buffer.byteLength(bodyText)}B timeout=${GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS}`);

    const mutationAttempt = beginAccountMutationAttempt(credentials.connectionId, modelId);
    let lifecycleTransferred = false;
    let transportCleaned = false;
    const cleanupTransport = () => {
      if (transportCleaned) return;
      transportCleaned = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortAttempt);
    };
    const markFailure = async (status, errorText) => {
      try {
        return await markAccountUnavailable(
          credentials.connectionId,
          status,
          errorText,
          "gemini",
          modelId,
          null,
          { signal: request.signal, mutationAttempt },
        );
      } catch (error) {
        if (request.signal?.aborted) {
          return { shouldFallback: false, aborted: true };
        }
        throw error;
      }
    };

    try {
      let upstreamResponse;
      try {
        const fetchPromise = Promise.resolve(fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": request.headers.get("Content-Type") || "application/json",
            ...authHeaders,
          },
          body: bodyText,
          signal: attemptController.signal,
        }));
        // AbortSignal is advisory to custom/intercepted fetch implementations.
        // Keep the request deadline authoritative and discard a late body.
        fetchPromise.then(
          (lateResponse) => {
            if (attemptController.signal.aborted) {
              cancelUpstreamBody(lateResponse, attemptController.signal.reason);
            }
          },
          () => {},
        );
        upstreamResponse = await awaitWithSignal(fetchPromise, attemptController.signal);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        if (request.signal?.aborted && !timedOut) {
          console.log(`[GEMINI_NATIVE] client aborted model=${modelId} ms=${durationMs} conn=${safeConnection}`);
          return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
        }

        const status = isGeminiNativeTimeoutError(error, timedOut) ? 504 : 502;
        const errorText = getSafeGeminiNativeErrorText(error);
        console.log(`[GEMINI_NATIVE] fetch failed model=${modelId} status=${status} ms=${durationMs} conn=${safeConnection} error=${errorText}`);

        const markResult = await markFailure(status, errorText);
        if (markResult.aborted) {
          return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
        }

        if (markResult.shouldFallback) {
          excludeConnectionIds.add(credentials.connectionId);
          lastError = errorText;
          lastStatus = status;
          console.log(`[GEMINI_NATIVE] fallback model=${modelId} status=${status} conn=${safeConnection} exclude=${excludeConnectionIds.size}`);
          continue;
        }

        return Response.json({ error: { message: errorText } }, { status });
      }

      if (request.signal?.aborted && !timedOut) {
        // Fetch can resolve its headers in the same turn that the client
        // disconnects. Do not publish a successful native response or mutate
        // account state after that cancellation boundary.
        cancelUpstreamBody(upstreamResponse, request.signal.reason);
        return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
      }

      console.log(`[GEMINI_NATIVE] upstream model=${modelId} status=${upstreamResponse.status} ms=${Date.now() - startedAt} conn=${safeConnection} ct=${upstreamResponse.headers.get("content-type") || "?"} cl=${upstreamResponse.headers.get("content-length") || "?"}`);

      if (upstreamResponse.ok) {
        const onSuccess = () => {
          recordAccountMutationSuccess(mutationAttempt);
          let cleanup;
          try {
            cleanup = clearAccountError(
              credentials.connectionId,
              credentials,
              modelId,
              { mutationAttempt },
            );
          } catch (error) {
            // Bookkeeping must not corrupt an otherwise valid provider response.
            console.error("[GEMINI_NATIVE] success cleanup failed:", error?.message || error);
            return;
          }
          // Account persistence is bookkeeping after the success watermark.
          // Observe it, but never let a stuck database write hold the provider
          // response or the streaming EOF open indefinitely.
          Promise.resolve(cleanup).catch((error) => {
            console.error("[GEMINI_NATIVE] success cleanup failed:", error?.message || error);
          });
        };

        if (action !== ":streamGenerateContent") {
          let responseBody;
          try {
            const mediaType = String(upstreamResponse.headers.get("content-type") || "")
              .split(";", 1)[0].trim().toLowerCase();
            if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
              throw invalidGeminiNativeResponse(
                `Gemini upstream returned ${mediaType || "an unknown content type"} with HTTP 200`
              );
            }
            responseBody = await readGeminiNativeBody(upstreamResponse, attemptController.signal);
            validateGeminiNativeJson(responseBody);
          } catch (error) {
            if (request.signal?.aborted && !timedOut) {
              return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
            }
            if (error?.code === "GEMINI_RESPONSE_TOO_LARGE") {
              return Response.json({ error: { message: error.message } }, { status: 502 });
            }
            cancelUpstreamBody(upstreamResponse, error);
            const status = isGeminiNativeTimeoutError(error, timedOut) ? 504 : 502;
            const errorText = getSafeGeminiNativeErrorText(error);
            const markResult = await markFailure(status, errorText);
            if (markResult.aborted) {
              return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
            }
            if (markResult.shouldFallback) {
              excludeConnectionIds.add(credentials.connectionId);
              lastError = errorText;
              lastStatus = status;
              continue;
            }
            return Response.json({ error: { message: errorText } }, { status });
          }
          onSuccess();
          return new Response(responseBody, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: corsHeadersFrom(upstreamResponse),
          });
        }

        const streamMediaType = String(upstreamResponse.headers.get("content-type") || "")
          .split(";", 1)[0].trim().toLowerCase();
        const declaredLength = upstreamResponse.headers.get("content-length");
        if (
          !upstreamResponse.body
          || streamMediaType !== "text/event-stream"
          || (declaredLength !== null && Number(declaredLength) > GEMINI_NATIVE_MAX_RESPONSE_BYTES)
        ) {
          const error = declaredLength !== null && Number(declaredLength) > GEMINI_NATIVE_MAX_RESPONSE_BYTES
            ? bodyLimitError()
            : invalidGeminiNativeResponse(
                `Gemini upstream returned ${streamMediaType || "an empty response"} for an SSE request with HTTP 200`
              );
          cancelUpstreamBody(upstreamResponse, error);
          const errorText = getSafeGeminiNativeErrorText(error);
          const markResult = await markFailure(502, errorText);
          if (markResult.aborted) {
            return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
          }
          if (markResult.shouldFallback) {
            excludeConnectionIds.add(credentials.connectionId);
            lastError = errorText;
            lastStatus = 502;
            continue;
          }
          return Response.json({ error: { message: errorText } }, { status: 502 });
        }

        const wrappedBody = wrapGeminiNativeBody(upstreamResponse.body, {
          signal: attemptController.signal,
          cleanupTransport,
          onSuccess,
          onFailure: async (error) => {
            if (request.signal?.aborted && !timedOut) return;
            const status = isGeminiNativeTimeoutError(error, timedOut) ? 504 : 502;
            await markFailure(status, getSafeGeminiNativeErrorText(error));
          },
          onFinished: () => endAccountMutationAttempt(mutationAttempt),
        });
        lifecycleTransferred = true;
        return new Response(wrappedBody, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: corsHeadersFrom(upstreamResponse),
        });
      }

      let errorText;
      try {
        errorText = new TextDecoder().decode(
          await readGeminiNativeBody(upstreamResponse, attemptController.signal)
        );
      } catch (error) {
        if (request.signal?.aborted && !timedOut) {
          return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
        }
        const status = isGeminiNativeTimeoutError(error, timedOut) ? 504 : 502;
        errorText = getSafeGeminiNativeErrorText(error);
        const markResult = await markFailure(status, errorText);
        if (markResult.aborted) {
          return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
        }
        if (markResult.shouldFallback) {
          excludeConnectionIds.add(credentials.connectionId);
          lastError = errorText;
          lastStatus = status;
          continue;
        }
        return Response.json({ error: { message: errorText } }, { status });
      }

      const markResult = await markFailure(upstreamResponse.status, errorText);
      if (markResult.aborted) {
        return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
      }

      if (markResult.shouldFallback) {
        excludeConnectionIds.add(credentials.connectionId);
        lastError = errorText;
        lastStatus = upstreamResponse.status;
        continue;
      }

      return new Response(errorText, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: corsHeadersFrom(upstreamResponse),
      });
    } finally {
      if (!lifecycleTransferred) {
        cleanupTransport();
        endAccountMutationAttempt(mutationAttempt);
      }
    }
  }
}

/**
 * Convert Gemini request format to OpenAI/internal format.
 *
 * @param {object} geminiBody  - parsed Gemini request body
 * @param {string} model       - resolved model string (e.g. "gemini-pro-high")
 * @param {boolean} stream     - whether to stream (from URL action)
 */
function convertGeminiToInternal(geminiBody, model, stream) {
  const messages = [];

  // Convert system instruction
  if (geminiBody.systemInstruction) {
    const systemText = geminiBody.systemInstruction.parts
      ?.map(p => p.text)
      .join("\n") || "";
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  // Convert contents to messages
  if (geminiBody.contents) {
    for (const content of geminiBody.contents) {
      const role = content.role === "model" ? "assistant" : "user";
      const text = content.parts?.map(p => p.text).join("\n") || "";
      messages.push({ role, content: text });
    }
  }

  return {
    model,
    messages,
    stream,
    max_tokens: geminiBody.generationConfig?.maxOutputTokens,
    temperature: geminiBody.generationConfig?.temperature,
    top_p: geminiBody.generationConfig?.topP,
  };
}

/** Map OpenAI finish_reason => Gemini finishReason */
const FINISH_REASON_MAP = {
  stop: "STOP",
  length: "MAX_TOKENS",
  tool_calls: "STOP",
  content_filter: "SAFETY",
};

function toGeminiUsage(usage) {
  const result = {
    promptTokenCount: Number(usage?.prompt_tokens) || 0,
    candidatesTokenCount: Number(usage?.completion_tokens) || 0,
    totalTokenCount: Number(usage?.total_tokens) || 0,
  };
  const reasoningTokens = Number(usage?.completion_tokens_details?.reasoning_tokens) || 0;
  if (reasoningTokens > 0) result.thoughtsTokenCount = reasoningTokens;
  return result;
}

function normalizeGeminiError(error) {
  const source = error && typeof error === "object" ? error : { message: String(error || "Unknown upstream error") };
  const numericCode = Number(source.code);
  return {
    code: Number.isInteger(numericCode) && numericCode >= 400 && numericCode <= 599
      ? numericCode
      : 502,
    message: String(source.message || source.error || "Upstream generation failed"),
    status: typeof source.status === "string" && source.status
      ? source.status
      : "BAD_GATEWAY",
  };
}

function geminiCompatibilityError(message) {
  return Response.json({ error: normalizeGeminiError({ message, code: 502 }) }, {
    status: 502,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * Transform an OpenAI SSE stream into a Gemini SSE stream.
 *
 * OpenAI SSE format (what handleChat returns):
 *   data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}
 *   data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}
 *   data: [DONE]
 *
 * Gemini SSE format (what @google/genai SDK expects):
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]},"index":0}]}
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP","index":0}],"usageMetadata":{...}}
 *   (stream closes — no [DONE])
 */
function transformOpenAISSEToGeminiSSE(upstreamResponse, model, signal = null) {
  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return upstreamResponse;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pending = "";
  let streamFailed = false;
  let terminalSeen = false;
  let emittedResult = false;
  let transportTerminated = false;

  const terminateTransport = (controller) => {
    if (transportTerminated) return;
    transportTerminated = true;
    try { controller.terminate(); } catch { /* stream already settled */ }
  };

  const emitError = (controller, error) => {
    controller.enqueue(encoder.encode(
      "data: " + JSON.stringify({ error: normalizeGeminiError(error) }) + "\r\n\r\n"
    ));
  };

  const failStream = (controller, error) => {
    if (streamFailed || transportTerminated) return;
    emitError(controller, error);
    streamFailed = true;
    pending = "";
    terminateTransport(controller);
  };

  const emitLine = (line, controller) => {
    if (streamFailed) return;
    if (!line.startsWith("data:")) return;

    const data = line.slice(5).trim();

    // Drop empty lines and the OpenAI [DONE] sentinel. Gemini SSE ends by
    // stream close, but DONE still proves the upstream protocol completed.
    if (!data) return;
    if (data === "[DONE]") {
      if (!emittedResult) {
        failStream(controller, { message: "OpenAI SSE ended without a response event" });
        return;
      }
      terminalSeen = true;
      terminateTransport(controller);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      failStream(controller, { message: "Invalid OpenAI SSE event" });
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      failStream(controller, { message: "Invalid OpenAI SSE event envelope" });
      return;
    }
    if (parsed.error || parsed.type === "error") {
      failStream(controller, parsed.error || parsed);
      return;
    }
    if (parsed.choices != null && !Array.isArray(parsed.choices)) {
      failStream(controller, { message: "Invalid OpenAI SSE choices" });
      return;
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      if (parsed.usage) {
        controller.enqueue(encoder.encode("data: " + JSON.stringify({
          candidates: [],
          usageMetadata: toGeminiUsage(parsed.usage),
          modelVersion: parsed.model || model,
        }) + "\r\n\r\n"));
        emittedResult = true;
      }
      return;
    }

    if (typeof choice !== "object" || Array.isArray(choice)) {
      failStream(controller, { message: "Invalid OpenAI SSE choice" });
      return;
    }

    const delta = choice.delta || {};
    if (typeof delta !== "object" || Array.isArray(delta)) {
      failStream(controller, { message: "Invalid OpenAI SSE delta" });
      return;
    }
    if (delta.reasoning_content != null && typeof delta.reasoning_content !== "string") {
      failStream(controller, { message: "Invalid OpenAI SSE reasoning content" });
      return;
    }
    if (delta.content != null && typeof delta.content !== "string") {
      failStream(controller, { message: "Invalid OpenAI SSE content" });
      return;
    }

    const parts = [];
    if (delta.reasoning_content) {
      parts.push({ text: delta.reasoning_content, thought: true });
    }
    if (delta.content) {
      parts.push({ text: delta.content });
    }

    // Skip pure role-only deltas with no content and no finish signal
    if (parts.length === 0 && !choice.finish_reason) return;

    const candidate = {
      content: {
        role: "model",
        parts: parts.length > 0 ? parts : [{ text: "" }],
      },
      index: 0,
    };

    if (choice.finish_reason) {
      candidate.finishReason = FINISH_REASON_MAP[choice.finish_reason] || "STOP";
      terminalSeen = true;
    }

    const geminiChunk = { candidates: [candidate] };

    // Attach usage + modelVersion on the final chunk (when finish_reason is set)
    if (choice.finish_reason && parsed.usage) {
      geminiChunk.usageMetadata = toGeminiUsage(parsed.usage);
      geminiChunk.modelVersion = parsed.model || model;
    }

    controller.enqueue(
      encoder.encode("data: " + JSON.stringify(geminiChunk) + "\r\n\r\n")
    );
    emittedResult = true;
  };

  const drainCompleteLines = (controller) => {
    // Keep the final unterminated line between chunks. TextDecoder's streaming
    // mode separately retains split UTF-8 code points.
    const lines = pending.split(/\r\n|\r|\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      emitLine(line, controller);
      if (streamFailed || transportTerminated) break;
    }
  };

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      if (streamFailed) return;
      try {
        pending += decoder.decode(chunk, { stream: true });
      } catch {
        failStream(controller, { message: "Invalid UTF-8 in OpenAI SSE stream" });
        return;
      }
      drainCompleteLines(controller);
    },
    flush(controller) {
      if (streamFailed) return;
      try {
        pending += decoder.decode();
      } catch {
        failStream(controller, { message: "Invalid UTF-8 in OpenAI SSE stream" });
        return;
      }
      if (pending) emitLine(pending, controller);
      pending = "";
      if (!streamFailed && !terminalSeen) {
        emitError(controller, {
          message: emittedResult
            ? "OpenAI SSE ended before a terminal event"
            : "OpenAI SSE ended without a response event",
        });
      }
    },
  });

  const transformedBody = signal
    ? upstreamResponse.body.pipeThrough(transformStream, { signal })
    : upstreamResponse.body.pipeThrough(transformStream);
  return new Response(transformedBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Convert an OpenAI chat.completion JSON response into a Gemini
 * GenerateContentResponse so that Gemini CLI can parse it.
 */
async function convertOpenAIResponseToGemini(response, model, signal = null) {
  if (!response.ok) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: corsHeadersFrom(response),
    });
  }

  let bytes;
  try {
    bytes = await readGeminiNativeBody(response, signal);
  } catch (error) {
    return geminiCompatibilityError(error?.message || "Unable to read OpenAI response");
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return geminiCompatibilityError("Invalid OpenAI JSON response");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return geminiCompatibilityError("Invalid OpenAI JSON response envelope");
  }

  if (body.error) return Response.json({ error: normalizeGeminiError(body.error) }, {
    status: 502,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });

  if (Object.prototype.hasOwnProperty.call(body, "candidates")) {
    if (!Array.isArray(body.candidates)) {
      return geminiCompatibilityError("Invalid Gemini candidates in upstream response");
    }
    return Response.json(body, {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  const choice = body.choices?.[0];
  if (!choice || !choice.message || typeof choice.message !== "object") {
    return geminiCompatibilityError("OpenAI response is missing choices");
  }

  const { message, finish_reason } = choice;

  const parts = [];
  if (message.reasoning_content) {
    parts.push({ text: message.reasoning_content, thought: true });
  }
  parts.push({ text: message.content || "" });

  const finishReason = FINISH_REASON_MAP[finish_reason] || "STOP";

  const geminiResponse = {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
        index: 0,
      },
    ],
    modelVersion: body.model || model,
  };

  if (body.usage) {
    geminiResponse.usageMetadata = toGeminiUsage(body.usage);
  }

  return Response.json(geminiResponse, {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
