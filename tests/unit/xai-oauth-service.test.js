import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("xai/oauth service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("validates discovered endpoints are https x.ai URLs", async () => {
    const { validateOAuthEndpoint } = await import("../../src/lib/oauth/services/xai.js");

    expect(validateOAuthEndpoint("https://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toBe(
      "https://auth.x.ai/oauth2/authorize"
    );
    expect(() => validateOAuthEndpoint("http://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toThrow(
      /must use https/
    );
    expect(() => validateOAuthEndpoint("https://example.com/oauth2/authorize", "authorization_endpoint")).toThrow(
      /is not on x\.ai/
    );
  });

  it("discovers endpoints without custom user-agent headers", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      }),
    });

    const { discoverEndpoints } = await import("../../src/lib/oauth/services/xai.js");
    await expect(discoverEndpoints()).resolves.toEqual({
      authorizeUrl: "https://auth.x.ai/oauth2/authorize",
      tokenUrl: "https://auth.x.ai/oauth2/token",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.x.ai/.well-known/openid-configuration",
      expect.objectContaining({ headers: { Accept: "application/json" } })
    );
  });

  it("builds authorize URLs with CLIProxyAPI query extras", async () => {
    const { XaiService } = await import("../../src/lib/oauth/services/xai.js");
    const authUrl = new XaiService().buildXaiAuthUrl(
      "http://127.0.0.1:56121/callback",
      "state-1",
      "challenge-1",
      "https://auth.x.ai/oauth2/authorize"
    );
    const parsed = new URL(authUrl);

    expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("state-1");
    expect(parsed.searchParams.get("nonce")).toMatch(/^[a-f0-9]{32}$/);
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("cli-proxy-api");
  });

  it("generates dashboard auth data with CLIProxyAPI PKCE size and discovered endpoints", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize-from-discovery",
        token_endpoint: "https://auth.x.ai/oauth2/token-from-discovery",
      }),
    });

    const { generateAuthData } = await import("../../src/lib/oauth/providers.js");
    const data = await generateAuthData("xai", "http://127.0.0.1:56121/callback");
    const parsed = new URL(data.authUrl);

    expect(data.codeVerifier).toHaveLength(128);
    expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize-from-discovery");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("cli-proxy-api");
  });

  it("exchanges dashboard codes against the discovered xAI token endpoint", async () => {
    const fetchMock = fetch;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
          token_endpoint: "https://auth.x.ai/oauth2/token-from-discovery",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        }),
      });

    const { exchangeTokens } = await import("../../src/lib/oauth/providers.js");
    const tokens = await exchangeTokens(
      "xai",
      "auth-code",
      "http://127.0.0.1:56121/callback",
      "verifier-1",
      "state-1"
    );

    expect(fetchMock.mock.calls[1][0]).toBe("https://auth.x.ai/oauth2/token-from-discovery");
    expect(fetchMock.mock.calls[1][1].body.get("grant_type")).toBe("authorization_code");
    expect(fetchMock.mock.calls[1][1].body.get("code")).toBe("auth-code");
    expect(fetchMock.mock.calls[1][1].body.get("code_verifier")).toBe("verifier-1");
    expect(tokens).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    });
  });

  it("falls back to static discovery when headers never arrive", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { discoverEndpoints } = await import("../../src/lib/oauth/services/xai.js");

    const pending = discoverEndpoints();
    await vi.advanceTimersByTimeAsync(15_001);

    await expect(pending).resolves.toEqual({
      authorizeUrl: "https://auth.x.ai/oauth2/authorize",
      tokenUrl: "https://auth.x.ai/oauth2/token",
    });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("bounds a stalled refresh body without waiting for cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise(() => {}));
    const stalled = new Response(new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      }), { status: 200 }))
      .mockResolvedValueOnce(stalled);
    vi.stubGlobal("fetch", fetchMock);
    const { XaiService } = await import("../../src/lib/oauth/services/xai.js");

    const pending = new XaiService().refreshAccessToken("refresh-token");
    const rejection = expect(pending).rejects.toThrow(/^xAI token refresh failed$/);
    await vi.advanceTimersByTimeAsync(15_001);

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["oversize", new Response("x".repeat(256 * 1024 + 1), { status: 200 })],
    ["invalid UTF-8", new Response(new Uint8Array([0xc3, 0x28]), { status: 200 })],
    ["malformed JSON", new Response('{"access_token":', { status: 200 })],
  ])("rejects a %s xAI refresh response with a generic error", async (_case, tokenResponse) => {
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      }), { status: 200 }))
      .mockResolvedValueOnce(tokenResponse);
    const { XaiService } = await import("../../src/lib/oauth/services/xai.js");

    await expect(new XaiService().refreshAccessToken("refresh-token"))
      .rejects.toThrow(/^xAI token refresh failed$/);
  });

  it("does not echo a reflected OAuth code from dashboard exchange errors", async () => {
    const reflectedSecret = "authorization-code-must-not-escape";
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: reflectedSecret,
    }), { status: 400 }));
    const { default: provider } = await import("../../src/lib/oauth/providers/xai.js");

    let failure;
    try {
      await provider.exchangeToken(
        provider.config,
        reflectedSecret,
        "http://127.0.0.1:56121/callback",
        "verifier",
      );
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toBe("xAI token exchange failed");
    expect(failure?.message).not.toContain(reflectedSecret);
  });
});
