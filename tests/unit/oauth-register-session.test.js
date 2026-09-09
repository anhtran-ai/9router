import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  exchangeTokens: vi.fn(),
  pollForToken: vi.fn(),
  generateAuthData: vi.fn(),
  startCodexProxy: vi.fn(),
  stopCodexProxy: vi.fn(),
  registerCodexSession: vi.fn(),
  getCodexSessionStatus: vi.fn(),
  clearCodexSession: vi.fn(),
  claimXaiSession: vi.fn(),
  isXaiSessionCurrent: vi.fn(),
  registerTraeSession: vi.fn(() => true),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: mocks.generateAuthData,
  exchangeTokens: mocks.exchangeTokens,
  requestDeviceCode: vi.fn(),
  pollForToken: mocks.pollForToken,
}));

vi.mock("@/models", () => ({ createProviderConnection: mocks.createConnection }));

vi.mock("@/lib/oauth/utils/server", () => ({
  startCodexProxy: mocks.startCodexProxy, stopCodexProxy: mocks.stopCodexProxy, registerCodexSession: mocks.registerCodexSession, getCodexSessionStatus: mocks.getCodexSessionStatus, clearCodexSession: mocks.clearCodexSession,
  startXaiProxy: vi.fn(), stopXaiProxy: vi.fn(), registerXaiSession: vi.fn(), getXaiSessionStatus: vi.fn(), claimXaiSession: mocks.claimXaiSession, isXaiSessionCurrent: mocks.isXaiSessionCurrent, clearXaiSession: vi.fn(),
  startTraeProxy: vi.fn(), stopTraeProxy: vi.fn(), registerTraeSession: mocks.registerTraeSession, getTraeSessionStatus: vi.fn(), clearTraeSession: vi.fn(),
  startWindsurfProxy: vi.fn(), stopWindsurfProxy: vi.fn(), registerWindsurfSession: vi.fn(), getWindsurfSessionStatus: vi.fn(), clearWindsurfSession: vi.fn(),
  startZedProxy: vi.fn(), stopZedProxy: vi.fn(), registerZedSession: vi.fn(), getZedSessionStatus: vi.fn(), clearZedSession: vi.fn(),
}));

vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));
vi.mock("@/lib/oauth/constants/oauth", () => ({ ZED_HOSTED_CONFIG: { defaultNativeAppPort: 58443 } }));

