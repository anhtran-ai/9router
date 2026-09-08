import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPublic: vi.fn(),
}));

vi.mock("../../src/shared/utils/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchPublic: mocks.fetchPublic };
});

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers.js";

const CONFIG = {
  id: "xquik",
  baseUrl: "https://xquik.com/api/v1/x/tweets/search",
  method: "GET",
  authType: "apikey",
  searchTypes: ["x"],
  defaultMaxResults: 5,
  maxMaxResults: 100,
  creditsPerResult: 1,
};

const PARAMS = {
  query: "from:github release notes",
  searchType: "x",
  maxResults: 10,
  token: "xq_test_key",
  language: "en",
  providerOptions: { queryType: "Latest", cursor: "next page" },
};

const RESPONSE = {
  tweets: [
    {
      id: "1234567890",
      text: "Release notes are live.",
      createdAt: "2026-08-25T12:00:00Z",
      author: { username: "github", name: "GitHub" },
      media: [{ mediaUrl: "https://pbs.twimg.com/media/example.jpg", type: "photo" }],
    },
  ],
  has_next_page: true,
  next_cursor: "cursor-2",
};

const originalFetch = global.fetch;

afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
  mocks.fetchPublic.mockReset();
});

describe("Xquik search provider", () => {
  it("registers a dedicated X search provider with no-charge key validation", () => {
    const entry = REGISTRY.find((candidate) => candidate.id === "xquik");

    expect(entry).toMatchObject({
      category: "apikey",
      serviceKinds: ["webSearch"],
      searchConfig: {
        authHeader: "x-api-key",
        validateUrl: "https://xquik.com/api/v1/credits",
        searchTypes: ["x"],
        creditsPerResult: 1,
      },
    });
    expect(AI_PROVIDERS.xquik?.searchConfig).toEqual(entry.searchConfig);
    expect(getProvidersByKind("webSearch").map((provider) => provider.id)).toContain("xquik");
  });

  it("builds the documented GET request without putting the key in the URL", () => {
    const request = buildSearchRequest(CONFIG, PARAMS);
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe("https://xquik.com/api/v1/x/tweets/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "from:github release notes",
      limit: "10",
      cursor: "next page",
      queryType: "Latest",
      language: "en",
    });
    expect(url.search).not.toContain("xq_test_key");
    expect(request.init).toEqual({
      method: "GET",
      headers: { Accept: "application/json", "x-api-key": "xq_test_key" },
    });
  });

  it("rejects unsupported query types before contacting Xquik", () => {
    expect(() => buildSearchRequest(CONFIG, {
      ...PARAMS,
      providerOptions: { queryType: "Popular" },
    })).toThrow("Xquik queryType must be Latest or Top");
  });

  it("normalizes posts and preserves cursor pagination", () => {
    const normalized = normalizeSearchResponse("xquik", RESPONSE, PARAMS.query, "x");

    expect(normalized.totalResults).toBeNull();
    expect(normalized.pagination).toEqual({ has_more: true, next_cursor: "cursor-2" });
    expect(normalized.results).toHaveLength(1);
    expect(normalized.results[0]).toMatchObject({
      title: "@github on X",
      url: "https://x.com/github/status/1234567890",
      display_url: "x.com/github/status/1234567890",
      snippet: "Release notes are live.",
      published_at: "2026-08-25T12:00:00Z",
      metadata: {
        author: "@github",
        source_type: "x_post",
        image_url: "https://pbs.twimg.com/media/example.jpg",
      },
      citation: { provider: "xquik", rank: 1 },
    });
    expect(normalized.results[0].content).toEqual({
      format: "text",
      text: "Release notes are live.",
      length: 23,
    });
  });

  it("uses the stable status URL when author data is unavailable", () => {
    const normalized = normalizeSearchResponse("xquik", {
      tweets: [{ id: "9876543210", text: "Author data is unavailable." }],
      has_next_page: false,
      next_cursor: "",
    }, PARAMS.query, "x");

    expect(normalized.results[0]).toMatchObject({
      title: "X post",
      url: "https://x.com/i/web/status/9876543210",
      metadata: { author: null, source_type: "x_post" },
    });
    expect(normalized.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("reports Xquik credits without claiming an unknown USD cost", async () => {
    mocks.fetchPublic.mockResolvedValue(new Response(JSON.stringify(RESPONSE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await handleSearchCore({
      body: { query: PARAMS.query, max_results: 10, provider_options: PARAMS.providerOptions },
      provider: { id: "xquik" },
      providerConfig: CONFIG,
      credentials: { apiKey: "xq_test_key" },
    });
    const payload = await result.response.json();

    expect(result.success).toBe(true);
    expect(payload.usage).toEqual({
      queries_used: 1,
      search_cost_usd: null,
      provider_credits_used: 1,
    });
    expect(payload.pagination).toEqual({ has_more: true, next_cursor: "cursor-2" });
  });

  it("keeps the chat-search timeout active while parsing a stalled body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: { cancel },
      json: () => new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("body timeout", "AbortError"));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      }),
    }));

    const pending = handleChatSearch({
      provider: "gemini",
      query: "stalled response",
      credentials: { apiKey: "fixture-key" },
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toMatchObject({ success: false, status: 504 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("caps a declared oversized chat-search JSON body and releases it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start() {}, cancel });
    global.fetch = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(16 * 1024 * 1024 + 1),
      },
    }));

    const result = await handleChatSearch({
      provider: "gemini",
      query: "oversized response",
      credentials: { apiKey: "fixture-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toMatch(/too large/i);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("keeps dedicated plus chat fallback inside one global deadline", async () => {
    vi.useFakeTimers();
    mocks.fetchPublic.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(Response.json({ error: "retry" }, { status: 502 })), 14_990);
    }));
    let fallbackSignal;
    global.fetch = vi.fn((_url, init) => {
      fallbackSignal = init.signal;
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException("fallback timeout", "AbortError"));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      });
    });

    const pending = handleSearchCore({
      body: { query: "one deadline" },
      provider: { id: "gemini", searchViaChat: { defaultModel: "gemini-2.5-flash" } },
      providerConfig: {
        authType: "apikey",
        baseUrl: "https://8.8.8.8/search",
        timeoutMs: 15_000,
        defaultMaxResults: 1,
        maxMaxResults: 1,
        searchTypes: ["web"],
      },
      credentials: { apiKey: "fixture-key" },
    });

    await vi.advanceTimersByTimeAsync(14_990);
    for (let i = 0; i < 30 && global.fetch.mock.calls.length === 0; i++) await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({ success: false });
    expect(fallbackSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
