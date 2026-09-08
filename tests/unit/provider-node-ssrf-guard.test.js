import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  },
}));

const originalFetch = globalThis.fetch;
const { POST } = await import("../../src/app/api/provider-nodes/validate/route.js");

function remoteRequest(baseUrl, extra = {}) {
  return new Request("https://gateway.example/api/provider-nodes/validate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-9r-via-proxy": "1" },
    body: JSON.stringify({ baseUrl, apiKey: "stored-provider-key", ...extra }),
  });
}

describe("provider-node validation SSRF guard", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("rejects a hostname resolving to a private address before sending the API key", async () => {
    lookupMock.mockResolvedValue([{ address: "192.168.10.20", family: 4 }]);
    globalThis.fetch = vi.fn();

    const response = await POST(remoteRequest("https://provider.attacker.example/v1"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "URL not allowed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not forward the API key across a cross-origin redirect", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 307,
        headers: { location: "https://redirect-target.example/models" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const response = await POST(remoteRequest("https://provider.example/v1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true });
    const redirectedHeaders = globalThis.fetch.mock.calls[1][1].headers;
    expect(redirectedHeaders.get("authorization")).toBeNull();
  });

  it("cancels an unused successful response body so its pinned Agent can close", async () => {
    const upstream = new Response("unused model catalog", { status: 200 });
    const cancel = vi.spyOn(upstream.body, "cancel");
    globalThis.fetch = vi.fn().mockResolvedValue(upstream);

    const response = await POST(remoteRequest("https://provider.example/v1"));

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps the timeout active through a stalled response body and cancels it", async () => {
    vi.useFakeTimers();
    let upstream;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const cancel = vi.fn(async () => {});
      const json = () => new Promise(() => {});
      upstream = {
        ok: true,
        status: 200,
        bodyUsed: false,
        body: { cancel },
        json,
        cancel,
      };
      return upstream;
    });

    const responsePromise = POST(remoteRequest("https://provider.example/v1", {
      type: "custom-embedding",
      modelId: "embedding-model",
    }));
    for (let i = 0; i < 20 && globalThis.fetch.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      valid: false,
      error: expect.stringMatching(/timeout/i),
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it("bounds stalled DNS validation inside the remote request path", async () => {
    vi.useFakeTimers();
    lookupMock.mockImplementation(() => new Promise(() => {}));
    globalThis.fetch = vi.fn();

    const responsePromise = POST(remoteRequest("https://dns-stall.example/v1"));
    const responseExpectation = responsePromise.then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(responseExpectation).resolves.toEqual({
      status: 400,
      body: { error: "URL not allowed" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects and cancels a fast chunked provider body over 2 MiB", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024 + 1);
    let reads = 0;
    let bodyUsed = false;
    const upstream = {
      ok: true,
      status: 200,
      get bodyUsed() { return bodyUsed; },
      body: {
        cancel: vi.fn(),
        getReader() {
          bodyUsed = true;
          return {
            read: async () => reads++ < 2 ? { done: false, value: chunk } : { done: true },
            cancel,
          };
        },
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue(upstream);

    const response = await POST(remoteRequest("https://provider.example/v1", {
      type: "custom-embedding",
      modelId: "embedding-model",
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      valid: false,
      error: "Provider response too large (>2 MiB)",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("releases the provider response reader after parsing completes", async () => {
    const upstream = new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = vi.fn().mockResolvedValue(upstream);

    const response = await POST(remoteRequest("https://provider.example/v1", {
      type: "custom-embedding",
      modelId: "embedding-model",
    }));

    expect(response.status).toBe(200);
    expect(upstream.body.locked).toBe(false);
  });

  it.each([
    ["malformed JSON", Buffer.from("{not-json")],
    ["invalid UTF-8", Buffer.concat([
      Buffer.from('{"data":[{"embedding":[1],"note":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}]}'),
    ])],
    ["a missing embedding vector", Buffer.from('{"data":[]}')],
    ["a non-numeric embedding vector", Buffer.from('{"data":[{"embedding":[1,"bad"]}]}')],
  ])("does not accept HTTP 200 with %s as a valid embedding provider", async (_label, body) => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const response = await POST(remoteRequest("https://provider.example/v1", {
      type: "custom-embedding",
      modelId: "embedding-model",
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      valid: false,
      error: "Invalid embeddings response",
      method: "embeddings",
    });
  });

  it("validates an Anthropic-compatible node through /messages when /models is unavailable", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(Response.json({
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
      }));

    const response = await POST(remoteRequest("https://anthropic.example/v1/messages", {
      type: "anthropic-compatible",
      modelId: "claude-fixture",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true, method: "chat" });
    expect(String(globalThis.fetch.mock.calls[0][0])).toBe("https://anthropic.example/v1/models");
    expect(String(globalThis.fetch.mock.calls[1][0])).toBe("https://anthropic.example/v1/messages");
    expect(JSON.parse(globalThis.fetch.mock.calls[1][1].body)).toMatchObject({
      model: "claude-fixture",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  });
});
