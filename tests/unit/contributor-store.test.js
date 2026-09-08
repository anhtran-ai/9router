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
