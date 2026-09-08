import { afterEach, describe, expect, it, vi } from "vitest";

import gitlab from "../../src/lib/oauth/providers/gitlab.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function exchangeToken(meta = {}) {
  return gitlab.exchangeToken(
    gitlab.config,
    "authorization-code",
    "http://localhost:20128/callback",
    "pkce-verifier",
    "state",
    {
      baseUrl: "https://gitlab.example/gitlab",
      clientId: "admin-client",
      clientSecret: "admin-secret",
      ...meta,
    },
  );
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("GitLab OAuth origin policy", () => {
  it.each([
    "javascript:alert(document.domain)",
    "ftp://gitlab.example",
    "https://user:password@gitlab.example",
    "https://gitlab.example/root?redirect=javascript:alert(1)",
    "https://gitlab.example/root#javascript:alert(1)",
  ])("rejects unsafe authorize base URL %s before returning a browser URL", (baseUrl) => {
    let error;
    try {
      gitlab.buildAuthUrl(
        gitlab.config,
        "http://localhost:20128/callback",
        "state",
        "challenge",
        { baseUrl, clientId: "admin-client" },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ status: 400 });
    expect(error?.message).toMatch(/GitLab base URL/i);
  });

  it("builds a self-hosted authorize URL only after normalizing its HTTP origin", () => {
    const authUrl = gitlab.buildAuthUrl(
      gitlab.config,
      "http://localhost:20128/callback",
      "state",
      "challenge",
      { baseUrl: "https://gitlab.example/root/", clientId: "admin-client" },
    );

    const parsed = new URL(authUrl);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://gitlab.example/root/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("admin-client");
    expect(parsed.searchParams.get("state")).toBe("state");
  });

  it("preserves explicit self-hosted GitLab for the administrator OAuth flow", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "gitlab-access-token",
        refresh_token: "gitlab-refresh-token",
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse({ username: "admin-approved-user" }));
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await gitlab.exchangeToken(
      gitlab.config,
      "authorization-code",
      "http://localhost:20128/callback",
      "pkce-verifier",
      "state",
      {
        baseUrl: "http://127.0.0.1:8929/gitlab",
        clientId: "admin-client",
        clientSecret: "admin-secret",
      },
    );

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8929/gitlab/oauth/token");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:8929/gitlab/api/v4/user");
    expect(fetchMock.mock.calls[1][1].headers.get("authorization")).toBe("Bearer gitlab-access-token");
    expect(gitlab.mapTokens(tokens).providerSpecificData).toMatchObject({
      baseUrl: "http://127.0.0.1:8929/gitlab",
      clientId: "admin-client",
      username: "admin-approved-user",
    });
  });

  it("rejects a 307 redirect to another origin before forwarding OAuth credentials", async () => {
    const redirectResponse = new Response("discard me", {
      status: 307,
      headers: { location: "https://attacker.example/capture" },
    });
    const cancel = vi.spyOn(redirectResponse.body, "cancel");
    const fetchMock = vi.fn().mockResolvedValue(redirectResponse);
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeToken()).rejects.toThrow(/redirect origin is not approved/i);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://gitlab.example/gitlab/oauth/token");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      redirect: "manual",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an HTTPS to HTTP redirect even when the hostname is unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 307,
      headers: { location: "http://gitlab.example/gitlab/oauth/token" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeToken()).rejects.toThrow(/redirect origin is not approved/i);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("follows bounded same-origin redirects and preserves a 307 POST body", async () => {
    const redirectResponse = new Response("discard me", {
      status: 307,
      headers: { location: "/gitlab/oauth/token-v2" },
    });
    const cancel = vi.spyOn(redirectResponse.body, "cancel");
    const tokenResponse = jsonResponse({ access_token: "access-token", expires_in: 3600 });
    const userResponse = jsonResponse({ username: "same-origin-user" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(userResponse);
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await exchangeToken();

    expect(tokens._user.username).toBe("same-origin-user");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("https://gitlab.example/gitlab/oauth/token-v2");
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
    expect(fetchMock.mock.calls[1][1].body).toContain("code=authorization-code");
    expect(fetchMock.mock.calls[1][1].body).toContain("client_secret=admin-secret");
    expect(cancel).toHaveBeenCalledOnce();
    expect(tokenResponse.body.locked).toBe(false);
    expect(userResponse.body.locked).toBe(false);
  });

  it("does not expose an upstream error body that echoes OAuth credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: "invalid_grant",
      error_description: "code=authorization-code client_secret=admin-secret access_token=echoed",
    }, { status: 400 })));

    let error;
    try {
      await exchangeToken();
    } catch (caught) {
      error = caught;
    }

    expect(error?.message).toBe("GitLab token exchange failed (400)");
    expect(error?.message).not.toMatch(/authorization-code|admin-secret|access_token|echoed/);
  });

  it("converts a same-origin 302 token redirect to GET without retaining the POST body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "/gitlab/oauth/token-v2" },
      }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-token" }))
      .mockResolvedValueOnce(jsonResponse({ username: "same-origin-user" }));
    vi.stubGlobal("fetch", fetchMock);

    await exchangeToken();

    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers.get("content-type")).toBeNull();
  });

  it("stops after the configured same-origin redirect budget", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, {
      status: 307,
      headers: { location: "/gitlab/oauth/token-again" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeToken()).rejects.toThrow(/redirect limit exceeded/i);

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("keeps the timeout active while the final response body is stalled and cancels it", async () => {
    vi.useFakeTimers();
    const readerCancel = vi.fn();
    const bodyCancel = vi.fn();
    let requestSignal;
    const fetchMock = vi.fn(async (_url, init) => {
      requestSignal = init.signal;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        bodyUsed: false,
        body: {
          cancel: bodyCancel,
          getReader: () => ({
            read: () => new Promise(() => {}),
            cancel: readerCancel,
          }),
        },
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = exchangeToken();
    const rejection = expect(resultPromise).rejects.toThrow(/request timeout/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    expect(requestSignal.aborted).toBe(true);
    expect(readerCancel).toHaveBeenCalledOnce();
    expect(bodyCancel).toHaveBeenCalledOnce();
  });

  it("does not call unbounded text/json fallbacks on response-like objects", async () => {
    const text = vi.fn(async () => "secret=" + "x".repeat(2 * 1024 * 1024));
    const json = vi.fn(async () => ({ access_token: "should-not-be-read" }));
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      bodyUsed: false,
      body: { cancel },
      text,
      json,
    }));

    await expect(exchangeToken()).rejects.toThrow(/not stream-readable/i);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops awaiting an abort-ignoring fetch and cancels its late response", async () => {
    vi.useFakeTimers();
    let resolveFetch;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })));

    const resultPromise = exchangeToken();
    const rejection = expect(resultPromise).rejects.toThrow(/request timeout/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    const lateResponse = jsonResponse({ access_token: "late-secret" });
    const cancel = vi.spyOn(lateResponse.body, "cancel");
    resolveFetch(lateResponse);
    await Promise.resolve();
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
  });
});
