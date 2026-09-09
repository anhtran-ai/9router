import { describe, expect, it } from "vitest";
import { __test__ } from "../../open-sse/services/combo.js";

const { parseRetryDeadline } = __test__;
const receivedAt = Date.parse("2026-09-09T12:00:00.000Z");

describe("combo retry deadline parsing", () => {
  it("keeps a numeric epoch retryAfter from the JSON error body", () => {
    const deadline = receivedAt + 30_000;

    expect(parseRetryDeadline(deadline, receivedAt)).toBe(deadline);
  });

  it("accepts an HTTP-date Retry-After header", () => {
    expect(parseRetryDeadline("Wed, 09 Sep 2026 12:00:30 GMT", receivedAt, true))
      .toBe(Date.parse("2026-09-09T12:00:30.000Z"));
  });

  it("treats a Retry-After delay-seconds value as relative", () => {
    expect(parseRetryDeadline("30", receivedAt, true)).toBe(receivedAt + 30_000);
  });

  it("rejects a bare numeric string from the JSON body as ambiguous", () => {
    expect(parseRetryDeadline("30", receivedAt)).toBeNull();
  });

  it("rejects a numeric value where delay-seconds are allowed", () => {
    // A header value is never a JS number; accepting one here would silently
    // reinterpret an epoch timestamp as a delay.
    expect(parseRetryDeadline(receivedAt + 30_000, receivedAt, true)).toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["unparseable text", "soon"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s", (_case, value) => {
    expect(parseRetryDeadline(value, receivedAt)).toBeNull();
  });
});
