// Guards the refactored REFRESH_HANDLERS dispatch: null-guards + the two different defaults.
import { afterEach, describe, it, expect, vi } from "vitest";

const load = () => import("../../open-sse/services/tokenRefresh.js");

function serviceAccount(id) {
  return {
    client_email: `${id}@example.test`,
    private_key: "-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----",
    project_id: "test-project",
  };
}

function mockJose() {
  vi.doMock("jose", () => ({
    importPKCS8: vi.fn().mockResolvedValue({}),
    SignJWT: class {
      setProtectedHeader() { return this; }
      setIssuer() { return this; }
      setAudience() { return this; }
      setIssuedAt() { return this; }
      setExpirationTime() { return this; }
      async sign() { return "signed-jwt"; }
    },
  }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("jose");
  vi.resetModules();
});

describe("tokenRefresh dispatch", () => {
  it("getAccessToken returns null for missing/invalid refreshToken", async () => {
    const mod = await load();
    expect(await mod.getAccessToken("claude", {}, null)).toBeNull();
    expect(await mod.getAccessToken("claude", { refreshToken: 123 }, null)).toBeNull();
  });

  it("getAccessToken default: unsupported provider → null", async () => {
    const mod = await load();
    expect(await mod.getAccessToken("totally-unknown", { refreshToken: "x" }, null)).toBeNull();
  });

  it("refreshTokenByProvider returns null without refreshToken", async () => {
    const mod = await load();
    expect(await mod.refreshTokenByProvider("claude", {}, null)).toBeNull();
  });
});

describe("refreshWithRetry diagnostics", () => {
  it("does not reflect an arbitrary refresh error message into logs", async () => {
    const marker = "SENSITIVE_REFRESH_ERROR_BODY";
    const log = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { refreshWithRetry } = await load();

    await expect(refreshWithRetry(
      () => Promise.reject(new Error(marker)),
      1,
      log,
    )).resolves.toBeNull();

    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(marker);
    expect(log.warn).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      "Attempt 1/1 failed: refresh failed",
    );
  });
});

describe("Vertex token refresh hardening", () => {
  it("bounds an upstream that never returns headers", async () => {
    vi.useFakeTimers();
    mockJose();
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const log = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const { refreshVertexToken } = await load();

    const pending = refreshVertexToken(serviceAccount("vertex-timeout"), log);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);

    await expect(pending).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not reflect an upstream error body into logs", async () => {
    mockJose();
    const marker = "SENSITIVE_VERTEX_ASSERTION_MARKER";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: marker,
      assertion: marker,
    }), { status: 400 })));
    const log = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const { refreshVertexToken } = await load();

    await expect(refreshVertexToken(serviceAccount("vertex-redaction"), log)).resolves.toBeNull();

    expect(JSON.stringify(log.error.mock.calls)).not.toContain(marker);
    expect(log.error).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      "Vertex token mint failed",
      { status: 400 },
    );
  });

  it("rejects oversized and tokenless HTTP 200 responses", async () => {
    mockJose();
    const responses = [
      new Response("x".repeat(256 * 1024 + 1), { status: 200 }),
      new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }),
    ];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(responses.shift())));
    const log = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const { refreshVertexToken } = await load();

    await expect(refreshVertexToken(serviceAccount("vertex-oversize"), log)).resolves.toBeNull();
    await expect(refreshVertexToken(serviceAccount("vertex-tokenless"), log)).resolves.toBeNull();
    expect(log.info).not.toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      expect.stringContaining("minted"),
    );
  });
});
