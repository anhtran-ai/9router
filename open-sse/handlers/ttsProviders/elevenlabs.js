// ElevenLabs TTS — voice id with optional model_id prefix
import { responseToBase64, throwUpstreamError } from "./_base.js";
import {
  VoiceListInvalidResponseError,
  VoiceListUpstreamError,
  assertVoiceListSuccessEnvelope,
  fetchVoiceListJson,
} from "./voiceList.js";

const VOICES_TTL = 24 * 60 * 60 * 1000;
const _voicesCache = new Map(); // by API key

export async function fetchElevenLabsVoices(apiKey, options = {}) {
  if (!apiKey) throw new Error("ElevenLabs API key required");
  const now = Date.now();
  const cached = _voicesCache.get(apiKey);
  if (cached && now - cached.time < VOICES_TTL) return cached.voices;

  const { response, data } = await fetchVoiceListJson(
    "https://api.elevenlabs.io/v1/voices",
    { headers: { "xi-api-key": apiKey, "Content-Type": "application/json" } },
    options,
  );
  if (!response.ok) throw new VoiceListUpstreamError("ElevenLabs", response.status);
  assertVoiceListSuccessEnvelope(data, "ElevenLabs");
  if (!Array.isArray(data.voices) || data.voices.some((voice) =>
    !voice || typeof voice !== "object" || Array.isArray(voice) ||
    typeof voice.voice_id !== "string" || !voice.voice_id.trim() ||
    typeof voice.name !== "string" || !voice.name.trim() ||
    (voice.labels != null && (typeof voice.labels !== "object" || Array.isArray(voice.labels))) ||
    (voice.labels?.language != null && typeof voice.labels.language !== "string") ||
    (voice.labels?.gender != null && typeof voice.labels.gender !== "string") ||
    (voice.verified_languages != null && !Array.isArray(voice.verified_languages))
  )) {
    throw new VoiceListInvalidResponseError("ElevenLabs returned an invalid voice catalog");
  }
  // Normalize: derive lang from labels for grouping
  const voices = (data.voices || []).map((v) => ({ ...v, lang: v.labels?.language || "en" }));
  _voicesCache.set(apiKey, { voices, time: now });
  return voices;
}

export default {
  async synthesize(text, model, credentials, _responseFormat, options = {}) {
    if (!credentials?.apiKey) throw new Error("ElevenLabs API key required");
    let modelId = "eleven_flash_v2_5";
    let voiceId = model;
    if (model && model.includes("/")) [modelId, voiceId] = model.split("/");

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": credentials.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: options.signal,
    });
    if (!res.ok) await throwUpstreamError(res, options);
    return responseToBase64(res, "mp3", options);
  },
};
