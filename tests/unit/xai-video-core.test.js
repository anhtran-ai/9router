/**
 * Unit tests for the xAI video proxy core (open-sse/handlers/videoCore.js)
 *
 * Covers:
 *  - registry wiring (videoConfig, grok-imagine-video kind)
 *  - byte-exact body forwarding (JSON + multipart)
 *  - request_id / polling-status passthrough (pending, processing, done, failed)
 *  - 401 → refresh once → retry once; refresh failure → no retry loop
 *  - no auto-retry of creation POSTs on network error
 *  - upstream error propagation with secret sanitization
 *  - abort/cancellation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("open-sse/services/tokenRefresh.js", () => ({
  refreshTokenByProvider: vi.fn(),
}));

import { handleVideoProxyCore, getVideoConfig, sanitizeSecrets, VIDEO_ACTIONS } from "open-sse/handlers/videoCore.js";
import { refreshTokenByProvider } from "open-sse/services/tokenRefresh.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "open-sse/providers/index.js";

const originalFetch = global.fetch;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const streamResponse = (chunks, { status = 200, headers = {}, cancel = vi.fn() } = {}) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
    cancel,
  });
  return {
    response: new Response(body, {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    }),
    cancel,
  };
};

async function expectInvalidUpstream(result) {
  expect(result.success).toBe(false);
  expect(result.status).toBe(502);
  expect(await result.response.json()).toMatchObject({
    error: { code: "invalid_upstream_response" },
  });
}

describe("registry wiring", () => {
  it("exposes videoConfig for xai", () => {
    expect(getVideoConfig("xai")).toEqual({ baseUrl: "https://api.x.ai/v1/videos" });
    expect(PROVIDER_MEDIA.xai.serviceKinds).toContain("video");
  });

  it("registers grok-imagine-video with kind video (kept out of LLM lists)", () => {
    const model = PROVIDER_MODELS.xai.find((m) => m.id === "grok-imagine-video");
    expect(model).toBeTruthy();
    expect(model.kind || model.type).toBe("video");
  });

  it("supports exactly the three creation actions", () => {
    expect([...VIDEO_ACTIONS].sort()).toEqual(["edits", "extensions", "generations"]);
  });
});

describe("handleVideoProxyCore", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    refreshTokenByProvider.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("rejects providers without videoConfig", async () => {
    const result = await handleVideoProxyCore({
      provider: "openai",
      action: "generations",
      rawBody: "{}",
      credentials: { apiKey: "k" },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support video generation");
  });

  it("forwards a creation POST byte-for-byte and passes request_id through", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ request_id: "req-123" }));

    const raw = '{"model":"grok-imagine-video","prompt":"neon city","duration":8}';
    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: raw,
      contentType: "application/json",
      idempotencyKey: "idem-1",
      credentials: { accessToken: "tok-A", refreshToken: "ref-A" },
    });

    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/videos/generations");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(raw); // byte-exact, no reshaping
    expect(init.headers.Authorization).toBe("Bearer tok-A");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Idempotency-Key"]).toBe("idem-1");

    expect(await result.response.json()).toEqual({ request_id: "req-123" });
  });

  it("accepts the alternate valid id field on creation", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ id: "req-by-id" }));

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
    });

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({ id: "req-by-id" });
  });

  it.each([
    ["empty", new Response("", { status: 200, headers: { "Content-Type": "application/json" } })],
    ["malformed JSON", new Response('{"request_id":', { status: 200, headers: { "Content-Type": "application/json" } })],
    ["non-JSON content type", new Response('{"request_id":"req-1"}', { status: 200, headers: { "Content-Type": "text/html" } })],
    ["missing creation id", jsonResponse({ status: "pending" })],
    ["embedded creation error", jsonResponse({ error: { code: "bad_request", message: "rejected" } })],
    ["explicit creation failure", jsonResponse({ success: false, request_id: "must-not-pass" })],
    ["terminal creation status", jsonResponse({ status: "failed", request_id: "must-not-pass" })],
    ["invalid preferred id beside a valid alternate", jsonResponse({ request_id: 42, id: "req-valid" })],
    ["conflicting creation ids", jsonResponse({ request_id: "req-a", id: "req-b" })],
  ])("fails closed on a %s HTTP-200 creation response", async (_label, upstream) => {
    global.fetch.mockResolvedValueOnce(upstream);

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
    });

    await expectInvalidUpstream(result);
  });

  it("rejects invalid UTF-8 in an otherwise valid HTTP-200 creation envelope", async () => {
    const prefix = new TextEncoder().encode('{"request_id":"job-');
    const suffix = new TextEncoder().encode('"}');
    const body = new Uint8Array(prefix.length + 1 + suffix.length);
    body.set(prefix, 0);
    body[prefix.length] = 0xff;
    body.set(suffix, prefix.length + 1);
    global.fetch.mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
    });

    await expectInvalidUpstream(result);
  });

  it("parses a valid creation response split across transport chunks", async () => {
    const { response } = streamResponse(['{"request_', 'id":"req-split"}']);
    global.fetch.mockResolvedValueOnce(response);

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
    });

    expect(result.success).toBe(true);
    expect(response.body.locked).toBe(false);
    expect(await result.response.json()).toEqual({ request_id: "req-split" });
  });

  it("forwards multipart bodies untouched with the original boundary header", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ request_id: "req-mp" }));

    const boundary = "----vitestBoundary42";
    const multipartBody = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nextend it\r\n--${boundary}--\r\n`
    );
    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "extensions",
      rawBody: multipartBody,
      contentType: `multipart/form-data; boundary=${boundary}`,
      credentials: { apiKey: "xai-key" },
    });

    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/videos/extensions");
    expect(init.body).toBe(multipartBody); // same Buffer, no re-encode
    expect(init.headers["Content-Type"]).toBe(`multipart/form-data; boundary=${boundary}`);
  });

  it.each([
    ["pending", { status: "pending", progress: 10 }],
    ["processing", { status: "processing", progress: 55 }],
    ["done", { status: "done", video: { url: "https://cdn.x.ai/v.mp4", duration: 8 } }],
  ])("passes %s polling payload through verbatim", async (_label, payload) => {
    global.fetch.mockResolvedValueOnce(jsonResponse(payload));

    const result = await handleVideoProxyCore({
      provider: "xai",
      requestId: "req-123",
      credentials: { accessToken: "tok" },
    });

    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/videos/req-123");
    expect(init.method).toBe("GET");
    expect(await result.response.json()).toEqual(payload);
  });

  it("passes a failed job (HTTP 200, status failed) through without translating", async () => {
    const payload = { status: "failed", error: { code: "internal_error", message: "render crashed" } };
    global.fetch.mockResolvedValueOnce(jsonResponse(payload));

    const result = await handleVideoProxyCore({
      provider: "xai",
      requestId: "req-bad",
      credentials: { accessToken: "tok" },
    });

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual(payload);
  });

  it.each([
    ["unknown status", { status: "complete", video: { url: "https://cdn.x.ai/v.mp4" } }],
    ["missing status", { error: { code: "render_failed", message: "boom" } }],
    ["pending with embedded error", { status: "pending", error: { message: "boom" } }],
    ["done without video", { status: "done" }],
    ["done with an insecure URL", { status: "done", video: { url: "http://cdn.x.ai/v.mp4" } }],
    ["failed without a valid error", { status: "failed", error: {} }],
    ["expired with a malformed error", { status: "expired", error: 42 }],
    ["pending with a false success flag", { status: "pending", success: false }],
    ["done with a false success flag", { status: "done", success: false, video: { url: "https://cdn.x.ai/v.mp4" } }],
    ["failed with a true success flag", { status: "failed", success: true, error: "render failed" }],
    ["non-boolean success flag", { status: "pending", success: "true" }],
  ])("fails closed on a poll response with %s", async (_label, payload) => {
    global.fetch.mockResolvedValueOnce(jsonResponse(payload));

    const result = await handleVideoProxyCore({
      provider: "xai",
      requestId: "req-invalid",
      credentials: { accessToken: "tok" },
    });

    await expectInvalidUpstream(result);
  });

  it("passes a recognized expired job through", async () => {
    const payload = { status: "expired", error: { code: "expired", message: "result expired" } };
    global.fetch.mockResolvedValueOnce(jsonResponse(payload));

    const result = await handleVideoProxyCore({
      provider: "xai",
      requestId: "req-expired",
      credentials: { accessToken: "tok" },
    });

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual(payload);
  });

  it("rejects an oversized HTTP-200 body and cancels it without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const { response } = streamResponse(["{}"], {
      headers: { "Content-Length": "4096" },
      cancel,
    });
    global.fetch.mockResolvedValueOnce(response);

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
      maxResponseBytes: 64,
    });

    await expectInvalidUpstream(result);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it("enforces the response cap when content-length is absent", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"request_id":"too-long"}'));
      },
      cancel,
    });
    const response = new Response(body, { headers: { "Content-Type": "application/json" } });
    global.fetch.mockResolvedValueOnce(response);

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
      maxResponseBytes: 8,
    });

    await expectInvalidUpstream(result);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it("times out a stalled HTTP-200 body, cancels it, and releases the reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const upstream = new Response(body, { headers: { "Content-Type": "application/json" } });
    global.fetch.mockResolvedValueOnce(upstream);

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
      timeoutMs: 1_000,
      bodyStallTimeoutMs: 15,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(await result.response.json()).toMatchObject({ error: { code: "video_upstream_timeout" } });
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(upstream.body.locked).toBe(false));
  });

  it("maps an actual caller abort during the response body to 499 and releases it", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const upstream = new Response(body, { headers: { "Content-Type": "application/json" } });
    global.fetch.mockResolvedValueOnce(upstream);

    const pending = handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
      signal: controller.signal,
      timeoutMs: 1_000,
      bodyStallTimeoutMs: 500,
    });
    await vi.waitFor(() => expect(upstream.body.locked).toBe(true));
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(upstream.body.locked).toBe(false));
  });

  it("enforces the full-operation deadline while waiting for response headers", async () => {
    global.fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
      timeoutMs: 15,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("url-encodes the request id when polling", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "pending" }));
    await handleVideoProxyCore({
      provider: "xai",
      requestId: "id with/slash",
      credentials: { accessToken: "tok" },
    });
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.x.ai/v1/videos/id%20with%2Fslash");
  });

  it("401 → refreshes once and retries once with the new token", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ request_id: "req-after-refresh" }));
    refreshTokenByProvider.mockResolvedValueOnce({ accessToken: "tok-NEW", refreshToken: "ref-NEW" });

    const credentials = { accessToken: "tok-OLD", refreshToken: "ref-OLD" };
    const onCredentialsRefreshed = vi.fn();

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: '{"prompt":"x"}',
      contentType: "application/json",
      credentials,
      onCredentialsRefreshed,
    });

    expect(result.success).toBe(true);
    expect(refreshTokenByProvider).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer tok-NEW");
    expect(onCredentialsRefreshed).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "tok-NEW" }));
    expect(await result.response.json()).toEqual({ request_id: "req-after-refresh" });
  });

  it("401 twice → still only one refresh and one retry (no loop)", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "still expired" }, 401));
    refreshTokenByProvider.mockResolvedValueOnce({ accessToken: "tok-NEW" });

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok-OLD", refreshToken: "ref" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(refreshTokenByProvider).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("failed refresh → 401 propagates with a single upstream call (account flagged for re-auth upstream)", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401));
    refreshTokenByProvider.mockResolvedValueOnce(null);

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok-OLD", refreshToken: "ref" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("API-key accounts (no refreshToken) never attempt refresh on 401", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: "bad key" }, 401));

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { apiKey: "xai-key" },
    });

    expect(result.success).toBe(false);
    expect(refreshTokenByProvider).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("never re-sends a creation POST after a network error", async () => {
    global.fetch.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok", refreshToken: "ref" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("sanitizes bearer tokens and credential values out of upstream errors", async () => {
    global.fetch.mockResolvedValueOnce(
      jsonResponse({ error: "denied for Bearer sk-secret-token-value-123456 (token tok-SECRETSECRET)" }, 403)
    );

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { apiKey: "tok-SECRETSECRET" },
    });

    expect(result.success).toBe(false);
    expect(result.error).not.toContain("sk-secret-token-value-123456");
    expect(result.error).not.toContain("tok-SECRETSECRET");
    expect(result.error).toContain("[redacted]");
  });

  it("does not misclassify an upstream AbortError as a caller abort", async () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    global.fetch.mockRejectedValueOnce(abortError);

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      credentials: { accessToken: "tok" },
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeSecrets", () => {
  it("redacts bearer tokens", () => {
    expect(sanitizeSecrets("Authorization: Bearer abc.def-ghi_jkl")).not.toContain("abc.def-ghi_jkl");
  });

  it("redacts explicit credential values", () => {
    const creds = { accessToken: "supersecretaccess", refreshToken: "supersecretrefresh" };
    const out = sanitizeSecrets("leak supersecretaccess and supersecretrefresh", creds);
    expect(out).toBe("leak [redacted] and [redacted]");
  });

  it("leaves normal text untouched", () => {
    expect(sanitizeSecrets("video render failed: invalid_argument")).toBe("video render failed: invalid_argument");
  });
});
