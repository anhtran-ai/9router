import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: null,
  consume: vi.fn(),
  upstreamGet: vi.fn(),
  upstreamPost: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));

vi.mock("@/lib/contributor/session", () => ({
  getContributorSession: async () => mocks.session,
  isSameOrigin: (request) => {
    const origin = request.headers.get("origin");
    return !origin || new URL(origin).host === request.headers.get("host");
  },
}));

vi.mock("@/lib/contributor/store", () => ({
  consumeContributorInvite: mocks.consume,
  normalizeContributorProviderBaseUrls: (providerBaseUrls, allowedProviders = []) => {
    if (!allowedProviders.includes("gitlab") || !providerBaseUrls?.gitlab) return {};
    const parsed = new URL(providerBaseUrls.gitlab);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid contributor origin");
    return { gitlab: parsed.toString().replace(/\/+$/, "") };
  },
}));

vi.mock("@/app/api/oauth/[provider]/[action]/route", () => ({
  GET: mocks.upstreamGet,
  POST: mocks.upstreamPost,
}));

const route = await import("../../src/app/api/contribute/oauth/[provider]/[action]/route.js");

function context(provider, action) {
  return { params: Promise.resolve({ provider, action }) };
}

function request(method = "GET", origin = "https://router.example", options = {}) {
  const provider = options.provider || "claude";
  const action = options.action || (method === "POST" ? "exchange" : "authorize");
  const url = new URL(`https://router.example/api/contribute/oauth/${provider}/${action}`);
  for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, value);
  return new Request(url, {
    method,
    headers: { host: "router.example", origin },
    ...(method === "POST" ? { body: JSON.stringify(options.body || {}) } : {}),
  });
}

describe("contributor OAuth guard", () => {
  beforeEach(() => {
    mocks.session = {
      invite: { id: "invite-1", allowedProviders: ["claude", "trae"] },
    };
    mocks.consume.mockReset();
    mocks.upstreamGet.mockReset().mockResolvedValue(Response.json({ success: true }));
    mocks.upstreamPost.mockReset().mockResolvedValue(Response.json({ success: true }));
  });

  it("rejects requests without a contributor session", async () => {
    mocks.session = null;
    const response = await route.GET(request(), context("claude", "authorize"));
    expect(response.status).toBe(401);
    expect(mocks.upstreamGet).not.toHaveBeenCalled();
  });

  it("rejects providers outside the invite allowlist", async () => {
    const response = await route.GET(request(), context("codex", "authorize"));
    expect(response.status).toBe(403);
    expect(mocks.upstreamGet).not.toHaveBeenCalled();
  });

  it("rejects cross-origin state-changing requests", async () => {
    const response = await route.POST(
      request("POST", "https://attacker.example"),
      context("claude", "exchange"),
    );
    expect(response.status).toBe(403);
    expect(mocks.upstreamPost).not.toHaveBeenCalled();
  });

  it("permits the new proxy registration action only through the guarded wrapper", async () => {
    const response = await route.POST(request("POST"), context("trae", "register-session"));
    expect(response.status).toBe(200);
    expect(mocks.upstreamPost).toHaveBeenCalledOnce();
  });

  it("consumes the invite after a successful credential exchange", async () => {
    mocks.upstreamPost.mockResolvedValue(Response.json({
      success: true,
      connection: { id: "connection-1", provider: "claude" },
    }));
    await route.POST(request("POST"), context("claude", "exchange"));
    expect(mocks.consume).toHaveBeenCalledWith("invite-1", {
      id: "connection-1",
      provider: "claude",
    });
  });

  it("pins contributor GitLab authorization to the server-approved origin", async () => {
    mocks.session.invite.allowedProviders = ["gitlab"];
    await route.GET(
      request("GET", "https://router.example", {
        provider: "gitlab",
        query: {
          baseUrl: "http://169.254.169.254/latest/meta-data",
          clientId: "contributor-client",
        },
      }),
      context("gitlab", "authorize"),
    );

    const forwarded = mocks.upstreamGet.mock.calls[0][0];
    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.searchParams.get("baseUrl")).toBe("https://gitlab.com");
    expect(forwardedUrl.searchParams.get("clientId")).toBe("contributor-client");
  });

  it("replaces an invite-holder GitLab exchange origin before any token-bearing POST", async () => {
    mocks.session.invite.allowedProviders = ["gitlab"];
    await route.POST(
      request("POST", "https://router.example", {
        provider: "gitlab",
        body: {
          code: "authorization-code",
          meta: {
            baseUrl: "http://127.0.0.1:8080/steal",
            clientId: "contributor-client",
            clientSecret: "contributor-secret",
          },
        },
      }),
      context("gitlab", "exchange"),
    );

    const forwarded = mocks.upstreamPost.mock.calls[0][0];
    const forwardedBody = await forwarded.json();
    expect(forwardedBody.meta).toEqual({
      baseUrl: "https://gitlab.com",
      clientId: "contributor-client",
      clientSecret: "contributor-secret",
    });
  });

  it("uses an administrator-approved self-hosted GitLab origin from the invite", async () => {
    mocks.session.invite.allowedProviders = ["gitlab"];
    mocks.session.invite.providerBaseUrls = { gitlab: "http://127.0.0.1:8929/gitlab" };
    await route.POST(
      request("POST", "https://router.example", {
        provider: "gitlab",
        body: { meta: { baseUrl: "https://attacker.example", clientId: "client" } },
      }),
      context("gitlab", "exchange"),
    );

    const forwarded = mocks.upstreamPost.mock.calls[0][0];
    expect((await forwarded.json()).meta.baseUrl).toBe("http://127.0.0.1:8929/gitlab");
  });

  it("fails closed when a stored GitLab origin is not HTTP(S)", async () => {
    mocks.session.invite.allowedProviders = ["gitlab"];
    mocks.session.invite.providerBaseUrls = { gitlab: "file:///etc/passwd" };
    const response = await route.POST(
      request("POST", "https://router.example", {
        provider: "gitlab",
        body: { meta: { baseUrl: "https://attacker.example" } },
      }),
      context("gitlab", "exchange"),
    );

    expect(response.status).toBe(403);
    expect(mocks.upstreamPost).not.toHaveBeenCalled();
  });
});
