import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map();
let dbGetCalls = 0;

vi.mock("@/lib/db/driver", () => ({
  getAdapter: async () => ({
    run(sql, params) {
      if (/^\s*UPDATE\s+kv/i.test(sql)) {
        const [nextValue, scope, key, currentValue] = params;
        const rowKey = `${scope}:${key}`;
        if (rows.get(rowKey) !== currentValue) return { changes: 0 };
        rows.set(rowKey, nextValue);
        return { changes: 1 };
      }
      const [scope, key, value] = params;
      rows.set(`${scope}:${key}`, value);
      return { changes: 1 };
    },
    get(_sql, params) {
      dbGetCalls += 1;
      const [scope, key] = params;
      const value = rows.get(`${scope}:${key}`);
      return value ? { value } : null;
    },
    all(_sql, params) {
      const [scope] = params;
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(`${scope}:`))
        .map(([, value]) => ({ value }));
    },
    transaction(callback) {
      return callback();
    },
  }),
}));

const store = await import("../../src/lib/contributor/store.js");

describe("contributor invite store", () => {
  beforeEach(() => {
    rows.clear();
    dbGetCalls = 0;
    vi.useRealTimers();
  });

  it("stores only a hash of the one-time secret and deduplicates providers", async () => {
    const { invite, token } = await store.createContributorInvite({
      alias: "reviewer",
      allowedProviders: ["claude", "claude", "codex"],
      expiresInMinutes: 30,
    });

    const persisted = JSON.parse(rows.get(`contributor_invites:${invite.id}`));
    const rawSecret = token.slice(token.indexOf(".") + 1);

    expect(persisted.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(rawSecret);
    expect(persisted.allowedProviders).toEqual(["claude", "codex"]);
    expect(persisted.providerBaseUrls).toEqual({});
  });

  it("stores a normalized administrator-approved GitLab base URL on the invite", async () => {
    const { invite } = await store.createContributorInvite({
      alias: "self-hosted-gitlab",
      allowedProviders: ["gitlab"],
      providerBaseUrls: { gitlab: "http://127.0.0.1:8929/gitlab/" },
    });

    const persisted = JSON.parse(rows.get(`contributor_invites:${invite.id}`));
    expect(persisted.providerBaseUrls).toEqual({
      gitlab: "http://127.0.0.1:8929/gitlab",
    });
  });

  it.each([
    "file:///etc/passwd",
    "https://user:password@gitlab.example",
    "https://gitlab.example?redirect=http://127.0.0.1",
    "https://gitlab.example/#fragment",
  ])("rejects an unsafe administrator-supplied GitLab base URL: %s", async (gitlab) => {
    await expect(store.createContributorInvite({
      alias: "unsafe-gitlab",
      allowedProviders: ["gitlab"],
      providerBaseUrls: { gitlab },
    })).rejects.toThrow(/GitLab contributor base URL/);
    expect(rows.size).toBe(0);
  });

  it("allows a token to be claimed only once", async () => {
    const { token } = await store.createContributorInvite({
      alias: "one-shot",
      allowedProviders: ["claude"],
    });

    const first = await store.claimContributorToken(token);
    const second = await store.claimContributorToken(token);

    expect(first?.sessionId).toBeTruthy();
    expect(second).toBeNull();
  });

  it("atomically allows only one of two concurrent token claims", async () => {
    const { token } = await store.createContributorInvite({
      alias: "concurrent-claim",
      allowedProviders: ["claude"],
    });

    const results = await Promise.all([
      store.claimContributorToken(token),
      store.claimContributorToken(token),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it("rejects malformed or oversized tokens before DB lookup", async () => {
    const malformed = `${"a".repeat(10_000)}.${"b".repeat(10_000)}`;

    await expect(store.validateContributorToken(malformed)).resolves.toBeNull();
    await expect(store.claimContributorToken(malformed)).resolves.toBeNull();
    expect(dbGetCalls).toBe(0);
  });

  it("atomically reserves and consumes an invite with one session-bound lease", async () => {
    const { token } = await store.createContributorInvite({
      alias: "concurrent-completion",
      allowedProviders: ["claude"],
    });
    const claimed = await store.claimContributorToken(token);

    const reservations = await Promise.all([
      store.reserveContributorInvite(claimed.id, claimed.sessionId),
      store.reserveContributorInvite(claimed.id, claimed.sessionId),
    ]);
    const reservation = reservations.find(Boolean);
    expect(reservations.filter(Boolean)).toHaveLength(1);

    const ownership = { sessionId: claimed.sessionId, leaseId: reservation.leaseId };
    const consumed = await Promise.all([
      store.consumeContributorInvite(claimed.id, { id: "connection-a", provider: "claude" }, ownership),
      store.consumeContributorInvite(claimed.id, { id: "connection-b", provider: "claude" }, ownership),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect(consumed.filter((result) => result === false)).toHaveLength(1);

    const persisted = await store.getContributorInvite(claimed.id);
    expect(persisted).toMatchObject({ status: "used" });
    expect(["connection-a", "connection-b"]).toContain(persisted.connection.id);
    expect(persisted.completionLeaseHash).toBeNull();
  });

  it("keeps concurrent proxy consume and stop cancellation in terminal states", async () => {
    const { token } = await store.createContributorInvite({
      alias: "poll-stop-race",
      allowedProviders: ["claude"],
    });
    const claimed = await store.claimContributorToken(token);
    await store.reserveContributorInvite(claimed.id, claimed.sessionId);
    const resumed = await store.resumeContributorInviteReservation(claimed.id, claimed.sessionId);

    const outcomes = await Promise.all([
      store.consumeContributorInvite(
        claimed.id,
        { id: "callback-created", provider: "claude" },
        resumed.reservation,
      ),
      store.cancelContributorInviteReservation(claimed.id, resumed.reservation),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const persisted = await store.getContributorInvite(claimed.id);
    expect(["used", "revoked"]).toContain(persisted.status);
    expect(persisted.status).not.toBe("active");
    expect(persisted.completionLeaseHash).toBeNull();
    await expect(store.reserveContributorInvite(
      claimed.id,
      claimed.sessionId,
    )).resolves.toBeNull();
  });

  it("rolls back only the exact session-bound completion lease", async () => {
    const { token } = await store.createContributorInvite({
      alias: "conditional-rollback",
      allowedProviders: ["claude"],
    });
    const claimed = await store.claimContributorToken(token);
    const reserved = await store.reserveContributorInvite(claimed.id, claimed.sessionId);

    await expect(store.releaseContributorInviteReservation(claimed.id, {
      sessionId: claimed.sessionId,
      leaseId: "wrong-lease",
    })).resolves.toBe(false);
    expect((await store.getContributorInvite(claimed.id)).status).toBe("completing");

    await expect(store.releaseContributorInviteReservation(claimed.id, {
      sessionId: claimed.sessionId,
      leaseId: reserved.leaseId,
    })).resolves.toBe(true);
    expect((await store.getContributorInvite(claimed.id)).status).toBe("active");
  });

  it("does not let a stale resumed proxy lease release or consume a replacement lease", async () => {
    const { token } = await store.createContributorInvite({
      alias: "proxy-lease-aba",
      allowedProviders: ["claude"],
    });
    const claimed = await store.claimContributorToken(token);
    const first = await store.reserveContributorInvite(claimed.id, claimed.sessionId);
    const resumedFirst = await store.resumeContributorInviteReservation(claimed.id, claimed.sessionId);

    await expect(store.releaseContributorInviteReservation(claimed.id, {
      sessionId: claimed.sessionId,
      leaseId: first.leaseId,
    })).resolves.toBe(true);
    const second = await store.reserveContributorInvite(claimed.id, claimed.sessionId);

    await expect(store.releaseContributorInviteReservation(
      claimed.id,
      resumedFirst.reservation,
    )).resolves.toBe(false);
    await expect(store.consumeContributorInvite(
      claimed.id,
      { id: "stale-proxy-connection" },
      resumedFirst.reservation,
    )).resolves.toBe(false);
    expect((await store.getContributorInvite(claimed.id)).completionLeaseHash)
      .not.toBe(resumedFirst.reservation.leaseHash);

    await expect(store.consumeContributorInvite(
      claimed.id,
      { id: "replacement-connection" },
      { sessionId: claimed.sessionId, leaseId: second.leaseId },
    )).resolves.toBe(true);
    expect((await store.getContributorInvite(claimed.id)).connection.id)
      .toBe("replacement-connection");
  });

  it("lets an administrator revoke a stuck completion and invalidates its old lease", async () => {
    const { token } = await store.createContributorInvite({
      alias: "stuck-completion",
      allowedProviders: ["claude"],
    });
    const claimed = await store.claimContributorToken(token);
    const reserved = await store.reserveContributorInvite(claimed.id, claimed.sessionId);
    const ownership = { sessionId: claimed.sessionId, leaseId: reserved.leaseId };

    await expect(store.revokeContributorInvite(claimed.id)).resolves.toBe(true);
    const revoked = await store.getContributorInvite(claimed.id);
    expect(revoked).toMatchObject({ status: "revoked" });
    expect(revoked.completionLeaseHash).toBeNull();
    await expect(store.releaseContributorInviteReservation(claimed.id, ownership)).resolves.toBe(false);
    await expect(store.consumeContributorInvite(claimed.id, { id: "late" }, ownership)).resolves.toBe(false);
  });

  it("invalidates a resumed proxy lease when an administrator revokes completion", async () => {
    const { token } = await store.createContributorInvite({
      alias: "revoked-proxy-completion",
      allowedProviders: ["claude"],
    });
    const claimed = await store.claimContributorToken(token);
    await store.reserveContributorInvite(claimed.id, claimed.sessionId);
    const resumed = await store.resumeContributorInviteReservation(claimed.id, claimed.sessionId);

    await expect(store.revokeContributorInvite(claimed.id)).resolves.toBe(true);
    await expect(store.releaseContributorInviteReservation(
      claimed.id,
      resumed.reservation,
    )).resolves.toBe(false);
    await expect(store.consumeContributorInvite(
      claimed.id,
      { id: "late-proxy-connection" },
      resumed.reservation,
    )).resolves.toBe(false);
  });

  it("rejects malformed expiry data and incomplete completion leases", async () => {
    expect(store.isContributorSessionUsable({
      status: "active",
      sessionId: "session-1",
      expiresAt: "not-a-date",
    }, "session-1")).toBe(false);
    expect(store.isContributorSessionUsable({
      status: "completing",
      sessionId: "session-1",
      completionSessionId: "session-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, "session-1")).toBe(false);

    const { token } = await store.createContributorInvite({
      alias: "invalid-expiry-resume",
      allowedProviders: ["claude"],
    });
    const claimed = await store.claimContributorToken(token);
    await store.reserveContributorInvite(claimed.id, claimed.sessionId);
    const rowKey = `contributor_invites:${claimed.id}`;
    const persisted = JSON.parse(rows.get(rowKey));
    rows.set(rowKey, JSON.stringify({ ...persisted, expiresAt: "invalid" }));

    await expect(store.resumeContributorInviteReservation(
      claimed.id,
      claimed.sessionId,
    )).resolves.toBeNull();
  });

  it("allows a used invite only for explicitly requested owner observation", () => {
    const invite = {
      status: "used",
      sessionId: "session-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    expect(store.isContributorSessionUsable(invite, "session-1")).toBe(false);
    expect(store.isContributorSessionUsable(invite, "session-1", { allowUsed: true })).toBe(true);
    expect(store.isContributorSessionUsable(invite, "other-session", { allowUsed: true })).toBe(false);
  });

  it("rejects expired tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
    const { token } = await store.createContributorInvite({
      alias: "expiring",
      allowedProviders: ["codex"],
      expiresInMinutes: 5,
    });
    vi.setSystemTime(new Date("2026-08-02T00:06:00Z"));

    expect(await store.validateContributorToken(token)).toBeNull();
  });

  it("removes token hashes from admin listings", async () => {
    await store.createContributorInvite({
      alias: "safe-list",
      allowedProviders: ["claude"],
    });

    const [listed] = await store.listContributorInvites();
    expect(listed.alias).toBe("safe-list");
    expect(listed).not.toHaveProperty("tokenHash");
  });

  it("reports an expired completing invite as expired without lease metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
    const { token } = await store.createContributorInvite({
      alias: "expired-completion",
      allowedProviders: ["claude"],
      expiresInMinutes: 5,
    });
    const claimed = await store.claimContributorToken(token);
    await store.reserveContributorInvite(claimed.id, claimed.sessionId);
    vi.setSystemTime(new Date("2026-09-08T00:06:00Z"));

    const [listed] = await store.listContributorInvites();

    expect(listed.status).toBe("expired");
    expect(listed).not.toHaveProperty("completionLeaseHash");
    expect(listed).not.toHaveProperty("completionSessionId");
    expect(listed).not.toHaveProperty("completionStartedAt");
  });
});
