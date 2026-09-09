import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ adapter: null }));

vi.mock("@/lib/db/driver", () => ({
  getAdapter: async () => fixture.adapter,
}));

const { createSqlJsAdapter } = await import("../../src/lib/db/adapters/sqljsAdapter.js");
const store = await import("../../src/lib/contributor/store.js");

let tempDir;

async function claimedReservation(alias) {
  const { token } = await store.createContributorInvite({
    alias,
    allowedProviders: ["claude"],
  });
  const invite = await store.claimContributorToken(token);
  const lease = await store.reserveContributorInvite(invite.id, invite.sessionId);
  return {
    invite,
    reservation: { sessionId: invite.sessionId, leaseId: lease.leaseId },
  };
}

function connectionCount() {
  return Number(fixture.adapter.get("SELECT COUNT(*) AS count FROM providerConnections")?.count || 0);
}

const connectionData = {
  provider: "claude",
  authType: "oauth",
  email: "sqlite-contributor@example.test",
  accessToken: "sqlite-access-token",
  refreshToken: "sqlite-refresh-token",
  testStatus: "active",
};

describe("atomic contributor completion on real SQLite", () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-contributor-atomic-"));
    fixture.adapter = await createSqlJsAdapter(path.join(tempDir, "fixture.sqlite"));
    fixture.adapter.exec(`
      CREATE TABLE kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE providerConnections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        authType TEXT NOT NULL,
        name TEXT,
        email TEXT,
        priority INTEGER,
        isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  });

  beforeEach(() => {
    fixture.adapter.exec("DELETE FROM providerConnections; DELETE FROM kv;");
  });

  afterAll(() => {
    fixture.adapter?.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("leaves providerConnections unchanged when revocation wins", async () => {
    const { invite, reservation } = await claimedReservation("sqlite-revoke-wins");
    expect(await store.revokeContributorInvite(invite.id)).toBe(true);

    expect(await store.completeContributorInviteWithConnection(
      invite.id,
      connectionData,
      reservation,
    )).toBeNull();

    expect(connectionCount()).toBe(0);
    expect(await store.getContributorInvite(invite.id)).toMatchObject({ status: "revoked" });
  });

  it("commits connection and used invite in one SQLite transaction", async () => {
    const { invite, reservation } = await claimedReservation("sqlite-completion-wins");

    const connection = await store.completeContributorInviteWithConnection(
      invite.id,
      connectionData,
      reservation,
    );

    expect(connectionCount()).toBe(1);
    expect(connection).toMatchObject({ provider: "claude", accessToken: "sqlite-access-token" });
    expect(await store.getContributorInvite(invite.id)).toMatchObject({
      status: "used",
      connection: { id: connection.id, provider: "claude" },
    });
    expect(await store.revokeContributorInvite(invite.id)).toBe(false);
  });

  it("rolls back a connection insert when the invite CAS fails", async () => {
    const { invite, reservation } = await claimedReservation("sqlite-cas-rollback");
    const realRun = fixture.adapter.run;
    fixture.adapter.run = (sql, params) => (
      /^\s*UPDATE kv SET value/i.test(sql)
        ? { changes: 0 }
        : realRun(sql, params)
    );

    try {
      await expect(store.completeContributorInviteWithConnection(
        invite.id,
        connectionData,
        reservation,
      )).rejects.toThrow("lost its reservation");
    } finally {
      fixture.adapter.run = realRun;
    }

    expect(connectionCount()).toBe(0);
    expect(await store.getContributorInvite(invite.id)).toMatchObject({
      status: "completing",
      completionSessionId: invite.sessionId,
    });
  });
});
