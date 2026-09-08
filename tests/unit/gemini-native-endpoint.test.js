import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  beginAccountMutationAttempt: vi.fn(() => ({ id: 1 })),
  endAccountMutationAttempt: vi.fn(),
  recordAccountMutationSuccess: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: mocks.handleChat,
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  beginAccountMutationAttempt: mocks.beginAccountMutationAttempt,
  endAccountMutationAttempt: mocks.endAccountMutationAttempt,
  recordAccountMutationSuccess: mocks.recordAccountMutationSuccess,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

const { GET } = await import("../../src/app/api/v1beta/models/route.js");
const {
  GEMINI_NATIVE_MAX_REQUEST_BYTES,
  POST,
} = await import("../../src/app/api/v1beta/models/[...path]/route.js");

function makeGeminiRequest(path, body, headers = {}, signal) {
  return new Request(`https://router.test/v1beta/models/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer router-client-key",
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function audioBody() {
  return {
    contents: [{ parts: [{ text: "Speak naturally: hello" }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" },
        },
      },
      temperature: 0.01,
      seed: 123,
    },
  };
}

describe("Gemini native v1beta endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "real-gemini-key",
      connectionId: "gemini-conn",
      connectionName: "Gemini Test",
      providerSpecificData: {},
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    mocks.handleChat.mockResolvedValue(
      Response.json({ candidates: [{ content: { parts: [{ text: "chat" }] } }] })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists Gemini TTS models using standard Google model names", async () => {
    const response = await GET();
    const body = await response.json();
    const names = body.models.map((model) => model.name);

    expect(names).toContain("models/gemini-3.1-flash-tts-preview");
    expect(names).toContain("models/gemini-2.5-flash-preview-tts");
    expect(names).toContain("models/gemini-2.5-pro-preview-tts");
  });

  it("passes Gemini AUDIO generateContent requests through to Google's native endpoint", async () => {
    const body = audioBody();
    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", body), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent"
    );

    const options = global.fetch.mock.calls[0][1];
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual(body);
    expect(options.headers["x-goog-api-key"]).toBe("real-gemini-key");
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("accepts Google-style client keys without forwarding them upstream", async () => {
    const request = makeGeminiRequest(
      "gemini-2.5-flash-preview-tts:generateContent?key=query-router-key",
      audioBody(),
      {
        Authorization: "",
        "x-goog-api-key": "client-router-key",
      }
    );
    await POST(request, {
      params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }),
    });

    expect(mocks.isValidApiKey).toHaveBeenCalledWith("client-router-key");
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("real-gemini-key");
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).not.toBe("client-router-key");
  });

  it("does not forward stale compression headers from native upstream responses", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Content-Length": "123",
          digest: "sha-256=stale",
          "content-digest": "sha-256=:stale:",
          "repr-digest": "sha-256=:stale:",
          "content-md5": "stale",
          etag: '"stale"',
          "content-range": "bytes 0-1/123",
          trailer: "digest",
        },
      })
    );

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("digest")).toBeNull();
    expect(response.headers.get("content-digest")).toBeNull();
    expect(response.headers.get("repr-digest")).toBeNull();
    expect(response.headers.get("content-md5")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("trailer")).toBeNull();
  });

  it("falls back to the next Gemini credential when native fetch times out before headers", async () => {
    const timeoutError = new TypeError("fetch failed");
    timeoutError.cause = { code: "UND_ERR_HEADERS_TIMEOUT", name: "HeadersTimeoutError" };

    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        apiKey: "first-gemini-key",
        connectionId: "first-conn",
        connectionName: "First Gemini",
        providerSpecificData: {},
      })
      .mockResolvedValueOnce({
        apiKey: "second-gemini-key",
        connectionId: "second-conn",
        connectionName: "Second Gemini",
        providerSpecificData: {},
      });
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    global.fetch
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: "pcm" } }] } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("first-gemini-key");
    expect(global.fetch.mock.calls[1][1].headers["x-goog-api-key"]).toBe("second-gemini-key");
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "first-conn",
      504,
      expect.stringContaining("UND_ERR_HEADERS_TIMEOUT"),
      "gemini",
      "gemini-3.1-flash-tts-preview",
      null,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        mutationAttempt: { id: 1 },
      }),
    );
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "second-conn",
      expect.objectContaining({ apiKey: "second-gemini-key" }),
      "gemini-3.1-flash-tts-preview",
      { mutationAttempt: { id: 1 } },
    );
  });

  it("returns 502 for native fetch failures when credential fallback is not allowed", async () => {
    const networkError = new TypeError("fetch failed");
    networkError.cause = { code: "ECONNRESET" };
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: false });
    global.fetch.mockRejectedValueOnce(networkError);

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.message).toContain("ECONNRESET");
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      502,
      expect.stringContaining("ECONNRESET"),
      "gemini",
      "gemini-3.1-flash-tts-preview",
      null,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        mutationAttempt: { id: 1 },
      }),
    );
  });

  it("does not mark Gemini credentials unavailable when the native client aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    global.fetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

    const response = await POST(
      makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody(), {}, controller.signal),
      {
        params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
      }
    );

    expect(response.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the native header deadline when fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    global.fetch.mockImplementationOnce(() => new Promise(() => {}));

    const pending = POST(
      makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()),
      { params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }) },
    );
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(45_000);
    const response = await pending;

    expect(response.status).toBe(504);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      504,
      expect.any(String),
      "gemini",
      "gemini-3.1-flash-tts-preview",
      null,
      expect.objectContaining({ mutationAttempt: { id: 1 } }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a declared oversized request before parsing or routing it", async () => {
    const request = new Request("https://router.test/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(GEMINI_NATIVE_MAX_REQUEST_BYTES + 1),
      },
      body: "{}",
    });

    const response = await POST(request, {
      params: Promise.resolve({ path: ["gemini-2.5-pro:generateContent"] }),
    });

    expect(response.status).toBe(413);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON instead of exposing an internal error", async () => {
    const request = new Request("https://router.test/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    const response = await POST(request, {
      params: Promise.resolve({ path: ["gemini-2.5-pro:generateContent"] }),
    });

    expect(response.status).toBe(400);
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  it.each(["null", "[]"])("rejects a non-object Gemini JSON body: %s", async (body) => {
    const request = new Request("https://router.test/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const response = await POST(request, {
      params: Promise.resolve({ path: ["gemini-2.5-pro:generateContent"] }),
    });

    expect(response.status).toBe(400);
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  it("rejects unknown Gemini URL actions instead of routing them as generation", async () => {
    const response = await POST(
      makeGeminiRequest("gemini-2.5-pro:countTokens", { contents: [] }),
      { params: Promise.resolve({ path: ["gemini-2.5-pro:countTokens"] }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("drops stale framing and integrity headers when rewriting a Gemini chat body", async () => {
    const request = makeGeminiRequest(
      "gemini-2.5-pro:generateContent",
      { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
      { "content-encoding": "gzip", digest: "sha-256=stale", "content-md5": "stale" },
    );

    const response = await POST(request, {
      params: Promise.resolve({ path: ["gemini-2.5-pro:generateContent"] }),
    });

    expect(response.status).toBe(200);
    const forwarded = mocks.handleChat.mock.calls[0][0];
    expect(forwarded.headers.get("content-length")).toBeNull();
    expect(forwarded.headers.get("content-encoding")).toBeNull();
    expect(forwarded.headers.get("digest")).toBeNull();
    expect(forwarded.headers.get("content-md5")).toBeNull();
  });

  it("keeps the native timeout active while a non-streaming success body stalls", async () => {
    vi.useFakeTimers();
    global.fetch.mockImplementationOnce(async (_url, options) => {
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener("abort", () => {
            controller.error(options.signal.reason || new DOMException("aborted", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const pending = POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(45_000);
    const response = await pending;

    expect(response.status).toBe(504);
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      504,
      expect.any(String),
      "gemini",
      "gemini-3.1-flash-tts-preview",
      null,
      expect.objectContaining({ mutationAttempt: { id: 1 } }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let non-settling success bookkeeping hold a native JSON response open", async () => {
    mocks.clearAccountError.mockReturnValueOnce(new Promise(() => {}));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:generateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ candidates: expect.any(Array) });
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(mocks.clearAccountError).toHaveBeenCalledOnce();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });

  it("times out a stalled error body even when upstream cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise(() => {}));
    const upstreamBody = new ReadableStream({ start() {}, cancel });
    global.fetch.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 502,
      headers: { "Content-Type": "application/json" },
    }));

    const pending = POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:generateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(45_000);
    const response = await pending;

    expect(response.status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      504,
      expect.any(String),
      "gemini",
      "gemini-3.1-flash-tts-preview",
      null,
      expect.objectContaining({ mutationAttempt: { id: 1 } }),
    );
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps a chunked native non-stream response without penalizing the credential", async () => {
    vi.useFakeTimers();
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const upstreamBody = new ReadableStream({
      pull(controller) {
        if (emitted < 65) {
          emitted += 1;
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    });
    global.fetch.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:generateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(/exceeds 67108864 bytes/);
    expect(upstreamBody.locked).toBe(false);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps a native non-success response body before recording the upstream failure", async () => {
    const upstreamBody = new ReadableStream({ start() {} });
    global.fetch.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(64 * 1024 * 1024 + 1),
      },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:generateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(/exceeds 67108864 bytes/);
    expect(upstreamBody.locked).toBe(false);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      502,
      expect.stringMatching(/GEMINI_RESPONSE_TOO_LARGE/),
      "gemini",
      "gemini-3.1-flash-tts-preview",
      null,
      expect.objectContaining({ mutationAttempt: { id: 1 } }),
    );
  });

  it.each([
    ["malformed JSON", "{malformed", "application/json"],
    ["invalid UTF-8 JSON", new Uint8Array([
      ...new TextEncoder().encode('{"candidates":[{"content":{"parts":[{"text":"'),
      0xff,
      ...new TextEncoder().encode('"}]}}]}'),
    ]), "application/json"],
    ["wrong JSON shape", JSON.stringify({ object: "not-a-gemini-message" }), "application/json"],
    ["HTML", "<html>gateway intercept</html>", "text/html"],
  ])("rejects native HTTP 200 %s without clearing the account", async (_label, payload, contentType) => {
    global.fetch.mockResolvedValueOnce(new Response(payload, {
      status: 200,
      headers: { "Content-Type": contentType },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:generateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(/Gemini upstream/);
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      502,
      expect.stringMatching(/GEMINI_INVALID_RESPONSE/),
      "gemini",
      "gemini-3.1-flash-tts-preview",
      null,
      expect.objectContaining({ mutationAttempt: { id: 1 } }),
    );
  });

  it("rejects a native HTTP 200 JSON error envelope and falls back to a healthy account", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        apiKey: "bad-gemini-key", connectionId: "bad-gemini", connectionName: "Bad", providerSpecificData: {},
      })
      .mockResolvedValueOnce({
        apiKey: "good-gemini-key", connectionId: "good-gemini", connectionName: "Good", providerSpecificData: {},
      });
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    global.fetch
      .mockResolvedValueOnce(Response.json({ error: { message: "intercepted" } }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:generateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][1].headers["x-goog-api-key"]).toBe("good-gemini-key");
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "good-gemini",
      expect.objectContaining({ apiKey: "good-gemini-key" }),
      "gemini-3.1-flash-tts-preview",
      { mutationAttempt: { id: 1 } },
    );
  });

  it("emits a typed failure for empty native HTTP 200 SSE and does not record success", async () => {
    const upstreamBody = new ReadableStream({ start(controller) { controller.close(); } });
    global.fetch.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:streamGenerateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:streamGenerateContent"] }),
    });
    const text = await response.text();
    const event = JSON.parse(text.replace(/^data:\s*/, "").trim());

    expect(response.status).toBe(200);
    expect(event).toMatchObject({
      error: { code: 502, message: expect.stringMatching(/without a valid response event/) },
    });
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      502,
      expect.stringMatching(/GEMINI_INVALID_RESPONSE/),
      "gemini",
      "gemini-3.1-flash-tts-preview",
      null,
      expect.objectContaining({ mutationAttempt: { id: 1 } }),
    );
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
    expect(upstreamBody.locked).toBe(false);
  });

  it("emits a typed failure for invalid UTF-8 in native HTTP 200 SSE", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"'),
      0xff,
      ...new TextEncoder().encode('"}]}}]}\n\n'),
    ]);
    global.fetch.mockResolvedValueOnce(new Response(bytes, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:streamGenerateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:streamGenerateContent"] }),
    });
    const event = JSON.parse((await response.text()).replace(/^data:\s*/, "").trim());

    expect(event).toMatchObject({
      error: { code: 502, message: expect.stringMatching(/invalid|malformed/i) },
    });
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
  });

  it("rejects a non-SSE native HTTP 200 stream response before publishing it", async () => {
    global.fetch.mockResolvedValueOnce(Response.json({ object: "not-sse" }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:streamGenerateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:streamGenerateContent"] }),
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(/SSE request/);
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
  });

  it("does not publish streaming success at headers and releases its body deadline", async () => {
    vi.useFakeTimers();
    let upstreamCancelled = false;
    global.fetch.mockImplementationOnce(async () => new Response(new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        upstreamCancelled = true;
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:streamGenerateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:streamGenerateContent"] }),
    });
    expect(response.status).toBe(200);
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();

    const bodyRead = expect(response.text()).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(45_000);
    await bodyRead;
    expect(upstreamCancelled).toBe(true);
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes native streaming success only after EOF and releases its lifecycle", async () => {
    vi.useFakeTimers();
    const event = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "done" }] } }] })}\n\n`;
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event));
        controller.close();
      },
    });
    global.fetch.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:streamGenerateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:streamGenerateContent"] }),
    });
    expect(await response.text()).toBe(event);

    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(mocks.clearAccountError).toHaveBeenCalledOnce();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
    expect(upstreamBody.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not fail a completed native stream when account cleanup rejects", async () => {
    mocks.clearAccountError.mockRejectedValueOnce(new Error("fixture DB cleanup failed"));
    const event = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "complete" }] } }] })}\n\n`;
    global.fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:streamGenerateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:streamGenerateContent"] }),
    });

    await expect(response.text()).resolves.toBe(event);
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });

  it("does not let non-settling success bookkeeping hold native SSE EOF open", async () => {
    mocks.clearAccountError.mockReturnValueOnce(new Promise(() => {}));
    const event = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "complete" }] } }] })}\n\n`;
    global.fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:streamGenerateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:streamGenerateContent"] }),
    });

    await expect(response.text()).resolves.toBe(event);
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(mocks.clearAccountError).toHaveBeenCalledOnce();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });

  it("cancels the upstream native stream and ends its attempt when the consumer cancels", async () => {
    vi.useFakeTimers();
    let upstreamCancelled = false;
    const upstreamBody = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    global.fetch.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-3.1-flash-tts-preview:streamGenerateContent",
      audioBody(),
    ), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:streamGenerateContent"] }),
    });
    await response.body.cancel("consumer stopped");

    expect(upstreamCancelled).toBe(true);
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
    expect(upstreamBody.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps non-audio Gemini requests on the existing chat conversion path", async () => {
    const body = {
      contents: [{ parts: [{ text: "hello" }] }],
      generationConfig: { temperature: 0.3 },
    };

    await POST(makeGeminiRequest("gemini-2.5-flash:generateContent", body), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("preserves compatibility error status without stale representation headers", async () => {
    mocks.handleChat.mockResolvedValueOnce(new Response('{"error":{"message":"busy"}}', {
      status: 429,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "999",
        "content-digest": "sha-256=:stale:",
        etag: '"stale"',
      },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:generateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-digest")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.json()).toEqual({ error: { message: "busy" } });
  });

  it("preserves OpenAI SSE events and UTF-8 characters split across network chunks", async () => {
    const encoder = new TextEncoder();
    const firstEvent = `data: ${JSON.stringify({
      choices: [{ delta: { content: "Xin chào 🌏" }, finish_reason: null }],
    })}\r\n\r\n`;
    const finalEvent = `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = encoder.encode(firstEvent + finalEvent);
    const globe = encoder.encode("🌏");
    const globeStart = bytes.findIndex((value, index) =>
      globe.every((part, offset) => bytes[index + offset] === part)
    );
    expect(globeStart).toBeGreaterThan(0);
    const splitPoints = [12, globeStart + 1, globeStart + 3, bytes.length - 9];
    let offset = 0;
    const upstreamBody = new ReadableStream({
      start(controller) {
        for (const end of [...splitPoints, bytes.length]) {
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        }
        controller.close();
      },
    });
    mocks.handleChat.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const body = { contents: [{ parts: [{ text: "hello" }] }] };
    const response = await POST(makeGeminiRequest("gemini-2.5-flash:streamGenerateContent", body), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:streamGenerateContent"] }),
    });
    const events = (await response.text())
      .split(/\r?\n\r?\n/)
      .filter(Boolean)
      .map((event) => JSON.parse(event.replace(/^data:\s*/, "")));

    expect(events).toHaveLength(2);
    expect(events[0].candidates[0].content.parts).toEqual([{ text: "Xin chào 🌏" }]);
    expect(events[1]).toMatchObject({
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    });
  });

  it("preserves a typed OpenAI SSE failure as a Gemini error event", async () => {
    const cancel = vi.fn();
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"error":{"message":"upstream stalled","code":"invalid_upstream_response"}}\n\ndata: [DONE]\n\n'
        ));
      },
      cancel,
    });
    mocks.handleChat.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:streamGenerateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:streamGenerateContent"] }),
    });
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean)
      .map((event) => JSON.parse(event.replace(/^data:\s*/, "")));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      error: { code: 502, message: "upstream stalled", status: "BAD_GATEWAY" },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstreamBody.locked).toBe(false);
  });

  it("closes and cancels an open OpenAI stream as soon as DONE arrives", async () => {
    const cancel = vi.fn();
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
        ));
      },
      cancel,
    });
    mocks.handleChat.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:streamGenerateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:streamGenerateContent"] }),
    });
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean);

    expect(events).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstreamBody.locked).toBe(false);
  });

  it("rejects a bare DONE sentinel instead of reporting an empty HTTP 200 stream", async () => {
    const cancel = vi.fn();
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      },
      cancel,
    });
    mocks.handleChat.mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:streamGenerateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:streamGenerateContent"] }),
    });
    const event = JSON.parse((await response.text()).replace(/^data:\s*/, "").trim());

    expect(event).toMatchObject({
      error: { code: 502, message: expect.stringMatching(/without a response event/) },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("emits a Gemini error when OpenAI SSE closes before a terminal event", async () => {
    mocks.handleChat.mockResolvedValueOnce(new Response(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:streamGenerateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:streamGenerateContent"] }),
    });
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean)
      .map((event) => JSON.parse(event.replace(/^data:\s*/, "")));

    expect(events[0]).toMatchObject({ candidates: [{ content: { parts: [{ text: "partial" }] } }] });
    expect(events[1]).toMatchObject({ error: { code: 502, message: expect.stringMatching(/terminal/) } });
  });

  it("accepts the OpenAI DONE sentinel as terminal when finish_reason is omitted", async () => {
    mocks.handleChat.mockResolvedValueOnce(new Response(
      'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:streamGenerateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:streamGenerateContent"] }),
    });
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean)
      .map((event) => JSON.parse(event.replace(/^data:\s*/, "")));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ candidates: [{ content: { parts: [{ text: "complete" }] } }] });
  });

  it("returns a readable typed 502 for malformed OpenAI HTTP 200 JSON", async () => {
    const upstream = new Response("{malformed", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    mocks.handleChat.mockResolvedValueOnce(upstream);

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:generateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: 502, message: "Invalid OpenAI JSON response", status: "BAD_GATEWAY" },
    });
    expect(upstream.body.locked).toBe(false);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["invalid Gemini candidates", { candidates: "not-an-array" }],
  ])("returns a typed 502 for %s in an OpenAI HTTP 200 response", async (_label, payload) => {
    mocks.handleChat.mockResolvedValueOnce(Response.json(payload));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:generateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: 502, status: "BAD_GATEWAY" },
    });
  });

  it("does not let candidates hide an explicit HTTP 200 error envelope", async () => {
    mocks.handleChat.mockResolvedValueOnce(Response.json({
      candidates: [],
      error: { message: "gateway rejected request", code: "gateway_error" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:generateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: 502, message: "gateway rejected request" },
    });
  });

  it("returns a readable typed 502 for invalid UTF-8 OpenAI HTTP 200 JSON", async () => {
    const upstream = new Response(new Uint8Array([
      ...new TextEncoder().encode('{"choices":[{"message":{"content":"'),
      0xff,
      ...new TextEncoder().encode('"}}]}'),
    ]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    mocks.handleChat.mockResolvedValueOnce(upstream);

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:generateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: 502, message: "Invalid OpenAI JSON response", status: "BAD_GATEWAY" },
    });
    expect(upstream.body.locked).toBe(false);
  });

  it("emits a typed Gemini error event for invalid UTF-8 OpenAI SSE", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('data: {"choices":[{"delta":{"content":"'),
      0xff,
      ...new TextEncoder().encode('"},"finish_reason":null}]}\n\n'),
    ]);
    mocks.handleChat.mockResolvedValueOnce(new Response(bytes, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:streamGenerateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:streamGenerateContent"] }),
    });
    const event = JSON.parse((await response.text()).replace(/^data:\s*/, "").trim());

    expect(event).toMatchObject({
      error: { code: 502, message: "Invalid UTF-8 in OpenAI SSE stream" },
    });
  });

  it("retains a standard usage-only chunk after the OpenAI finish event", async () => {
    const raw = [
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"model":"fixture-model","usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    mocks.handleChat.mockResolvedValueOnce(new Response(raw, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await POST(makeGeminiRequest(
      "gemini-2.5-flash:streamGenerateContent",
      { contents: [{ parts: [{ text: "hello" }] }] },
    ), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:streamGenerateContent"] }),
    });
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean)
      .map((event) => JSON.parse(event.replace(/^data:\s*/, "")));

    expect(events.at(-1)).toMatchObject({
      candidates: [],
      modelVersion: "fixture-model",
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
    });
  });

  it("does not hijack provider-prefixed non-Gemini audio requests", async () => {
    await POST(makeGeminiRequest("openai/gpt-4o-mini-tts:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["openai", "gpt-4o-mini-tts:generateContent"] }),
    });

    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
