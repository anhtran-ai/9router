// Shared TTS transport and payload-integrity helpers.
import { Buffer } from "node:buffer";
import {
  MAX_TTS_RESPONSE_BYTES,
  TTS_BODY_STALL_TIMEOUT_MS,
} from "../../config/mediaConfig.js";

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const MAX_TTS_ERROR_BYTES = 256 * 1024;

export class TtsBodyTooLargeError extends Error {
  constructor(maxBytes, actualBytes = null) {
    super(`TTS upstream response exceeds the ${maxBytes}-byte limit${Number.isSafeInteger(actualBytes) ? ` (${actualBytes} bytes)` : ""}`);
    this.name = "TtsBodyTooLargeError";
    this.code = "ERR_TTS_BODY_TOO_LARGE";
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

export class TtsBodyStallError extends Error {
  constructor(timeoutMs) {
    super(`TTS upstream response body stalled for more than ${timeoutMs}ms`);
    this.name = "TtsBodyStallError";
    this.code = "ERR_TTS_BODY_STALLED";
  }
}

export class TtsInvalidResponseError extends Error {
  constructor(message = "TTS upstream returned an invalid response") {
    super(message);
    this.name = "TtsInvalidResponseError";
    this.code = "ERR_TTS_INVALID_RESPONSE";
  }
}

export class TtsUpstreamError extends Error {
  constructor(status, message) {
    super(message || `TTS upstream error (${status})`);
    this.name = "TtsUpstreamError";
    this.status = status;
  }
}

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Request aborted", "AbortError");
}

function declaredBodyLength(response) {
  const raw = response?.headers?.get?.("content-length");
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

function cancelBody(body, reason) {
  try {
    const cancellation = body?.cancel?.(reason);
    cancellation?.catch?.(() => {});
  } catch {
    // Cleanup is best-effort and must not replace the primary body failure.
  }
}

export function cancelTtsResponse(response, reason) {
  cancelBody(response?.body, reason);
}

function readChunk(reader, signal, stallTimeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(
      () => finish(reject, new TtsBodyStallError(stallTimeoutMs)),
      stallTimeoutMs,
    );
    timer.unref?.();

    let pending;
    try {
      pending = reader.read();
    } catch (error) {
      finish(reject, error);
      return;
    }
    // Keep observing reader.read() after timeout/abort wins so a late rejection
    // never becomes unhandled.
    Promise.resolve(pending).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

/**
 * Fully consume one upstream TTS body with an absolute byte cap, a per-chunk
 * stall timeout and caller/deadline abort propagation. Cancellation is fired
 * but never awaited because a broken stream can also hang its cancel hook.
 */
export async function readTtsResponseBytes(
  response,
  {
    signal = null,
    maxResponseBytes = MAX_TTS_RESPONSE_BYTES,
    stallTimeoutMs = TTS_BODY_STALL_TIMEOUT_MS,
  } = {},
) {
  const maxBytes = positiveLimit(maxResponseBytes, MAX_TTS_RESPONSE_BYTES);
  const stallMs = positiveLimit(stallTimeoutMs, TTS_BODY_STALL_TIMEOUT_MS);
  const declaredLength = declaredBodyLength(response);

  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = new TtsBodyTooLargeError(maxBytes, declaredLength);
    cancelBody(response?.body, error);
    throw error;
  }
  if (signal?.aborted) {
    const error = abortReason(signal);
    cancelBody(response?.body, error);
    throw error;
  }

  const body = response?.body;
  if (!body || typeof body.getReader !== "function") {
    throw new TtsInvalidResponseError("TTS upstream response has no readable body");
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;
  let terminalError = null;

  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal, stallMs);
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new TtsInvalidResponseError("TTS upstream returned an invalid body chunk");
      }
      total += value.byteLength;
      if (total > maxBytes) throw new TtsBodyTooLargeError(maxBytes, total);
      if (value.byteLength) chunks.push(value);
    }

