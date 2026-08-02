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
}));

vi.mock("@/app/api/oauth/[provider]/[action]/route", () => ({
  GET: mocks.upstreamGet,
  POST: mocks.upstreamPost,
}));

const route = await import("../../src/app/api/contribute/oauth/[provider]/[action]/route.js");

function context(provider, action) {
  return { params: Promise.resolve({ provider, action }) };
}

function request(method = "GET", origin = "https://router.example") {
  return new Request("https://router.example/api/contribute/oauth/claude/authorize", {
    method,
    headers: { host: "router.example", origin },
    ...(method === "POST" ? { body: "{}" } : {}),
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
});
