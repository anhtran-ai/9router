import { describe, expect, it, vi } from "vitest";

import {
  parseUpstreamError,
  readUpstreamBodyText,
  rebuildUpstreamResponse,
  UpstreamBodyLengthMismatchError,
  UpstreamBodyTooLargeError,
} from "../../open-sse/utils/error.js";

function trackedResponse({ chunks = [], status = 502, stall = false, headers = {} } = {}) {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (!stall) controller.close();
    },
    cancel,
  });
  const response = new Response(body, { status, headers });
  return { response, body, cancel };
}

describe("bounded upstream error-body parsing", () => {
  it("preserves provider-specific parsing for a normal bounded error", async () => {
    const response = new Response(JSON.stringify({ error: { message: "quota" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    const executor = {
      parseError: vi.fn((_response, text) => ({
        status: 429,
        message: JSON.parse(text).error.message,
        resetsAtMs: 1234,
      })),
    };

    await expect(parseUpstreamError(response, executor)).resolves.toEqual({
      statusCode: 429,
      message: "quota",
      resetsAtMs: 1234,
    });
    expect(executor.parseError).toHaveBeenCalledOnce();
  });

  it("caps a chunked body and cancels/releases its reader", async () => {
    const upstream = trackedResponse({ chunks: ["1234", "5678"], stall: true });

    await expect(readUpstreamBodyText(upstream.response, { maxBytes: 5 }))
      .rejects.toBeInstanceOf(UpstreamBodyTooLargeError);
    await Promise.resolve();

    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("falls back to the HTTP status when an error body stalls", async () => {
    const upstream = trackedResponse({ chunks: ["partial"], status: 503, stall: true });

    await expect(parseUpstreamError(upstream.response, null, { stallTimeoutMs: 10 }))
      .resolves.toMatchObject({ statusCode: 503 });
    await Promise.resolve();

    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("propagates caller abort and cancels/releases a stalled body", async () => {
    const upstream = trackedResponse({ status: 502, stall: true });
    const controller = new AbortController();
    const pending = parseUpstreamError(upstream.response, null, {
      signal: controller.signal,
      stallTimeoutMs: 10_000,
    });

    controller.abort(new DOMException("client left", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();

    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("rejects an oversized declared length before reading and cancels the body", async () => {
    const upstream = trackedResponse({
      chunks: ["small"],
      headers: { "content-length": "999" },
    });

    await expect(readUpstreamBodyText(upstream.response, { maxBytes: 10 }))
      .rejects.toBeInstanceOf(UpstreamBodyTooLargeError);

    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("rejects a clean EOF that contradicts an identity Content-Length", async () => {
    const upstream = trackedResponse({
      chunks: ["short"],
      headers: { "content-length": "8" },
    });

    await expect(readUpstreamBodyText(upstream.response))
      .rejects.toBeInstanceOf(UpstreamBodyLengthMismatchError);

    expect(upstream.body.locked).toBe(false);
  });

  it("does not compare decoded bytes with a compressed wire Content-Length", async () => {
    const upstream = trackedResponse({
      chunks: ["decoded"],
      headers: { "content-encoding": "gzip", "content-length": "99" },
    });

    await expect(readUpstreamBodyText(upstream.response)).resolves.toBe("decoded");
  });

  it("cleans up its abort listener when reader.read throws synchronously", async () => {
    const reader = {
      read: vi.fn(() => { throw new Error("broken reader"); }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const response = {
      headers: new Headers(),
      body: { getReader: () => reader },
    };

    await expect(readUpstreamBodyText(response, { signal, stallTimeoutMs: 10_000 }))
      .rejects.toThrow("broken reader");

    expect(signal.addEventListener).toHaveBeenCalledOnce();
    expect(signal.removeEventListener).toHaveBeenCalledOnce();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it("rebuilds a consumed response without stale framing headers", async () => {
    const upstream = new Response("decoded", {
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        "content-encoding": "gzip",
        "content-length": "999",
        "transfer-encoding": "chunked",
        digest: "sha-256=stale",
        "content-digest": "sha-256=:stale:",
        "repr-digest": "sha-256=:stale:",
        "content-md5": "stale",
        etag: '"stale"',
        "content-range": "bytes 0-6/999",
        trailer: "digest",
        "content-type": "text/plain; charset=iso-8859-1; format=flowed",
        "x-upstream": "yes",
      },
    });

    const rebuilt = rebuildUpstreamResponse(upstream, "decoded");

    expect(rebuilt.status).toBe(429);
    expect(rebuilt.statusText).toBe("Too Many Requests");
    expect(rebuilt.headers.get("content-encoding")).toBeNull();
    expect(rebuilt.headers.get("content-length")).toBeNull();
    expect(rebuilt.headers.get("transfer-encoding")).toBeNull();
    expect(rebuilt.headers.get("digest")).toBeNull();
    expect(rebuilt.headers.get("content-digest")).toBeNull();
    expect(rebuilt.headers.get("repr-digest")).toBeNull();
    expect(rebuilt.headers.get("content-md5")).toBeNull();
    expect(rebuilt.headers.get("etag")).toBeNull();
    expect(rebuilt.headers.get("content-range")).toBeNull();
    expect(rebuilt.headers.get("trailer")).toBeNull();
    expect(rebuilt.headers.get("content-type")).toBe("text/plain; format=flowed; charset=utf-8");
    expect(rebuilt.headers.get("x-upstream")).toBe("yes");
    expect(await rebuilt.text()).toBe("decoded");
  });
});
