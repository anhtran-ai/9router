import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const PREFILL_ERROR = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "This model does not support assistant message prefill. The conversation must end with a user message.",
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "claude-a",
    provider: "claude",
    name: "claude-a",
    backoffLevel: 2,
  }]);
});

describe("assistant prefill error classification", () => {
  it("does not fallback or cooldown for Claude request-shape errors", () => {
    expect(checkFallbackError(400, PREFILL_ERROR, 2)).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });

  it("does not mark the Claude connection unavailable", async () => {
    await expect(markAccountUnavailable(
      "claude-a",
      400,
      PREFILL_ERROR,
      "claude",
      "claude-opus-4-6",
    )).resolves.toEqual({ shouldFallback: false, cooldownMs: 0 });

    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it.each([
    [429, "rate limit exceeded", 2_000, 1],
    [403, "quota exceeded", 2_000, 1],
    [401, "invalid token", 120_000, undefined],
    [503, "provider capacity exhausted", 2_000, 1],
    [502, "bad gateway", 30_000, undefined],
  ])("keeps fallback behavior for status %s", (status, message, cooldownMs, newBackoffLevel) => {
    expect(checkFallbackError(status, message)).toEqual({
      shouldFallback: true,
      cooldownMs,
      ...(newBackoffLevel === undefined ? {} : { newBackoffLevel }),
    });
  });
});
