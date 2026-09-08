import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  edgeFetcher: vi.fn(async () => []),
  localFetcher: vi.fn(async () => []),
  geminiFetcher: vi.fn(async () => []),
  elevenFetcher: vi.fn(async () => []),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({
  fetchElevenLabsVoices: mocks.elevenFetcher,
  VOICE_FETCHERS: {
    "edge-tts": mocks.edgeFetcher,
    "local-device": mocks.localFetcher,
    gemini: mocks.geminiFetcher,
  },
}));

import {
  VoiceListInvalidResponseError,
  VoiceListTimeoutError,
  fetchVoiceListJson,
} from "../../open-sse/handlers/ttsProviders/voiceList.js";
import { fetchEdgeTtsVoices } from "../../open-sse/handlers/ttsProviders/edgeTts.js";
import { fetchElevenLabsVoices } from "../../open-sse/handlers/ttsProviders/elevenlabs.js";
import { GET as getGenericVoices } from "../../src/app/api/media-providers/tts/voices/route.js";
import { GET as getDeepgramVoices } from "../../src/app/api/media-providers/tts/deepgram/voices/route.js";
import { GET as getInworldVoices } from "../../src/app/api/media-providers/tts/inworld/voices/route.js";
import { GET as getMiniMaxVoices } from "../../src/app/api/media-providers/tts/minimax/voices/route.js";
import { GET as getOpenAiVoices } from "../../src/app/api/v1/audio/voices/route.js";

const originalFetch = global.fetch;
const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

describe("TTS voice-list transport integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
    mocks.getProviderConnections.mockResolvedValue([{ apiKey: "stored-provider-key" }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it("enforces one deadline even when fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const pending = fetchVoiceListJson("https://voices.example/catalog", {}, {
      timeoutMs: 25,
      fetchImpl: vi.fn(() => new Promise(() => {})),
    });
    const rejection = expect(pending).rejects.toBeInstanceOf(VoiceListTimeoutError);

    await vi.advanceTimersByTimeAsync(26);

    await rejection;
  });

  it("rejects a declared oversized catalog without awaiting a hanging cancel", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const response = new Response(new ReadableStream({ cancel }), {
      headers: {
        "content-type": "application/json",
        "content-length": "65",
      },
    });

    await expect(fetchVoiceListJson("https://voices.example/catalog", {}, {
      maxBytes: 64,
      fetchImpl: vi.fn(async () => response),
    })).rejects.toMatchObject({ code: "ERR_UPSTREAM_BODY_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects invalid UTF-8 and malformed JSON success bodies", async () => {
    const invalidUtf8 = new Response(
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      { headers: { "content-type": "application/json" } },
    );
    await expect(fetchVoiceListJson("https://voices.example/utf8", {}, {
      fetchImpl: vi.fn(async () => invalidUtf8),
    })).rejects.toThrow();

    await expect(fetchVoiceListJson("https://voices.example/json", {}, {
      fetchImpl: vi.fn(async () => new Response("{not-json", {
        headers: { "content-type": "application/json" },
      })),
    })).rejects.toBeInstanceOf(VoiceListInvalidResponseError);
  });

  it("requires a JSON content type", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "text/html" },
    });
    await expect(fetchVoiceListJson("https://voices.example/catalog", {}, {
      fetchImpl: vi.fn(async () => response),
    })).rejects.toThrow("non-JSON content type");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("applies strict semantic validation to Edge and ElevenLabs catalogs", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse([{ ShortName: "voice-without-locale" }]))
      .mockResolvedValueOnce(jsonResponse({
        success: false,
        voices: [{ voice_id: "voice-1", name: "Voice One" }],
      }));

    await expect(fetchEdgeTtsVoices()).rejects.toThrow("invalid voice catalog");
    await expect(fetchElevenLabsVoices("unique-test-key")).rejects.toThrow("error envelope");
  });

  it("never accepts or forwards an API key from the generic query route", async () => {
    const secret = "elevenlabs-secret-that-must-not-leak";
    const response = await getGenericVoices(new Request(
      `http://localhost/api/media-providers/tts/voices?provider=edge-tts&apiKey=${secret}`,
    ));
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).not.toContain(secret);
    expect(mocks.edgeFetcher).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("directs generic ElevenLabs callers to the DB-backed endpoint", async () => {
    const response = await getGenericVoices(new Request(
      "http://localhost/api/media-providers/tts/voices?provider=elevenlabs",
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Use /api/media-providers/tts/elevenlabs/voices with a configured ElevenLabs connection",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects semantically malformed Deepgram and Inworld catalogs", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ tts: "not-an-array" }))
      .mockResolvedValueOnce(jsonResponse({ voices: [{ voiceId: 42 }] }));

    const deepgram = await getDeepgramVoices(new Request(
      "http://localhost/api/media-providers/tts/deepgram/voices",
    ));
    const inworld = await getInworldVoices(new Request(
      "http://localhost/api/media-providers/tts/inworld/voices",
    ));

    expect(deepgram.status).toBe(502);
    expect(inworld.status).toBe(502);
  });

  it("rejects a MiniMax success envelope without a valid provider status", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ system_voice: [] }));

    const response = await getMiniMaxVoices(new Request(
      "http://localhost/api/media-providers/tts/minimax/voices",
    ));

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toContain("invalid voice-list status");
  });

  it("dispatches the OpenAI voice list in-process without trusting a spoofed origin", async () => {
    mocks.edgeFetcher.mockResolvedValueOnce([
      {
        ShortName: "en-US-TestNeural",
        FriendlyName: "Microsoft Test Online (Natural) - English",
        Locale: "en-US",
        Gender: "Female",
      },
      {
        ShortName: "vi-VN-TestNeural",
        FriendlyName: "Microsoft Test Online (Natural) - Vietnamese",
        Locale: "vi-VN",
        Gender: "Female",
      },
    ]);

    const response = await getOpenAiVoices(new Request(
      "https://attacker.example/v1/audio/voices?provider=edge-tts&lang=en",
      { headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" } },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "en-US-TestNeural",
      lang: "en",
    });
    expect(mocks.edgeFetcher).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("uses stored ElevenLabs credentials and preserves the language filter in-process", async () => {
    mocks.elevenFetcher.mockResolvedValueOnce([
      {
        voice_id: "voice-en",
        name: "English Voice",
        labels: { language: "en", gender: "female" },
      },
      {
        voice_id: "voice-vi",
        name: "Vietnamese Voice",
        labels: { language: "vi", gender: "female" },
      },
    ]);

    const response = await getOpenAiVoices(new Request(
      "https://attacker.example/v1/audio/voices?provider=elevenlabs&lang=vi&apiKey=attacker-key",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({ id: "voice-vi", lang: "vi" }),
    ]);
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({
      provider: "elevenlabs",
      isActive: true,
    });
    expect(mocks.elevenFetcher).toHaveBeenCalledWith(
      "stored-provider-key",
      { signal: expect.any(AbortSignal) },
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
