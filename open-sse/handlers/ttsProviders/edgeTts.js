// Microsoft Edge / Bing TTS (no auth) — via Bing translator endpoint
import {
  UA,
  cancelTtsResponse,
  readTtsResponseText,
  responseToBase64,
  throwUpstreamError,
} from "./_base.js";
import {
  VoiceListInvalidResponseError,
  VoiceListUpstreamError,
  fetchVoiceListJson,
} from "./voiceList.js";

const REFRESH_MS = 5 * 60 * 1000; // token TTL ~1h, refresh early
const VOICES_TTL = 24 * 60 * 60 * 1000;

const cache = { token: null, tokenTime: 0 };
let _voicesCache = null;
let _voicesCacheTime = 0;

function escapeSsml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function getToken(options = {}) {
  const now = Date.now();
  if (cache.token && now - cache.tokenTime < REFRESH_MS) return cache.token;
  const res = await fetch("https://www.bing.com/translator", {
    headers: { "User-Agent": UA, "Accept-Language": "vi,en-US;q=0.9,en;q=0.8" },
    signal: options.signal,
  });
  if (!res.ok) await throwUpstreamError(res, options);
  const rawCookies = res.headers.getSetCookie?.() || [];
  const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");
  const html = await readTtsResponseText(res, options);
  const match = html.match(/params_AbusePreventionHelper\s*=\s*\[([^,]+),([^,]+),/);
  if (!match) throw new Error("Failed to parse Bing token");
  cache.token = { key: match[1], token: match[2].replace(/"/g, ""), cookie };
  cache.tokenTime = now;
  return cache.token;
}

async function ttsRequest(text, voiceId, token, options = {}) {
  const parts = voiceId.split("-");
  const xmlLang = parts.slice(0, 2).join("-");
  const gender = /(?:^|[-_\s])male(?:$|[-_\s])/i.test(voiceId) ? "Male" : "Female";
  const safeLanguage = escapeSsml(xmlLang);
  const safeVoiceId = escapeSsml(voiceId);
  const safeText = escapeSsml(text);
  const ssml = `<speak version='1.0' xml:lang='${safeLanguage}'><voice xml:lang='${safeLanguage}' xml:gender='${gender}' name='${safeVoiceId}'><prosody rate='0.00%'>${safeText}</prosody></voice></speak>`;
  const body = new URLSearchParams();
  body.append("ssml", ssml);
  body.append("token", token.token);
  body.append("key", token.key);
  return fetch("https://www.bing.com/tfettts?isVertical=1&&IG=1&IID=translator.5023&SFX=1", {
    method: "POST",
    body: body.toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "*/*",
      "Origin": "https://www.bing.com",
      "Referer": "https://www.bing.com/translator",
      "User-Agent": UA,
      ...(token.cookie ? { "Cookie": token.cookie } : {}),
    },
    signal: options.signal,
  });
}

export async function fetchEdgeTtsVoices(options = {}) {
  const now = Date.now();
  if (_voicesCache && now - _voicesCacheTime < VOICES_TTL) return _voicesCache;
  const { response, data } = await fetchVoiceListJson(
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4",
    { headers: { "User-Agent": UA } },
    { ...options, expectedRoot: "array" },
  );
  if (!response.ok) throw new VoiceListUpstreamError("Edge TTS", response.status);
  const voices = data;
  if (voices.some((voice) =>
    !voice || typeof voice !== "object" || Array.isArray(voice) ||
    typeof voice.ShortName !== "string" || !voice.ShortName.trim() ||
    typeof voice.Locale !== "string" || !voice.Locale.trim() ||
    (voice.FriendlyName != null && typeof voice.FriendlyName !== "string") ||
    (voice.Gender != null && typeof voice.Gender !== "string")
  )) {
    throw new VoiceListInvalidResponseError("Edge TTS returned an invalid voice catalog");
  }
  _voicesCache = voices;
  _voicesCacheTime = now;
  return voices;
}

export default {
  noAuth: true,
  async synthesize(text, model, _credentials, _responseFormat, options = {}) {
    const voiceId = model || "vi-VN-HoaiMyNeural";
    let token = await getToken(options);
    let res = await ttsRequest(text, voiceId, token, options);

    // 429/403: invalidate cache and retry once
    if (res.status === 429 || res.status === 403) {
      cancelTtsResponse(res);
      cache.token = null;
      cache.tokenTime = 0;
      token = await getToken(options);
      res = await ttsRequest(text, voiceId, token, options);
    }

    if (!res.ok) await throwUpstreamError(res, options);
    return responseToBase64(res, "mp3", options);
  },
};
