import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map();

vi.mock("@/lib/db/driver", () => ({
  getAdapter: async () => ({
    run(_sql, params) {
      const [scope, key, value] = params;
      rows.set(`${scope}:${key}`, value);
      return { changes: 1 };
    },
    get(_sql, params) {
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
  }),
}));

const store = await import("../../src/lib/contributor/store.js");

describe("contributor invite store", () => {
  beforeEach(() => {
    rows.clear();
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
});
