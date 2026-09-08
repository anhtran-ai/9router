/**
 * Generic OAuth2 token refresh — config-driven profiles.
 *
 * Verifies refreshAccessToken() handles the 4 foldable providers
 * (iflow, github, kimi, claude) via a REFRESH_PROFILES table,
 * while preserving the legacy generic path for unknown providers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

function mockTraeRefreshConfig() {
  vi.doMock("../../open-sse/config/providers.js", async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      PROVIDER_OAUTH: {
        ...actual.PROVIDER_OAUTH,
        trae: { exchangeTokenUrl: "https://example.test/trae/refresh" },
      },
    };
  });
}

function mockFetchOnce(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
  global.fetch = fn;
  return fn;
}

describe("refreshAccessToken — config-driven profiles", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("iflow: Basic Auth header from clientId:clientSecret, form body keeps client_secret", async () => {
    const fm = mockFetchOnce({ access_token: "if-acc", refresh_token: "if-rot", expires_in: 3600 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await refreshAccessToken("iflow", "if-old", {}, console);

    const [, init] = fm.mock.calls[0];
    expect(init.headers["Authorization"]).toMatch(/^Basic /);
    const body = new URLSearchParams(init.body);
    expect(body.get("client_id")).toBeTruthy();
    expect(body.get("client_secret")).toBeTruthy();
  });

  it("github: omits client_secret when config has none", async () => {
    const fm = mockFetchOnce({ access_token: "gh-acc", expires_in: 28800 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const out = await refreshAccessToken("github", "gh-old", {}, console);

    const body = new URLSearchParams(fm.mock.calls[0][1].body);
    expect(body.get("client_secret")).toBeNull();
    expect(out.accessToken).toBe("gh-acc");
    expect(out.refreshToken).toBe("gh-old");
  });

  it("kimi: merges X-Msh-* headers from credentials.providerSpecificData.deviceId", async () => {
    const fm = mockFetchOnce({ access_token: "km-acc", expires_in: 86400 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await refreshAccessToken("kimi", "km-old", {
      providerSpecificData: { deviceId: "dev-xyz" },
    }, console);

    const headers = fm.mock.calls[0][1].headers;
    // Kimi's buildKimiHeaders must contribute at least one X-Msh- header
    const mshKeys = Object.keys(headers).filter((k) => k.toLowerCase().startsWith("x-msh-"));
    expect(mshKeys.length).toBeGreaterThan(0);
  });

  it("claude: JSON body, client_id only (no client_secret)", async () => {
    const fm = mockFetchOnce({ access_token: "cl-acc", refresh_token: "cl-rot", expires_in: 3600 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await refreshAccessToken("claude", "cl-old", {}, console);

    const [, init] = fm.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(init.body);
    expect(parsed.grant_type).toBe("refresh_token");
    expect(parsed.client_id).toBeTruthy();
    expect(parsed).not.toHaveProperty("client_secret");
  });

  it("returns null on non-ok response", async () => {
    mockFetchOnce({ error: "invalid_grant" }, { ok: false, status: 400 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const out = await refreshAccessToken("iflow", "dead", {}, console);
    expect(out).toBeNull();
  });

  it("returns null when refreshToken missing", async () => {
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const out = await refreshAccessToken("iflow", "", {}, console);
    expect(out).toBeNull();
  });

  it("dedupes concurrent calls with same refresh token (same dedupKey)", async () => {
    const fm = mockFetchOnce({ access_token: "dd-acc", expires_in: 3600 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const creds = { providerSpecificData: { deviceId: "d" } };
    await Promise.all([
      refreshAccessToken("kimi", "dup-refresh", creds, console),
      refreshAccessToken("kimi", "dup-refresh", creds, console),
    ]);
    expect(fm).toHaveBeenCalledTimes(1);
  });
});
describe("Cline refresh", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("uses the extension JSON refresh contract", async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const fm = mockFetchOnce({
      data: {
        accessToken: "cline-acc",
        refreshToken: "cline-rot",
        expiresAt,
      },
    });
    const { refreshTokenByProvider } = await import(
      "open-sse/services/tokenRefresh.js"
    );

    const out = await refreshTokenByProvider(
      "cline",
      { refreshToken: "cline-old" },
      console
    );

    const [, init] = fm.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      refreshToken: "cline-old",
      grantType: "refresh_token",
      clientType: "extension",
    });
    expect(out.accessToken).toBe("cline-acc");
    expect(out.refreshToken).toBe("cline-rot");
    expect(out.expiresIn).toBeGreaterThan(0);
  });
});

describe("token refresh response hardening", () => {
  const log = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("../../open-sse/config/providers.js");
    global.fetch = originalFetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("../../open-sse/config/providers.js");
    global.fetch = originalFetch;
  });

  it("stops waiting when the upstream never returns headers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise(() => {}));
    global.fetch = fetchMock;
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const pending = refreshAccessToken("iflow", "stalled-headers", {}, log);
    await vi.advanceTimersByTimeAsync(30_001);

    await expect(pending).resolves.toBeNull();
    const signal = fetchMock.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
  });

  it("cancels a response body that arrives after the header deadline", async () => {
    vi.useFakeTimers();
    let resolveFetch;
    const cancel = vi.fn();
    global.fetch = vi.fn(() => new Promise(resolve => { resolveFetch = resolve; }));
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const pending = refreshAccessToken("iflow", "late-headers", {}, log);
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(pending).resolves.toBeNull();

    resolveFetch({ body: { cancel } });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a body even when stream cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise(() => {}));
    const response = new Response(new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    global.fetch = vi.fn().mockResolvedValue(response);
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const pending = refreshAccessToken("iflow", "stalled-body", {}, log);
    await vi.advanceTimersByTimeAsync(30_001);

    await expect(pending).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects a success body larger than the refresh response cap", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(
      "x".repeat(256 * 1024 + 1),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await expect(refreshAccessToken("iflow", "oversize-body", {}, log)).resolves.toBeNull();
    expect(log.info).not.toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      expect.stringContaining("Successfully refreshed"),
      expect.anything(),
    );
  });

  it("rejects invalid UTF-8 and malformed JSON success bodies", async () => {
    const responses = [
      new Response(new Uint8Array([0xc3, 0x28]), { status: 200 }),
      new Response('{"access_token":', { status: 200 }),
    ];
    global.fetch = vi.fn(() => Promise.resolve(responses.shift()));
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await expect(refreshAccessToken("iflow", "invalid-utf8", {}, log)).resolves.toBeNull();
    await expect(refreshAccessToken("iflow", "malformed-json", {}, log)).resolves.toBeNull();
  });

  it("rejects HTTP 200 JSON that has no access token", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await expect(refreshAccessToken("iflow", "missing-access-token", {}, log)).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      expect.stringContaining("returned no access token"),
    );
  });

  it.each([
    ["Cline", "refreshClineToken", ["cline-missing"]],
    ["Google", "refreshGoogleToken", ["google-missing", "client", "secret"]],
    ["Codex", "refreshCodexToken", ["codex-missing"]],
    ["Kiro", "refreshKiroToken", ["kiro-missing", {
      profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/missing-token",
    }]],
    ["Copilot", "refreshCopilotToken", ["copilot-missing"]],
  ])("rejects a %s HTTP 200 result without an access token", async (_label, exportName, args) => {
    global.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const providers = await import("open-sse/services/tokenRefresh/providers.js");

    await expect(providers[exportName](...args, log)).resolves.toBeNull();
  });

  it.each([
    ["Kiro", (providers, token) => providers.refreshKiroToken(token, {
      profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/late-response",
    }, log)],
    ["Copilot", (providers, token) => providers.refreshCopilotToken(token, log)],
  ])("cancels a late %s response after its absolute deadline", async (label, invoke) => {
    vi.useFakeTimers();
    let resolveFetch;
    const cancel = vi.fn();
    global.fetch = vi.fn(() => new Promise(resolve => { resolveFetch = resolve; }));
    const providers = await import("open-sse/services/tokenRefresh/providers.js");

    const pending = invoke(providers, `${label.toLowerCase()}-late-response`);
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(pending).resolves.toBeNull();

    resolveFetch({ body: { cancel } });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not log arbitrary upstream error bodies and keeps failure metadata bounded", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(
      "e".repeat(8192),
      { status: 502, headers: { "Content-Type": "text/plain" } },
    ));
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await expect(refreshAccessToken("iflow", "large-error", {}, log)).resolves.toBeNull();
    const failure = log.error.mock.calls.find(([, message]) => message.includes("Failed to refresh"));
    expect(failure?.[2]).toEqual({ status: 502 });
    expect(JSON.stringify(failure?.[2]).length).toBeLessThan(128);
  });

  it.each([
    ["generic", (providers, token) => providers.refreshAccessToken("iflow", token, {}, log)],
    ["Cline", (providers, token) => providers.refreshClineToken(token, log)],
    ["Google", (providers, token) => providers.refreshGoogleToken(token, "client", "secret", log)],
    ["Codex", (providers, token) => providers.refreshCodexToken(token, log)],
    ["CodeBuddy", (providers, token) => providers.refreshCodebuddyToken(token, log)],
    ["CodeBuddy intl", (providers, token) => providers.refreshCodebuddyIntlToken(token, log)],
    ["Trae", (providers, token) => providers.refreshTraeToken(token, {}, log)],
    ["Kiro", (providers, token) => providers.refreshKiroToken(token, {
      profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/log-redaction",
    }, log)],
    ["Copilot", (providers, token) => providers.refreshCopilotToken(token, log)],
  ])("redacts reflected credentials from %s HTTP failure logs", async (label, invoke) => {
    const marker = `SENSITIVE_${label.replaceAll(" ", "_").toUpperCase()}_MARKER`;
    if (label === "Trae") mockTraeRefreshConfig();
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: marker,
      code: marker,
      refresh_token: marker,
      access_token: marker,
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));
    const providers = await import("open-sse/services/tokenRefresh/providers.js");

    await invoke(providers, `${label}-redaction-token`);

    const serializedLogs = JSON.stringify(log.error.mock.calls);
    expect(serializedLogs).not.toContain(marker);
    const failure = log.error.mock.calls.find((call) => call[2]?.status === 400);
    expect(failure?.[2]).toEqual({ status: 400, code: "invalid_grant" });
    expect(JSON.stringify(failure?.[2]).length).toBeLessThan(128);
  });

  it.each([
    ["CodeBuddy", "refreshCodebuddyToken", { code: 987654, msg: "SENSITIVE_APP_ERROR", data: { refreshToken: "SENSITIVE_APP_ERROR" } }],
    ["CodeBuddy intl", "refreshCodebuddyIntlToken", { code: 987654, msg: "SENSITIVE_APP_ERROR", data: { refreshToken: "SENSITIVE_APP_ERROR" } }],
    ["Trae", "refreshTraeToken", { code: "SENSITIVE_APP_ERROR", error_description: "SENSITIVE_APP_ERROR", Result: { RefreshToken: "SENSITIVE_APP_ERROR" } }],
  ])("redacts %s application-level failure payloads", async (label, exportName, payload) => {
    if (label === "Trae") mockTraeRefreshConfig();
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const providers = await import("open-sse/services/tokenRefresh/providers.js");

    const args = label === "Trae"
      ? ["trae-app-error", {}, log]
      : [`${label}-app-error`, log];
    await expect(providers[exportName](...args)).resolves.toBeNull();

    const serializedLogs = JSON.stringify(log.error.mock.calls);
    expect(serializedLogs).not.toContain("SENSITIVE_APP_ERROR");
    const failure = log.error.mock.calls.find(([, message]) => message.includes("returned no"));
    expect(failure?.[2]).toEqual({});
  });

  it.each([
    ["Kiro", (providers) => providers.refreshKiroToken("kiro-malformed-log", {
      profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/malformed-log",
    }, log)],
    ["Copilot", (providers) => providers.refreshCopilotToken("copilot-malformed-log", log)],
  ])("redacts malformed %s success bodies from exception logs", async (_label, invoke) => {
    global.fetch = vi.fn().mockResolvedValue(new Response(
      '{"SENSITIVE_MALFORMED_BODY":',
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const providers = await import("open-sse/services/tokenRefresh/providers.js");

    await expect(invoke(providers)).resolves.toBeNull();

    const serializedLogs = JSON.stringify(log.error.mock.calls);
    expect(serializedLogs).not.toContain("SENSITIVE_MALFORMED_BODY");
    expect(serializedLogs).toContain("returned malformed JSON");
  });

  it.each([
    ["Cline", "refreshClineToken", ["cline-refresh"], { data: { accessToken: "cline-access" } }],
    ["Google", "refreshGoogleToken", ["google-refresh", "client", "secret"], { access_token: "google-access" }],
    ["Codex", "refreshCodexToken", ["codex-refresh"], { access_token: "codex-access" }],
    ["CodeBuddy", "refreshCodebuddyToken", ["codebuddy-refresh"], { code: 0, data: { accessToken: "cb-access" } }],
    ["CodeBuddy intl", "refreshCodebuddyIntlToken", ["codebuddy-intl-refresh"], { code: 0, data: { accessToken: "cbi-access" } }],
  ])("%s refresh passes its deadline signal to fetch", async (_label, exportName, args, payload) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    global.fetch = fetchMock;
    const providers = await import("open-sse/services/tokenRefresh/providers.js");

    const result = await providers[exportName](...args, log);

    expect(result).not.toBeNull();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["CodeBuddy", "refreshCodebuddyToken"],
    ["CodeBuddy intl", "refreshCodebuddyIntlToken"],
  ])("treats a null JSON success body from %s as a failed refresh", async (label, exportName) => {
    global.fetch = vi.fn().mockResolvedValue(new Response("null", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const providers = await import("open-sse/services/tokenRefresh/providers.js");

    await expect(providers[exportName](`${label}-null-body`, log)).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      expect.stringContaining("returned no token"),
      {},
    );
  });

  it("does not return an arbitrary Codex error code reflected by the token endpoint", async () => {
    const reflectedSecret = "REFLECTED_CODEX_REFRESH_TOKEN";
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: reflectedSecret,
      error_description: `invalid_grant ${reflectedSecret}`,
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));
    const { refreshCodexToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const result = await refreshCodexToken("codex-reflected-code", log);

    expect(result).toEqual({ error: "unrecoverable_refresh_error", code: "invalid_grant" });
    expect(JSON.stringify(result)).not.toContain(reflectedSecret);
  });

  it("cancels a Kiro profile response that arrives after its deadline", async () => {
    vi.useFakeTimers();
    let resolveFetch;
    const cancel = vi.fn();
    global.fetch = vi.fn(() => new Promise(resolve => { resolveFetch = resolve; }));
    const { fetchKiroProfileArn } = await import("../../src/lib/oauth/providerHelpers.js");

    const pending = fetchKiroProfileArn("kiro-profile-late", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    await expect(pending).resolves.toBeNull();

    resolveFetch({ body: { cancel } });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled Kiro profile response body without waiting for cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise(() => {}));
    const response = new Response(new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    global.fetch = vi.fn().mockResolvedValue(response);
    const { fetchKiroProfileArn } = await import("../../src/lib/oauth/providerHelpers.js");

    const pending = fetchKiroProfileArn("kiro-profile-stalled", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);

    await expect(pending).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized Kiro profile response body", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
      cancel,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    global.fetch = vi.fn().mockResolvedValue(response);
    const { fetchKiroProfileArn } = await import("../../src/lib/oauth/providerHelpers.js");

    await expect(fetchKiroProfileArn("kiro-profile-oversized", { timeoutMs: 100 })).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
