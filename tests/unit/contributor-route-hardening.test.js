import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listInvites: vi.fn(),
  createInvite: vi.fn(),
  revokeInvite: vi.fn(),
  claimToken: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => {
      const response = Response.json(body, init);
      response.cookies = { set: () => {} };
      return response;
    },
  },
}));

vi.mock("@/lib/contributor/store", () => ({
  createContributorInvite: mocks.createInvite,
  listContributorInvites: mocks.listInvites,
  revokeContributorInvite: mocks.revokeInvite,
  claimContributorToken: mocks.claimToken,
}));

vi.mock("@/lib/contributor/session", () => ({
  CONTRIBUTOR_COOKIE: "contributor_session",
  contributorCookieOptions: () => ({}),
  createContributorSession: async () => "signed-token",
  getContributorSession: mocks.getSession,
  isSameOrigin: (request) => {
    if (request.headers.get("sec-fetch-site") === "cross-site") return false;
    const origin = request.headers.get("origin");
    if (!origin) return true;
    return new URL(origin).host === request.headers.get("host");
  },
}));

vi.mock("@/lib/oauth/providers", () => ({ getProviderNames: () => ["claude"] }));
vi.mock("@/lib/auth/oidc", () => ({ getPublicOrigin: () => "https://router.example" }));

const invites = await import("../../src/app/api/contributor-admin/invites/route.js");
const session = await import("../../src/app/api/contribute/session/route.js");

function request(url, { method = "GET", origin, fetchSite, body, headers = {} } = {}) {
  const requestHeaders = { host: "router.example", ...headers };
  if (origin) requestHeaders.origin = origin;
  if (fetchSite) requestHeaders["sec-fetch-site"] = fetchSite;
  return new Request(url, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body }),
  });
}

describe("contributor-admin invite reads", () => {
  beforeEach(() => {
    mocks.listInvites.mockReset().mockResolvedValue([{ id: "invite-1", alias: "alice" }]);
    mocks.createInvite.mockReset();
  });

  it("rejects a cross-site invite listing instead of leaking invites", async () => {
    const response = await invites.GET(request(
      "https://router.example/api/contributor-admin/invites",
      { origin: "https://attacker.example" },
    ));

    expect(response.status).toBe(403);
    expect(mocks.listInvites).not.toHaveBeenCalled();
  });

  it("rejects a cross-site fetch even when Origin is omitted", async () => {
    const response = await invites.GET(request(
      "https://router.example/api/contributor-admin/invites",
      { fetchSite: "cross-site" },
    ));

    expect(response.status).toBe(403);
    expect(mocks.listInvites).not.toHaveBeenCalled();
  });

  it("still serves a same-origin invite listing", async () => {
    const response = await invites.GET(request(
      "https://router.example/api/contributor-admin/invites",
      { origin: "https://router.example" },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      invites: [{ id: "invite-1", alias: "alice" }],
    });
  });

  it("answers a null invite body with 400 rather than a 500", async () => {
    const response = await invites.POST(request(
      "https://router.example/api/contributor-admin/invites",
      { method: "POST", origin: "https://router.example", body: "null" },
    ));

    expect(response.status).toBe(400);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it("does not leak an internal error message on failure", async () => {
    mocks.createInvite.mockRejectedValue(new Error("sqlite: contributor_invites is locked"));

    const response = await invites.POST(request(
      "https://router.example/api/contributor-admin/invites",
      {
        method: "POST",
        origin: "https://router.example",
        body: JSON.stringify({ alias: "alice", allowedProviders: ["claude"] }),
      },
    ));

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error).not.toMatch(/sqlite/i);
  });
});

describe("public contributor session route", () => {
  beforeEach(() => {
    mocks.claimToken.mockReset().mockResolvedValue(null);
    mocks.getSession.mockReset().mockResolvedValue(null);
  });

  it("caps an oversized unauthenticated body before touching the token store", async () => {
    const response = await session.POST(request(
      "https://router.example/api/contribute/session",
      {
        method: "POST",
        origin: "https://router.example",
        body: JSON.stringify({ token: "a".repeat(64 * 1024) }),
      },
    ));

    expect(response.status).toBe(413);
    expect(mocks.claimToken).not.toHaveBeenCalled();
  });

  it("rejects a non-string token with 400 rather than a 500", async () => {
    const response = await session.POST(request(
      "https://router.example/api/contribute/session",
      {
        method: "POST",
        origin: "https://router.example",
        body: JSON.stringify({ token: { nested: true } }),
      },
    ));

    expect(response.status).toBe(400);
    expect(mocks.claimToken).not.toHaveBeenCalled();
  });

  it("rejects a null body with 400 rather than a 500", async () => {
    const response = await session.POST(request(
      "https://router.example/api/contribute/session",
      { method: "POST", origin: "https://router.example", body: "null" },
    ));

    expect(response.status).toBe(400);
    expect(mocks.claimToken).not.toHaveBeenCalled();
  });

  it("still claims a well-formed token", async () => {
    mocks.claimToken.mockResolvedValue({
      id: "invite-1",
      expiresAt: new Date("2030-01-01T00:00:00Z").toISOString(),
    });

    const response = await session.POST(request(
      "https://router.example/api/contribute/session",
      {
        method: "POST",
        origin: "https://router.example",
        body: JSON.stringify({ token: "valid-token" }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.claimToken).toHaveBeenCalledWith("valid-token");
  });
});
