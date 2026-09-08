import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: null,
  cancel: vi.fn(),
  complete: vi.fn(),
  reserve: vi.fn(),
  resume: vi.fn(),
  release: vi.fn(),
  upstreamGet: vi.fn(),
  upstreamPost: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));

vi.mock("@/lib/contributor/session", () => ({
  getContributorSession: async () => mocks.session,
  isSameOrigin: (request) => {
    if (request.headers.get("sec-fetch-site") === "cross-site") return false;
    const origin = request.headers.get("origin");
    return !origin || new URL(origin).host === request.headers.get("host");
  },
}));

vi.mock("@/lib/contributor/store", () => ({
  cancelContributorInviteReservation: mocks.cancel,
  completeContributorInviteWithConnection: mocks.complete,
  getContributorInvite: async () => mocks.session?.invite || null,
  reserveContributorInvite: mocks.reserve,
  resumeContributorInviteReservation: mocks.resume,
  releaseContributorInviteReservation: mocks.release,
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
  const headers = { host: "router.example" };
  if (origin) headers.origin = origin;
  if (options.fetchSite) headers["sec-fetch-site"] = options.fetchSite;
  return new Request(url, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(options.body || {}) } : {}),
  });
}

describe("contributor OAuth guard", () => {
  beforeEach(() => {
    mocks.session = {
      invite: {
        id: "invite-1",
        sessionId: "session-1",
        status: "active",
        allowedProviders: ["claude", "trae"],
      },
      payload: { sessionId: "session-1" },
    };
    mocks.cancel.mockReset().mockResolvedValue(true);
    mocks.complete.mockReset().mockImplementation(async (_id, data) => ({
      id: "connection-1",
      ...data,
    }));
    mocks.reserve.mockReset().mockResolvedValue({
      leaseId: "lease-1",
      invite: { completionLeaseHash: "lease-hash-1" },
    });
    mocks.resume.mockReset().mockResolvedValue({
      reservation: { sessionId: "session-1", leaseHash: "lease-hash-1" },
    });
    mocks.release.mockReset().mockResolvedValue(true);
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

  it("atomically commits the connection through the reserved invite hook", async () => {
    const connectionData = {
      provider: "claude",
      authType: "oauth",
      accessToken: "fixture-token",
    };
    mocks.upstreamPost.mockImplementation(async (_request, _context, internalOptions) => {
      const connection = await internalOptions.commitProviderConnection(connectionData);
      return Response.json({ success: true, connection });
    });

    const response = await route.POST(request("POST"), context("claude", "exchange"));

    expect(response.status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledWith(
      "invite-1",
      connectionData,
      { sessionId: "session-1", leaseId: "lease-1" },
    );
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("rejects cross-site GET OAuth actions even when Origin is omitted", async () => {
    const response = await route.GET(
      request("GET", "", { action: "start-proxy", fetchSite: "cross-site" }),
      context("claude", "start-proxy"),
    );
    expect(response.status).toBe(403);
    expect(mocks.upstreamGet).not.toHaveBeenCalled();
  });

  it("allows direct same-site GET navigation when Origin is omitted", async () => {
    const response = await route.GET(
      request("GET", "", { action: "authorize", fetchSite: "none" }),
      context("claude", "authorize"),
    );
    expect(response.status).toBe(200);
    expect(mocks.upstreamGet).toHaveBeenCalledOnce();
  });

  it("reserves before OAuth side effects and rejects a concurrent completion", async () => {
    let leaseHeld = false;
    mocks.reserve.mockImplementation(async () => {
      if (leaseHeld) return null;
      leaseHeld = true;
      return { leaseId: "lease-concurrent" };
    });
    let releaseUpstream;
    let markUpstreamStarted;
    const upstreamStarted = new Promise((resolve) => { markUpstreamStarted = resolve; });
    mocks.upstreamPost.mockImplementationOnce(async (_request, _context, internalOptions) => {
      markUpstreamStarted();
      await new Promise((resolve) => { releaseUpstream = resolve; });
      const connection = await internalOptions.commitProviderConnection({
        provider: "claude",
        authType: "oauth",
        accessToken: "fixture-token",
      });
      return Response.json({ success: true, connection });
    });

    const first = route.POST(request("POST"), context("claude", "exchange"));
    await upstreamStarted;
    const second = await route.POST(request("POST"), context("claude", "exchange"));

    expect(second.status).toBe(409);
    expect(mocks.upstreamPost).toHaveBeenCalledTimes(1);
    releaseUpstream();
    expect((await first).status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledWith(
      "invite-1",
      expect.objectContaining({ provider: "claude", accessToken: "fixture-token" }),
      { sessionId: "session-1", leaseId: "lease-concurrent" },
    );
  });

  it("conditionally releases the reservation when OAuth does not complete", async () => {
    mocks.upstreamPost.mockResolvedValue(Response.json({
      success: false,
      pending: true,
      error: "authorization_pending",
    }));

    const response = await route.POST(request("POST"), context("claude", "poll"));

    expect(response.status).toBe(200);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(
      "invite-1",
      { sessionId: "session-1", leaseId: "lease-1" },
    );
  });

  it("rejects a malformed HTTP-success completion response", async () => {
    mocks.upstreamPost.mockResolvedValueOnce(Response.json({ connection: null }));

    const response = await route.POST(request("POST"), context("claude", "exchange"));

    expect(response.status).toBe(502);
    expect(mocks.release).toHaveBeenCalledWith(
      "invite-1",
      { sessionId: "session-1", leaseId: "lease-1" },
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("reuses the existing xAI proxy lease for manual-code completion", async () => {
    mocks.session.invite.allowedProviders.push("xai");
    mocks.session.invite.status = "completing";
    mocks.upstreamPost.mockImplementationOnce(async (_request, _context, internalOptions) => {
      const connection = await internalOptions.commitProviderConnection({
        provider: "xai",
        authType: "oauth",
        accessToken: "xai-token",
      });
      return Response.json({ success: true, connection });
    });

    const response = await route.POST(
      request("POST", "https://router.example", { action: "manual-code", provider: "xai" }),
      context("xai", "manual-code"),
    );

    expect(response.status).toBe(200);
    expect(mocks.resume).toHaveBeenCalledWith("invite-1", "session-1");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(
      "invite-1",
      expect.objectContaining({ provider: "xai", accessToken: "xai-token" }),
      { sessionId: "session-1", leaseHash: "lease-hash-1" },
    );
  });

  it("reuses and retains a proxy lease for a Trae manual exchange fallback", async () => {
    mocks.session.invite.status = "completing";
    mocks.upstreamPost.mockResolvedValueOnce(
      Response.json({ error: "invalid pasted callback" }, { status: 400 }),
    );

    const response = await route.POST(
      request("POST", "https://router.example", { action: "exchange", provider: "trae" }),
      context("trae", "exchange"),
    );

    expect(response.status).toBe(400);
    expect(mocks.resume).toHaveBeenCalledWith("invite-1", "session-1");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("reserves before starting a callback proxy and keeps the lease after success", async () => {
    let reserved = false;
    mocks.reserve.mockImplementationOnce(async () => {
      reserved = true;
      return { leaseId: "proxy-lease" };
    });
    mocks.upstreamGet.mockImplementationOnce(async () => {
      expect(reserved).toBe(true);
      return Response.json({ success: true, port: 20128 });
    });

    const response = await route.GET(
      request("GET", "https://router.example", { action: "start-proxy" }),
      context("claude", "start-proxy"),
    );

    expect(response.status).toBe(200);
    expect(mocks.reserve).toHaveBeenCalledWith("invite-1", "session-1");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("terminally rejects an ambiguous successful proxy start", async () => {
    mocks.upstreamGet.mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    const response = await route.GET(
      request("GET", "https://router.example", { action: "start-proxy" }),
      context("claude", "start-proxy"),
    );

    expect(response.status).toBe(502);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalledWith(
      "invite-1",
      { sessionId: "session-1", leaseId: "lease-1" },
    );
  });

  it("rejects a fixed-port contributor proxy without server-side registration", async () => {
    mocks.session.invite.allowedProviders.push("codex");
    mocks.upstreamGet.mockResolvedValueOnce(Response.json({
      success: true,
      port: 1455,
      serverSide: false,
    }));

    const response = await route.GET(
      request("GET", "https://router.example", { action: "start-proxy", provider: "codex" }),
      context("codex", "start-proxy"),
    );

    expect(response.status).toBe(409);
    expect(mocks.cancel).toHaveBeenCalledWith(
      "invite-1",
      { sessionId: "session-1", leaseId: "lease-1" },
    );
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("keeps a pending proxy lease, then lets the used owner observe done", async () => {
    mocks.session.invite.status = "completing";
    mocks.upstreamGet.mockResolvedValueOnce(Response.json({ status: "pending" }));

    const pending = await route.GET(
      request("GET", "https://router.example", { action: "poll-status" }),
      context("claude", "poll-status"),
    );

    expect(pending.status).toBe(200);
    expect(mocks.resume).toHaveBeenCalledWith("invite-1", "session-1");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();

    // The local callback has already atomically committed the connection and
    // invite before the browser's next poll.
    mocks.session.invite.status = "used";
    mocks.session.invite.connection = {
      id: "proxy-connection",
      provider: "claude",
    };
    mocks.upstreamGet.mockResolvedValueOnce(Response.json({
      status: "done",
      connection: { id: "proxy-connection", provider: "claude" },
    }));
    const done = await route.GET(
      request("GET", "https://router.example", { action: "poll-status" }),
      context("claude", "poll-status"),
    );

    expect(done.status).toBe(200);
    expect(mocks.resume).toHaveBeenCalledTimes(1);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("returns done when the callback commits during an in-flight poll", async () => {
    mocks.session.invite.status = "completing";
    mocks.upstreamGet.mockImplementationOnce(async () => {
      // The proxy callback commits after this request was authorized but
      // before the generic poll route consumes its terminal session result.
      mocks.session.invite.status = "used";
      mocks.session.invite.connection = { id: "proxy-race", provider: "claude" };
      mocks.session.invite.completionObservationHash = "lease-hash-1";
      return Response.json({
        status: "done",
        connectionId: "proxy-race",
      });
    });

    const response = await route.GET(
      request("GET", "https://router.example", { action: "poll-status" }),
      context("claude", "poll-status"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "done", connectionId: "proxy-race" });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("keeps an unknown proxy poll fail-closed until stop or revoke", async () => {
    mocks.session.invite.status = "completing";
    mocks.upstreamGet.mockResolvedValueOnce(Response.json({ status: "unknown" }));

    const response = await route.GET(
      request("GET", "https://router.example", { action: "poll-status" }),
      context("claude", "poll-status"),
    );

    expect(response.status).toBe(200);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("terminally cancels the same proxy lease after a successful stop", async () => {
    mocks.session.invite.status = "completing";
    mocks.upstreamGet.mockResolvedValueOnce(Response.json({ success: true }));

    const response = await route.GET(
      request("GET", "https://router.example", { action: "stop-proxy" }),
      context("claude", "stop-proxy"),
    );

    expect(response.status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith(
      "invite-1",
      { sessionId: "session-1", leaseHash: "lease-hash-1" },
    );
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("does not let an active invite stop a proxy it never reserved", async () => {
    mocks.resume.mockResolvedValueOnce(null);

    const response = await route.GET(
      request("GET", "https://router.example", { action: "stop-proxy" }),
      context("claude", "stop-proxy"),
    );

    expect(response.status).toBe(409);
    expect(mocks.upstreamGet).not.toHaveBeenCalled();
  });

  it("allows only poll/stop observation for the owning provider after atomic use", async () => {
    mocks.session.invite.status = "used";
    mocks.session.invite.connection = {
      id: "created-connection",
      provider: "claude",
      email: "created@example.test",
    };
    mocks.session.invite.completionObservationHash = "lease-hash-1";

    const pollResponse = await route.GET(
      request("GET", "https://router.example", { action: "poll-status" }),
      context("claude", "poll-status"),
    );
    const stop = await route.GET(
      request("GET", "https://router.example", { action: "stop-proxy" }),
      context("claude", "stop-proxy"),
    );
    const duplicate = await route.POST(
      request("POST", "https://router.example", { action: "exchange" }),
      context("claude", "exchange"),
    );

    expect(stop.status).toBe(200);
    expect(pollResponse.status).toBe(200);
    expect(await pollResponse.json()).toEqual({
      status: "done",
      connectionId: "created-connection",
      email: "created@example.test",
    });
    expect(duplicate.status).toBe(409);
    expect(mocks.upstreamPost).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.upstreamGet).not.toHaveBeenCalled();
  });

  it("releases the exact reservation when the upstream OAuth action throws", async () => {
    const failure = new Error("fixture upstream failure");
    mocks.upstreamPost.mockRejectedValue(failure);

    await expect(route.POST(request("POST"), context("claude", "exchange"))).rejects.toBe(failure);
    expect(mocks.release).toHaveBeenCalledWith(
      "invite-1",
      { sessionId: "session-1", leaseId: "lease-1" },
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("terminally cancels an ambiguous proxy-start exception", async () => {
    const failure = new Error("fixture proxy start failure");
    mocks.upstreamGet.mockRejectedValueOnce(failure);

    await expect(route.GET(
      request("GET", "https://router.example", { action: "start-proxy" }),
      context("claude", "start-proxy"),
    )).rejects.toBe(failure);
    expect(mocks.cancel).toHaveBeenCalledWith(
      "invite-1",
      { sessionId: "session-1", leaseId: "lease-1" },
    );
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("releases the reservation after an atomic transaction failure", async () => {
    const failure = new Error("fixture atomic transaction failure");
    mocks.complete.mockRejectedValue(failure);
    mocks.upstreamPost.mockImplementation(async (_request, _context, internalOptions) => {
      await internalOptions.commitProviderConnection({
        provider: "claude",
        authType: "oauth",
        accessToken: "fixture-token",
      });
      return Response.json({ success: true });
    });

    await expect(route.POST(request("POST"), context("claude", "exchange"))).rejects.toBe(failure);
    expect(mocks.release).toHaveBeenCalledWith(
      "invite-1",
      { sessionId: "session-1", leaseId: "lease-1" },
    );
  });

  it("returns conflict without a persistence side effect when revocation wins", async () => {
    mocks.complete.mockResolvedValue(null);
    mocks.upstreamPost.mockImplementation(async (_request, _context, internalOptions) => {
      const connection = await internalOptions.commitProviderConnection({
        provider: "claude",
        authType: "oauth",
        accessToken: "must-not-persist",
      });
      return connection
        ? Response.json({ success: true, connection })
        : Response.json({ error: "Contribution reservation is no longer valid" }, { status: 409 });
    });

    const response = await route.POST(request("POST"), context("claude", "exchange"));

    expect(response.status).toBe(409);
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith(
      "invite-1",
      { sessionId: "session-1", leaseId: "lease-1" },
    );
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

  it("rejects a chunked GitLab exchange body over the limit and releases its reader", async () => {
    mocks.session.invite.allowedProviders = ["gitlab"];
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array((1024 * 1024) + 1));
      },
      cancel,
    });
    const oversizedRequest = new Request(
      "https://router.example/api/contribute/oauth/gitlab/exchange",
      {
        method: "POST",
        headers: {
          host: "router.example",
          origin: "https://router.example",
          "content-type": "application/json",
        },
        body,
        duplex: "half",
      },
    );

    const response = await route.POST(oversizedRequest, context("gitlab", "exchange"));

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(mocks.upstreamPost).not.toHaveBeenCalled();
  });

  it.each([
    ["claude", "exchange"],
    ["claude", "poll"],
    ["claude", "manual-code"],
    ["trae", "register-session"],
  ])("bounds contributor POST bodies before reservation/upstream for %s/%s", async (provider, action) => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array((1024 * 1024) + 1));
      },
      cancel,
    });
    const oversizedRequest = new Request(
      `https://router.example/api/contribute/oauth/${provider}/${action}`,
      {
        method: "POST",
        headers: {
          host: "router.example",
          origin: "https://router.example",
          "content-type": "application/json",
        },
        body,
        duplex: "half",
      },
    );

    const response = await route.POST(oversizedRequest, context(provider, action));

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.upstreamPost).not.toHaveBeenCalled();
  });

  it("cancels a stalled GitLab body read when the client disconnects", async () => {
    mocks.session.invite.allowedProviders = ["gitlab"];
    const client = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel,
    });
    const pendingRequest = new Request(
      "https://router.example/api/contribute/oauth/gitlab/exchange",
      {
        method: "POST",
        headers: {
          host: "router.example",
          origin: "https://router.example",
          "content-type": "application/json",
        },
        body,
        duplex: "half",
        signal: client.signal,
      },
    );

    const pending = route.POST(pendingRequest, context("gitlab", "exchange"));
    await vi.waitFor(() => expect(body.locked).toBe(true));
    client.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(body.locked).toBe(false));
    expect(mocks.upstreamPost).not.toHaveBeenCalled();
  });

  it("forwards invalid GitLab JSON from one bounded read without cloning the request", async () => {
    mocks.session.invite.allowedProviders = ["gitlab"];
    mocks.upstreamPost.mockImplementationOnce(async (forwarded) => new Response(
      await forwarded.text(),
      { status: 400 },
    ));
    const invalid = new Request(
      "https://router.example/api/contribute/oauth/gitlab/exchange",
      {
        method: "POST",
        headers: {
          host: "router.example",
          origin: "https://router.example",
          "content-type": "application/json",
        },
        body: "{invalid-json",
      },
    );

    const response = await route.POST(invalid, context("gitlab", "exchange"));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("{invalid-json");
    expect(mocks.upstreamPost).toHaveBeenCalledOnce();
  });

  it("rejects invalid UTF-8 in a GitLab exchange body", async () => {
    mocks.session.invite.allowedProviders = ["gitlab"];
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('{"code":"'),
      0xff,
      ...new TextEncoder().encode('"}'),
    ]);
    const invalid = new Request(
      "https://router.example/api/contribute/oauth/gitlab/exchange",
      {
        method: "POST",
        headers: {
          host: "router.example",
          origin: "https://router.example",
          "content-type": "application/json",
        },
        body: bytes,
      },
    );

    const response = await route.POST(invalid, context("gitlab", "exchange"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid UTF-8 OAuth request body" });
    expect(mocks.upstreamPost).not.toHaveBeenCalled();
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
