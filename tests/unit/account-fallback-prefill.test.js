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
const { handleComboChat } = await import("../../open-sse/services/combo.js");
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

  it("falls through to the next combo model for the exact prefill 400", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(PREFILL_ERROR, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Start" }] },
      models: ["claude/claude-opus-5", "openai/gpt-5.6-sol"],
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      autoSwitch: false,
    });

    expect(response.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual([
      "claude/claude-opus-5",
      "openai/gpt-5.6-sol",
    ]);
  });

  it("stops combo fallback for another HTTP 400", async () => {
    const response400 = new Response(JSON.stringify({
      error: { type: "invalid_request_error", message: "max_tokens must be positive" },
    }), { status: 400, headers: { "Content-Type": "application/json" } });
    const handleSingleModel = vi.fn().mockResolvedValue(response400);

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Start" }] },
      models: ["claude/claude-opus-5", "openai/gpt-5.6-sol"],
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      autoSwitch: false,
    });

    expect(response).toBe(response400);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
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
