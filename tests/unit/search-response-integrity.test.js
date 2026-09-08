import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchPublic: vi.fn() }));

vi.mock("../../src/shared/utils/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchPublic: mocks.fetchPublic };
});

import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";

const originalFetch = global.fetch;
const dedicatedProvider = { id: "searxng" };
const dedicatedConfig = {
  authType: "none",
  baseUrl: "https://8.8.8.8/search",
  timeoutMs: 5_000,
  defaultMaxResults: 10,
  maxMaxResults: 10,
  searchTypes: ["web"],
};

afterEach(() => {
  global.fetch = originalFetch;
  mocks.fetchPublic.mockReset();
});

describe("search response semantic integrity", () => {
  it.each([
    [{ error: { message: "quota exhausted" } }, /quota exhausted/i],
    [{ success: false, message: "provider failed" }, /provider failed/i],
    [{}, /invalid upstream search response envelope/i],
  ])("rejects a dedicated HTTP 200 failure or wrong envelope: %j", async (payload, message) => {
    mocks.fetchPublic.mockResolvedValue(Response.json(payload));

    const result = await handleSearchCore({
      body: { query: "integrity regression" },
      provider: dedicatedProvider,
      providerConfig: dedicatedConfig,
      credentials: null,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toMatch(message);
  });

  it("preserves a legitimate dedicated zero-result response", async () => {
    mocks.fetchPublic.mockResolvedValue(Response.json({ results: [] }));

    const result = await handleSearchCore({
      body: { query: "nothing matches" },
      provider: dedicatedProvider,
      providerConfig: dedicatedConfig,
      credentials: null,
    });

    expect(result.success).toBe(true);
    await expect(result.response.json()).resolves.toMatchObject({
      provider: "searxng",
      results: [],
    });
  });

  it("rejects invalid UTF-8 in a dedicated HTTP 200 JSON response", async () => {
    mocks.fetchPublic.mockResolvedValue(new Response(new Uint8Array([
      ...new TextEncoder().encode('{"results":[{"url":"https://example.com/'),
      0xff,
      ...new TextEncoder().encode('"}]}'),
    ])));

    const result = await handleSearchCore({
      body: { query: "integrity regression" },
      provider: dedicatedProvider,
      providerConfig: dedicatedConfig,
      credentials: null,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
  });

  it.each([
    [{ error: { message: "grounding unavailable" } }, /grounding unavailable/i],
    [{}, /invalid upstream response envelope/i],
    [{ candidates: [{ content: { parts: [] } }] }, /no answer or search citations/i],
  ])("rejects a chat-search HTTP 200 failure or empty semantic result: %j", async (payload, message) => {
    global.fetch = vi.fn().mockResolvedValue(Response.json(payload));

    const result = await handleChatSearch({
      provider: "gemini",
      query: "integrity regression",
      credentials: { apiKey: "fixture-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toMatch(message);
  });

  it("accepts a chat-search answer even when grounding finds no URLs", async () => {
    global.fetch = vi.fn().mockResolvedValue(Response.json({
      candidates: [{ content: { parts: [{ text: "No matching public sources were found." }] } }],
      usageMetadata: { totalTokenCount: 7 },
    }));

    const result = await handleChatSearch({
      provider: "gemini",
      query: "nothing matches",
      credentials: { apiKey: "fixture-key" },
    });

    expect(result).toMatchObject({ success: true, status: 200 });
    expect(result.data).toMatchObject({
      results: [],
      answer: { text: "No matching public sources were found." },
      usage: { llm_tokens: 7 },
    });
  });

  it("rejects invalid UTF-8 in a chat-search HTTP 200 JSON response", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([
      ...new TextEncoder().encode('{"candidates":[{"content":{"parts":[{"text":"'),
      0xff,
      ...new TextEncoder().encode('"}]}}]}'),
    ])));

    const result = await handleChatSearch({
      provider: "gemini",
      query: "integrity regression",
      credentials: { apiKey: "fixture-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
  });
});
