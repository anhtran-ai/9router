import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleSttCore,
  MAX_STT_AUDIO_BYTES,
} from "../../open-sse/handlers/sttCore.js";

const encoder = new TextEncoder();

function makeForm({ bytes = "audio", type = "audio/wav", name = "sample.wav" } = {}) {
  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type }), name);
  return formData;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function options(format, overrides = {}) {
  return {
    provider: "test-provider",
    model: "test-model",
    formData: makeForm(),
    credentials: { apiKey: "test-token" },
    sttConfig: {
      format,
      baseUrl: "https://stt.example.test/v1/transcriptions",
      authType: "apikey",
      authHeader: "bearer",
    },
    requestTimeoutMs: 1_000,
    responseStallTimeoutMs: 100,
    pollIntervalMs: 1,
    ...overrides,
  };
}

async function responseJson(result) {
  return result.response.json();
}

describe("STT provider response integrity", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["deepgram", { results: { channels: [{ alternatives: [{ transcript: "deep text" }] }] } }, "deep text"],
    ["nvidia-asr", { transcript: "nvidia text" }, "nvidia text"],
    ["huggingface-asr", { text: "hf text" }, "hf text"],
    ["gemini-stt", { candidates: [{ content: { parts: [{ text: "gemini " }, { text: "text" }] } }] }, "gemini text"],
  ])("accepts a valid %s transcript", async (format, payload, expected) => {
    vi.mocked(fetch).mockResolvedValueOnce(json(payload));

    const result = await handleSttCore(options(format));

    expect(result.success).toBe(true);
    await expect(responseJson(result)).resolves.toEqual({ text: expected });
    expect(vi.mocked(fetch).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["deepgram", { results: { channels: [{ alternatives: [{}] }] } }],
    ["nvidia-asr", {}],
    ["huggingface-asr", { text: "   " }],
    ["gemini-stt", { candidates: [{ content: { parts: [] } }] }],
  ])("rejects a successful %s response with no transcript", async (format, payload) => {
    vi.mocked(fetch).mockResolvedValueOnce(json(payload));

    const result = await handleSttCore(options(format));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    await expect(responseJson(result)).resolves.toMatchObject({
      error: { code: "invalid_upstream_response" },
    });
  });

  it.each(["deepgram", "nvidia-asr", "huggingface-asr", "gemini-stt"])(
    "rejects a malformed JSON body from %s",
    async (format) => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response("{broken", {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

      const result = await handleSttCore(options(format));

      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
    },
  );

  it("rejects invalid UTF-8 instead of publishing a replacement-character transcript", async () => {
    const prefix = encoder.encode('{"text":"spoken ');
    const suffix = encoder.encode('"}');
    const body = new Uint8Array(prefix.length + 1 + suffix.length);
    body.set(prefix, 0);
    body[prefix.length] = 0xff;
    body.set(suffix, prefix.length + 1);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await handleSttCore(options("huggingface-asr"));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).not.toContain("spoken �");
  });

  it("rejects an explicit provider error hidden behind HTTP 200", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({
      error: { message: "gateway interception" },
      text: "should not be accepted",
    }));

    const result = await handleSttCore(options("huggingface-asr"));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("error payload");
  });

  it("redacts credential material from a non-2xx provider error", async () => {
    const secret = "stt-secret-token-123";
    vi.mocked(fetch).mockResolvedValueOnce(json({
      error: { message: `Authorization Bearer ${secret}` },
    }, 401));

    const result = await handleSttCore(options("openai", {
      credentials: { apiKey: secret },
    }));
    const publicBody = await result.response.text();

    expect(result).toMatchObject({ success: false, status: 401 });
    expect(result.error).toContain("[redacted]");
    expect(result.error).not.toContain(secret);
    expect(publicBody).not.toContain(secret);
  });

  it("rejects an HTTP 200 failure flag even when a transcript is present", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ success: false, text: "must not publish" }));

    const result = await handleSttCore(options("openai"));

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("error payload");
  });

  it.each([
    ["empty", "", "text/plain"],
    ["HTML", "<body>cloud proxy error</body>", "text/plain"],
    ["malformed JSON", "{broken", "application/json"],
    ["empty JSON object", "{}", "application/json"],
    ["error JSON", JSON.stringify({ error: "bad gateway" }), "application/json"],
  ])("rejects a compatible provider's %s body", async (_label, body, contentType) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    }));

    const result = await handleSttCore(options("openai"));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });

  it.each(["error", "forbidden", "Service unavailable: try later"])(
    "preserves a possible literal spoken transcript: %s",
    async (transcript) => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(transcript, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }));
      const result = await handleSttCore(options("openai"));
      expect(result.success).toBe(true);
      await expect(result.response.text()).resolves.toBe(transcript);
    },
  );

  it.each([
    [JSON.stringify({ text: "json transcript" }), "application/json", JSON.stringify({ text: "json transcript" })],
    ["plain transcript", "text/plain; charset=utf-8", "plain transcript"],
    ["WEBVTT\n\n00:00.000 --> 00:01.000\nhello", "text/vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nhello"],
  ])("preserves a valid compatible response", async (body, contentType, expectedBody) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    }));

    const result = await handleSttCore(options("openai"));

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe(contentType);
    await expect(result.response.text()).resolves.toBe(expectedBody);
  });
});