    // Fetch transparently decompresses encoded bodies while retaining the
    // wire Content-Length, so compare lengths only for identity bodies.
    const contentEncoding = response?.headers?.get?.("content-encoding")?.trim().toLowerCase();
    if (declaredLength !== null && (!contentEncoding || contentEncoding === "identity") && total !== declaredLength) {
      throw new TtsInvalidResponseError(
        `TTS upstream response was truncated (declared ${declaredLength} bytes, received ${total})`,
      );
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    terminalError = error;
    throw error;
  } finally {
    let cancellation = null;
    if (!completed || terminalError) {
      try {
        cancellation = Promise.resolve(reader.cancel(terminalError)).catch(() => {});
      } catch {
        // Preserve the primary timeout, abort, transport, or integrity error.
      }
    }
    const release = () => {
      try { reader.releaseLock?.(); } catch { /* pending read or already released */ }
    };
    release();
    cancellation?.finally(release);
  }
}

export async function readTtsResponseText(response, options = {}) {
  const bytes = await readTtsResponseBytes(response, options);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TtsInvalidResponseError("TTS upstream returned invalid UTF-8");
  }
}

export async function readTtsJson(response, options = {}) {
  const text = await readTtsResponseText(response, options);
  if (!text.trim()) throw new TtsInvalidResponseError("TTS upstream returned an empty JSON response");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TtsInvalidResponseError("TTS upstream returned malformed JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TtsInvalidResponseError("TTS upstream returned an invalid JSON envelope");
  }
  const failureStatus = typeof data.status === "string" &&
    ["error", "failed", "failure", "cancelled", "canceled", "expired"].includes(data.status.trim().toLowerCase());
  if (data.error != null || data.errors != null || data.success === false || failureStatus) {
    const message = data.error?.message || data.error?.detail || data.errors?.[0]?.message ||
      data.message || "TTS upstream returned an error envelope with HTTP 200";
    throw new TtsInvalidResponseError(typeof message === "string" ? message : "TTS upstream returned an error envelope with HTTP 200");
  }
  return data;
}

function isRejectedAudioContentType(contentType) {
  const value = String(contentType || "").toLowerCase();
  return value.startsWith("text/")
    || value.includes("json")
    || value.includes("html")
    || value.includes("xml");
}

function formatFromContentType(contentType, fallback) {
  const value = String(contentType || "").toLowerCase();
  if (value.includes("wav") || value.includes("wave")) return "wav";
  if (value.includes("mpeg") || value.includes("mp3")) return "mp3";
  if (value.includes("ogg") || value.includes("opus")) return "ogg";
  if (value.includes("flac")) return "flac";
  if (value.includes("aac")) return "aac";
  return fallback;
}

function normalizeAudioFormat(format) {
  const value = String(format || "mp3").trim().toLowerCase();
  const aliases = { mpeg: "mp3", mpeg3: "mp3", wave: "wav", "x-wav": "wav", opus: "ogg" };
  const normalized = aliases[value] || value;
  if (!/^[a-z0-9][a-z0-9.+-]{0,31}$/.test(normalized)) {
    throw new TtsInvalidResponseError("TTS upstream returned an invalid audio format");
  }
  if (!["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "mp4", "pcm", "l16", "raw"].includes(normalized)) {
    throw new TtsInvalidResponseError(`TTS upstream returned unsupported audio format '${normalized}'`);
  }
  return normalized;
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function isMp3FrameHeader(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[offset + 1] >> 3) & 0x03;
  const layer = (bytes[offset + 1] >> 1) & 0x03;
  const bitrate = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRate = (bytes[offset + 2] >> 2) & 0x03;
  return version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3;
}

function mp3FrameLength(bytes, offset) {
  if (!isMp3FrameHeader(bytes, offset)) return 0;
  const versionBits = (bytes[offset + 1] >> 3) & 0x03;
  const layerBits = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleIndex = (bytes[offset + 2] >> 2) & 0x03;
  const padding = (bytes[offset + 2] >> 1) & 0x01;
  const mpeg1 = versionBits === 3;
  const sampleRates = versionBits === 3
    ? [44100, 48000, 32000]
    : versionBits === 2
      ? [22050, 24000, 16000]
      : [11025, 12000, 8000];
  const layer1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
  const layer2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
  const layer3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const mpeg2Layer1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
  const mpeg2Layer23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const table = mpeg1
    ? (layerBits === 3 ? layer1 : layerBits === 2 ? layer2 : layer3)
    : (layerBits === 3 ? mpeg2Layer1 : mpeg2Layer23);
  const bitrate = table[bitrateIndex] * 1000;
  const sampleRate = sampleRates[sampleIndex];
  if (layerBits === 3) return Math.floor((12 * bitrate / sampleRate + padding) * 4);
  const coefficient = layerBits === 1 && !mpeg1 ? 72 : 144;
  return Math.floor(coefficient * bitrate / sampleRate + padding);
}

function hasCompleteMp3Frame(bytes, offset) {
  const length = mp3FrameLength(bytes, offset);
  return length > 0 && offset + length <= bytes.length;
}

function validateMp3(bytes) {
  if (hasCompleteMp3Frame(bytes, 0)) return;
  if (isMp3FrameHeader(bytes, 0)) {
    throw new TtsInvalidResponseError("TTS upstream returned truncated MP3 audio");
  }
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") {
    throw new TtsInvalidResponseError("TTS upstream returned invalid MP3 audio");
  }
  const sizeBytes = bytes.subarray(6, 10);
  if ([...sizeBytes].some(value => value > 0x7f)) {
    throw new TtsInvalidResponseError("TTS upstream returned an invalid MP3 ID3 header");
  }
  const tagSize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
  const frameStart = 10 + tagSize + ((bytes[5] & 0x10) ? 10 : 0);
  if (frameStart >= bytes.length) {
    throw new TtsInvalidResponseError("TTS upstream returned truncated MP3 audio");
  }
  for (let offset = frameStart; offset + 4 <= bytes.length; offset++) {
    if (hasCompleteMp3Frame(bytes, offset)) return;
    if (isMp3FrameHeader(bytes, offset)) {
      throw new TtsInvalidResponseError("TTS upstream returned truncated MP3 audio");
    }
  }
  throw new TtsInvalidResponseError("TTS upstream returned MP3 metadata without audio frames");
}

