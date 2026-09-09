import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "contributor-secret-"));

vi.mock("@/lib/dataDir", () => ({ DATA_DIR: dataDir }));
vi.mock("@/lib/contributor/store", () => ({
  getContributorInvite: async () => null,
  isContributorSessionUsable: () => true,
}));

const secretFile = path.join(dataDir, "contributor-secret");

async function loadFreshModule() {
  vi.resetModules();
  return import("../../src/lib/contributor/session.js");
}

async function signWithCurrentSecret() {
  const { createContributorSession } = await loadFreshModule();
  return createContributorSession({
    id: "invite-1",
    sessionId: "session-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

describe("contributor session secret", () => {
  beforeEach(() => {
    fs.rmSync(secretFile, { force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the secret file with owner-only permissions", async () => {
    await signWithCurrentSecret();

    expect(fs.existsSync(secretFile)).toBe(true);
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
  });

  it("reuses the persisted secret across module reloads", async () => {
    await signWithCurrentSecret();
    const persisted = fs.readFileSync(secretFile, "utf8").trim();

    await signWithCurrentSecret();

    expect(fs.readFileSync(secretFile, "utf8").trim()).toBe(persisted);
  });

  it("regenerates a zero-length secret instead of signing with an empty key", async () => {
    fs.writeFileSync(secretFile, "   ", { mode: 0o600 });

    await expect(signWithCurrentSecret()).resolves.toBeTypeOf("string");
    expect(fs.readFileSync(secretFile, "utf8").trim().length).toBeGreaterThan(0);
  });

  it("propagates a read fault instead of silently rotating the live secret", async () => {
    fs.writeFileSync(secretFile, "existing-secret", { mode: 0o600 });
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    });

    await expect(signWithCurrentSecret()).rejects.toThrow(/permission denied/);

    readSpy.mockRestore();
    // The pre-existing secret must survive the failed read.
    expect(fs.readFileSync(secretFile, "utf8").trim()).toBe("existing-secret");
  });

  it("adopts the winning secret when a concurrent worker created it first", async () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, _data, options) => {
      // Simulate the exclusive-create race: another worker won.
      writeSpy.mockRestore();
      fs.writeFileSync(file, "winner-secret", options);
      const error = new Error("file already exists");
      error.code = "EEXIST";
      throw error;
    });

    await expect(signWithCurrentSecret()).resolves.toBeTypeOf("string");
    expect(fs.readFileSync(secretFile, "utf8").trim()).toBe("winner-secret");
  });
});
