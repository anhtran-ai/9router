import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdapter: vi.fn() }));

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));

const { createProviderConnection, updateProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");

describe("provider connection update cancellation", () => {
  it("rechecks create ownership after the adapter wait and skips the transaction", async () => {
    let releaseAdapter;
    const adapterReady = new Promise((resolve) => { releaseAdapter = resolve; });
    const db = { transaction: vi.fn() };
    mocks.getAdapter.mockReturnValue(adapterReady);
    let ownsMutation = true;

    const pending = createProviderConnection(
      { provider: "fixture", authType: "oauth", email: "stale@example.test" },
      { shouldCommit: () => ownsMutation },
    );
    ownsMutation = false;
    releaseAdapter(db);

    await expect(pending).resolves.toBeNull();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rechecks the signal after the adapter wait and before the synchronous commit", async () => {
    let releaseAdapter;
    const adapterReady = new Promise((resolve) => { releaseAdapter = resolve; });
    const db = { transaction: vi.fn() };
    mocks.getAdapter.mockReturnValue(adapterReady);
    const client = new AbortController();

    const pending = updateProviderConnection("connection-a", { lastError: "fixture" }, { signal: client.signal });
    client.abort();
    releaseAdapter(db);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rechecks a mutation ownership predicate at the adapter boundary", async () => {
    let releaseAdapter;
    const adapterReady = new Promise((resolve) => { releaseAdapter = resolve; });
    const db = { transaction: vi.fn() };
    mocks.getAdapter.mockReturnValue(adapterReady);
    let ownsMutation = true;

    const pending = updateProviderConnection(
      "connection-a",
      { lastError: "stale fixture" },
      { shouldCommit: () => ownsMutation },
    );
    ownsMutation = false;
    releaseAdapter(db);

    await expect(pending).resolves.toBeNull();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("publishes ordering metadata only after a guarded transaction commits", async () => {
    const order = [];
    const db = {
      transaction: vi.fn((callback) => {
        order.push("transaction");
        callback();
        order.push("committed");
      }),
      get: vi.fn(() => ({
        id: "connection-a",
        provider: "fixture",
        authType: "apikey",
        isActive: 1,
        data: "{}",
      })),
      run: vi.fn(),
    };
    mocks.getAdapter.mockResolvedValue(db);

    await updateProviderConnection("connection-a", { lastError: "fixture" }, {
      shouldCommit: () => true,
      beforeCommit: () => order.push("guard"),
      afterCommit: () => order.push("watermark"),
    });

    expect(order).toEqual(["guard", "transaction", "committed", "watermark"]);
  });

  it("does not publish ordering metadata when the transaction fails", async () => {
    const afterCommit = vi.fn();
    const dbError = new Error("fixture transaction failed");
    mocks.getAdapter.mockResolvedValue({
      transaction: vi.fn(() => { throw dbError; }),
    });

    await expect(updateProviderConnection("connection-a", { lastError: "fixture" }, {
      beforeCommit: vi.fn(),
      afterCommit,
    })).rejects.toBe(dbError);

    expect(afterCommit).not.toHaveBeenCalled();
  });
});