function validateWav(bytes) {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new TtsInvalidResponseError("TTS upstream returned invalid WAV audio");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd !== bytes.length) throw new TtsInvalidResponseError("TTS upstream returned truncated or trailing WAV audio");

  let offset = 12;
  let blockAlign = 0;
  let foundFormat = false;
  let foundAudio = false;
  while (offset + 8 <= riffEnd) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkEnd = offset + 8 + chunkSize;
    if (chunkEnd > riffEnd || chunkEnd > bytes.length) {
      throw new TtsInvalidResponseError("TTS upstream returned truncated WAV audio");
    }
    if (chunkId === "fmt ") {
      if (foundFormat || chunkSize < 16) {
        throw new TtsInvalidResponseError("TTS upstream returned an invalid WAV format chunk");
      }
      const audioFormat = view.getUint16(offset + 8, true);
      const channels = view.getUint16(offset + 10, true);
      const sampleRate = view.getUint32(offset + 12, true);
      const byteRate = view.getUint32(offset + 16, true);
      blockAlign = view.getUint16(offset + 20, true);
      const bitsPerSample = view.getUint16(offset + 22, true);
      if (!audioFormat || !channels || channels > 64 || !sampleRate || !byteRate || !blockAlign || !bitsPerSample) {
        throw new TtsInvalidResponseError("TTS upstream returned invalid WAV stream parameters");
      }
      foundFormat = true;
    } else if (chunkId === "data") {
      if (!foundFormat || chunkSize === 0 || chunkSize % blockAlign !== 0) {
        throw new TtsInvalidResponseError("TTS upstream returned invalid WAV audio data");
      }
      foundAudio = true;
    }
    const paddedEnd = chunkEnd + (chunkSize % 2);
    if (paddedEnd > riffEnd) throw new TtsInvalidResponseError("TTS upstream returned truncated WAV padding");
    offset = paddedEnd;
  }
  if (offset !== riffEnd || !foundFormat || !foundAudio) {
    throw new TtsInvalidResponseError("TTS upstream WAV response is missing required audio chunks");
  }
}

function validateOgg(bytes) {
  let offset = 0;
  let payloadBytes = 0;
  let sawEndOfStream = false;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || ascii(bytes, offset, 4) !== "OggS" || bytes[offset + 4] !== 0) {
      throw new TtsInvalidResponseError("TTS upstream returned invalid Ogg audio");
    }
    const pageSegments = bytes[offset + 26];
    const segmentTableEnd = offset + 27 + pageSegments;
    if (segmentTableEnd > bytes.length) {
      throw new TtsInvalidResponseError("TTS upstream returned truncated Ogg segment table");
    }
    let pagePayload = 0;
    for (let i = offset + 27; i < segmentTableEnd; i++) pagePayload += bytes[i];
    const pageEnd = segmentTableEnd + pagePayload;
    if (pageEnd > bytes.length) {
      throw new TtsInvalidResponseError("TTS upstream returned truncated Ogg page data");
    }
    payloadBytes += pagePayload;
    sawEndOfStream = (bytes[offset + 5] & 0x04) !== 0;
    offset = pageEnd;
  }
  if (!payloadBytes || !sawEndOfStream) {
    throw new TtsInvalidResponseError("TTS upstream returned incomplete Ogg audio");
  }
}