const { GET, POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

describe("OAuth proxy session registration", () => {
  it("returns a client error when authorize metadata validation rejects the request", async () => {
    const validationError = Object.assign(new Error("GitLab base URL must use HTTP or HTTPS"), {
      status: 400,
    });
    mocks.generateAuthData.mockRejectedValueOnce(validationError);

    const response = await GET(
      new Request("https://router.example/api/oauth/gitlab/authorize?baseUrl=javascript%3Aalert(1)"),
      { params: Promise.resolve({ provider: "gitlab", action: "authorize" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: validationError.message });
  });

  it("rejects OAuth client secrets in authorize query URLs", async () => {
    const response = await GET(
      new Request("https://router.example/api/oauth/gitlab/authorize?clientId=public&clientSecret=private"),
      { params: Promise.resolve({ provider: "gitlab", action: "authorize" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "OAuth client secrets are not accepted in authorize URLs",
    });
  });

  it("reads state from the POST body and registers the proxy session", async () => {
    const request = new Request("https://router.example/api/oauth/trae/register-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "state-1" }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ provider: "trae", action: "register-session" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.registerTraeSession).toHaveBeenCalledWith({ state: "state-1" });
  });

  it("attaches the internal contributor commit hook to a proxy session", async () => {
    const commitProviderConnection = vi.fn();
    const contributorReservationHash = "reservation-hash-1";
    const request = new Request("https://router.example/api/oauth/trae/register-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "state-contributor" }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ provider: "trae", action: "register-session" }),
    }, { commitProviderConnection, contributorReservationHash });

    expect(response.status).toBe(200);
    expect(mocks.registerTraeSession).toHaveBeenLastCalledWith({
      state: "state-contributor",
      commitProviderConnection,
      contributorReservationHash,
    });
  });

  it("uses the internal atomic commit hook instead of normal OAuth persistence", async () => {
    const tokenData = { accessToken: "contributor-token", email: "contributor@example.test" };
    const connection = { id: "atomic-connection", provider: "claude", ...tokenData };
    mocks.exchangeTokens.mockResolvedValueOnce(tokenData);
    const commitProviderConnection = vi.fn(async () => connection);
    const request = new Request("https://router.example/api/oauth/claude/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "authorization-code",
        redirectUri: "https://router.example/callback",
        codeVerifier: "pkce-verifier",
        state: "state-direct",
      }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ provider: "claude", action: "exchange" }),
    }, { commitProviderConnection });

    expect(response.status).toBe(200);
    expect(commitProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      authType: "oauth",
      accessToken: "contributor-token",
    }));
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });

  it("does not start a contributor Codex proxy without atomic session parameters", async () => {
    mocks.startCodexProxy.mockClear();
    const request = new Request("https://router.example/api/oauth/codex/start-proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appPort: 1455 }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ provider: "codex", action: "start-proxy" }),
    }, {
      commitProviderConnection: vi.fn(),
      contributorReservationHash: "reservation-hash-1",
    });

    expect(response.status).toBe(400);
    expect(mocks.startCodexProxy).not.toHaveBeenCalled();
  });

  it("stops a started contributor proxy when server-side registration fails", async () => {
    mocks.startCodexProxy.mockResolvedValueOnce({ success: true, port: 1455 });
    mocks.registerCodexSession.mockReturnValueOnce(false);
    mocks.stopCodexProxy.mockClear();
    const request = new Request(
      "https://router.example/api/oauth/codex/start-proxy",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appPort: 1455,
          state: "state-1",
          codeVerifier: "verifier-1",
          redirectUri: "http://localhost:1455/auth/callback",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ provider: "codex", action: "start-proxy" }),
    }, {
      commitProviderConnection: vi.fn(),
      contributorReservationHash: "reservation-hash-1",
    });

    expect(response.status).toBe(409);
    expect(mocks.stopCodexProxy).toHaveBeenCalledWith("reservation-hash-1");
  });

  it("rejects OAuth session material in a start-proxy query URL", async () => {
    mocks.startCodexProxy.mockClear();
    const response = await GET(
      new Request(
        "https://router.example/api/oauth/codex/start-proxy"
          + "?app_port=1455&state=secret-state&code_verifier=secret-verifier",
      ),
      { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.startCodexProxy).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "OAuth state, verifier, and tokens are not accepted in start-proxy URLs",
    });
  });

  it("rejects OAuth session material in a POST start-proxy query URL", async () => {
    mocks.startCodexProxy.mockClear();
    const response = await POST(
      new Request(
        "https://router.example/api/oauth/codex/start-proxy?codeVerifier=logged-secret",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appPort: 1455 }),
        },
      ),
      { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.startCodexProxy).not.toHaveBeenCalled();
  });

  it("caps normal OAuth POST bodies before parsing or starting a proxy", async () => {
    mocks.startCodexProxy.mockClear();
    const cancel = vi.fn();
    const requestBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array((1024 * 1024) + 1));
      },
      cancel,
    });
    const response = await POST(
      new Request("https://router.example/api/oauth/codex/start-proxy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        duplex: "half",
      }),
      { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) },
    );

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(requestBody.locked).toBe(false);
    expect(mocks.startCodexProxy).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 in a normal OAuth JSON body", async () => {
    mocks.startCodexProxy.mockClear();
    const response = await POST(
      new Request("https://router.example/api/oauth/codex/start-proxy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array([0xc3, 0x28]),
      }),
      { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.startCodexProxy).not.toHaveBeenCalled();
  });

  it("starts and registers a fixed proxy from a JSON body", async () => {
    mocks.startCodexProxy.mockReset().mockResolvedValueOnce({ success: true, port: 1455 });
    mocks.registerCodexSession.mockReset().mockReturnValueOnce(true);
    const commitProviderConnection = vi.fn();
    const request = new Request("https://router.example/api/oauth/codex/start-proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appPort: 3210,
        state: "body-state",
        codeVerifier: "body-verifier",
        redirectUri: "http://localhost:1455/auth/callback",
      }),
    });

    const response = await POST(
      request,
      { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) },
      {
        commitProviderConnection,
        contributorReservationHash: "body-reservation",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, serverSide: true });
    expect(mocks.startCodexProxy).toHaveBeenCalledWith(3210, "body-reservation");
    expect(mocks.registerCodexSession).toHaveBeenCalledWith({
      state: "body-state",
      codeVerifier: "body-verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      commitProviderConnection,
      contributorReservationHash: "body-reservation",
    });
  });

  it.each([0, 65536, "not-a-port"])("rejects invalid fixed proxy app port %s", async (appPort) => {
    mocks.startCodexProxy.mockClear();
    const response = await POST(
      new Request("https://router.example/api/oauth/codex/start-proxy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appPort }),
      }),
      { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.startCodexProxy).not.toHaveBeenCalled();
  });

  it("rejects state in a register-session URL", async () => {
    mocks.registerTraeSession.mockClear();
    const response = await POST(
      new Request("https://router.example/api/oauth/trae/register-session?state=query-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ provider: "trae", action: "register-session" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.registerTraeSession).not.toHaveBeenCalled();
  });

  it("claims an xAI manual-code session once before awaiting token exchange", async () => {
    let resolveExchange;
    let markExchangeStarted;
    const exchangeStarted = new Promise((resolve) => { markExchangeStarted = resolve; });
    const session = {
      state: "manual-state",
      redirectUri: "http://127.0.0.1:56121/callback",
      codeVerifier: "manual-verifier",
    };
    mocks.claimXaiSession.mockReset()
      .mockReturnValueOnce(session)
      .mockReturnValueOnce(null);
    mocks.isXaiSessionCurrent.mockReset().mockReturnValue(true);
    mocks.exchangeTokens.mockReset().mockImplementationOnce(async () => {
      markExchangeStarted();
      return new Promise((resolve) => { resolveExchange = resolve; });
    });
    mocks.createConnection.mockReset().mockResolvedValueOnce({
      id: "manual-connection",
      provider: "xai",
      email: "manual@example.test",
    });
    const makeRequest = () => new Request("https://router.example/api/oauth/xai/manual-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "manual-code", state: "manual-state" }),
    });
    const context = { params: Promise.resolve({ provider: "xai", action: "manual-code" }) };

    const first = POST(makeRequest(), context);
    await exchangeStarted;
    const duplicate = await POST(makeRequest(), context);

    expect(duplicate.status).toBe(409);
    expect(mocks.exchangeTokens).toHaveBeenCalledOnce();

    resolveExchange({
      accessToken: "manual-access",
      refreshToken: "manual-refresh",
      email: "manual@example.test",
    });
    const completed = await first;
    expect(completed.status).toBe(200);
    expect(mocks.createConnection).toHaveBeenCalledOnce();
  });

  it("whitelists terminal proxy status fields", async () => {
    mocks.getCodexSessionStatus.mockReturnValueOnce({
      status: "done",
      connectionId: "connection-1",
      email: "person@example.test",
      state: "secret-state",
      codeVerifier: "secret-verifier",
      commitProviderConnection: vi.fn(),
    });
    const response = await GET(
      new Request("https://router.example/api/oauth/codex/poll-status?state=secret-state"),
      { params: Promise.resolve({ provider: "codex", action: "poll-status" }) },
    );

    expect(await response.json()).toEqual({
      status: "done",
      connectionId: "connection-1",
      email: "person@example.test",
    });
    expect(mocks.clearCodexSession).toHaveBeenCalledWith("secret-state");
  });

  it("does not expose or clear a proxy session owned by another contributor reservation", async () => {
    mocks.getCodexSessionStatus.mockReturnValueOnce({
      status: "done",
      connectionId: "connection-other",
      contributorReservationHash: "other-reservation-hash",
    });
    mocks.clearCodexSession.mockClear();

    const response = await GET(
      new Request("https://router.example/api/oauth/codex/poll-status?state=state-other"),
      { params: Promise.resolve({ provider: "codex", action: "poll-status" }) },
      { contributorReservationHash: "request-reservation-hash" },
    );

    expect(response.status).toBe(409);
    expect(mocks.clearCodexSession).not.toHaveBeenCalled();
  });

  it("does not return or log raw provider exceptions from an OAuth exchange", async () => {
    const reflectedSecret = "client_secret=exchange-secret authorization_code=secret-code";
    mocks.exchangeTokens.mockReset().mockRejectedValueOnce(new Error(reflectedSecret));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await POST(
        new Request("https://router.example/api/oauth/claude/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: "secret-code",
            redirectUri: "https://router.example/callback",
            codeVerifier: "secret-verifier",
            state: "secret-state",
          }),
        }),
        { params: Promise.resolve({ provider: "claude", action: "exchange" }) },
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "OAuth request failed" });
      expect(JSON.stringify(log.mock.calls)).not.toContain(reflectedSecret);
    } finally {
      log.mockRestore();
    }
  });

  it("maps device-poll error payloads to fixed public values", async () => {
    const reflectedSecret = "device_code=device-secret client_secret=poll-secret";
    mocks.pollForToken.mockReset().mockResolvedValueOnce({
      success: false,
      error: reflectedSecret,
      errorDescription: reflectedSecret,
    });
    const response = await POST(
      new Request("https://router.example/api/oauth/github/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: "device-secret" }),
      }),
      { params: Promise.resolve({ provider: "github", action: "poll" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: "oauth_poll_failed",
      errorDescription: "OAuth token polling failed",
      pending: false,
    });
    expect(JSON.stringify(body)).not.toContain(reflectedSecret);
  });
});