describe("STT body caps and deadlines", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an oversized audio file before any provider request", async () => {
    const result = await handleSttCore(options("openai", {
      formData: makeForm({ bytes: "1234" }),
      maxAudioBytes: 3,
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the production audio cap at 25 MiB", () => {
    expect(MAX_STT_AUDIO_BYTES).toBe(25 * 1024 * 1024);
  });

  it("caps a chunked provider response and releases its reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("123456"));
      },
      cancel,
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    vi.mocked(fetch).mockResolvedValueOnce(response);

    const result = await handleSttCore(options("openai", { maxResponseBytes: 5 }));

    expect(result.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it("fails and cancels a provider body that stalls between chunks", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("partial"));
      },
      cancel,
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    vi.mocked(fetch).mockResolvedValueOnce(response);

    const result = await handleSttCore(options("openai", {
      responseStallTimeoutMs: 10,
    }));

    expect(result.status).toBe(502);
    expect(result.error).toContain("stalled");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it("applies one absolute deadline through response-body consumption", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    vi.mocked(fetch).mockResolvedValueOnce(response);

    const result = await handleSttCore(options("openai", {
      requestTimeoutMs: 10,
      responseStallTimeoutMs: 1_000,
    }));

    expect(result.status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it("aborts a response reader as 499 and releases it", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    vi.mocked(fetch).mockResolvedValueOnce(response);

    const pending = handleSttCore(options("openai", {
      signal: controller.signal,
      responseStallTimeoutMs: 1_000,
    }));
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;

    expect(result.status).toBe(499);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it("aborts a request waiting for provider headers at the absolute deadline", async () => {
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((resolve, reject) => {
      const rejectForAbort = () => reject(init.signal.reason);
      if (init.signal.aborted) rejectForAbort();
      else init.signal.addEventListener("abort", rejectForAbort, { once: true });
    }));

    const result = await handleSttCore(options("openai", { requestTimeoutMs: 10 }));

    expect(result.status).toBe(504);
  });

  it("does not call fetch when the client signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await handleSttCore(options("openai", { signal: controller.signal }));

    expect(result.status).toBe(499);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("AssemblyAI lifecycle", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  function assemblyOptions(overrides = {}) {
    return options("assemblyai", {
      model: "universal-2",
      sttConfig: {
        format: "assemblyai",
        baseUrl: "https://api.assemblyai.com/v2/transcript",
        authType: "apikey",
        authHeader: "authorization",
      },
      ...overrides,
    });
  }

  it("uses AssemblyAI raw Authorization and returns a completed transcript", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ upload_url: "https://upload.example/audio" }))
      .mockResolvedValueOnce(json({ id: "transcript/id" }))
      .mockResolvedValueOnce(json({ status: "completed", text: "assembled text" }));

    const result = await handleSttCore(assemblyOptions());

    expect(result.success).toBe(true);
    await expect(responseJson(result)).resolves.toEqual({ text: "assembled text" });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(3);
    expect(vi.mocked(fetch).mock.calls[0][1].headers.Authorization).toBe("test-token");
    expect(vi.mocked(fetch).mock.calls[1][1].headers.Authorization).toBe("test-token");
    expect(vi.mocked(fetch).mock.calls[2][1].headers.Authorization).toBe("test-token");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
  });

  it("retries transient poll failures within the shared deadline", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ upload_url: "https://upload.example/audio" }))
      .mockResolvedValueOnce(json({ id: "transcript-id" }))
      .mockResolvedValueOnce(json({ error: { message: "temporary" } }, 503))
      .mockResolvedValueOnce(json({ status: "completed", text: "recovered" }));

    const result = await handleSttCore(assemblyOptions());

    expect(result.success).toBe(true);
    await expect(responseJson(result)).resolves.toEqual({ text: "recovered" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["upload URL", [{}, { id: "unused" }]],
    ["transcript ID", [{ upload_url: "https://upload.example/audio" }, {}]],
  ])("rejects a missing AssemblyAI %s", async (_label, responses) => {
    for (const payload of responses) vi.mocked(fetch).mockResolvedValueOnce(json(payload));

    const result = await handleSttCore(assemblyOptions());

    expect(result.status).toBe(502);
  });

  it("rejects a completed AssemblyAI job with a blank transcript", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ upload_url: "https://upload.example/audio" }))
      .mockResolvedValueOnce(json({ id: "transcript-id" }))
      .mockResolvedValueOnce(json({ status: "completed", text: " " }));

    const result = await handleSttCore(assemblyOptions());

    expect(result.status).toBe(502);
  });

  it("returns a job-level AssemblyAI error as an unprocessable request", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ upload_url: "https://upload.example/audio" }))
      .mockResolvedValueOnce(json({ id: "transcript-id" }))
      .mockResolvedValueOnce(json({ status: "error", error: "audio format unsupported" }));

    const result = await handleSttCore(assemblyOptions());

    expect(result).toMatchObject({ success: false, status: 422 });
    expect(result.error).toContain("audio format unsupported");
  });

  it("stops the polling wait immediately when the client disconnects", async () => {
    const controller = new AbortController();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ upload_url: "https://upload.example/audio" }))
      .mockResolvedValueOnce(json({ id: "transcript-id" }));

    const pending = handleSttCore(assemblyOptions({
      signal: controller.signal,
      pollIntervalMs: 5_000,
      requestTimeoutMs: 10_000,
    }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    const result = await pending;

    expect(result.status).toBe(499);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight polling fetch on disconnect", async () => {
    const controller = new AbortController();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ upload_url: "https://upload.example/audio" }))
      .mockResolvedValueOnce(json({ id: "transcript-id" }))
      .mockImplementationOnce((_url, init) => new Promise((resolve, reject) => {
        const rejectForAbort = () => reject(init.signal.reason);
        if (init.signal.aborted) rejectForAbort();
        else init.signal.addEventListener("abort", rejectForAbort, { once: true });
      }));

    const pending = handleSttCore(assemblyOptions({ signal: controller.signal }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    controller.abort();
    const result = await pending;

    expect(result.status).toBe(499);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
