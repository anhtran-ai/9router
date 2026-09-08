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

function requestCallback(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
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
    proxy.stopTraeProxy();
    proxy.clearTraeSession();
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
});
