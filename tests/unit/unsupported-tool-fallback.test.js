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
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { translateRequest } = await import("../../open-sse/translator/index.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { ToolCompatibilityError } = await import("../../open-sse/translator/concerns/hostedToolPolicy.js");

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

async function runComboOutcomes(outcomes) {
  const handleSingleModel = vi.fn();
  for (const outcome of outcomes) {
    if (outcome instanceof Error) {
      handleSingleModel.mockRejectedValueOnce(outcome);
    } else if (outcome instanceof Response) {
      handleSingleModel.mockResolvedValueOnce(outcome);
    } else {
      handleSingleModel.mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: outcome.message },
        ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}),
      }), { status: outcome.status, headers: { "Content-Type": "application/json", ...outcome.headers } }));
    }
  }
  const response = await handleComboChat({
    body: { messages: [{ role: "user", content: "Start" }] },
    models: outcomes.map((_, index) => `codex/fallback-${index}`),
    handleSingleModel,
    log: { info: vi.fn(), warn: vi.fn() },
    autoSwitch: false,
  });
  return { response, handleSingleModel };
}

describe("exhausted combo error selection", () => {
  const unsupported = { status: 400, message: "Unsupported tool type: web_search_preview" };
  const rateLimited = { status: 429, message: "rate limit exceeded" };
  const unavailable = { status: 503, message: "Service temporarily unavailable" };

  it.each([
    ["unsupported tool then 429", [unsupported, rateLimited], rateLimited],
    ["429 then unsupported tool", [rateLimited, unsupported], rateLimited],
    ["unsupported tool then 503", [unsupported, unavailable], unavailable],
    ["503 then unsupported tool", [unavailable, unsupported], unavailable],
    ["multiple retryable failures", [rateLimited, unavailable], unavailable],
    ["only incompatible models", [unsupported, { status: 400, message: "Unknown tool type: file_search" }],
      { status: 400, message: "Unknown tool type: file_search" }],
    ["unsupported tool then exception", [unsupported, new Error("upstream connection closed")],
      { status: 500, message: "upstream connection closed" }],
    ["exception then unsupported tool", [new Error("upstream connection closed"), unsupported],
      { status: 500, message: "upstream connection closed" }],
    ["no credentials", [{ status: 404, message: "No credentials for provider A" },
      { status: 404, message: "No credentials for provider B" }],
      { status: 503, message: "No credentials for provider B" }],
  ])("keeps a coherent status/message for %s", async (_label, outcomes, expected) => {
    const { response, handleSingleModel } = await runComboOutcomes(outcomes);
    expect(handleSingleModel).toHaveBeenCalledTimes(outcomes.length);
    expect(response.status).toBe(expected.status);
    expect(await response.json()).toEqual({ error: { message: expected.message } });
  });

  it("keeps the earliest retry time while selecting a retryable error pair", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { response } = await runComboOutcomes([
        unsupported,
        { ...rateLimited, retryAfter: new Date(now + 30_000).toISOString() },
        { ...unavailable, retryAfter: new Date(now + 10_000).toISOString() },
        { ...rateLimited, message: "second rate limit", retryAfter: new Date(now + 20_000).toISOString() },
      ]);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("10");
      expect(await response.json()).toEqual({ error: { message: "second rate limit (reset after 10s)" } });
    } finally {
      clock.mockRestore();
    }
  });

  it("returns success after retryable and compatibility failures", async () => {
    const success = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const { response } = await runComboOutcomes([rateLimited, unsupported, success]);
    expect(response).toBe(success);
  });

  it("still stops at an ordinary terminal 400 after a retryable failure", async () => {
    const invalid = new Response(JSON.stringify({ error: { message: "max_tokens must be positive" } }), { status: 400 });
    const { response, handleSingleModel } = await runComboOutcomes([rateLimited, invalid, unavailable]);
    expect(response).toBe(invalid);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["actual app diagnostic", [{ status: 404, message: "No active credentials for provider: alpha" },
      { status: 404, message: "No active credentials for provider: beta" }],
      { status: 503, message: "No active credentials for provider: beta" }],
    ["real model 404 then missing credentials", [{ status: 404, message: "Model not found" },
      { status: 404, message: "No active credentials for provider: beta" }],
      { status: 404, message: "No active credentials for provider: beta" }],
    ["missing credentials then real model 404", [{ status: 404, message: "No active credentials for provider: alpha" },
      { status: 404, message: "Model not found" }], { status: 404, message: "Model not found" }],
    ["429 then missing credentials", [rateLimited, { status: 404, message: "No active credentials for provider: beta" }], rateLimited],
    ["503 then missing credentials", [unavailable, { status: 404, message: "No active credentials for provider: beta" }], unavailable],
    ["quoted diagnostic is not route unavailability", [{ status: 404, message: "Unknown model: no credentials for provider X" }],
      { status: 404, message: "Unknown model: no credentials for provider X" }],
  ])("only normalizes genuinely unavailable combos: %s", async (_label, outcomes, expected) => {
    const { response } = await runComboOutcomes(outcomes);
    expect(response.status).toBe(expected.status);
    expect((await response.json()).error.message).toBe(expected.message);
  });

  it("aggregates header seconds, HTTP dates, and legacy JSON as valid deadlines", async () => {
    const now = Date.parse("2026-08-26T03:30:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { response } = await runComboOutcomes([
        { ...rateLimited, retryAfter: "not-a-date" },
        { ...rateLimited, headers: { "Retry-After": "30" } },
        { ...unavailable, headers: { "Retry-After": new Date(now + 10_000).toUTCString() } },
        { ...rateLimited, retryAfter: new Date(now + 20_000).toISOString() },
      ]);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("10");
    } finally { clock.mockRestore(); }
  });

  it.each(["-1", "1.5", "Infinity", "invalid", "9999999999999999999999999"])(
    "ignores invalid HTTP Retry-After %s and retains legacy JSON timing", async (value) => {
      const now = Date.parse("2026-08-26T03:30:00Z");
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const { response } = await runComboOutcomes([
          { ...rateLimited, headers: { "Retry-After": value }, retryAfter: new Date(now + 15_000).toISOString() },
        ]);
        expect(response.headers.get("Retry-After")).toBe("15");
      } finally { clock.mockRestore(); }
    },
  );

  it("does not emit NaN retry timing for invalid JSON dates", async () => {
    const { response } = await runComboOutcomes([{ ...rateLimited, retryAfter: "not-a-date" }]);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect((await response.json()).error.message).toBe(rateLimited.message);
  });

  it.each(["0", "Tue, 25 Aug 2026 03:30:00 GMT"])("handles an already-due Retry-After %s without invalid timing", async (value) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-26T03:30:00Z"));
    try {
      const { response } = await runComboOutcomes([{ ...rateLimited, headers: { "Retry-After": value } }]);
      expect(response.headers.get("Retry-After")).toBe("1");
    } finally { clock.mockRestore(); }
  });
});

