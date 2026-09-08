import { afterEach, describe, it, expect, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("../../src/lib/oauth/services/xai.js");
  vi.resetModules();
});

// We can't easily import the open-sse switch logic without real PROVIDERS config,
// so verify the wrapper function shape directly via dynamic import.

describe("xai/token-refresh wrapper", () => {
  it("refreshXaiToken module loads without throwing", async () => {
    // Just verify the file imports cleanly. The actual wrapper is internal.
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    expect(typeof mod.refreshTokenByProvider).toBe("function");
    expect(typeof mod.formatProviderCredentials).toBe("function");
  });

  it("formatProviderCredentials returns Bearer-shape for xai", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const out = mod.formatProviderCredentials(
      "xai",
      { apiKey: "k", accessToken: "t", refreshToken: "r" },
      null
    );
    expect(out).toEqual({ apiKey: "k", accessToken: "t" });
  });

  it("refreshTokenByProvider returns null when refreshToken missing", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const out = await mod.refreshTokenByProvider("xai", { refreshToken: "" }, null);
    expect(out).toBeNull();
  });

  it("refreshTokenByProvider returns expiresIn for refreshed xai tokens", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/oauth/services/xai.js", () => ({
      XaiService: class {
        async refreshAccessToken(refreshToken) {
          return {
            access_token: "new-access",
            refresh_token: `${refreshToken}-rotated`,
            expires_in: 900,
            id_token: "id-token",
          };
        }
      },
    }));

    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const out = await mod.refreshTokenByProvider(
      "xai",
      { refreshToken: "old-refresh" },
      null
    );

    expect(out).toEqual({
      accessToken: "new-access",
      refreshToken: "old-refresh-rotated",
      expiresIn: 900,
      idToken: "id-token",
    });
    expect(out).not.toHaveProperty("expiresAt");

    vi.doUnmock("../../src/lib/oauth/services/xai.js");
    vi.resetModules();
  });

  it("bounds an abort-ignoring xAI refresh service call", async () => {
    vi.useFakeTimers();
    let refreshSignal;
    vi.resetModules();
    vi.doMock("../../src/lib/oauth/services/xai.js", () => ({
      XaiService: class {
        async refreshAccessToken(_refreshToken, options) {
          refreshSignal = options?.signal;
          return new Promise(() => {});
        }
      },
    }));

    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const pending = mod.refreshTokenByProvider("xai", { refreshToken: "stalled-xai" }, null);
    await vi.advanceTimersByTimeAsync(30_001);

    await expect(pending).resolves.toBeNull();
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    expect(refreshSignal.aborted).toBe(true);
  });

  it("rejects an xAI HTTP 200 result without an access token", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/oauth/services/xai.js", () => ({
      XaiService: class {
        async refreshAccessToken() {
          return { expires_in: 900 };
        }
      },
    }));

    const mod = await import("../../open-sse/services/tokenRefresh.js");
    await expect(mod.refreshTokenByProvider(
      "xai",
      { refreshToken: "malformed-xai" },
      null,
    )).resolves.toBeNull();
  });

  it("preserves safe invalid_grant classification without parsing an error message", async () => {
    const reflectedSecret = "SENSITIVE_XAI_REFRESH_ERROR";
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    vi.resetModules();
    vi.doMock("../../src/lib/oauth/services/xai.js", () => ({
      XaiService: class {
        async refreshAccessToken() {
          const error = new Error(reflectedSecret);
          error.oauthCode = "invalid_grant";
          throw error;
        }
      },
    }));

    const mod = await import("../../open-sse/services/tokenRefresh.js");
    await expect(mod.refreshTokenByProvider(
      "xai",
      { refreshToken: "revoked-xai" },
      log,
    )).resolves.toEqual({ error: "invalid_grant" });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(reflectedSecret);
  });
});
