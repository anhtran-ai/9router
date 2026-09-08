import { createErrorResult } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import {
  MAX_TTS_RESPONSE_BYTES,
  TTS_BODY_STALL_TIMEOUT_MS,
  TTS_GENERATION_TIMEOUT_MS,
} from "../config/mediaConfig.js";
import { getTtsAdapter, synthesizeViaConfig } from "./ttsProviders/index.js";
import {
  decodeBase64Audio,
  TtsBodyStallError,
} from "./ttsProviders/_base.js";

// Re-export voice fetchers + voices APIs for backward compat with existing routes
export {
  VOICE_FETCHERS,
  fetchEdgeTtsVoices,
  fetchLocalDeviceVoices,
  fetchElevenLabsVoices,
} from "./ttsProviders/index.js";

// ── Response Formatter (DRY) ───────────────────────────────────
function createTtsResponse(audio, responseFormat) {
  const { bytes: audioBuffer, base64: base64Audio, format } = audio;

  // JSON format: return base64 encoded audio
  if (responseFormat === "json") {
    return {
      success: true,
      response: new Response(JSON.stringify({ audio: base64Audio, format }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }),
    };
  }

  // Binary format (default): return raw audio
  return {
    success: true,
    response: new Response(audioBuffer, {
      headers: {
        "Content-Type": `audio/${format}`,
        "Content-Length": String(audioBuffer.length),
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createFullResponseDeadline(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = new DOMException("TTS upstream request timed out", "TimeoutError");
  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason ?? new DOMException("Request aborted", "AbortError"));
  };

  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener?.("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.("abort", onCallerAbort);
    },
  };
}

function sanitizeCredentialError(message, credentials) {
  let value = String(message || "TTS synthesis failed")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  for (const key of ["accessToken", "refreshToken", "apiKey"]) {
    const secret = credentials?.[key];
    if (typeof secret === "string" && secret.length >= 8) {
      value = value.split(secret).join("[redacted]");
    }
  }
  return value;
}

function errorResult(error, callerSignal, deadline, provider, model, credentials) {
  if (callerSignal?.aborted) {
    return createErrorResult(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
  }
  if (deadline.didTimeOut() || error instanceof TtsBodyStallError) {
    return createErrorResult(
      HTTP_STATUS.GATEWAY_TIMEOUT,
      `[${provider}/${model}] TTS upstream request timed out`,
    );
  }
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : HTTP_STATUS.BAD_GATEWAY;
  return createErrorResult(
    status,
    sanitizeCredentialError(error?.message || "TTS synthesis failed", credentials),
  );
}

// ── Core handler ───────────────────────────────────────────────
/**
 * Synthesize text to audio. Provider logic lives in `./ttsProviders/{id}.js`
 * or is dispatched generically via `ttsConfig.format`.
 *
 * @returns {Promise<{success, response, status?, error?}>}
 */
export async function handleTtsCore({
  provider,
  model,
  input,
  credentials,
  responseFormat = "mp3",
  language,
  style,
  signal: callerSignal = null,
  requestTimeoutMs = TTS_GENERATION_TIMEOUT_MS,
  responseStallTimeoutMs = TTS_BODY_STALL_TIMEOUT_MS,
  maxResponseBytes = MAX_TTS_RESPONSE_BYTES,
  onRequestSuccess = null,
}) {
  if (typeof input !== "string" || !input.trim()) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }

  const responseByteLimit = positiveLimit(maxResponseBytes, MAX_TTS_RESPONSE_BYTES);
  const deadline = createFullResponseDeadline(
    callerSignal,
    positiveLimit(requestTimeoutMs, TTS_GENERATION_TIMEOUT_MS),
  );
  const transportOptions = {
    language,
    style,
    signal: deadline.signal,
    maxResponseBytes: responseByteLimit,
    stallTimeoutMs: positiveLimit(responseStallTimeoutMs, TTS_BODY_STALL_TIMEOUT_MS),
  };
  let successResult;

  try {
    // Special-case adapters (google-tts, edge-tts, local-device, elevenlabs, openai, openrouter, gemini, xiaomi-mimo)
    const adapter = getTtsAdapter(provider);
    if (adapter) {
      const result = await adapter.synthesize(input.trim(), model, credentials, responseFormat, transportOptions);
      if (result?.success === false) return result;
      if (result?.success === true) {
        throw new Error("Legacy TTS response envelopes cannot be integrity-validated");
      }
      successResult = createTtsResponse(
        decodeBase64Audio(result?.base64, result?.format, responseByteLimit),
        responseFormat,
      );
    } else {
      // Generic config-driven (hyperbolic, deepgram, nvidia, huggingface, inworld, cartesia, playht, coqui, tortoise, qwen, ...)
      const result = await synthesizeViaConfig(
        provider,
        input.trim(),
        model,
        credentials,
        transportOptions,
      );
      if (result) {
        successResult = createTtsResponse(
          decodeBase64Audio(result.base64, result.format, responseByteLimit),
          responseFormat,
        );
      } else {
        return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support TTS via this route.`);
      }
    }
  } catch (err) {
    return errorResult(err, callerSignal, deadline, provider, model, credentials);
  } finally {
    // The absolute deadline covers fetch plus full body consumption, then stops
    // before local account-state cleanup begins.
    deadline.dispose();
  }

  // A provider is successful only after its entire response has been consumed,
  // decoded and passed container/magic validation.
  if (onRequestSuccess) {
    try {
      // Invoke the hook before returning so success accounting is scheduled in
      // order, but do not let secondary persistence failure replace verified,
      // potentially billable audio with a retryable 5xx response.
      Promise.resolve(onRequestSuccess()).catch(error => {
        console.error("[TtsCore] onRequestSuccess failed:", error?.message || error);
      });
    } catch (error) {
      console.error("[TtsCore] onRequestSuccess failed:", error?.message || error);
    }
  }
  return successResult;
}
