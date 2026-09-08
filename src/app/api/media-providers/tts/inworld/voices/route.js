import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import {
  VoiceListInvalidResponseError,
  VoiceListUpstreamError,
  assertVoiceListSuccessEnvelope,
  fetchVoiceListJson,
  voiceListErrorStatus,
} from "open-sse/handlers/ttsProviders/voiceList.js";

const langNames = new Intl.DisplayNames(["en"], { type: "language" });

/**
 * GET /api/media-providers/tts/inworld/voices[?lang=en]
 * Returns { languages, byLang } grouped by language code (same shape as edge-tts/elevenlabs)
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const langFilter = searchParams.get("lang");

    const connections = await getProviderConnections({ provider: "inworld", isActive: true });
    const apiKey = connections[0]?.apiKey;
    if (!apiKey) return NextResponse.json({ error: "No Inworld connection found" }, { status: 400 });

    const { response, data } = await fetchVoiceListJson(
      "https://api.inworld.ai/tts/v1/voices",
      { headers: { "Authorization": `Basic ${apiKey}` } },
      { signal: request.signal },
    );
    if (!response.ok) throw new VoiceListUpstreamError("Inworld", response.status);
    assertVoiceListSuccessEnvelope(data, "Inworld");
    if (!Array.isArray(data.voices) || data.voices.some((voice) =>
      !voice || typeof voice !== "object" || Array.isArray(voice) ||
      typeof voice.voiceId !== "string" || !voice.voiceId.trim() ||
      (voice.displayName != null && typeof voice.displayName !== "string") ||
      (voice.gender != null && typeof voice.gender !== "string") ||
      (voice.languages != null && (
        !Array.isArray(voice.languages) || voice.languages.some((lang) => typeof lang !== "string" || !lang)
      ))
    )) {
      throw new VoiceListInvalidResponseError("Inworld returned an invalid voice catalog");
    }
    const voices = data.voices;

    const byLang = {};
    for (const v of voices) {
      // Each voice has `languages: ["en", "es", ...]`
      const langs = Array.isArray(v.languages) && v.languages.length ? v.languages : ["en"];
      for (const code of langs) {
        if (!byLang[code]) {
          byLang[code] = {
            code,
            name: (() => { try { return langNames.of(code); } catch { return code; } })(),
            voices: [],
          };
        }
        if (!byLang[code].voices.find((x) => x.id === v.voiceId)) {
          byLang[code].voices.push({
            id: v.voiceId,
            name: v.displayName || v.voiceId,
            gender: v.gender || "",
            lang: code,
          });
        }
      }
    }

    const languages = Object.values(byLang).sort((a, b) => a.name.localeCompare(b.name));

    if (langFilter) {
      return NextResponse.json({ voices: byLang[langFilter]?.voices || [] });
    }
    return NextResponse.json({ languages, byLang });
  } catch (err) {
    const status = request.signal?.aborted ? 499 : voiceListErrorStatus(err);
    return NextResponse.json({ error: err.message || "Failed to fetch voices" }, { status });
  }
}
