import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdapter: vi.fn() }));

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));

const { updateProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");

describe("provider connection update cancellation", () => {
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

  it("records a failure watermark immediately before a guarded transaction", async () => {
    const order = [];
    const db = {
      transaction: vi.fn((callback) => {
        order.push("transaction");
        callback();
      }),
      get: vi.fn(() => null),
    };
    mocks.getAdapter.mockResolvedValue(db);

    await updateProviderConnection("connection-a", { lastError: "fixture" }, {
      shouldCommit: () => true,
      beforeCommit: () => order.push("watermark"),
    });

    expect(order).toEqual(["watermark", "transaction"]);
  });
});