describe("hosted tool preservation across combo attempts", () => {
  it("keeps the same request's native Claude tool restrictions after a Codex failure", async () => {
    const hostedTool = {
      type: "web_search_20250305", name: "web_search",
      allowed_domains: ["example.org"], max_uses: 1,
    };
    const body = {
      model: "combo", max_tokens: 256, stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Search the allowed site" }] }],
      tools: [hostedTool],
    };
    const originalTools = structuredClone(body.tools);
    let claudeRequest, compatibilityError;
    const handleSingleModel = vi.fn(async (sameBody, model) => {
      expect(sameBody).toBe(body);
      if (model.startsWith("codex/")) {
        // Match the handler/native-passthrough shallow envelopes; do not clone
        // the tools per leg or this test would hide cross-attempt mutations.
        const codexRequest = { ...sameBody, model: "gpt-5.6-sol" };
        try {
          new CodexExecutor().transformRequest("gpt-5.6-sol", codexRequest, true, {
            connectionId: "offline-combo-test", providerSpecificData: {},
          });
        } catch (error) { compatibilityError = error; }
        return new Response(JSON.stringify({ error: { message: compatibilityError?.message || "fixture constraint was not rejected", code: compatibilityError?.code } }), { status: 400 });
      }
      claudeRequest = translateRequest(
        FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-opus-5",
        { ...sameBody, model }, true, null, "claude",
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleComboChat({
      body, models: ["codex/gpt-5.6-sol", "claude/claude-opus-5"],
      handleSingleModel, log: { info: vi.fn(), warn: vi.fn() }, autoSwitch: false,
    });

    expect(response.ok).toBe(true);
    expect(compatibilityError).toBeInstanceOf(ToolCompatibilityError);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(body.tools).toEqual(originalTools);
    expect(claudeRequest.tools[0]).toMatchObject(originalTools[0]);
  });
});
