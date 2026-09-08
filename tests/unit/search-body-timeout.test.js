import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformFetch = globalThis.fetch;
const { handleSearchCore } = await import("../../open-sse/handlers/search/index.js");

function hangingResponse(_init, { ok = true, status = 200 } = {}) {
  const cancel = vi.fn(async () => {});
  const neverSettles = () => new Promise(() => {});
  return {
    ok,
    status,
    bodyUsed: false,
    body: { cancel },
    json: neverSettles,
    text: neverSettles,
    cancel,
  };
}

function oversizedChunkedResponse({ ok = true, status = 200 } = {}) {
  const cancel = vi.fn();
  const chunk = new Uint8Array(8 * 1024 * 1024 + 1);
  let reads = 0;
  let bodyUsed = false;
  return {
    ok,
    status,
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
    cancel,
  };
}

describe("dedicated search response-body deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = platformFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts and cancels a success body that stalls after response headers", async () => {
    let upstream;
    globalThis.fetch = vi.fn(async (_url, init) => {
      upstream = hangingResponse(init);
      return upstream;
    });

    const resultPromise = handleSearchCore({
      body: { query: "timeout regression" },
      provider: { id: "searxng" },
      providerConfig: {
        authType: "none",
        baseUrl: "https://8.8.8.8",
        timeoutMs: 25,
        defaultMaxResults: 1,
        maxMaxResults: 1,
        searchTypes: ["web"],
      },
      credentials: null,
      log: null,
    });

    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(result).toMatchObject({ success: false, status: 504 });
    expect(result.error).toMatch(/timeout/i);
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it("also enforces the deadline while reading an upstream error body", async () => {
    let upstream;
    globalThis.fetch = vi.fn(async (_url, init) => {
      upstream = hangingResponse(init, { ok: false, status: 502 });
      return upstream;
    });

    const resultPromise = handleSearchCore({
      body: { query: "timeout regression" },
      provider: { id: "searxng" },
      providerConfig: {
        authType: "none",
        baseUrl: "https://8.8.8.8",
        timeoutMs: 25,
        defaultMaxResults: 1,
        maxMaxResults: 1,
        searchTypes: ["web"],
      },
      credentials: null,
      log: null,
    });

    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(result).toMatchObject({ success: false, status: 504 });
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { ok: true, status: 200, label: "success JSON" },
    { ok: false, status: 502, label: "error text" },
  ])("rejects a fast chunked oversized $label body", async ({ ok, status }) => {
    const upstream = oversizedChunkedResponse({ ok, status });
    globalThis.fetch = vi.fn().mockResolvedValue(upstream);

    const result = await handleSearchCore({
      body: { query: "oversize regression" },
      provider: { id: "searxng" },
      providerConfig: {
        authType: "none",
        baseUrl: "https://8.8.8.8",
        timeoutMs: 5_000,
        defaultMaxResults: 1,
        maxMaxResults: 1,
        searchTypes: ["web"],
      },
      credentials: null,
      log: null,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toMatch(/response body is too large/i);
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it("releases the response reader lock after a complete body", async () => {
    const upstream = new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(upstream);

    await handleSearchCore({
      body: { query: "reader lifecycle" },
      provider: { id: "searxng" },
      providerConfig: {
        authType: "none",
        baseUrl: "https://8.8.8.8",
        timeoutMs: 5_000,
        defaultMaxResults: 1,
        maxMaxResults: 1,
        searchTypes: ["web"],
      },
      credentials: null,
      log: null,
    });

    expect(upstream.body.locked).toBe(false);
  });
});
