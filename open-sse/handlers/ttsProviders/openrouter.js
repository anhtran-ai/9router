// OpenRouter TTS — via chat completions + audio modality (SSE stream)
import { PROVIDER_MEDIA } from "../../providers/index.js";
import {
  cancelTtsResponse,
  readTtsResponseText,
  throwUpstreamError,
  TtsInvalidResponseError,
} from "./_base.js";

const TTS_CFG = PROVIDER_MEDIA["openrouter"]?.ttsConfig || {};

export default {
  async synthesize(text, model, credentials, _responseFormat, options = {}) {
    if (!credentials?.apiKey) throw new Error("No OpenRouter API key configured");

    // model format: "tts-model/voice" e.g. "openai/gpt-4o-mini-tts/alloy"
    let ttsModel = TTS_CFG.defaultModel;
    let voice = "alloy";
    if (model && model.includes("/")) {
      const lastSlash = model.lastIndexOf("/");
      const maybVoice = model.slice(lastSlash + 1);
      const maybeModel = model.slice(0, lastSlash);
      if (maybeModel.includes("/")) {
        ttsModel = maybeModel;
        voice = maybVoice;
      } else {
        voice = model;
      }
    } else if (model) {
      voice = model;
    }

    const res = await fetch(TTS_CFG.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${credentials.apiKey}`,
        ...(TTS_CFG.headers || {}),
      },
      body: JSON.stringify({
        model: ttsModel,
        modalities: ["text", "audio"],
        audio: { voice, format: "wav" },
        stream: true,
        messages: [{ role: "user", content: text }],
      }),
      signal: options.signal,
    });

    if (!res.ok) await throwUpstreamError(res, options);

    const mediaType = String(res.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType && mediaType !== "text/event-stream") {
      cancelTtsResponse(res, new TtsInvalidResponseError("OpenRouter TTS returned a non-SSE response"));
      throw new TtsInvalidResponseError(`OpenRouter TTS returned unexpected content-type '${mediaType}'`);
    }

    // The endpoint is SSE, but TTS already buffers all audio before returning.
    // Read it through the shared cap/deadline and require the terminal marker so
    // an upstream disconnect cannot turn a partial clip into HTTP 200 success.
    const textBody = await readTtsResponseText(res, options);
    const chunks = [];
    let sawDone = false;
    for (const rawLine of textBody.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trimStart();
      if (payload === "[DONE]") {
        if (sawDone) throw new TtsInvalidResponseError("OpenRouter TTS returned duplicate terminal markers");
        sawDone = true;
        continue;
      }
      if (!payload) continue;
      if (sawDone) throw new TtsInvalidResponseError("OpenRouter TTS returned data after [DONE]");
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        throw new TtsInvalidResponseError("OpenRouter TTS returned malformed SSE JSON");
      }
      const status = typeof json?.status === "string" ? json.status.trim().toLowerCase() : "";
      if (json?.error != null || json?.errors != null || json?.success === false ||
          ["error", "failed", "failure", "cancelled", "canceled", "expired"].includes(status)) {
        throw new TtsInvalidResponseError(
          json.error?.message || json.errors?.[0]?.message || json.message ||
          "OpenRouter TTS returned an error envelope with HTTP 200",
        );
      }
      const audioData = json?.choices?.[0]?.delta?.audio?.data;
      if (audioData !== undefined && (typeof audioData !== "string" || !audioData)) {
        throw new TtsInvalidResponseError("OpenRouter TTS returned invalid audio data");
      }
      if (audioData) chunks.push(audioData);
    }

    if (!sawDone) throw new TtsInvalidResponseError("OpenRouter TTS stream ended before [DONE]");
    if (chunks.length === 0) throw new Error("OpenRouter TTS returned no audio data");
    return { base64: chunks.join(""), format: "wav" };
  },
};
