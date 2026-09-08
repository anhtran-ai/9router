import { Buffer } from "node:buffer";
import {
  createErrorResult,
  parseUpstreamError,
  readUpstreamBodyText,
} from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { awaitWithSignal, throwIfAborted, waitWithSignal } from "../utils/abort.js";

const DEFAULT_STT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STT_BODY_STALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STT_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_STT_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_ASSEMBLYAI_POLL_INTERVAL_MS = 2_000;

export class InvalidSttResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidSttResponseError";
    this.code = "ERR_INVALID_STT_RESPONSE";
  }
}

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sanitizeCredentialError(message, credentials) {
  let value = String(message || "STT request failed")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  for (const key of ["accessToken", "refreshToken", "apiKey"]) {
    const secret = credentials?.[key];
    if (typeof secret === "string" && secret.length >= 8) {
      value = value.split(secret).join("[redacted]");
    }
  }
  return value;
}

function createFullResponseDeadline(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = new DOMException("STT upstream request timed out", "TimeoutError");
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
    dispose() {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.("abort", onCallerAbort);
    },
  };
}

function buildAuthHeaders(cfg, token) {
  if (!token) return {};
  switch (cfg.authHeader) {
    case "bearer":        return { "Authorization": `Bearer ${token}` };
    case "token":         return { "Authorization": `Token ${token}` };
    case "x-api-key":     return { "x-api-key": token };
    case "key":           return { "Authorization": `Key ${token}` };
    case "authorization": return { "Authorization": token };
    default:               return { "Authorization": `Bearer ${token}` };
  }
}

function resolveAudioContentType(file) {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("audio/")) return type;
  const name = typeof file.name === "string" ? file.name.toLowerCase() : "";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  const map = {
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    webm: "audio/webm",
    aac: "audio/aac",
    opus: "audio/opus",
  };
  return map[ext] || "application/octet-stream";
}

function hasExplicitError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
  return payload.error != null || payload.errors != null || payload.success === false ||
    ["error", "failed", "failure", "cancelled", "canceled", "expired"].includes(status);
}

function requireTranscript(value, providerLabel) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidSttResponseError(`${providerLabel} returned no transcript`);
  }
  return value;
}

async function readJsonResponse(response, context, providerLabel, { allowExplicitError = false } = {}) {
  const text = await readUpstreamBodyText(response, {
    signal: context.signal,
    maxBytes: context.maxResponseBytes,
    stallTimeoutMs: context.bodyStallTimeoutMs,
    fatalUtf8: true,
  });
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new InvalidSttResponseError(`${providerLabel} returned malformed JSON`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidSttResponseError(`${providerLabel} returned an invalid JSON envelope`);
  }
  if (!allowExplicitError && hasExplicitError(payload)) {
    throw new InvalidSttResponseError(`${providerLabel} returned an error payload with HTTP 200`);
  }
  return payload;
}

async function upstreamError(response, context) {
  const { statusCode, message } = await parseUpstreamError(response, null, {
    signal: context.signal,
    stallTimeoutMs: context.bodyStallTimeoutMs,
  });
  return createErrorResult(statusCode, sanitizeCredentialError(message, context.credentials));
}

