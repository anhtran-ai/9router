import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  initTranslators: vi.fn(),
  transformToOllama: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: mocks.initTranslators }));
vi.mock("open-sse/utils/ollamaTransform.js", () => ({
  transformToOllama: mocks.transformToOllama,
}));

const { POST } = await import("../../src/app/api/v1/api/chat/route.js");

function streamingRequest(body, { signal } = {}) {
  return new Request("https://router.example/v1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
    signal,
  });
}

describe("Ollama request body boundary", () => {
  beforeEach(() => {
    mocks.handleChat.mockReset().mockImplementation(async (request) => Response.json({
      forwardedBody: await request.text(),
    }));
    mocks.initTranslators.mockResolvedValue(undefined);
    mocks.transformToOllama.mockReset().mockImplementation(async (response) => response);
  });

  afterEach(() => vi.useRealTimers());

  it("reads the request once, forwards the same bytes, and selects its model", async () => {
    const raw = JSON.stringify({ model: "mix/model-max", messages: [{ role: "user", content: "xin chào" }] });
    const source = new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(raw);
        controller.enqueue(bytes.slice(0, 9));
        controller.enqueue(bytes.slice(9));
        controller.close();
      },
    });

    const response = await POST(streamingRequest(source));

    expect(await response.json()).toEqual({ forwardedBody: raw });
    expect(mocks.handleChat).toHaveBeenCalledOnce();
    expect(mocks.transformToOllama).toHaveBeenCalledWith(
      expect.any(Response),
      "mix/model-max",
      expect.any(AbortSignal),
    );
    expect(source.locked).toBe(false);
  });

  it("rejects and cancels a chunked body over 64 MiB before chat handling", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array((64 * 1024 * 1024) + 1));
      },
      cancel,
    });

    const response = await POST(streamingRequest(source));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Ollama request body exceeds the 67108864 byte limit",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  it("aborts a pending body read and releases the upstream reader", async () => {
    const client = new AbortController();
    const cancel = vi.fn();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel,
    });

    const pending = POST(streamingRequest(source, { signal: client.signal }));
    await vi.waitFor(() => expect(source.locked).toBe(true));
    client.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(source.locked).toBe(false));
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid UTF-8 before chat handling", async () => {
    for (const body of [
      "{invalid-json",
      new Uint8Array([0x7b, 0x22, 0x6d, 0x6f, 0x64, 0x65, 0x6c, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    ]) {
      const response = await POST(streamingRequest(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    }
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  it("strips stale representation headers when rebuilding the request", async () => {
    const raw = JSON.stringify({ model: "mix/model-max", messages: [] });
    const request = new Request("https://router.example/v1/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        digest: "sha-256=stale",
        "content-md5": "stale",
      },
      body: raw,
    });
    mocks.handleChat.mockImplementationOnce(async (forwarded) => Response.json({
      encoding: forwarded.headers.get("content-encoding"),
      digest: forwarded.headers.get("digest"),
      contentMd5: forwarded.headers.get("content-md5"),
    }));

    const response = await POST(request);
    expect(await response.json()).toEqual({ encoding: null, digest: null, contentMd5: null });
  });
});
