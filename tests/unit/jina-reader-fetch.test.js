import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetchCore, __test__ } from "../../open-sse/handlers/fetch/index.js";

const originalFetch = global.fetch;

describe("Jina Reader fetch", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it("uses Jina's JSON POST API instead of embedding the URL in the path", async () => {
    global.fetch.mockResolvedValueOnce(new Response([
      "Title: Example page",
      "",
      "URL Source: https://example.com/article",
      "",
      "Markdown Content:",
      "Hello",
    ].join("\n")));

    const result = await handleFetchCore({
      url: "https://example.com/article",
      format: "markdown",
      provider: "jina-reader",
      providerConfig: { timeoutMs: 30000 },
      credentials: { apiKey: "jina-test-key" },
    });

    expect(result.success).toBe(true);
    expect(result.data.title).toBe("Example page");
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [requestUrl, init] = global.fetch.mock.calls[0];
    expect(requestUrl).toBe("https://r.jina.ai/");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer jina-test-key",
    });
    expect(JSON.parse(init.body)).toEqual({ url: "https://example.com/article" });
  });

  it("returns the upstream status and error body", async () => {
    global.fetch.mockResolvedValueOnce(new Response(
      JSON.stringify({ detail: "Payment required" }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    ));

    const result = await handleFetchCore({
      url: "https://example.com/article",
      provider: "jina-reader",
      providerConfig: { timeoutMs: 30000 },
      credentials: { apiKey: "jina-test-key" },
    });

    expect(result).toMatchObject({
      success: false,
      status: 402,
    });
    expect(result.error).toContain("Payment required");
  });

  it("keeps the provider timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    global.fetch.mockImplementationOnce(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/plain" }),
      body: { cancel },
      text: () => new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("body timeout", "AbortError"));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      }),
    }));

    const pending = handleFetchCore({
      url: "https://example.com/stalled",
      provider: "jina-reader",
      providerConfig: { timeoutMs: 25 },
      credentials: { apiKey: "jina-test-key" },
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toMatchObject({ success: false, status: 504 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a chunked upstream body once its byte limit is exceeded", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("12345"));
        controller.enqueue(encoder.encode("67890"));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      headers: { "content-type": "text/plain" },
    });

    await expect(__test__.readTextWithLimit(response, 8)).rejects.toThrow(/exceeds/i);
    expect(cancelled).toBe(true);
  });
});