function validateFlac(bytes) {
  if (bytes.length < 4 + 4 + 34 + 2 || ascii(bytes, 0, 4) !== "fLaC") {
    throw new TtsInvalidResponseError("TTS upstream returned invalid FLAC audio");
  }
  let offset = 4;
  let metadataIndex = 0;
  let sawLastMetadata = false;
  while (!sawLastMetadata) {
    if (offset + 4 > bytes.length) throw new TtsInvalidResponseError("TTS upstream returned truncated FLAC metadata");
    const header = bytes[offset];
    const type = header & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const blockStart = offset + 4;
    const blockEnd = blockStart + length;
    if (blockEnd > bytes.length) throw new TtsInvalidResponseError("TTS upstream returned truncated FLAC metadata");
    if (metadataIndex === 0) {
      if (type !== 0 || length !== 34) throw new TtsInvalidResponseError("TTS upstream FLAC response has no STREAMINFO block");
      const view = new DataView(bytes.buffer, bytes.byteOffset + blockStart, length);
      const minBlockSize = view.getUint16(0, false);
      const maxBlockSize = view.getUint16(2, false);
      const sampleRate = (bytes[blockStart + 10] << 12) |
        (bytes[blockStart + 11] << 4) |
        (bytes[blockStart + 12] >> 4);
      if (!minBlockSize || !maxBlockSize || !sampleRate) {
        throw new TtsInvalidResponseError("TTS upstream returned invalid FLAC STREAMINFO");
      }
    }
    sawLastMetadata = (header & 0x80) !== 0;
    offset = blockEnd;
    metadataIndex++;
  }
  if (offset + 2 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xfc) !== 0xf8) {
    throw new TtsInvalidResponseError("TTS upstream FLAC response has no audio frame");
  }
}

function validateAac(bytes) {
  let offset = 0;
  let frames = 0;
  while (offset < bytes.length) {
    if (offset + 7 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0) {
      throw new TtsInvalidResponseError("TTS upstream returned invalid AAC audio");
    }
    const headerLength = (bytes[offset + 1] & 0x01) ? 7 : 9;
    const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x0f;
    const frameLength = ((bytes[offset + 3] & 0x03) << 11) |
      (bytes[offset + 4] << 3) |
      ((bytes[offset + 5] >> 5) & 0x07);
    if (sampleRateIndex === 0x0f || frameLength < headerLength || offset + frameLength > bytes.length) {
      throw new TtsInvalidResponseError("TTS upstream returned truncated AAC audio");
    }
    offset += frameLength;
    frames++;
  }
  if (!frames) throw new TtsInvalidResponseError("TTS upstream returned empty AAC audio");
}

function readUint64(view, offset) {
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  const value = (high * 0x1_0000_0000) + low;
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}

function validateMp4(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let hasFtyp = false;
  let hasMoov = false;
  let hasMedia = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new TtsInvalidResponseError("TTS upstream returned truncated MP4 atom");
    const size32 = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    let headerLength = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > bytes.length) throw new TtsInvalidResponseError("TTS upstream returned truncated MP4 atom");
      headerLength = 16;
      size = readUint64(view, offset + 8);
    } else if (size32 === 0) {
      size = bytes.length - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerLength || offset + size > bytes.length) {
      throw new TtsInvalidResponseError("TTS upstream returned invalid MP4 atom size");
    }
    const payloadLength = size - headerLength;
    if (type === "ftyp" && payloadLength >= 4) hasFtyp = true;
    if (type === "moov" && payloadLength > 0) hasMoov = true;
    if (type === "mdat" && payloadLength > 0) hasMedia = true;
    offset += size;
  }
  if (!hasFtyp || !hasMoov || !hasMedia) {
    throw new TtsInvalidResponseError("TTS upstream MP4 response is missing required atoms");
  }
}

