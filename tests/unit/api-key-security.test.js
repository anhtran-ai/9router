import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateApiKeyWithMachine,
  parseApiKey,
  verifyApiKeyCrc,
} from "../../src/shared/utils/apiKey.js";

const machineId = "0123456789abcdef";

function legacyCrc(keyId) {
  return crypto
    .createHmac("sha256", process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret")
    .update(machineId + keyId)
    .digest("hex")
    .slice(0, 8);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API key generation hardening", () => {
  it("uses a 128-bit CSPRNG key id without consulting Math.random", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not generate credentials");
    });

    const generated = generateApiKeyWithMachine(machineId);
    expect(generated.keyId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseApiKey(generated.key)).toEqual({
      machineId,
      keyId: generated.keyId,
      isNewFormat: true,
    });
  });

  it("keeps existing six-character and legacy two-part keys parseable", () => {
    const keyId = "abc123";
    expect(parseApiKey(`sk-${machineId}-${keyId}-${legacyCrc(keyId)}`)).toEqual({
      machineId,
      keyId,
      isNewFormat: true,
    });
    expect(parseApiKey("sk-oldkey8")).toEqual({
      machineId: null,
      keyId: "oldkey8",
      isNewFormat: false,
    });
  });

  it("rejects malformed values and CRC changes", () => {
    const keyId = "abc123";
    const valid = `sk-${machineId}-${keyId}-${legacyCrc(keyId)}`;
    expect(verifyApiKeyCrc(valid)).toBe(true);
    const replacement = valid.endsWith("0") ? "1" : "0";
    expect(verifyApiKeyCrc(`${valid.slice(0, -1)}${replacement}`)).toBe(false);
    expect(parseApiKey({ startsWith: () => true })).toBeNull();
  });
});
