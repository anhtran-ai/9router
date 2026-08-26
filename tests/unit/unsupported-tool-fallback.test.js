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

const { checkFallbackError, isUnsupportedToolTypeError } = await import("../../open-sse/services/accountFallback.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const UNSUPPORTED_TOOL_ERROR = JSON.stringify({
  error: { message: "[codex/gpt-5.6-sol] [400]: {\"detail\":\"Unsupported tool type: web_search_preview\"}" },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "codex-a",
    provider: "codex",
    name: "codex-a",
    backoffLevel: 1,
  }]);
});

describe("unsupported hosted tool classification", () => {
  it("detects the upstream rejection without cooling the account down", () => {
    expect(isUnsupportedToolTypeError(400, UNSUPPORTED_TOOL_ERROR)).toBe(true);
    expect(checkFallbackError(400, UNSUPPORTED_TOOL_ERROR, 1)).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });

  it("does not mark the upstream account unavailable", async () => {
    await expect(markAccountUnavailable(
      "codex-a",
      400,
      UNSUPPORTED_TOOL_ERROR,
      "codex",
      "gpt-5.6-sol",
    )).resolves.toEqual({ shouldFallback: false, cooldownMs: 0 });

    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("falls through to the next combo model", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(UNSUPPORTED_TOOL_ERROR, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Start" }] },
      models: ["codex/gpt-5.6-sol", "claude/claude-opus-5"],
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      autoSwitch: false,
    });

    expect(response.ok).toBe(true);
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual([
      "codex/gpt-5.6-sol",
      "claude/claude-opus-5",
    ]);
  });

  it("keeps stopping the combo for unrelated HTTP 400s", async () => {
    const response400 = new Response(JSON.stringify({
      error: { message: "max_tokens must be positive" },
    }), { status: 400, headers: { "Content-Type": "application/json" } });
    const handleSingleModel = vi.fn().mockResolvedValue(response400);

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "Start" }] },
      models: ["codex/gpt-5.6-sol", "claude/claude-opus-5"],
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      autoSwitch: false,
    });

    expect(response).toBe(response400);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });
});
