import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  kv: new Map(),
  connections: new Map(),
  failConnectionWrite: false,
}));

function cloneMap(map) {
  return new Map([...map.entries()].map(([key, value]) => [key, structuredClone(value)]));
}

function restoreMap(target, snapshot) {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

const adapter = {
  run(sql, params) {
    if (/^\s*INSERT OR REPLACE INTO kv/i.test(sql)) {
      const [scope, key, value] = params;
      state.kv.set(`${scope}:${key}`, value);
      return { changes: 1 };
    }
    if (/^\s*UPDATE kv SET value/i.test(sql)) {
      const [nextValue, scope, key, currentValue] = params;
      const rowKey = `${scope}:${key}`;
      if (state.kv.get(rowKey) !== currentValue) return { changes: 0 };
      state.kv.set(rowKey, nextValue);
      return { changes: 1 };
    }
    if (/^\s*INSERT INTO providerConnections/i.test(sql)) {
      if (state.failConnectionWrite) throw new Error("fixture connection write failure");
      const [id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt] = params;
      state.connections.set(id, {
        id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt,
      });
      return { changes: 1 };
    }
    if (/^\s*UPDATE providerConnections SET priority/i.test(sql)) {
      const [priority, id] = params;
      const row = state.connections.get(id);
      if (!row) return { changes: 0 };
      state.connections.set(id, { ...row, priority });
      return { changes: 1 };
    }
    throw new Error(`Unexpected SQL in fixture: ${sql}`);
  },
  get(sql, params) {
    if (/SELECT value FROM kv/i.test(sql)) {
      const [scope, key] = params;
      const value = state.kv.get(`${scope}:${key}`);
      return value ? { value } : null;
    }
    if (/SELECT \* FROM providerConnections WHERE id/i.test(sql)) {
      return state.connections.get(params[0]) || null;
    }
    throw new Error(`Unexpected SQL in fixture: ${sql}`);
  },
  all(sql, params) {
    if (/SELECT value FROM kv/i.test(sql)) {
      const [scope] = params;
      return [...state.kv.entries()]
        .filter(([key]) => key.startsWith(`${scope}:`))
        .map(([, value]) => ({ value }));
    }
    if (/SELECT \* FROM providerConnections WHERE provider/i.test(sql)) {
      return [...state.connections.values()].filter((row) => row.provider === params[0]);
    }
    throw new Error(`Unexpected SQL in fixture: ${sql}`);
  },
  transaction(callback) {
    const kvSnapshot = cloneMap(state.kv);
    const connectionSnapshot = cloneMap(state.connections);
    try {
      return callback();
    } catch (error) {
      restoreMap(state.kv, kvSnapshot);
      restoreMap(state.connections, connectionSnapshot);
      throw error;
    }
  },
};

vi.mock("@/lib/db/driver", () => ({ getAdapter: async () => adapter }));

const store = await import("../../src/lib/contributor/store.js");

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

const connectionData = {
  provider: "claude",
  authType: "oauth",
  email: "contributor@example.test",
  accessToken: "fixture-access-token",
  refreshToken: "fixture-refresh-token",
  testStatus: "active",
};

describe("atomic contributor connection completion", () => {
  beforeEach(() => {
    state.kv.clear();
    state.connections.clear();
    state.failConnectionWrite = false;
  });

  it("performs zero connection mutation when administrator revocation wins", async () => {
    const { invite, reservation } = await claimedReservation("revoke-wins");
    await expect(store.revokeContributorInvite(invite.id)).resolves.toBe(true);

    await expect(store.completeContributorInviteWithConnection(
      invite.id,
      connectionData,
      reservation,
    )).resolves.toBeNull();

    expect(state.connections.size).toBe(0);
    await expect(store.getContributorInvite(invite.id)).resolves.toMatchObject({ status: "revoked" });
  });

  it("rejects a connection provider outside the invite allowlist", async () => {
    const { invite, reservation } = await claimedReservation("provider-mismatch");

    await expect(store.completeContributorInviteWithConnection(
      invite.id,
      { ...connectionData, provider: "codex" },
      reservation,
    )).resolves.toBeNull();

    expect(state.connections.size).toBe(0);
    await expect(store.getContributorInvite(invite.id)).resolves.toMatchObject({
      status: "completing",
      completionSessionId: invite.sessionId,
    });
  });

  it("commits the connection and used invite together when completion wins", async () => {
    const { invite, reservation } = await claimedReservation("completion-wins");
    const connection = await store.completeContributorInviteWithConnection(
      invite.id,
      connectionData,
      reservation,
    );

    expect(connection).toMatchObject({ provider: "claude", accessToken: "fixture-access-token" });
    expect(state.connections.get(connection.id)).toBeTruthy();
    await expect(store.getContributorInvite(invite.id)).resolves.toMatchObject({
      status: "used",
      connection: { id: connection.id, provider: "claude", email: "contributor@example.test" },
    });
    await expect(store.revokeContributorInvite(invite.id)).resolves.toBe(false);
  });

  it("rolls back both records when connection persistence throws", async () => {
    const { invite, reservation } = await claimedReservation("transaction-rollback");
    state.failConnectionWrite = true;

    await expect(store.completeContributorInviteWithConnection(
      invite.id,
      connectionData,
      reservation,
    )).rejects.toThrow("fixture connection write failure");

    expect(state.connections.size).toBe(0);
    await expect(store.getContributorInvite(invite.id)).resolves.toMatchObject({
      status: "completing",
      completionSessionId: invite.sessionId,
    });
  });
});
