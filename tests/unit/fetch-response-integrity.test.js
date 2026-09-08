import { afterEach, describe, expect, it, vi } from "vitest";

import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";

const originalFetch = global.fetch;

afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
});

function run(provider, response, extra = {}) {
  global.fetch = vi.fn().mockResolvedValue(response);
  return handleFetchCore({
    url: "https://example.com/article",
    provider,
    providerConfig: {
      timeoutMs: 5_000,
      ...(provider === "ollama" ? { baseUrl: "https://ollama.com/api/web_fetch" } : {}),
    },
    credentials: { apiKey: "fixture-key" },
    ...extra,
  });
}

describe("web fetch response semantic integrity", () => {
  it("rejects an empty Jina HTTP 200 body", async () => {
    await expect(run("jina-reader", new Response("", {
      headers: { "content-type": "text/plain" },
    }))).resolves.toMatchObject({ success: false, status: 502, error: expect.stringMatching(/empty content/i) });
  });

  it.each([
    ["firecrawl", "{not-json", /invalid JSON/i],
    ["firecrawl", JSON.stringify({ success: false, error: "scrape failed" }), /scrape failed/i],
    ["tavily", JSON.stringify({ results: [] }), /invalid response envelope/i],
    ["exa", JSON.stringify({ object: "wrong-envelope" }), /invalid response envelope/i],
  ])("rejects a %s HTTP 200 malformed, error, or empty payload", async (provider, body, message) => {
    const result = await run(provider, new Response(body, {
      headers: { "content-type": "application/json" },
    }));

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toMatch(message);
  });

  it("rejects empty Ollama content", async () => {
    await expect(run("ollama", Response.json({ content: "" }))).resolves.toMatchObject({
      success: false,
      status: 502,
      error: expect.stringMatching(/empty or invalid/i),
    });
  });

  it("rejects invalid UTF-8 in an otherwise valid HTTP 200 JSON payload", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('{"success":true,"data":{"markdown":"'),
      0xff,
      ...new TextEncoder().encode('"}}'),
    ]);

    const result = await run("firecrawl", new Response(bytes, {
      headers: { "content-type": "application/json" },
    }));

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(JSON.stringify(result)).not.toContain("�");
  });

  it("enforces the fetch deadline when an injected fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(() => new Promise(() => {}));

    const pending = handleFetchCore({
      url: "https://example.com/article",
      provider: "jina-reader",
      providerConfig: { timeoutMs: 100 },
      credentials: { apiKey: "fixture-key" },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ success: false, status: 504 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns 499 promptly and cancels a stalled response body on client abort", async () => {
    const client = new AbortController();
    let cancelCalled = false;
    const body = new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() {
        cancelCalled = true;
        return new Promise(() => {});
      },
    });
    const pending = run("jina-reader", new Response(body, {
      headers: { "content-type": "text/plain" },
    }), { signal: client.signal });

    await Promise.resolve();
    client.abort(new DOMException("client closed", "AbortError"));

    await expect(pending).resolves.toMatchObject({ success: false, status: 499 });
    expect(cancelCalled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("keeps accepting valid provider content", async () => {
    const result = await run("firecrawl", Response.json({
      success: true,
      data: { markdown: "# Verified content", metadata: { title: "Fixture" } },
    }));

    expect(result).toMatchObject({
      success: true,
      data: { title: "Fixture", content: { text: "# Verified content" } },
    });
  });
});