function jsonResponse(text) {
  return {
    success: true,
    response: new Response(JSON.stringify({ text }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}

async function readAudioArrayBuffer(file, context) {
  const buffer = await awaitWithSignal(file.arrayBuffer(), context.signal);
  if (buffer.byteLength > context.maxAudioBytes) {
    throw Object.assign(new Error(`Audio file exceeds the ${context.maxAudioBytes}-byte limit`), {
      status: 413,
    });
  }
  return buffer;
}

async function transcribeDeepgram(cfg, file, model, token, formData, context) {
  const url = new URL(cfg.baseUrl);
  url.searchParams.set("model", model);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  const language = formData.get("language");
  if (typeof language === "string" && language.trim()) {
    url.searchParams.set("language", language.trim());
  } else {
    url.searchParams.set("detect_language", "true");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...buildAuthHeaders(cfg, token),
      "Content-Type": resolveAudioContentType(file),
    },
    body: file,
    signal: context.signal,
  });
  if (!response.ok) return upstreamError(response, context);
  const data = await readJsonResponse(response, context, "Deepgram");
  const text = requireTranscript(
    data.results?.channels?.[0]?.alternatives?.[0]?.transcript,
    "Deepgram",
  );
  return jsonResponse(text);
}

async function transcribeAssemblyAI(cfg, file, model, token, context) {
  const auth = buildAuthHeaders(cfg, token);
  const upload = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/octet-stream" },
    body: file,
    signal: context.signal,
  });
  if (!upload.ok) return upstreamError(upload, context);
  const uploadData = await readJsonResponse(upload, context, "AssemblyAI upload");
  if (typeof uploadData.upload_url !== "string" || !uploadData.upload_url.trim()) {
    throw new InvalidSttResponseError("AssemblyAI upload returned no upload URL");
  }

  const submit = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_url: uploadData.upload_url,
      speech_models: [model],
      language_detection: true,
    }),
    signal: context.signal,
  });
  if (!submit.ok) return upstreamError(submit, context);
  const submitData = await readJsonResponse(submit, context, "AssemblyAI submit");
  if (typeof submitData.id !== "string" || !submitData.id.trim()) {
    throw new InvalidSttResponseError("AssemblyAI submit returned no transcript ID");
  }

  while (true) {
    await waitWithSignal(context.pollIntervalMs, context.signal);
    const poll = await fetch(`${cfg.baseUrl}/${encodeURIComponent(submitData.id)}`, {
      headers: auth,
      signal: context.signal,
    });
    if (!poll.ok) {
      const pollError = await upstreamError(poll, context);
      if (poll.status === HTTP_STATUS.RATE_LIMITED || poll.status >= 500) continue;
      return pollError;
    }

    const pollData = await readJsonResponse(
      poll,
      context,
      "AssemblyAI poll",
      { allowExplicitError: true },
    );
    if (pollData.status === "completed") {
      return jsonResponse(requireTranscript(pollData.text, "AssemblyAI"));
    }
    if (pollData.status === "queued" || pollData.status === "processing") continue;
    if (pollData.status === "error") {
      const message = typeof pollData.error === "string" && pollData.error.trim()
        ? pollData.error.trim()
        : "AssemblyAI transcription job failed";
      // A completed job-level failure describes the submitted audio/options,
      // not the health of the API credential used to poll it.
      return createErrorResult(422, sanitizeCredentialError(message, context.credentials));
    }
    throw new InvalidSttResponseError("AssemblyAI poll returned an unknown status");
  }
}

async function transcribeNvidia(cfg, file, model, token, context) {
  const data = new FormData();
  data.append("file", file, file.name || "audio.wav");
  data.append("model", model);
  const response = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: buildAuthHeaders(cfg, token),
    body: data,
    signal: context.signal,
  });
  if (!response.ok) return upstreamError(response, context);
  const payload = await readJsonResponse(response, context, "NVIDIA");
  return jsonResponse(requireTranscript(payload.text ?? payload.transcript, "NVIDIA"));
}