export function validateTtsAudioBytes(bytes, format = "mp3") {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TtsInvalidResponseError("TTS upstream returned empty audio");
  }
  const normalizedFormat = normalizeAudioFormat(format);
  if (normalizedFormat === "mp3") validateMp3(bytes);
  else if (normalizedFormat === "wav") validateWav(bytes);
  else if (normalizedFormat === "ogg" || normalizedFormat === "oga") validateOgg(bytes);
  else if (normalizedFormat === "flac") validateFlac(bytes);
  else if (normalizedFormat === "aac") validateAac(bytes);
  else if (["m4a", "mp4"].includes(normalizedFormat)) validateMp4(bytes);
  else if (["pcm", "l16", "raw"].includes(normalizedFormat) && (bytes.length < 2 || bytes.length % 2 !== 0)) {
    throw new TtsInvalidResponseError("TTS upstream returned invalid PCM audio");
  }
  return normalizedFormat;
}

export function decodeBase64Audio(base64, format = "mp3", maxResponseBytes = MAX_TTS_RESPONSE_BYTES) {
  if (typeof base64 !== "string") throw new TtsInvalidResponseError("TTS upstream returned no audio data");
  const compact = base64.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new TtsInvalidResponseError("TTS upstream returned invalid base64 audio");
  }
  const firstPadding = compact.indexOf("=");
  if (firstPadding !== -1 && firstPadding < compact.length - 2) {
    throw new TtsInvalidResponseError("TTS upstream returned invalid base64 audio padding");
  }
  const padded = compact.padEnd(compact.length + ((4 - compact.length % 4) % 4), "=");
  const bytes = Buffer.from(padded, "base64");
  const canonicalInput = padded.replace(/=+$/, "");
  if (bytes.toString("base64").replace(/=+$/, "") !== canonicalInput) {
    throw new TtsInvalidResponseError("TTS upstream returned invalid base64 audio");
  }
  const maxBytes = positiveLimit(maxResponseBytes, MAX_TTS_RESPONSE_BYTES);
  if (bytes.byteLength > maxBytes) throw new TtsBodyTooLargeError(maxBytes, bytes.byteLength);
  const normalizedFormat = validateTtsAudioBytes(bytes, format);
  return { bytes, base64: bytes.toString("base64"), format: normalizedFormat };
}

// Convert upstream Response (binary audio) to { base64, format }.
export async function responseToBase64(res, defaultFormat = "mp3", options = {}) {
  const contentType = res?.headers?.get?.("content-type") || "";
  if (isRejectedAudioContentType(contentType)) {
    cancelBody(res?.body, new TtsInvalidResponseError("TTS upstream returned a non-audio content type"));
    throw new TtsInvalidResponseError(`TTS upstream returned non-audio content-type '${contentType}'`);
  }
  const bytes = await readTtsResponseBytes(res, options);
  const format = formatFromContentType(contentType, defaultFormat);
  validateTtsAudioBytes(bytes, format);
  return { base64: Buffer.from(bytes).toString("base64"), format: normalizeAudioFormat(format) };
}

export async function throwUpstreamError(res, options = {}) {
  let text = "";
  try {
    text = await readTtsResponseText(res, {
      ...options,
      maxResponseBytes: Math.min(
        positiveLimit(options.maxResponseBytes, MAX_TTS_ERROR_BYTES),
        MAX_TTS_ERROR_BYTES,
      ),
    });
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    // The HTTP status is still authoritative if its optional diagnostic body
    // is oversized, malformed, or stalls.
  }
  let message = `TTS upstream error (${res.status})`;
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || parsed?.detail?.message
      || (typeof parsed?.detail === "string" ? parsed.detail : null) || text || message;
  } catch {
    message = text || message;
  }
  throw new TtsUpstreamError(res.status, message);
}

// Parse `model` string as "modelId/voiceId" — match against known model list (longest prefix wins)
export function parseModelVoice(model, defaultModel = "", defaultVoice = "", knownModels = []) {
  if (!model) return { modelId: defaultModel, voiceId: defaultVoice };
  const known = knownModels.map((m) => m.id || m).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const id of known) {
    if (model === id) return { modelId: id, voiceId: defaultVoice };
    if (model.startsWith(`${id}/`)) return { modelId: id, voiceId: model.slice(id.length + 1) };
  }
  const idx = model.lastIndexOf("/");
  if (idx > 0) return { modelId: model.slice(0, idx), voiceId: model.slice(idx + 1) };
  return { modelId: defaultModel || model, voiceId: defaultVoice || model };
}
