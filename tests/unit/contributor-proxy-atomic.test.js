import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  exchangeTokens: vi.fn(),
}));

vi.mock("@/lib/oauth/providers", () => ({
  exchangeTokens: mocks.exchangeTokens,
}));
vi.mock("@/models", () => ({
  createProviderConnection: mocks.createConnection,
}));

const proxy = await import("../../src/lib/oauth/utils/server.js");

// The deterministic offline-suite guard permits only ephemeral loopback
// fixtures. These callbacks intentionally exercise the providers' required
// fixed ports, so keep them in the normal focused gate and skip only inside
// that guarded full-suite environment.
const fixedPortTest = process.env.AZOX_AUDIT_OUTPUT ? it.skip : it;

function requestCallback(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, ...options }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", reject);
  });
}

function requestCallbackWithBody(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, ...options }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
  });
}

describe("contributor proxy atomic persistence hook", () => {
  beforeEach(() => {
    mocks.createConnection.mockReset();
    mocks.exchangeTokens.mockReset().mockResolvedValue({
      accessToken: "proxy-access-token",
      refreshToken: "proxy-refresh-token",
      email: "proxy@example.test",
    });
    proxy.clearTraeSession();
  });

  afterEach(() => {
    for (const owner of [
      "reservation-hash-1",
      "reservation-hash-revoked",
      "reservation-hash-a",
      "reservation-hash-b",
      "dynamic-old",
      "dynamic-new",
      "fixed-old",
      "fixed-new",
      "cross-origin-owner",
      "normal-replacement-owner",
    ]) {
      proxy.stopTraeProxy(owner);
      proxy.stopXaiProxy(owner);
      proxy.stopCodexProxy(owner);
      proxy.stopWindsurfProxy(owner);
    }
    proxy.stopTraeProxy();
    proxy.stopXaiProxy();
    proxy.stopCodexProxy();
    proxy.stopWindsurfProxy();
    proxy.clearTraeSession();
    proxy.clearWindsurfSession();
    for (const state of ["fixed-old-state", "fixed-new-state", "cross-origin-state"]) {
      proxy.clearXaiSession(state);
      proxy.clearCodexSession(state);
    }
  });

  it("commits a proxy credential only through the contributor hook", async () => {
    const started = await proxy.startTraeProxy("reservation-hash-1");
    const connection = { id: "proxy-atomic", provider: "trae", email: "proxy@example.test" };
    const commitProviderConnection = vi.fn(async () => connection);
    expect(proxy.registerTraeSession({
      state: "proxy-state",
      commitProviderConnection,
      contributorReservationHash: "reservation-hash-1",
    })).toBe(true);

    await expect(requestCallback(
      `${started.callbackUrl}?refreshToken=fixture&loginHost=example.test&state=proxy-state`,
    )).resolves.toBe(200);

    expect(commitProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "trae",
      authType: "oauth",
      accessToken: "proxy-access-token",
    }));
    expect(mocks.createConnection).not.toHaveBeenCalled();
    expect(proxy.getTraeSessionStatus("proxy-state")).toBeNull();
  });

  it("does not expose raw provider failures in callback HTML or poll state", async () => {
    const reflectedSecret = "refreshToken=secret-value upstream echoed credentials";
    mocks.exchangeTokens.mockRejectedValueOnce(new Error(reflectedSecret));
    const started = await proxy.startTraeProxy();
    expect(proxy.registerTraeSession({ state: "proxy-error-state" })).toBe(true);

    const callback = await requestCallbackWithBody(
      `${started.callbackUrl}?refreshToken=fixture&loginHost=example.test&state=proxy-error-state`,
    );

    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain("OAuth authentication failed");
    expect(callback.body).not.toContain(reflectedSecret);
    expect(proxy.getTraeSessionStatus("proxy-error-state")).toMatchObject({
      status: "error",
      error: "OAuth authentication failed",
    });
  });

  it("does not fall back to normal persistence when revocation rejects the hook", async () => {
    const started = await proxy.startTraeProxy("reservation-hash-revoked");
    const commitProviderConnection = vi.fn(async () => null);
    expect(proxy.registerTraeSession({
      state: "revoked-state",
      commitProviderConnection,
      contributorReservationHash: "reservation-hash-revoked",
    })).toBe(true);

    await expect(requestCallback(
      `${started.callbackUrl}?refreshToken=fixture&loginHost=example.test&state=revoked-state`,
    )).resolves.toBe(200);

    expect(commitProviderConnection).toHaveBeenCalledOnce();
    expect(mocks.createConnection).not.toHaveBeenCalled();
    expect(proxy.getTraeSessionStatus("revoked-state")).toBeNull();
  });

  it("does not let another reservation reuse or stop an active singleton proxy", async () => {
    const first = await proxy.startTraeProxy("reservation-hash-a");

    expect(first.success).toBe(true);
    await expect(proxy.startTraeProxy("reservation-hash-b")).resolves.toMatchObject({
      success: false,
      reason: expect.stringContaining("already in use"),
    });
    expect(proxy.registerTraeSession({
      state: "state-b",
      contributorReservationHash: "reservation-hash-b",
      commitProviderConnection: vi.fn(),
    })).toBe(false);
    expect(proxy.stopTraeProxy("reservation-hash-b")).toBe(false);
    expect(proxy.registerTraeSession({
      state: "state-a",
      contributorReservationHash: "reservation-hash-a",
      commitProviderConnection: vi.fn(),
    })).toBe(true);
    expect(proxy.stopTraeProxy("reservation-hash-a")).toBe(true);
  });

  it("does not let an ownerless stop close a contributor proxy and clears its pending session on exact stop", async () => {
    const first = await proxy.startTraeProxy("dynamic-old");
    expect(first.success).toBe(true);
    expect(proxy.registerTraeSession({
      state: "dynamic-old-state",
      contributorReservationHash: "dynamic-old",
      commitProviderConnection: vi.fn(),
    })).toBe(true);

    expect(proxy.stopTraeProxy()).toBe(false);
    expect(proxy.getTraeSessionStatus("dynamic-old-state")).toMatchObject({ status: "pending" });
    await expect(proxy.startTraeProxy("dynamic-new")).resolves.toMatchObject({
      success: false,
      reason: expect.stringContaining("already in use"),
    });

    expect(proxy.stopTraeProxy("dynamic-old")).toBe(true);
    expect(proxy.getTraeSessionStatus("dynamic-old-state")).toBeNull();
    await expect(proxy.startTraeProxy("dynamic-new")).resolves.toMatchObject({ success: true });
  });

  it.each([
    {
      provider: "Trae",
      start: () => proxy.startTraeProxy(),
      register: (state) => proxy.registerTraeSession({ state }),
      status: (state) => proxy.getTraeSessionStatus(state),
      callbackQuery: (state) => `refreshToken=fixture&loginHost=example.test&state=${state}`,
    },
    {
      provider: "Windsurf",
      start: () => proxy.startWindsurfProxy(),
      register: (state) => proxy.registerWindsurfSession({ state }),
      status: (state) => proxy.getWindsurfSessionStatus(state),
      callbackQuery: (state) => `access_token=fixture&state=${state}`,
    },
  ])("keeps the $provider session pending after a wrong-state callback", async ({
    start,
    register,
    status,
    callbackQuery,
  }) => {
    mocks.createConnection.mockResolvedValueOnce({
      id: "correct-state-connection",
      email: "correct@example.test",
    });
    const started = await start();
    expect(started.success).toBe(true);
    expect(register("correct-state")).toBe(true);

    await expect(requestCallback(
      `${started.callbackUrl}?${callbackQuery("wrong-state")}`,
    )).resolves.toBe(409);
    expect(status("correct-state")).toMatchObject({ status: "pending" });

    await expect(requestCallback(
      `${started.callbackUrl}?${callbackQuery("correct-state")}`,
    )).resolves.toBe(200);
    expect(status("correct-state")).toMatchObject({ status: "done" });
    expect(mocks.exchangeTokens).toHaveBeenCalledOnce();
    expect(mocks.createConnection).toHaveBeenCalledOnce();
  });

  it("does not persist a delayed dynamic callback or stop the replacement generation", async () => {
    let resolveExchange;
    let markExchangeStarted;
    const exchangeStarted = new Promise((resolve) => { markExchangeStarted = resolve; });
    mocks.exchangeTokens.mockImplementationOnce(async () => {
      markExchangeStarted();
      return new Promise((resolve) => { resolveExchange = resolve; });
    });

    const first = await proxy.startTraeProxy("dynamic-old");
    const oldCommit = vi.fn(async () => ({ id: "must-not-persist" }));
    expect(proxy.registerTraeSession({
      state: "dynamic-old-state",
      contributorReservationHash: "dynamic-old",
      commitProviderConnection: oldCommit,
    })).toBe(true);

    const oldCallback = requestCallback(
      `${first.callbackUrl}?refreshToken=fixture&loginHost=example.test&state=dynamic-old-state`,
    );
    await exchangeStarted;
    await expect(requestCallback(
      `${first.callbackUrl}?refreshToken=duplicate&loginHost=example.test&state=dynamic-old-state`,
    )).resolves.toBe(409);
    expect(mocks.exchangeTokens).toHaveBeenCalledOnce();

    expect(proxy.stopTraeProxy("dynamic-old")).toBe(true);
    const replacement = await proxy.startTraeProxy("dynamic-new");
    expect(replacement.success).toBe(true);
    expect(proxy.registerTraeSession({
      state: "dynamic-new-state",
      contributorReservationHash: "dynamic-new",
      commitProviderConnection: vi.fn(),
    })).toBe(true);

    resolveExchange({
      accessToken: "late-access",
      refreshToken: "late-refresh",
      email: "late@example.test",
    });
    await expect(oldCallback).resolves.toBe(200);

    expect(oldCommit).not.toHaveBeenCalled();
    expect(proxy.getTraeSessionStatus("dynamic-new-state")).toMatchObject({ status: "pending" });
    await expect(proxy.startTraeProxy("dynamic-new")).resolves.toMatchObject({
      success: true,
      callbackUrl: replacement.callbackUrl,
    });
  });

  it("rechecks a normal persistence guard after a delayed DB boundary", async () => {
    let releasePersistence;
    let markPersistenceStarted;
    const persistenceStarted = new Promise((resolve) => { markPersistenceStarted = resolve; });
    const dbWrite = vi.fn();
    mocks.createConnection.mockImplementationOnce(async (_connection, options) => {
      markPersistenceStarted();
      await new Promise((resolve) => { releasePersistence = resolve; });
      if (options?.shouldCommit && !options.shouldCommit()) return null;
      dbWrite();
      return { id: "stale-normal-write", email: "stale@example.test" };
    });

    const first = await proxy.startTraeProxy();
    expect(first.success).toBe(true);
    expect(proxy.registerTraeSession({ state: "normal-old-state" })).toBe(true);
    const oldCallback = requestCallback(
      `${first.callbackUrl}?refreshToken=fixture&loginHost=example.test&state=normal-old-state`,
    );
    await persistenceStarted;

    expect(proxy.stopTraeProxy()).toBe(true);
    const replacement = await proxy.startTraeProxy();
    expect(replacement.success).toBe(true);
    expect(proxy.registerTraeSession({ state: "normal-new-state" })).toBe(true);

    releasePersistence();
    await expect(oldCallback).resolves.toBe(200);

    expect(dbWrite).not.toHaveBeenCalled();
    expect(proxy.getTraeSessionStatus("normal-new-state")).toMatchObject({ status: "pending" });
    await expect(proxy.startTraeProxy()).resolves.toMatchObject({
      success: true,
      callbackUrl: replacement.callbackUrl,
    });
  });

  fixedPortTest("does not persist a delayed fixed-port callback or stop the replacement generation", async () => {
    let resolveExchange;
    let markExchangeStarted;
    const exchangeStarted = new Promise((resolve) => { markExchangeStarted = resolve; });
    mocks.exchangeTokens.mockImplementationOnce(async () => {
      markExchangeStarted();
      return new Promise((resolve) => { resolveExchange = resolve; });
    });

    const first = await proxy.startXaiProxy(3000, "fixed-old");
    expect(first.success).toBe(true);
    const oldCommit = vi.fn(async () => ({ id: "must-not-persist" }));
    expect(proxy.registerXaiSession({
      state: "fixed-old-state",
      codeVerifier: "fixed-old-verifier",
      redirectUri: "http://127.0.0.1:56121/callback",
      contributorReservationHash: "fixed-old",
      commitProviderConnection: oldCommit,
    })).toBe(true);

    const oldCallback = requestCallback(
      "http://127.0.0.1:56121/callback?code=late-code&state=fixed-old-state",
    );
    await exchangeStarted;

    expect(proxy.stopXaiProxy("fixed-old")).toBe(true);
    expect(proxy.getXaiSessionStatus("fixed-old-state")).toBeNull();
    await expect(proxy.startXaiProxy(3000, "fixed-new")).resolves.toMatchObject({ success: true });
    expect(proxy.registerXaiSession({
      state: "fixed-new-state",
      codeVerifier: "fixed-new-verifier",
      redirectUri: "http://127.0.0.1:56121/callback",
      contributorReservationHash: "fixed-new",
      commitProviderConnection: vi.fn(),
    })).toBe(true);
    await expect(requestCallback(
      "http://127.0.0.1:56121/callback?code=stale-arrival&state=fixed-old-state",
    )).resolves.toBe(409);
    expect(mocks.exchangeTokens).toHaveBeenCalledOnce();

    resolveExchange({
      accessToken: "late-access",
      refreshToken: "late-refresh",
      email: "late@example.test",
    });
    await expect(oldCallback).resolves.toBe(200);

    expect(oldCommit).not.toHaveBeenCalled();
    expect(proxy.getXaiSessionStatus("fixed-new-state")).toMatchObject({ status: "pending" });
    await expect(proxy.startXaiProxy(3000, "fixed-new")).resolves.toMatchObject({ success: true });
  });

  fixedPortTest.each([
    {
      provider: "xAI",
      start: () => proxy.startXaiProxy(3000, "cross-origin-owner"),
      register: () => proxy.registerXaiSession({
        state: "cross-origin-state",
        codeVerifier: "cross-origin-verifier",
        redirectUri: "http://127.0.0.1:56121/callback",
        contributorReservationHash: "cross-origin-owner",
        commitProviderConnection: vi.fn(),
      }),
      callbackUrl: "http://127.0.0.1:56121/callback?code=attacker",
      status: () => proxy.getXaiSessionStatus("cross-origin-state"),
    },
    {
      provider: "Codex",
      start: () => proxy.startCodexProxy(3000, "cross-origin-owner"),
      register: () => proxy.registerCodexSession({
        state: "cross-origin-state",
        codeVerifier: "cross-origin-verifier",
        redirectUri: "http://localhost:1455/auth/callback",
        contributorReservationHash: "cross-origin-owner",
        commitProviderConnection: vi.fn(),
      }),
      callbackUrl: "http://127.0.0.1:1455/auth/callback?code=attacker",
      status: () => proxy.getCodexSessionStatus("cross-origin-state"),
    },
  ])("rejects a cross-origin $provider callback without stopping its session", async ({
    start,
    register,
    callbackUrl,
    status,
  }) => {
    await expect(start()).resolves.toMatchObject({ success: true });
    expect(register()).toBe(true);

    await expect(requestCallback(
      callbackUrl,
      { headers: { Origin: "https://attacker.example" } },
    )).resolves.toBe(403);

    expect(mocks.exchangeTokens).not.toHaveBeenCalled();
    expect(status()).toMatchObject({ status: "pending" });
    await expect(start()).resolves.toMatchObject({ success: true });
  });
});
