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
 * GET /api/media-providers/tts/deepgram/voices[?lang=en]
 * Returns { languages, byLang } grouped by language code (same shape as edge-tts/elevenlabs/inworld)
 * Each Deepgram voice = one model (canonical_name like "aura-2-thalia-en")
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const langFilter = searchParams.get("lang");

    const connections = await getProviderConnections({ provider: "deepgram", isActive: true });
    const apiKey = connections[0]?.apiKey;
    if (!apiKey) return NextResponse.json({ error: "No Deepgram connection found" }, { status: 400 });

    const { response, data } = await fetchVoiceListJson(
      "https://api.deepgram.com/v1/models",
      { headers: { "Authorization": `Token ${apiKey}` } },
      { signal: request.signal },
    );
    if (!response.ok) throw new VoiceListUpstreamError("Deepgram", response.status);
    assertVoiceListSuccessEnvelope(data, "Deepgram");
    if (!Array.isArray(data.tts) || data.tts.some((model) =>
      !model || typeof model !== "object" || Array.isArray(model) ||
      (typeof model.canonical_name !== "string" && typeof model.name !== "string") ||
      (model.languages != null && (
        !Array.isArray(model.languages) || model.languages.some((lang) => typeof lang !== "string" || !lang)
      ))
    )) {
      throw new VoiceListInvalidResponseError("Deepgram returned an invalid voice catalog");
    }
    const ttsModels = data.tts;

    const byLang = {};
    for (const m of ttsModels) {
      // Deepgram returns `languages: ["en"]` or sometimes language inferred from canonical_name suffix
      const langs = Array.isArray(m.languages) && m.languages.length
        ? m.languages
        : [m.canonical_name?.split("-").pop() || "en"];
      for (const code of langs) {
        if (!byLang[code]) {
          byLang[code] = {
            code,
            name: (() => { try { return langNames.of(code); } catch { return code; } })(),
            voices: [],
          };
        }
        const voiceId = m.canonical_name || m.name;
        if (!byLang[code].voices.find((x) => x.id === voiceId)) {
          byLang[code].voices.push({
            id: voiceId,
            name: m.name || voiceId,
            gender: m.metadata?.tags?.find((t) => t === "masculine" || t === "feminine") || "",
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
