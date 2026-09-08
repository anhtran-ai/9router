import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateShortId } from "../../src/lib/tunnel/shared/state.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tunnel short id generation", () => {
  it("uses a CSPRNG and preserves the worker-compatible hostname format", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not generate public route ids");
    });
    let next = 0;
    const randomInt = vi.spyOn(crypto, "randomInt").mockImplementation((max) => {
      expect(max).toBe(33);
      return next++ % max;
    });

    const id = generateShortId();
    expect(id).toBe("abcdef");
    expect(id).toMatch(/^[abcdefghijklmnpqrstuvwxyz23456789]{6}$/);
    expect(randomInt).toHaveBeenCalledTimes(6);
  });
});
