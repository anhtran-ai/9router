/**
 * Unit tests for the app-side video handler (src/sse/handlers/videoGeneration.js)
 *
 * Covers:
 *  - `xai/` model prefix stripping before the body is forwarded upstream
 *  - byte-exact forwarding when no prefix rewrite is needed
 *  - multi-account selection (preferred connection id, rotation on 401)
 *  - NO rotation on 5xx creation errors (a job may already exist upstream)
 *  - connection id surfaced via x-9router-connection-id
 *  - GET polling pinned to x-connection-id, no rotation
 *  - refresh failure recorded via markAccountUnavailable (dashboard re-auth signal)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
  beginAccountMutationAttempt: vi.fn(() => ({ id: 1 })),
  endAccountMutationAttempt: vi.fn(),
  recordAccountMutationSuccess: vi.fn(),
}));
const tokenMocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => {}),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => tokenMocks);
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getComboByName: vi.fn(async () => null),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
}));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { handleVideoCreate, handleVideoGet } from "@/sse/handlers/videoGeneration.js";

const originalFetch = global.fetch;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const makeRequest = (body, { headers = {}, contentType = "application/json" } = {}) =>
  new Request("http://localhost/v1/videos/generations", {
    method: "POST",
    headers: { "Content-Type": contentType, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const account = (overrides = {}) => ({
  connectionId: "conn-1",
  accessToken: "tok-1",
  refreshToken: "ref-1",
  authType: "oauth",
  ...overrides,
});

beforeEach(() => {
  global.fetch = vi.fn();
  authMocks.getProviderCredentials.mockReset();
  authMocks.markAccountUnavailable.mockClear();
  authMocks.clearAccountError.mockClear();
  authMocks.beginAccountMutationAttempt.mockClear();
  authMocks.endAccountMutationAttempt.mockClear();
  authMocks.recordAccountMutationSuccess.mockClear();
  tokenMocks.checkAndRefreshToken.mockClear();
  tokenMocks.updateProviderCredentials.mockClear();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("handleVideoCreate", () => {
  it("strips the xai/ prefix from model before forwarding", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    const res = await handleVideoCreate(
      makeRequest({ model: "xai/grok-imagine-video", prompt: "a cat" }),
      "generations"
    );

    expect(res.status).toBe(200);
    const forwarded = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(forwarded.model).toBe("grok-imagine-video");
    expect(forwarded.prompt).toBe("a cat");
  });

  it("forwards the original raw JSON bytes when no rewrite is needed", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    // Odd spacing survives only if we forward the raw string untouched
    const raw = '{ "model" : "grok-imagine-video",  "prompt" : "spaced" }';
    await handleVideoCreate(makeRequest(raw), "generations");

    expect(global.fetch.mock.calls[0][1].body).toBe(raw);
  });

  it("rejects providers without video support", async () => {
    const res = await handleVideoCreate(
      makeRequest({ model: "openai/sora-alike", prompt: "x" }),
      "generations"
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not support video generation");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns the serving connection id in x-9router-connection-id", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ connectionId: "conn-77" }));
    global.fetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");
    expect(res.headers.get("x-9router-connection-id")).toBe("conn-77");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-9router-connection-id");
    expect(await res.json()).toEqual({ request_id: "r1" });
  });

  it("preserves an accepted billable job when account-health cleanup rejects", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ connectionId: "conn-77" }));
    authMocks.clearAccountError.mockRejectedValueOnce(new Error("fixture DB cleanup failed"));
    global.fetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-9router-connection-id")).toBe("conn-77");
    await expect(res.json()).resolves.toEqual({ request_id: "r1" });
    expect(authMocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(authMocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("returns an accepted billable job without waiting for account cleanup", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ connectionId: "conn-77" }));
    authMocks.clearAccountError.mockReturnValueOnce(new Promise(() => {}));
    global.fetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    const pending = handleVideoCreate(makeRequest({ prompt: "x" }), "generations");
    await vi.waitFor(() => expect(authMocks.clearAccountError).toHaveBeenCalledOnce());
    const stillPending = Symbol("still pending");
    const result = await Promise.race([pending, Promise.resolve(stillPending)]);

    expect(result).not.toBe(stillPending);
    expect(result.status).toBe(200);
    expect(authMocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(authMocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });

  it("honors preferred x-connection-id when selecting the account", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    await handleVideoCreate(
      makeRequest({ prompt: "x" }, { headers: { "x-connection-id": "conn-9" } }),
      "generations"
    );

    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "xai", expect.anything(), "video:grok-imagine-video", expect.objectContaining({ preferredConnectionId: "conn-9" })
    );
  });

  it("rotates to the next account on 401 (auth errors cannot have created a job)", async () => {
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(account({ connectionId: "conn-1", refreshToken: null }))
      .mockResolvedValueOnce(account({ connectionId: "conn-2", accessToken: "tok-2", refreshToken: null }));
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ request_id: "r2" }));

    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-9router-connection-id")).toBe("conn-2");
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-1",
      401,
      expect.any(String),
      "xai",
      "video:grok-imagine-video",
      null,
      { mutationAttempt: { id: 1 } },
    );
  });

  it("does NOT rotate accounts on a 500 creation error (job may exist upstream)", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ refreshToken: null }));
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");

    expect(res.status).toBe(500);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("forwards multipart bodies byte-exact with default xai provider", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(jsonResponse({ request_id: "r-mp" }));

    const boundary = "----handlerBoundary";
    const raw = `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit\r\n--${boundary}--\r\n`;
    const req = new Request("http://localhost/v1/videos/edits", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: raw,
    });

    const res = await handleVideoCreate(req, "edits");
    expect(res.status).toBe(200);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/videos/edits");
    expect(Buffer.from(init.body).toString()).toBe(raw);
    expect(init.headers["Content-Type"]).toContain(boundary);
  });

  it("returns 400 when no credentials are connected", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(null);
    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("No credentials for provider: xai");
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await handleVideoCreate(makeRequest("{not json"), "generations");
    expect(res.status).toBe(400);
  });

  it("rejects invalid UTF-8 JSON before selecting or mutating an account", async () => {
    const prefix = new TextEncoder().encode('{"model":"xai/grok-imagine-video","prompt":"');
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix, 0);
    bytes[prefix.length] = 0xff;
    bytes.set(suffix, prefix.length + 1);
    const request = new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "Application/JSON; charset=utf-8" },
      body: bytes,
    });

    const res = await handleVideoCreate(request, "generations");

    expect(res.status).toBe(400);
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(authMocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized inbound body before account selection and cancels non-blockingly", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const request = new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(64 * 1024 * 1024 + 1),
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel,
      }),
      duplex: "half",
    });

    const res = await handleVideoCreate(request, "generations");

    expect(res.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.body.locked).toBe(false);
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("enforces the inbound cap when content-length is absent", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    const request = new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=test" },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel,
      }),
      duplex: "half",
    });

    const res = await handleVideoCreate(request, "generations");

    expect(res.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.body.locked).toBe(false);
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("times out a stalled inbound body before account selection and releases it", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const request = new Request("http://localhost/v1/videos/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new ReadableStream({ cancel }),
        duplex: "half",
      });

      const pending = handleVideoCreate(request, "generations");
      await vi.advanceTimersByTimeAsync(30_001);
      const res = await pending;

      expect(res.status).toBe(408);
      expect(cancel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(request.body.locked).toBe(false);
      expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps an inbound client abort to 499 without selecting or mutating an account", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const request = new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream({ cancel }),
      duplex: "half",
      signal: controller.signal,
    });

    const pending = handleVideoCreate(request, "generations");
    await vi.waitFor(() => expect(request.body.locked).toBe(true));
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const res = await pending;

    expect(res.status).toBe(499);
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(request.body.locked).toBe(false));
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.clearAccountError).not.toHaveBeenCalled();
    expect(authMocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
  });

  it("does not treat an invalid HTTP-200 envelope as account success", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(jsonResponse({}));

    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");

    expect(res.status).toBe(502);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.clearAccountError).not.toHaveBeenCalled();
    expect(authMocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
  });

  it("maps an upstream-body client abort to 499 without account penalty or fallback", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Type": "application/json" },
    });
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(account({ connectionId: "conn-abort" }))
      .mockResolvedValueOnce(account({ connectionId: "conn-should-not-run" }));
    global.fetch.mockResolvedValueOnce(upstream);
    const request = makeRequest({ prompt: "x" });
    const abortableRequest = new Request(request, { signal: controller.signal });

    const pending = handleVideoCreate(abortableRequest, "generations");
    await vi.waitFor(() => expect(upstream.body.locked).toBe(true));
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const res = await pending;

    expect(res.status).toBe(499);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.clearAccountError).not.toHaveBeenCalled();
    expect(authMocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(upstream.body.locked).toBe(false));
  });

  it("returns 499 promptly if account token refresh ignores client cancellation", async () => {
    const controller = new AbortController();
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    tokenMocks.checkAndRefreshToken.mockImplementationOnce(() => new Promise(() => {}));
    const base = makeRequest({ prompt: "x" });
    const pending = handleVideoCreate(new Request(base, { signal: controller.signal }), "generations");
    await vi.waitFor(() => expect(tokenMocks.checkAndRefreshToken).toHaveBeenCalledOnce());
    controller.abort(new DOMException("client disconnected", "AbortError"));

    expect((await pending).status).toBe(499);
    expect(authMocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("handleVideoGet", () => {
  it("polls upstream pinned to the x-connection-id account and passes status through", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ connectionId: "conn-5" }));
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "pending", progress: 42 }));

    const req = new Request("http://localhost/v1/videos/req-1", {
      headers: { "x-connection-id": "conn-5" },
    });
    const res = await handleVideoGet(req, "req-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending", progress: 42 });
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "xai", null, "video:grok-imagine-video", expect.objectContaining({ preferredConnectionId: "conn-5" })
    );
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.x.ai/v1/videos/req-1");
  });

  it("records the failure when polling hits a terminal auth error", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ refreshToken: null }));
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    const res = await handleVideoGet(new Request("http://localhost/v1/videos/req-1"), "req-1");

    expect(res.status).toBe(401);
    expect(authMocks.markAccountUnavailable).toHaveBeenCalled();
  });

  it("passes a valid failed job through without penalizing the serving account", async () => {
    const payload = { status: "failed", error: { code: "render_failed", message: "unsafe prompt" } };
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(jsonResponse(payload));

    const res = await handleVideoGet(new Request("http://localhost/v1/videos/req-1"), "req-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(authMocks.clearAccountError).toHaveBeenCalledOnce();
  });

  it("returns a valid poll result without waiting for account cleanup", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    authMocks.clearAccountError.mockReturnValueOnce(new Promise(() => {}));
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "pending", progress: 42 }));

    const pending = handleVideoGet(new Request("http://localhost/v1/videos/req-1"), "req-1");
    await vi.waitFor(() => expect(authMocks.clearAccountError).toHaveBeenCalledOnce());
    const stillPending = Symbol("still pending");
    const result = await Promise.race([pending, Promise.resolve(stillPending)]);

    expect(result).not.toBe(stillPending);
    expect(result.status).toBe(200);
    expect(authMocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(authMocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });

  it("maps a polling client abort to 499 without changing account health", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Type": "application/json" },
    });
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(upstream);
    const request = new Request("http://localhost/v1/videos/req-1", { signal: controller.signal });

    const pending = handleVideoGet(request, "req-1");
    await vi.waitFor(() => expect(upstream.body.locked).toBe(true));
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const res = await pending;

    expect(res.status).toBe(499);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.clearAccountError).not.toHaveBeenCalled();
    expect(authMocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(upstream.body.locked).toBe(false));
  });

  it("rejects an invalid request id before account selection", async () => {
    const response = await handleVideoGet(
      new Request("http://localhost/v1/videos/bad"),
      `id-${"x".repeat(513)}`,
    );
    expect(response.status).toBe(400);
    expect(authMocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(tokenMocks.checkAndRefreshToken).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not poison account state for a non-auth poll failure", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: "gateway" }, 502));
    const response = await handleVideoGet(new Request("http://localhost/v1/videos/req-1"), "req-1");
    expect(response.status).toBe(502);
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.clearAccountError).not.toHaveBeenCalled();
  });

  it("returns 499 if polling token refresh never settles after disconnect", async () => {
    const controller = new AbortController();
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    tokenMocks.checkAndRefreshToken.mockImplementationOnce(() => new Promise(() => {}));
    const pending = handleVideoGet(
      new Request("http://localhost/v1/videos/req-1", { signal: controller.signal }),
      "req-1",
    );
    await vi.waitFor(() => expect(tokenMocks.checkAndRefreshToken).toHaveBeenCalledOnce());
    controller.abort(new DOMException("client disconnected", "AbortError"));

    expect((await pending).status).toBe(499);
    expect(authMocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed instead of polling with a different account than the requested pin", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ connectionId: "conn-other" }));

    const response = await handleVideoGet(
      new Request("http://localhost/v1/videos/req-1", {
        headers: { "x-connection-id": "conn-required" },
      }),
      "req-1",
    );

    expect(response.status).toBe(409);
    expect(tokenMocks.checkAndRefreshToken).not.toHaveBeenCalled();
    expect(authMocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(authMocks.clearAccountError).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reports a missing requested poll connection without mutating another account", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(null);

    const response = await handleVideoGet(
      new Request("http://localhost/v1/videos/req-1", {
        headers: { "x-connection-id": "conn-missing" },
      }),
      "req-1",
    );

    expect(response.status).toBe(409);
    expect(tokenMocks.checkAndRefreshToken).not.toHaveBeenCalled();
    expect(authMocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
    expect(authMocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
