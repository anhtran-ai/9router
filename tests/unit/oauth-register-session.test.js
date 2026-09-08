import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  exchangeTokens: vi.fn(),
  startCodexProxy: vi.fn(),
  stopCodexProxy: vi.fn(),
  registerCodexSession: vi.fn(),
  getCodexSessionStatus: vi.fn(),
  clearCodexSession: vi.fn(),
  registerTraeSession: vi.fn(() => true),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: mocks.exchangeTokens,
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

vi.mock("@/models", () => ({ createProviderConnection: mocks.createConnection }));

vi.mock("@/lib/oauth/utils/server", () => ({
  startCodexProxy: mocks.startCodexProxy, stopCodexProxy: mocks.stopCodexProxy, registerCodexSession: mocks.registerCodexSession, getCodexSessionStatus: mocks.getCodexSessionStatus, clearCodexSession: mocks.clearCodexSession,
  startXaiProxy: vi.fn(), stopXaiProxy: vi.fn(), registerXaiSession: vi.fn(), getXaiSessionStatus: vi.fn(), clearXaiSession: vi.fn(),
  startTraeProxy: vi.fn(), stopTraeProxy: vi.fn(), registerTraeSession: mocks.registerTraeSession, getTraeSessionStatus: vi.fn(), clearTraeSession: vi.fn(),
  startWindsurfProxy: vi.fn(), stopWindsurfProxy: vi.fn(), registerWindsurfSession: vi.fn(), getWindsurfSessionStatus: vi.fn(), clearWindsurfSession: vi.fn(),
  startZedProxy: vi.fn(), stopZedProxy: vi.fn(), registerZedSession: vi.fn(), getZedSessionStatus: vi.fn(), clearZedSession: vi.fn(),
}));

vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));
vi.mock("@/lib/oauth/constants/oauth", () => ({ ZED_HOSTED_CONFIG: { defaultNativeAppPort: 58443 } }));

const { GET, POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

describe("OAuth proxy session registration", () => {
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
    const request = new Request("https://router.example/api/oauth/codex/start-proxy?app_port=1455");

    const response = await GET(request, {
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
      "https://router.example/api/oauth/codex/start-proxy"
        + "?app_port=1455&state=state-1&code_verifier=verifier-1"
        + "&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    );

    const response = await GET(request, {
      params: Promise.resolve({ provider: "codex", action: "start-proxy" }),
    }, {
      commitProviderConnection: vi.fn(),
      contributorReservationHash: "reservation-hash-1",
    });

    expect(response.status).toBe(409);
    expect(mocks.stopCodexProxy).toHaveBeenCalledOnce();
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
});
