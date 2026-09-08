import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(async (data) => ({ id: "connection-1", ...data })),
  completeConnection: vi.fn(async (_id, data) => ({ id: "connection-1", ...data })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));

vi.mock("@/lib/contributor/session", () => ({
  getContributorSession: async () => ({
    invite: { id: "invite-1", sessionId: "session-1", allowedProviders: ["gitlab"], providerBaseUrls: {} },
    payload: { sessionId: "session-1" },
  }),
  isSameOrigin: () => true,
}));

vi.mock("@/lib/contributor/store", () => ({
  cancelContributorInviteReservation: vi.fn(async () => true),
  completeContributorInviteWithConnection: mocks.completeConnection,
  getContributorInvite: vi.fn(async () => null),
  reserveContributorInvite: vi.fn(async () => ({ leaseId: "lease-1" })),
  resumeContributorInviteReservation: vi.fn(async () => ({
    reservation: { sessionId: "session-1", leaseHash: "lease-hash-1" },
  })),
  releaseContributorInviteReservation: vi.fn(async () => true),
  normalizeContributorProviderBaseUrls: (providerBaseUrls, allowedProviders = []) => {
    if (!allowedProviders.includes("gitlab") || !providerBaseUrls?.gitlab) return {};
    const parsed = new URL(providerBaseUrls.gitlab);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid contributor origin");
    return { gitlab: parsed.toString().replace(/\/+$/, "") };
  },
}));

vi.mock("@/models", () => ({ createProviderConnection: mocks.createConnection }));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));
vi.mock("@/lib/oauth/utils/server", () => ({
  startCodexProxy: vi.fn(), stopCodexProxy: vi.fn(), registerCodexSession: vi.fn(), getCodexSessionStatus: vi.fn(), clearCodexSession: vi.fn(),
  startXaiProxy: vi.fn(), stopXaiProxy: vi.fn(), registerXaiSession: vi.fn(), getXaiSessionStatus: vi.fn(), claimXaiSession: vi.fn(), isXaiSessionCurrent: vi.fn(), clearXaiSession: vi.fn(),
  startTraeProxy: vi.fn(), stopTraeProxy: vi.fn(), registerTraeSession: vi.fn(), getTraeSessionStatus: vi.fn(), clearTraeSession: vi.fn(),
  startWindsurfProxy: vi.fn(), stopWindsurfProxy: vi.fn(), registerWindsurfSession: vi.fn(), getWindsurfSessionStatus: vi.fn(), clearWindsurfSession: vi.fn(),
  startZedProxy: vi.fn(), stopZedProxy: vi.fn(), registerZedSession: vi.fn(), getZedSessionStatus: vi.fn(), clearZedSession: vi.fn(),
}));

const { POST } = await import("../../src/app/api/contribute/oauth/[provider]/[action]/route.js");

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.createConnection.mockClear();
  mocks.completeConnection.mockClear();
});

describe("contributor GitLab OAuth SSRF boundary", () => {
  it("never sends an authorization code, client secret, or bearer token to a client-selected host", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "gitlab-access-token", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ username: "contributor" }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://router.example/api/contribute/oauth/gitlab/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "router.example",
        origin: "https://router.example",
      },
      body: JSON.stringify({
        code: "authorization-code",
        redirectUri: "http://localhost:20128/callback",
        codeVerifier: "pkce-verifier",
        state: "state",
        meta: {
          baseUrl: "http://169.254.169.254/latest/meta-data",
          clientId: "contributor-client",
          clientSecret: "contributor-secret",
        },
      }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ provider: "gitlab", action: "exchange" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://gitlab.com/oauth/token");
    expect(fetchMock.mock.calls[0][1].body).toContain("code=authorization-code");
    expect(fetchMock.mock.calls[0][1].body).toContain("client_secret=contributor-secret");
    expect(fetchMock.mock.calls[1][0]).toBe("https://gitlab.com/api/v4/user");
    expect(fetchMock.mock.calls[1][1].headers.get("authorization")).toBe("Bearer gitlab-access-token");
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).hostname === "gitlab.com")).toBe(true);
    expect(mocks.completeConnection).toHaveBeenCalledWith(
      "invite-1",
      expect.objectContaining({
      provider: "gitlab",
      accessToken: "gitlab-access-token",
      providerSpecificData: expect.objectContaining({ baseUrl: "https://gitlab.com" }),
      }),
      { sessionId: "session-1", leaseId: "lease-1" },
    );
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });
});
