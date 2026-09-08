import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import {
  readTtsResponseBytes,
  TtsBodyStallError,
  validateTtsAudioBytes,
} from "../../open-sse/handlers/ttsProviders/_base.js";
import { readBoundedGeneratedAudio } from "../../open-sse/handlers/ttsProviders/localDevice.js";

const originalFetch = global.fetch;

function validMp3() {
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz => one 417-byte frame.
  const audio = new Uint8Array(417);
  audio.set([0xff, 0xfb, 0x90, 0x64]);
  return audio;
}

function validWav() {
  const audio = Buffer.alloc(46);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(38, 4);
  audio.write("WAVE", 8);
  audio.write("fmt ", 12);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(2, 40);
  audio.writeInt16LE(1, 44);
  return audio;
}

function validOgg() {
  const audio = Buffer.alloc(29);
  audio.write("OggS", 0);
  audio[4] = 0;
  audio[5] = 0x04;
  audio[26] = 1;
  audio[27] = 1;
  audio[28] = 1;
  return audio;
}

function validFlac() {
  const audio = Buffer.alloc(44);
  audio.write("fLaC", 0);
  audio[4] = 0x80;
  audio[7] = 34;
  audio.writeUInt16BE(16, 8);
  audio.writeUInt16BE(16, 10);
  audio.set([0x0a, 0xc4, 0x40], 18); // 44.1 kHz in STREAMINFO.
  audio.set([0xff, 0xf8], 42);
  return audio;
}

function validAac() {
  return Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00]);
}

function mp4Box(type, payload) {
  const body = Buffer.from(payload);
  const box = Buffer.alloc(8 + body.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4);
  body.copy(box, 8);
  return box;
}

function validM4a() {
  return Buffer.concat([
    mp4Box("ftyp", Buffer.from("M4A ")),
    mp4Box("moov", Buffer.from([0])),
    mp4Box("mdat", Buffer.from([1])),
  ]);
}

function openAiCall(overrides = {}) {
  return handleTtsCore({
    provider: "openai",
    model: "tts-1/alloy",
    input: "hello",
    credentials: { apiKey: "test-key" },
    requestTimeoutMs: 5_000,
    responseStallTimeoutMs: 5_000,
    ...overrides,
  });
}

