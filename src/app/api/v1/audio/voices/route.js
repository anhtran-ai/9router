import { AI_PROVIDERS } from "@/shared/constants/providers";
import {
  VoiceListInvalidResponseError,
  assertVoiceListSuccessEnvelope,
  fetchVoiceListJson,
  voiceListErrorStatus,
} from "open-sse/handlers/ttsProviders/voiceList.js";
import { GET as getGenericVoices } from "@/app/api/media-providers/tts/voices/route.js";
import { GET as getElevenLabsVoices } from "@/app/api/media-providers/tts/elevenlabs/voices/route.js";
import { GET as getDeepgramVoices } from "@/app/api/media-providers/tts/deepgram/voices/route.js";
import { GET as getInworldVoices } from "@/app/api/media-providers/tts/inworld/voices/route.js";

// Provider → in-process route handler. Never relay through request.url.origin:
// the inbound Host/forwarded-host is not a trusted server-side fetch target.
const PROVIDER_API = {
  elevenlabs: { handler: getElevenLabsVoices, path: "/api/media-providers/tts/elevenlabs/voices" },
  deepgram: { handler: getDeepgramVoices, path: "/api/media-providers/tts/deepgram/voices" },
  inworld: { handler: getInworldVoices, path: "/api/media-providers/tts/inworld/voices" },
  "edge-tts": { handler: getGenericVoices, path: "/api/media-providers/tts/voices?provider=edge-tts" },
  "local-device": { handler: getGenericVoices, path: "/api/media-providers/tts/voices?provider=local-device" },
};

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/audio/voices?provider={p}[&lang=xx]
// Returns OpenAI-style list with each voice's full model id ready for /v1/audio/speech
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const lang = searchParams.get("lang");

    if (!provider || !PROVIDER_API[provider]) {
      return Response.json(
        { error: { message: `provider must be one of: ${Object.keys(PROVIDER_API).join(", ")}`, type: "invalid_request_error" } },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const route = PROVIDER_API[provider];
    const internalUrl = new URL(route.path, "http://9router.internal");
    if (lang) internalUrl.searchParams.set("lang", lang);
    const { response: res, data } = await fetchVoiceListJson(
      internalUrl,
      {},
      {
        signal: request.signal,
        fetchImpl: (_url, init) => route.handler(new Request(internalUrl, {
          method: "GET",
          signal: init.signal,
        })),
      },
    );
    if (!res.ok) {
      const upstreamMessage = typeof data.error === "string"
        ? data.error
        : data.error?.message;
      return Response.json(
        { error: { message: upstreamMessage || `Upstream ${res.status}`, type: "server_error" } },
        { status: res.status, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    assertVoiceListSuccessEnvelope(data, "Internal");

    // Internal API shape: { voices } when lang filter, else { byLang, languages }
    let rawVoices;
    if (lang) {
      if (!Array.isArray(data.voices)) {
        throw new VoiceListInvalidResponseError("Internal voice-list response has no voices array");
      }
      rawVoices = data.voices;
    } else {
      if (!data.byLang || typeof data.byLang !== "object" || Array.isArray(data.byLang)) {
        throw new VoiceListInvalidResponseError("Internal voice-list response has no language catalog");
      }
      const groups = Object.values(data.byLang);
      if (groups.some((group) => !group || !Array.isArray(group.voices))) {
        throw new VoiceListInvalidResponseError("Internal voice-list response has an invalid language catalog");
      }
      rawVoices = groups.flatMap((group) => group.voices);
    }
    if (rawVoices.some((voice) =>
      !voice || typeof voice !== "object" || Array.isArray(voice) ||
      typeof voice.id !== "string" || !voice.id.trim() ||
      typeof voice.name !== "string" || !voice.name.trim()
    )) {
      throw new VoiceListInvalidResponseError("Internal voice-list response has an invalid voice entry");
    }

    // Use provider alias for /v1/audio/speech model param (matches skill convention e.g. el/, dg/, edge-tts/)
    const alias = AI_PROVIDERS[provider]?.alias || provider;
    const data_out = rawVoices.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang || "",
      gender: v.gender || "",
      model: `${alias}/${v.id}`,
    }));

    return Response.json({ object: "list", data: data_out }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    const status = request.signal?.aborted ? 499 : voiceListErrorStatus(err);
    return Response.json(
      { error: { message: err.message || "Failed", type: "server_error" } },
      { status, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
}