async function transcribeGemini(cfg, file, model, token, formData, context) {
  const buffer = await readAudioArrayBuffer(file, context);
  const b64 = Buffer.from(buffer).toString("base64");
  const mime = resolveAudioContentType(file);
  const language = formData.get("language");
  const userPrompt = formData.get("prompt");
  let promptText = typeof userPrompt === "string" && userPrompt.trim()
    ? userPrompt.trim()
    : "Generate a transcript of the speech. Return only the transcribed text, no commentary.";
  if (typeof language === "string" && language.trim()) {
    promptText += ` Language: ${language.trim()}.`;
  }

  const url = `${cfg.baseUrl}/${model}:generateContent?key=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: promptText },
          { inline_data: { mime_type: mime, data: b64 } },
        ],
      }],
    }),
    signal: context.signal,
  });
  if (!response.ok) return upstreamError(response, context);
  const data = await readJsonResponse(response, context, "Gemini");
  const text = data.candidates?.[0]?.content?.parts
    ?.map(part => typeof part?.text === "string" ? part.text : "")
    .join("");
  return jsonResponse(requireTranscript(text, "Gemini"));
}

async function transcribeHuggingFace(cfg, file, model, token, context) {
  const encodedModel = model.split("/").map(segment => encodeURIComponent(segment)).join("/");
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/${encodedModel}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...buildAuthHeaders(cfg, token),
      "Content-Type": resolveAudioContentType(file),
    },
    body: file,
    signal: context.signal,
  });
  if (!response.ok) return upstreamError(response, context);
  const data = await readJsonResponse(response, context, "HuggingFace");
  return jsonResponse(requireTranscript(data.text, "HuggingFace"));
}

function validateCompatibleTranscript(text, contentType) {
  const trimmed = text.trim();
  if (!trimmed) throw new InvalidSttResponseError("STT provider returned no transcript");

  const normalizedType = contentType.toLowerCase();
  if (normalizedType.includes("text/html") ||
      /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text)) {
    throw new InvalidSttResponseError("STT provider returned HTML instead of a transcript");
  }

  const declaresJson = normalizedType.includes("json");
  const looksJson = /^(?:\{|\[)/.test(trimmed);
  if (declaresJson || looksJson) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      if (declaresJson) {
        throw new InvalidSttResponseError("STT provider returned malformed JSON");
      }
    }
    if (payload !== undefined) {
      if (hasExplicitError(payload)) {
        throw new InvalidSttResponseError("STT provider returned an error payload with HTTP 200");
      }
      const transcript = typeof payload === "string"
        ? payload
        : payload?.text ?? payload?.transcript;
      requireTranscript(transcript, "STT provider");
      return;
    }
  }

  if (normalizedType &&
      !normalizedType.startsWith("text/") &&
      !normalizedType.includes("application/x-subrip")) {
    throw new InvalidSttResponseError("STT provider returned an unsupported content type");
  }
}

function isSafeHuggingFaceModelId(model) {
  if (typeof model !== "string" || !model || model.length > 512) return false;
  if (model.includes("\\") || model.includes("%") || /[\u0000-\u001f\u007f]/.test(model)) return false;
  const segments = model.split("/");
  return segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

export function validateSttInput({
  provider,
  model,
  formData,
  sttConfig,
  maxAudioBytes = DEFAULT_MAX_STT_AUDIO_BYTES,
}) {
  const file = formData?.get?.("file");
  if (!file) return { status: HTTP_STATUS.BAD_REQUEST, message: "Missing required field: file" };
  if (typeof file.arrayBuffer !== "function" || !Number.isSafeInteger(file.size)) {
    return { status: HTTP_STATUS.BAD_REQUEST, message: "file must be an uploaded audio file" };
  }

  const audioByteLimit = positiveLimit(maxAudioBytes, DEFAULT_MAX_STT_AUDIO_BYTES);
  if (file.size === 0) return { status: HTTP_STATUS.BAD_REQUEST, message: "Audio file is empty" };
  if (file.size > audioByteLimit) {
    return { status: 413, message: `Audio file exceeds the ${audioByteLimit}-byte limit` };
  }
  if (!sttConfig) {
    return { status: HTTP_STATUS.BAD_REQUEST, message: `Provider '${provider}' does not support STT` };
  }
  if (sttConfig.format === "huggingface-asr" && !isSafeHuggingFaceModelId(model)) {
    return { status: HTTP_STATUS.BAD_REQUEST, message: "Invalid model ID" };
  }
  return null;
}

async function transcribeOpenAICompatible(cfg, file, model, token, formData, context) {
  const data = new FormData();
  data.append("file", file, file.name || "audio.wav");
  data.append("model", model);
  for (const key of ["language", "prompt", "response_format", "temperature"]) {
    const value = formData.get(key);
    if (typeof value === "string" && value !== "") data.append(key, value);
  }

  const response = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: buildAuthHeaders(cfg, token),
    body: data,
    signal: context.signal,
  });
  if (!response.ok) return upstreamError(response, context);

  const contentType = response.headers.get("content-type") || "";
  const text = await readUpstreamBodyText(response, {
    signal: context.signal,
    maxBytes: context.maxResponseBytes,
    stallTimeoutMs: context.bodyStallTimeoutMs,
    fatalUtf8: true,
  });
  validateCompatibleTranscript(text, contentType);
  return {
    success: true,
    response: new Response(text, {
      status: 200,
      headers: {
        "Content-Type": contentType || "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}

export async function handleSttCore({
  provider,
  model,
  formData,
  credentials,
  sttConfig,
  signal: callerSignal = null,
  requestTimeoutMs = DEFAULT_STT_REQUEST_TIMEOUT_MS,
  responseStallTimeoutMs = DEFAULT_STT_BODY_STALL_TIMEOUT_MS,
  maxAudioBytes = DEFAULT_MAX_STT_AUDIO_BYTES,
  maxResponseBytes = DEFAULT_MAX_STT_RESPONSE_BYTES,
  pollIntervalMs = DEFAULT_ASSEMBLYAI_POLL_INTERVAL_MS,
}) {
  const audioByteLimit = positiveLimit(maxAudioBytes, DEFAULT_MAX_STT_AUDIO_BYTES);
  const inputError = validateSttInput({ provider, model, formData, sttConfig, maxAudioBytes: audioByteLimit });
  if (inputError) return createErrorResult(inputError.status, inputError.message);
  const file = formData.get("file");

  let cfg = sttConfig;

  const overrideUrl = credentials?.providerSpecificData?.baseUrl;
  if (overrideUrl) cfg = { ...cfg, baseUrl: String(overrideUrl).replace(/\/+$/, "") };
  if (!cfg.baseUrl) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "STT provider endpoint is missing");

  const token = cfg.authType === "none"
    ? null
    : credentials?.apiKey || credentials?.accessToken;
  if (cfg.authType !== "none" && !token) {
    return createErrorResult(HTTP_STATUS.UNAUTHORIZED, `No credentials for STT provider: ${provider}`);
  }

  const deadline = createFullResponseDeadline(
    callerSignal,
    positiveLimit(requestTimeoutMs, DEFAULT_STT_REQUEST_TIMEOUT_MS),
  );
  const context = {
    signal: deadline.signal,
    credentials,
    maxAudioBytes: audioByteLimit,
    maxResponseBytes: positiveLimit(maxResponseBytes, DEFAULT_MAX_STT_RESPONSE_BYTES),
    bodyStallTimeoutMs: positiveLimit(
      responseStallTimeoutMs,
      DEFAULT_STT_BODY_STALL_TIMEOUT_MS,
    ),
    pollIntervalMs: positiveLimit(pollIntervalMs, DEFAULT_ASSEMBLYAI_POLL_INTERVAL_MS),
  };

  try {
    throwIfAborted(deadline.signal);
    switch (cfg.format) {
      case "deepgram":
        return await transcribeDeepgram(cfg, file, model, token, formData, context);
      case "assemblyai":
        return await transcribeAssemblyAI(cfg, file, model, token, context);
      case "nvidia-asr":
        return await transcribeNvidia(cfg, file, model, token, context);
      case "huggingface-asr":
        return await transcribeHuggingFace(cfg, file, model, token, context);
      case "gemini-stt":
        return await transcribeGemini(cfg, file, model, token, formData, context);
      default:
        return await transcribeOpenAICompatible(cfg, file, model, token, formData, context);
    }
  } catch (error) {
    if (callerSignal?.aborted) {
      return createErrorResult(HTTP_STATUS.CLIENT_CLOSED_REQUEST, "Request aborted");
    }
    if (deadline.didTimeOut()) {
      return createErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, "STT upstream request timed out");
    }
    if (Number.isSafeInteger(error?.status)) {
      return createErrorResult(
        error.status,
        sanitizeCredentialError(error.message || "Invalid STT request", credentials),
      );
    }
    if (error instanceof InvalidSttResponseError ||
        error?.code === "ERR_UPSTREAM_BODY_TOO_LARGE" ||
        error?.code === "ERR_UPSTREAM_BODY_STALLED") {
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        sanitizeCredentialError(error.message || "Invalid STT provider response", credentials),
        undefined,
        "invalid_upstream_response",
      );
    }
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      sanitizeCredentialError(error?.message || "STT request failed", credentials),
    );
  } finally {
    deadline.dispose();
  }
}

export const STT_REQUEST_TIMEOUT_MS = DEFAULT_STT_REQUEST_TIMEOUT_MS;
export const STT_BODY_STALL_TIMEOUT_MS = DEFAULT_STT_BODY_STALL_TIMEOUT_MS;
export const MAX_STT_AUDIO_BYTES = DEFAULT_MAX_STT_AUDIO_BYTES;
export const MAX_STT_RESPONSE_BYTES = DEFAULT_MAX_STT_RESPONSE_BYTES;