describe("TTS response integrity", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each([
    ["ogg", Buffer.from("OggS"), validOgg()],
    ["flac", Buffer.from("fLaC"), validFlac()],
    ["aac", Buffer.from([0xff, 0xf1]), validAac()],
    ["m4a", mp4Box("ftyp", Buffer.from("M4A ")), validM4a()],
  ])("requires a complete %s container instead of accepting its magic bytes", (format, truncated, valid) => {
    expect(() => validateTtsAudioBytes(truncated, format)).toThrow();
    expect(validateTtsAudioBytes(valid, format)).toBe(format);
  });

  it("rejects a WAV data chunk without a valid format chunk", () => {
    const audio = Buffer.alloc(22);
    audio.write("RIFF", 0);
    audio.writeUInt32LE(14, 4);
    audio.write("WAVE", 8);
    audio.write("data", 12);
    audio.writeUInt32LE(2, 16);
    audio.writeInt16LE(1, 20);
    expect(() => validateTtsAudioBytes(audio, "wav")).toThrow();
    expect(validateTtsAudioBytes(validWav(), "wav")).toBe("wav");
  });

  it("returns a client error for a non-string input instead of throwing", async () => {
    const result = await openAiCall({ input: 123 });
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized local-device output before reading it into memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tts-cap-test-"));
    const output = join(dir, "out.mp3");
    try {
      await writeFile(output, Buffer.alloc(65));
      await expect(readBoundedGeneratedAudio(output, { maxBytes: 64 }))
        .rejects.toMatchObject({ code: "ERR_TTS_BODY_TOO_LARGE", actualBytes: 65 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty HTTP 200 audio body before publishing success", async () => {
    const onRequestSuccess = vi.fn();
    global.fetch.mockResolvedValue(new Response(null, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));

    const result = await openAiCall({ onRequestSuccess });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("rejects a JSON error page returned as HTTP 200 audio", async () => {
    const onRequestSuccess = vi.fn();
    global.fetch.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "gateway intercept" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await openAiCall({ onRequestSuccess });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("non-audio content-type");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("redacts credential material from an upstream error response", async () => {
    const secret = "tts-secret-token-123";
    global.fetch.mockResolvedValue(new Response(JSON.stringify({
      error: { message: `Authorization Bearer ${secret}` },
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));

    const result = await openAiCall({ credentials: { apiKey: secret } });
    const publicBody = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 401 });
    expect(result.error).toContain("[redacted]");
    expect(result.error).not.toContain(secret);
    expect(publicBody).not.toContain(secret);
  });

  it("rejects malformed success JSON", async () => {
    global.fetch.mockResolvedValue(new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await handleTtsCore({
      provider: "xiaomi-mimo",
      model: "mimo-v2.5-tts/Chloe",
      input: "hello",
      credentials: { apiKey: "test-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("malformed JSON");
  });

  it("rejects an explicit HTTP 200 failure even when it carries valid audio", async () => {
    global.fetch.mockResolvedValue(new Response(JSON.stringify({
      success: false,
      message: "synthesis rejected",
      choices: [{ message: { audio: { data: validWav().toString("base64"), format: "wav" } } }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await handleTtsCore({
      provider: "xiaomi-mimo",
      model: "mimo-v2.5-tts/Chloe",
      input: "hello",
      credentials: { apiKey: "test-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("synthesis rejected");
  });

  it("rejects non-decodable base64 from a JSON provider", async () => {
    global.fetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { audio: { data: "%%%not-base64%%%", format: "wav" } } }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await handleTtsCore({
      provider: "xiaomi-mimo",
      model: "mimo-v2.5-tts/Chloe",
      input: "hello",
      credentials: { apiKey: "test-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("invalid base64 audio");
  });

  it("rejects a body shorter than its declared Content-Length", async () => {
    const audio = validMp3();
    global.fetch.mockResolvedValue(new Response(audio, {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(audio.byteLength + 20),
      },
    }));

    const result = await openAiCall();

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("truncated");
  });

  it("caps chunked responses and cancels/releases the reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(80));
      },
      cancel,
    });
    global.fetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));

    const result = await openAiCall({ maxResponseBytes: 100 });
    await Promise.resolve();

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("100-byte limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("keeps the absolute deadline active through full body consumption", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    global.fetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));

    const result = await openAiCall({
      requestTimeoutMs: 15,
      responseStallTimeoutMs: 5_000,
    });
    await Promise.resolve();

    expect(result).toMatchObject({ success: false, status: 504 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("fails a stalled body even before the absolute deadline", async () => {
    const body = new ReadableStream({ cancel: vi.fn() });
    global.fetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));

    const result = await openAiCall({
      requestTimeoutMs: 5_000,
      responseStallTimeoutMs: 15,
    });

    expect(result).toMatchObject({ success: false, status: 504 });
  });

  it("returns 499 and cleans up when the client aborts a body read", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    global.fetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));
    const client = new AbortController();
    const onRequestSuccess = vi.fn();

    const pending = openAiCall({ signal: client.signal, onRequestSuccess });
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    client.abort(new DOMException("client left", "AbortError"));
    const result = await pending;
    await Promise.resolve();

    expect(result).toMatchObject({ success: false, status: 499 });
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("does not await a stream cancel hook that never settles", async () => {
    const never = new Promise(() => {});
    const reader = {
      read: vi.fn(() => never),
      cancel: vi.fn(() => never),
      releaseLock: vi.fn(),
    };
    const response = {
      headers: new Headers(),
      body: { getReader: () => reader },
    };

    await expect(readTtsResponseBytes(response, { stallTimeoutMs: 10 }))
      .rejects.toBeInstanceOf(TtsBodyStallError);

    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it("publishes success only after the final validated audio byte", async () => {
    let upstream;
    const body = new ReadableStream({ start(controller) { upstream = controller; } });
    global.fetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));
    const onRequestSuccess = vi.fn();

    const pending = openAiCall({ onRequestSuccess });
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    expect(onRequestSuccess).not.toHaveBeenCalled();

    upstream.enqueue(validMp3());
    await Promise.resolve();
    expect(onRequestSuccess).not.toHaveBeenCalled();
    upstream.close();

    const result = await pending;
    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledOnce();
    expect((await result.response.arrayBuffer()).byteLength).toBe(validMp3().byteLength);
  });

  it("preserves verified audio when the success-accounting hook rejects", async () => {
    global.fetch.mockResolvedValue(new Response(validMp3(), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));
    const hookError = new Error("fixture persistence failed");
    const onRequestSuccess = vi.fn(() => Promise.reject(hookError));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await openAiCall({ onRequestSuccess });
    await Promise.resolve();

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledOnce();
    expect(await result.response.arrayBuffer()).toEqual(validMp3().buffer);
    expect(consoleError).toHaveBeenCalledWith(
      "[TtsCore] onRequestSuccess failed:",
      hookError.message,
    );
  });

  it("escapes Edge TTS text and voice fields before building SSML", async () => {
    global.fetch
      .mockResolvedValueOnce(new Response(
        '<script>params_AbusePreventionHelper = [123,"token-value","ignored"];</script>',
        { status: 200, headers: { "content-type": "text/html" } },
      ))
      .mockResolvedValueOnce(new Response(validMp3(), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }));

    const result = await handleTtsCore({
      provider: "edge-tts",
      model: "en-US-Alice'Neural",
      input: '5 < 7 & "quoted"',
    });

    expect(result.success).toBe(true);
    const form = new URLSearchParams(global.fetch.mock.calls[1][1].body);
    const ssml = form.get("ssml");
    expect(ssml).toContain("5 &lt; 7 &amp; &quot;quoted&quot;");
    expect(ssml).toContain("name='en-US-Alice&apos;Neural'");
    expect(ssml).not.toContain('>5 < 7 & "quoted"<');
  });

  it("rejects an OpenRouter SSE response that ends without [DONE]", async () => {
    const wav = validWav().toString("base64");
    global.fetch.mockResolvedValue(new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: wav } } }] })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));

    const result = await handleTtsCore({
      provider: "openrouter",
      model: "openai/gpt-4o-mini-tts/alloy",
      input: "hello",
      credentials: { apiKey: "test-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("before [DONE]");
  });

  it("rejects OpenRouter audio emitted after the terminal marker", async () => {
    const wav = validWav().toString("base64");
    global.fetch.mockResolvedValue(new Response(
      `data: [DONE]\n\ndata: ${JSON.stringify({ choices: [{ delta: { audio: { data: wav } } }] })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));

    const result = await handleTtsCore({
      provider: "openrouter",
      model: "openai/gpt-4o-mini-tts/alloy",
      input: "hello",
      credentials: { apiKey: "test-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("after [DONE]");
  });

  it("rejects an OpenRouter HTTP 200 response declared as HTML", async () => {
    global.fetch.mockResolvedValue(new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));

    const result = await handleTtsCore({
      provider: "openrouter",
      model: "openai/gpt-4o-mini-tts/alloy",
      input: "hello",
      credentials: { apiKey: "test-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("unexpected content-type");
  });
});
