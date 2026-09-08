import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  connections: [], updates: [], execute: vi.fn(), refresh: vi.fn(), pending: vi.fn(), noAuth: true,
  quotaError: vi.fn(), clearQuotaStrikes: vi.fn(),
  beginQuotaAttempt: vi.fn(), endQuotaAttempt: vi.fn(),
  isQuotaAttemptSuperseded: vi.fn(), canQuotaAttemptClearFailure: vi.fn(), recordQuotaAttemptFailure: vi.fn(),
  latestQuotaSuccessId: 0, newestQuotaFailureId: 0,
  readConnections: vi.fn(), readSettings: vi.fn(), writeConnection: vi.fn(),
  projectId: vi.fn(),
  models: ["openrouter/model-a", "deepseek/model-b"],
  settings: { requireApiKey: false, comboStrategy: "fallback" },
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: state.execute, refreshCredentials: state.refresh, noAuth: state.noAuth }),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: (...args) => state.readSettings(...args),
  getProviderConnections: (...args) => state.readConnections(...args),
  updateProviderConnection: (...args) => state.writeConnection(...args),
  getProxyPools: vi.fn(async () => []), validateApiKey: vi.fn(async () => false),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})), pickProxyPoolId: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (name) => name }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(),
  tagForSession: vi.fn(() => ""), nextTag: vi.fn(() => ""), line: vi.fn(), errorLine: vi.fn(), fmtThink: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async (name) => ({ provider: name.split("/")[0], model: name.split("/")[1] })),
  getComboModels: vi.fn(async (name) => name === "test-combo" ? state.models : null),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: vi.fn(), checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials) }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: state.quotaError,
  clearAntigravityStrikes: state.clearQuotaStrikes,
  beginAntigravityQuotaAttempt: state.beginQuotaAttempt,
  endAntigravityQuotaAttempt: state.endQuotaAttempt,
  isAntigravityQuotaAttemptSuperseded: state.isQuotaAttemptSuperseded,
  canAntigravityQuotaAttemptClearFailure: state.canQuotaAttemptClearFailure,
  recordAntigravityQuotaAttemptFailure: state.recordQuotaAttemptFailure,
  getAntigravityQuotaCache: vi.fn(() => new Map()),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://example.invalid" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: state.projectId }));
vi.mock("open-sse/utils/requestLogger.js", () => ({
  sanitizeUrl: (url) => url,
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: state.pending, appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

import { getRotatedModels, resetComboRotation, handleComboChat } from "../../open-sse/services/combo.js";
import { handleChat } from "../../src/sse/handlers/chat.js";
import {
  ACCOUNT_MUTATION_STATE_MAX_ENTRIES,
  __getAccountMutationStateStatsForTests,
  beginAccountMutationAttempt,
  clearAccountError,
  endAccountMutationAttempt,
  getProviderCredentials,
  markAccountUnavailable,
  recordAccountMutationSuccess,
} from "../../src/sse/services/auth.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { ToolCompatibilityError } from "../../open-sse/translator/concerns/hostedToolPolicy.js";
import * as translator from "../../open-sse/translator/index.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});

const fixedNow = Date.parse("2026-08-26T03:30:00Z");
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const makeConnection = (provider, extra = {}) => ({
  id: `fixture-${provider}`, name: `fixture-${provider}`, provider, isActive: true,
  testStatus: "active", authType: "apikey", providerSpecificData: {}, ...extra,
});
const makeRequest = (model = "test-combo", signal, extra = {}) => new Request("http://127.0.0.1/api/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "offline fixture" }], stream: false, ...extra }),
  ...(signal ? { signal } : {}),
});
const executorResult = (response = new Response(JSON.stringify({
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
}), { headers: { "Content-Type": "application/json" } })) => ({
  response, url: "https://example.invalid/chat", headers: {}, transformedBody: {},
});
const runCore = (extra = {}) => handleChatCore({
  body: { model: "model-a", messages: [{ role: "user", content: "offline fixture" }], stream: false },
  modelInfo: { provider: "openrouter", model: "model-a" },
  credentials: { connectionId: "fixture-openrouter", providerSpecificData: {} },
  connectionId: "fixture-openrouter", sourceFormatOverride: "openai", log, ...extra,
});

describe("actual app, account selection, core and combo boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.connections = []; state.updates = []; state.noAuth = true;
    state.models = ["openrouter/model-a", "deepseek/model-b"];
    state.settings = { requireApiKey: false, comboStrategy: "fallback" };
    state.readSettings.mockReset().mockImplementation(async () => state.settings);
    state.readConnections.mockReset().mockImplementation(async ({ provider, isActive } = {}) => structuredClone(state.connections.filter(
      (connection) => (!provider || connection.provider === provider) && (isActive === undefined || connection.isActive === isActive),
    )));
    state.writeConnection.mockReset().mockImplementation(async (id, update, options = {}) => {
      if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException("Request aborted", "AbortError");
      if (options?.shouldCommit && !options.shouldCommit()) return null;
      options?.beforeCommit?.();
      if (options?.shouldCommit && !options.shouldCommit()) return null;
      state.updates.push({ id, ...structuredClone(update) });
      Object.assign(state.connections.find((connection) => connection.id === id) || {}, update);
      options?.afterCommit?.();
    });
    let quotaAttemptId = 0;
    state.latestQuotaSuccessId = 0;
    state.newestQuotaFailureId = 0;
    state.beginQuotaAttempt.mockReset().mockImplementation((connectionId, model) => ({ key: `${connectionId}|${model}`, id: ++quotaAttemptId }));
    state.endQuotaAttempt.mockReset();
    state.execute.mockReset().mockImplementation(async () => executorResult());
    state.refresh.mockReset();
    state.projectId.mockReset().mockResolvedValue(null);
    state.quotaError.mockReset().mockImplementation(async (...args) => {
      const attempt = args.at(-1);
      if (attempt?.id) state.newestQuotaFailureId = Math.max(state.newestQuotaFailureId, attempt.id);
      return null;
    });
    state.clearQuotaStrikes.mockReset().mockImplementation((_connectionId, _model, attempt) => {
      if (!attempt?.id) return;
      state.latestQuotaSuccessId = Math.max(state.latestQuotaSuccessId, attempt.id);
      if (attempt.id >= state.newestQuotaFailureId) state.newestQuotaFailureId = 0;
    });
    state.isQuotaAttemptSuperseded.mockReset().mockImplementation((attempt) => (
      Boolean(attempt?.id && state.latestQuotaSuccessId > attempt.id)
    ));
    state.canQuotaAttemptClearFailure.mockReset().mockImplementation((attempt) => (
      !attempt?.id || attempt.id >= state.newestQuotaFailureId
    ));
    state.recordQuotaAttemptFailure.mockReset().mockImplementation((attempt) => {
      if (attempt?.id) state.newestQuotaFailureId = Math.max(state.newestQuotaFailureId, attempt.id);
    });
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps the earliest actual account Retry-After header on combo exhaustion", async () => {
    state.connections = [
      makeConnection("openrouter", { "modelLock_model-a": new Date(fixedNow + 30_000).toISOString(), lastError: "quota", errorCode: 429 }),
      makeConnection("deepseek", { "modelLock_model-b": new Date(fixedNow + 10_000).toISOString(), lastError: "quota", errorCode: 429 }),
    ];
    const single = await handleChat(makeRequest("openrouter/model-a"));
    const combo = await handleChat(makeRequest());
    expect(single.headers.get("Retry-After")).toBe("30");
    expect(combo.status).toBe(429);
    expect(combo.headers.get("Retry-After")).toBe("10");
    expect((await combo.json()).error.message.match(/\(reset after 10s\)/g)).toHaveLength(1);
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("normalizes the actual all-missing-credentials diagnostic to503", async () => {
    const response = await handleChat(makeRequest());
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toBe("No active credentials for provider: deepseek");
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("never dispatches a pre-aborted Request", async () => {
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek")];
    const client = new AbortController(); client.abort();
    const response = await handleChat(makeRequest("test-combo", client.signal));
    expect(response.status).toBe(499);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("propagates Request abort to the actual executor and stops account/model fallback", async () => {
    state.connections = [makeConnection("openrouter"), makeConnection("openrouter", { id: "second-account" }), makeConnection("deepseek")];
    const client = new AbortController();
    const aborted = vi.fn(); let executorSignal;
    state.execute.mockImplementation(async ({ signal }) => {
      executorSignal = signal;
      signal.addEventListener("abort", aborted, { once: true });
      client.abort();
      // Always settle the offline fake, including the pre-fix unconnected-signal case.
      throw new DOMException("fixture abort", "AbortError");
    });
    const response = await handleChat(makeRequest("test-combo", client.signal));
    expect(executorSignal.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(499);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual([]);
  });

  it("preserves selection mutex ordering but skips round-robin writes for an aborted waiter", async () => {
    state.connections = [makeConnection("openrouter")];
    state.settings = { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 };
    let releaseFirstSettings;
    let markFirstSettingsStarted;
    const firstSettingsStarted = new Promise((resolve) => { markFirstSettingsStarted = resolve; });
    let settingsReads = 0;
    state.readSettings.mockImplementation(async () => {
      settingsReads += 1;
      if (settingsReads === 1) {
        markFirstSettingsStarted();
        await new Promise((resolve) => { releaseFirstSettings = resolve; });
      }
      return state.settings;
    });

    const first = getProviderCredentials("openrouter", null, "model-a");
    await firstSettingsStarted;
    const client = new AbortController();
    const abortedWaiter = getProviderCredentials("openrouter", null, "model-a", { signal: client.signal });
    client.abort();
    releaseFirstSettings();

    await expect(first).resolves.toMatchObject({ connectionId: "fixture-openrouter" });
    await expect(abortedWaiter).rejects.toMatchObject({ name: "AbortError" });
    expect(state.readConnections).toHaveBeenCalledTimes(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ id: "fixture-openrouter", consecutiveUseCount: 1 });
  });

  it("propagates a fusion quorum abort to the real straggler executor before judging", async () => {
    state.models = ["openrouter/model-a", "deepseek/model-b", "openrouter/model-slow"];
    state.settings = {
      requireApiKey: false,
      comboStrategy: "fusion",
      comboStrategies: {
        "test-combo": {
          fallbackStrategy: "fusion",
          judgeModel: "openrouter/model-judge",
          fusionTuning: { minPanel: 2, stragglerGraceMs: 5, panelHardTimeoutMs: 1000 },
        },
      },
    };
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek")];

    let slowAborted = false;
    let judgeObservedAbort = false;
    state.execute.mockImplementation(async ({ model, signal }) => {
      if (model === "model-slow") {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            slowAborted = true;
            reject(new DOMException("fusion straggler aborted", "AbortError"));
          }, { once: true });
        });
      }
      if (model === "model-judge") judgeObservedAbort = slowAborted;
      return executorResult(new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: `answer-${model}` }, finish_reason: "stop" }],
      }), { headers: { "Content-Type": "application/json" } }));
    });

    const response = await handleChat(makeRequest("test-combo"));

    expect(response.status).toBe(200);
    expect(slowAborted).toBe(true);
    expect(judgeObservedAbort).toBe(true);
    expect(state.execute.mock.calls.some(([{ model }]) => model === "model-judge")).toBe(true);
    expect(state.clearQuotaStrikes).not.toHaveBeenCalledWith("fixture-openrouter", "model-slow");
    expect(state.quotaError).not.toHaveBeenCalled();
  });

  it("does not write cooldown after quorum aborts a panel paused in the auth DB read", async () => {
    vi.useFakeTimers();
    state.models = ["openrouter/model-fast-a", "deepseek/model-fast-b", "antigravity/model-slow"];
    state.settings = {
      requireApiKey: false,
      comboStrategy: "fusion",
      comboStrategies: {
        "test-combo": {
          fallbackStrategy: "fusion",
          judgeModel: "openrouter/model-judge",
          fusionTuning: { minPanel: 2, stragglerGraceMs: 5, panelHardTimeoutMs: 90_000 },
        },
      },
    };
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek"), makeConnection("antigravity")];

    let releaseMarkRead;
    let markReadStarted;
    const started = new Promise((resolve) => { markReadStarted = resolve; });
    const defaultRead = state.readConnections.getMockImplementation();
    state.readConnections.mockImplementation(async (query = {}) => {
      if (query.provider === "antigravity" && query.isActive === undefined) {
        markReadStarted();
        await new Promise((resolve) => { releaseMarkRead = resolve; });
      }
      return defaultRead(query);
    });
    let markSlowEnded;
    const slowEnded = new Promise((resolve) => { markSlowEnded = resolve; });
    state.endQuotaAttempt.mockImplementation((attempt) => {
      if (attempt?.key === "fixture-antigravity|model-slow") markSlowEnded();
    });
    state.execute.mockImplementation(async ({ model }) => {
      if (model === "model-slow") {
        return executorResult(new Response(JSON.stringify({ error: { message: "fixture overloaded" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return executorResult(new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: `answer-${model}` }, finish_reason: "stop" }],
      }), { headers: { "Content-Type": "application/json" } }));
    });

    try {
      const pending = handleChat(makeRequest("test-combo"));
      await started;
      await vi.advanceTimersByTimeAsync(5);
      const response = await pending;
      expect(response.status).toBe(200);

      releaseMarkRead();
      await slowEnded;
      expect(state.updates.some(({ id }) => id === "fixture-antigravity")).toBe(false);
      expect(state.quotaError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records Antigravity success before an account-cleanup rejection", async () => {
    state.connections = [makeConnection("antigravity", {
      testStatus: "unavailable",
      lastError: "old failure",
      errorCode: 429,
    })];
    let markCleanupStarted;
    const cleanupStarted = new Promise((resolve) => { markCleanupStarted = resolve; });
    state.writeConnection.mockImplementation(async () => {
      markCleanupStarted();
      throw new Error("fixture DB cleanup failure");
    });

    const response = await handleChat(makeRequest("antigravity/model-a"));
    await cleanupStarted;

    expect(response.status).toBe(200);
    expect(state.clearQuotaStrikes).toHaveBeenCalledWith(
      "fixture-antigravity",
      "model-a",
      expect.objectContaining({ key: "fixture-antigravity|model-a" }),
    );
    expect(state.clearQuotaStrikes.mock.invocationCallOrder[0])
      .toBeLessThan(state.writeConnection.mock.invocationCallOrder[0]);
  });

  it("does not record Antigravity streaming success from headers alone", async () => {
    state.connections = [makeConnection("antigravity")];
    state.execute.mockImplementationOnce(async () => executorResult(new Response(new ReadableStream({
      start() {
        // Valid streaming headers with no terminal event: success cleanup must
        // wait for the stream contract to complete, not the initial 200.
      },
    }), { headers: { "Content-Type": "text/event-stream" } })));

    const response = await handleChat(makeRequest("antigravity/model-a", undefined, { stream: true }));
    expect(response.status).toBe(200);
    expect(state.clearQuotaStrikes).not.toHaveBeenCalled();
    await response.body.cancel();
    expect(state.clearQuotaStrikes).not.toHaveBeenCalled();
  });

  it("stops Antigravity quota refresh and account fallback when the request aborts", async () => {
    state.connections = [
      makeConnection("antigravity", { id: "ag-first" }),
      makeConnection("antigravity", { id: "ag-second" }),
    ];
    state.execute.mockResolvedValueOnce(executorResult(new Response(
      JSON.stringify({ error: { message: "quota exhausted" } }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    )));

    let quotaStarted;
    const started = new Promise(resolve => { quotaStarted = resolve; });
    state.quotaError.mockImplementation((...args) => {
      const signal = args.at(-2);
      quotaStarted();
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    });

    const client = new AbortController();
    const pending = handleChat(makeRequest("antigravity/model-a", client.signal));
    await started;
    client.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(state.quotaError).toHaveBeenCalledTimes(1);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual([]);
  });

  it("skips a stale Antigravity cooldown but continues account fallback after a newer success", async () => {
    state.connections = [
      makeConnection("antigravity"),
      makeConnection("antigravity", { id: "ag-second" }),
    ];
    state.execute
      .mockResolvedValueOnce(executorResult(new Response(
        JSON.stringify({ error: { message: "older quota error" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )))
      .mockResolvedValueOnce(executorResult());
    let releaseOlderQuota;
    let markOlderQuotaStarted;
    const olderQuotaStarted = new Promise((resolve) => { markOlderQuotaStarted = resolve; });
    state.quotaError.mockImplementation(async () => {
      markOlderQuotaStarted();
      await new Promise((resolve) => { releaseOlderQuota = resolve; });
      return null;
    });

    const older = handleChat(makeRequest("antigravity/model-a"));
    await olderQuotaStarted;
    const newerResponse = await handleChat(makeRequest("antigravity/model-a"));
    expect(newerResponse.status).toBe(200);

    releaseOlderQuota();
    const olderResponse = await older;
    expect(olderResponse.status).toBe(200);
    expect(state.execute).toHaveBeenCalledTimes(3);
    expect(state.updates).toEqual([]);
    expect(state.isQuotaAttemptSuperseded).toHaveReturnedWith(true);
  });

  it("does not let an older success cleanup erase a newer Antigravity DB lock", async () => {
    state.connections = [makeConnection("antigravity", {
      testStatus: "unavailable",
      lastError: "expired failure",
      errorCode: 429,
      "modelLock_model-a": new Date(fixedNow - 1_000).toISOString(),
    })];
    state.execute
      .mockResolvedValueOnce(executorResult())
      .mockResolvedValueOnce(executorResult(new Response(
        JSON.stringify({ error: { message: "newer provider error" } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      )));

    let releaseOlderCleanupRead;
    let markOlderCleanupReadStarted;
    const olderCleanupReadStarted = new Promise((resolve) => { markOlderCleanupReadStarted = resolve; });
    let unfilteredReads = 0;
    const defaultRead = state.readConnections.getMockImplementation();
    state.readConnections.mockImplementation(async (query = {}) => {
      if (query.provider === "antigravity" && query.isActive === undefined) {
        unfilteredReads += 1;
        if (unfilteredReads === 1) {
          markOlderCleanupReadStarted();
          await new Promise((resolve) => { releaseOlderCleanupRead = resolve; });
        }
      }
      return defaultRead(query);
    });
    let markRejectedCleanupGuardSeen;
    const rejectedCleanupGuardSeen = new Promise((resolve) => { markRejectedCleanupGuardSeen = resolve; });
    state.canQuotaAttemptClearFailure.mockImplementation((attempt) => {
      const canClear = !attempt?.id || attempt.id >= state.newestQuotaFailureId;
      if (!canClear && attempt?.id === 1) markRejectedCleanupGuardSeen();
      return canClear;
    });

    const olderSuccess = await handleChat(makeRequest("antigravity/model-a"));
    expect(olderSuccess.status).toBe(200);
    await olderCleanupReadStarted;

    const newerFailure = await handleChat(makeRequest("antigravity/model-a"));
    expect(newerFailure.status).toBe(503);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      id: "fixture-antigravity",
      testStatus: "unavailable",
      errorCode: 503,
    });
    expect(state.recordQuotaAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));

    releaseOlderCleanupRead();
    await rejectedCleanupGuardSeen;
    await Promise.resolve();
    expect(state.updates).toHaveLength(1);
    expect(state.connections[0]["modelLock_model-a"]).not.toBeNull();
    expect(state.connections[0].testStatus).toBe("unavailable");
  });

  it("does not let an older Antigravity failure overwrite a newer failure at the DB boundary", async () => {
    state.connections = [makeConnection("antigravity")];
    state.execute
      .mockResolvedValueOnce(executorResult(new Response(
        JSON.stringify({ error: { message: "older overload" } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      )))
      .mockResolvedValueOnce(executorResult(new Response(
        JSON.stringify({ error: { message: "newer auth failure" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )));

    let releaseOlderWrite;
    let markOlderWriteStarted;
    const olderWriteStarted = new Promise((resolve) => { markOlderWriteStarted = resolve; });
    const defaultWrite = state.writeConnection.getMockImplementation();
    state.writeConnection.mockImplementation(async (id, update, options = {}) => {
      if (update.errorCode === 503) {
        markOlderWriteStarted();
        await new Promise((resolve) => { releaseOlderWrite = resolve; });
      }
      return defaultWrite(id, update, options);
    });

    const older = handleChat(makeRequest("antigravity/model-a"));
    await olderWriteStarted;

    const newerResponse = await handleChat(makeRequest("antigravity/model-a"));
    expect(newerResponse.status).toBe(401);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      id: "fixture-antigravity",
      testStatus: "unavailable",
      errorCode: 401,
      lastError: "[401]: newer auth failure",
    });

    releaseOlderWrite();
    const olderResponse = await older;
    expect(olderResponse.status).toBe(503);
    expect(state.updates).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({
      testStatus: "unavailable",
      errorCode: 401,
      lastError: "[401]: newer auth failure",
    });
    expect(state.recordQuotaAttemptFailure).toHaveBeenCalledTimes(1);
    expect(state.recordQuotaAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });

  it("does not let an older non-Antigravity success clear a newer failure", async () => {
    state.connections = [makeConnection("openrouter", {
      testStatus: "unavailable",
      lastError: "expired failure",
      errorCode: 429,
      "modelLock_model-a": new Date(fixedNow - 1_000).toISOString(),
    })];
    state.execute
      .mockResolvedValueOnce(executorResult())
      .mockResolvedValueOnce(executorResult(new Response(
        JSON.stringify({ error: { message: "newer auth failure" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )));

    let releaseOlderCleanupRead;
    let markOlderCleanupReadStarted;
    let markOlderCleanupReadFinished;
    const olderCleanupReadStarted = new Promise((resolve) => { markOlderCleanupReadStarted = resolve; });
    const olderCleanupReadFinished = new Promise((resolve) => { markOlderCleanupReadFinished = resolve; });
    let unfilteredReads = 0;
    const defaultRead = state.readConnections.getMockImplementation();
    state.readConnections.mockImplementation(async (query = {}) => {
      if (query.provider === "openrouter" && query.isActive === undefined) {
        unfilteredReads += 1;
        if (unfilteredReads === 1) {
          markOlderCleanupReadStarted();
          await new Promise((resolve) => { releaseOlderCleanupRead = resolve; });
          markOlderCleanupReadFinished();
        }
      }
      return defaultRead(query);
    });

    const olderSuccess = await handleChat(makeRequest("openrouter/model-a"));
    expect(olderSuccess.status).toBe(200);
    await olderCleanupReadStarted;

    const newerFailure = await handleChat(makeRequest("openrouter/model-a"));
    expect(newerFailure.status).toBe(401);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      id: "fixture-openrouter",
      testStatus: "unavailable",
      errorCode: 401,
      lastError: "[401]: newer auth failure",
    });

    releaseOlderCleanupRead();
    await olderCleanupReadFinished;
    // Let clearAccountError resume from the DB read and evaluate its boundary guard.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.updates).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({
      testStatus: "unavailable",
      errorCode: 401,
      lastError: "[401]: newer auth failure",
    });
    expect(state.connections[0]["modelLock_model-a"]).not.toBeNull();
  });

  it("does not retain a phantom failure watermark after a DB transaction error", async () => {
    const connection = makeConnection("openrouter", {
      testStatus: "unavailable",
      lastError: "expired failure",
      errorCode: 503,
      "modelLock_model-a": new Date(fixedNow - 1_000).toISOString(),
    });
    state.connections = [connection];
    const olderSuccess = beginAccountMutationAttempt(connection.id, "model-a");
    const newerFailure = beginAccountMutationAttempt(connection.id, "model-a");
    const defaultWrite = state.writeConnection.getMockImplementation();
    state.writeConnection.mockImplementationOnce(async (_id, _update, options = {}) => {
      options?.beforeCommit?.();
      throw new Error("fixture DB transaction failed");
    });

    await expect(markAccountUnavailable(
      connection.id,
      503,
      "newer upstream failure",
      "openrouter",
      "model-a",
      null,
      { mutationAttempt: newerFailure },
    )).rejects.toThrow("fixture DB transaction failed");

    state.writeConnection.mockImplementation(defaultWrite);
    await clearAccountError(connection.id, { _connection: connection }, "model-a", {
      mutationAttempt: olderSuccess,
    });

    expect(state.updates).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({
      testStatus: "active",
      lastError: null,
      errorCode: null,
      "modelLock_model-a": null,
    });
    endAccountMutationAttempt(olderSuccess);
    endAccountMutationAttempt(newerFailure);
  });

  it("keeps retry classification when a newer success supersedes the cooldown write", async () => {
    const connection = makeConnection("openrouter");
    state.connections = [connection];
    const olderFailure = beginAccountMutationAttempt(connection.id, "model-a");
    const newerSuccess = beginAccountMutationAttempt(connection.id, "model-a");
    recordAccountMutationSuccess(newerSuccess);

    const result = await markAccountUnavailable(
      connection.id,
      503,
      "older provider overload",
      "openrouter",
      "model-a",
      null,
      { mutationAttempt: olderFailure },
    );

    expect(result).toMatchObject({
      shouldFallback: true,
      cooldownMs: expect.any(Number),
      superseded: true,
    });
    expect(result.cooldownMs).toBeGreaterThan(0);
    expect(state.updates).toEqual([]);
    endAccountMutationAttempt(olderFailure);
    endAccountMutationAttempt(newerSuccess);
  });

  it("caps dormant mutation watermarks created by unbounded model names", async () => {
    const connectionId = "cardinality-fixture";
    const connection = makeConnection("openrouter", { id: connectionId });
    // Start from an expired/swept map so the oldest retained generation below
    // is deterministic even when earlier cases exercised account failures.
    vi.mocked(Date.now).mockReturnValue(fixedNow + 366 * 24 * 60 * 60 * 1000);
    expect(__getAccountMutationStateStatsForTests().activeEntries).toBe(0);
    vi.mocked(Date.now).mockReturnValue(fixedNow);
    state.readConnections.mockImplementation(async () => [connection]);
    state.writeConnection.mockImplementation(async (id, _update, options = {}) => {
      if (options?.shouldCommit && !options.shouldCommit()) return null;
      options?.beforeCommit?.();
      if (options?.shouldCommit && !options.shouldCommit()) return null;
      const result = { id };
      options?.afterCommit?.(result);
      return result;
    });

    // A prior failure retains the key after the streaming request wrapper
    // returns. Its success callback is deliberately delayed until after cap
    // eviction and reuse of this exact model key.
    const priorFailure = beginAccountMutationAttempt(connectionId, "victim-model");
    await markAccountUnavailable(
      connectionId, 503, "fixture overload", null, "victim-model", null,
      { mutationAttempt: priorFailure },
    );
    endAccountMutationAttempt(priorFailure);
    const lateStreamingSuccess = beginAccountMutationAttempt(connectionId, "victim-model");
    endAccountMutationAttempt(lateStreamingSuccess);

    // This attempt predates cap eviction but remains active. The tombstone is
    // only a fallback for missing states and must not invalidate live work.
    const activeAttempt = beginAccountMutationAttempt("active-cardinality-fixture", "active-model");

    for (let index = 0; index < ACCOUNT_MUTATION_STATE_MAX_ENTRIES + 16; index += 1) {
      const attempt = beginAccountMutationAttempt(connectionId, `attacker-model-${index}`);
      const result = await markAccountUnavailable(
        connectionId,
        503,
        "fixture overload",
        null,
        `attacker-model-${index}`,
        null,
        { mutationAttempt: attempt },
      );
      expect(result.shouldFallback).toBe(true);
      endAccountMutationAttempt(attempt);
    }

    expect(__getAccountMutationStateStatsForTests()).toMatchObject({
      size: ACCOUNT_MUTATION_STATE_MAX_ENTRIES,
      activeEntries: 2,
      dormantEntries: ACCOUNT_MUTATION_STATE_MAX_ENTRIES - 2,
    });

    const writesBeforeActiveFailure = state.writeConnection.mock.calls.length;
    const activeResult = await markAccountUnavailable(
      "active-cardinality-fixture",
      503,
      "active request overload",
      null,
      "active-model",
      null,
      { mutationAttempt: activeAttempt },
    );
    expect(activeResult).toMatchObject({ shouldFallback: true });
    expect(activeResult.superseded).toBeUndefined();
    expect(state.writeConnection).toHaveBeenCalledTimes(writesBeforeActiveFailure + 1);
    endAccountMutationAttempt(activeAttempt);

    // Reusing an evicted key starts a new generation. A callback from the old
    // generation must not clear the replacement failure.
    const replacementFailure = beginAccountMutationAttempt(connectionId, "victim-model");
    await markAccountUnavailable(
      connectionId, 503, "replacement overload", null, "victim-model", null,
      { mutationAttempt: replacementFailure },
    );
    endAccountMutationAttempt(replacementFailure);
    const writesBeforeLateSuccess = state.writeConnection.mock.calls.length;
    recordAccountMutationSuccess(lateStreamingSuccess);
    await clearAccountError(
      connectionId,
      {
        _connection: {
          ...connection,
          testStatus: "unavailable",
          lastError: "replacement overload",
          "modelLock_victim-model": new Date(fixedNow + 30_000).toISOString(),
        },
      },
      "victim-model",
      { mutationAttempt: lateStreamingSuccess },
    );
    expect(state.writeConnection).toHaveBeenCalledTimes(writesBeforeLateSuccess);

    // Expired entries are swept without a timer and do not leak across tests.
    vi.mocked(Date.now).mockReturnValue(fixedNow + 366 * 24 * 60 * 60 * 1000);
    expect(__getAccountMutationStateStatsForTests()).toEqual({
      size: 0,
      activeEntries: 0,
      dormantEntries: 0,
    });
  });

  it("does not let an older cross-model GitHub monthly failure write an account-wide lock after a newer success", async () => {
    state.connections = [makeConnection("github")];
    state.execute
      .mockResolvedValueOnce(executorResult(new Response(
        JSON.stringify({ error: { message: "You've reached your additional usage limit for your plan" } }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )))
      .mockResolvedValueOnce(executorResult());

    let releaseOlderWrite;
    let markOlderWriteStarted;
    const olderWriteStarted = new Promise((resolve) => { markOlderWriteStarted = resolve; });
    const defaultWrite = state.writeConnection.getMockImplementation();
    state.writeConnection.mockImplementation(async (id, update, options = {}) => {
      if (update.errorCode === 402) {
        markOlderWriteStarted();
        await new Promise((resolve) => { releaseOlderWrite = resolve; });
      }
      return defaultWrite(id, update, options);
    });

    const olderFailure = handleChat(makeRequest("github/model-a"));
    await olderWriteStarted;
    const newerSuccess = await handleChat(makeRequest("github/model-b"));
    expect(newerSuccess.status).toBe(200);

    releaseOlderWrite();
    expect((await olderFailure).status).toBe(402);
    expect(state.updates).toEqual([]);
    expect(state.connections[0].modelLock___all).toBeUndefined();
  });

  it("does not let an older cross-model success clear a newer GitHub account-wide lock", async () => {
    state.connections = [makeConnection("github", {
      testStatus: "unavailable",
      lastError: "expired monthly limit",
      errorCode: 402,
      modelLock___all: new Date(fixedNow - 1_000).toISOString(),
    })];
    state.execute
      .mockResolvedValueOnce(executorResult())
      .mockResolvedValueOnce(executorResult(new Response(
        JSON.stringify({ error: { message: "You've reached your additional usage limit for your plan" } }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )));

    let releaseOlderCleanupRead;
    let markOlderCleanupReadStarted;
    const olderCleanupReadStarted = new Promise((resolve) => { markOlderCleanupReadStarted = resolve; });
    let unfilteredReads = 0;
    const defaultRead = state.readConnections.getMockImplementation();
    state.readConnections.mockImplementation(async (query = {}) => {
      if (query.provider === "github" && query.isActive === undefined) {
        unfilteredReads += 1;
        if (unfilteredReads === 1) {
          markOlderCleanupReadStarted();
          await new Promise((resolve) => { releaseOlderCleanupRead = resolve; });
        }
      }
      return defaultRead(query);
    });

    const olderSuccess = await handleChat(makeRequest("github/model-a"));
    expect(olderSuccess.status).toBe(200);
    await olderCleanupReadStarted;

    const newerFailure = await handleChat(makeRequest("github/model-b"));
    expect(newerFailure.status).toBe(402);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      id: "fixture-github",
      testStatus: "unavailable",
      errorCode: 402,
    });

    releaseOlderCleanupRead();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.updates).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({
      testStatus: "unavailable",
      errorCode: 402,
    });
    expect(state.connections[0].modelLock___all).not.toBeNull();
  });

  it("stops during a cold project-ID lookup without dispatching or mutating account state", async () => {
    state.connections = [makeConnection("antigravity", { accessToken: "access-token" })];
    const client = new AbortController();
    let lookupStarted;
    const started = new Promise((resolve) => { lookupStarted = resolve; });
    state.projectId.mockImplementation((_connectionId, _token, _provider, { signal }) => {
      lookupStarted();
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    });

    const pending = handleChat(makeRequest("antigravity/model-a", client.signal));
    await started;
    client.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(state.projectId).toHaveBeenCalledWith(
      "fixture-antigravity",
      "access-token",
      "antigravity",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("treats actual core AbortError499 as terminal even without a client signal", async () => {
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek")];
    state.execute.mockRejectedValue(new DOMException("fixture abort", "AbortError"));
    const response = await handleChat(makeRequest());
    expect(response.status).toBe(499);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual([]);
  });

  it("preserves provider timeout fallback and cooldown", async () => {
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek")];
    state.execute.mockRejectedValueOnce(new DOMException("fixture provider timeout", "TimeoutError"));
    const response = await handleChat(makeRequest());
    expect(response.status).toBe(200);
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.updates).toContainEqual(expect.objectContaining({ id: "fixture-openrouter", errorCode: 502 }));
  });

  it("preserves ordinary400 account policy while stopping combo fallback", async () => {
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek")];
    state.execute.mockImplementation(async () => executorResult(new Response(JSON.stringify({ error: { message: "max_tokens must be positive" } }), { status: 400 })));
    const response = await handleChat(makeRequest());
    expect(response.status).toBe(400);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.updates).toContainEqual(expect.objectContaining({ id: "fixture-openrouter", errorCode: 400 }));
  });

  it("releases the client abort listener after a non-streaming core response", async () => {
    const client = new AbortController();
    const add = vi.spyOn(client.signal, "addEventListener");
    const remove = vi.spyOn(client.signal, "removeEventListener");
    const result = await runCore({ signal: client.signal });
    expect(result.success).toBe(true);
    const listener = add.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(listener).toBeTypeOf("function");
    expect(remove).toHaveBeenCalledWith("abort", listener);
    const upstreamSignal = state.execute.mock.calls[0][0].signal;
    client.abort();
    expect(upstreamSignal.aborted).toBe(false);
  });

  it("keeps the client signal attached for the streaming response lifetime", async () => {
    const client = new AbortController();
    let upstreamSignal;
    state.execute.mockImplementationOnce(async ({ signal }) => {
      upstreamSignal = signal;
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
        signal.addEventListener("abort", () => controller.error(new DOMException("fixture abort", "AbortError")), { once: true });
      } });
      return executorResult(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    });
    const result = await runCore({ signal: client.signal, body: { model: "model-a", messages: [{ role: "user", content: "offline fixture" }], stream: true } });
    const reader = result.response.body.getReader();
    try {
      await reader.read();
      client.abort();
      expect(upstreamSignal.aborted).toBe(true);
      expect((await reader.read()).done).toBe(true);
      expect(state.execute).toHaveBeenCalledTimes(1);
    } finally { await reader.cancel().catch(() => {}); }
  });

  it("returns structured400 for a typed translation constraint before dispatch", async () => {
    vi.spyOn(translator, "translateRequest").mockImplementationOnce(() => { throw new ToolCompatibilityError("fixture target cannot preserve this constraint"); });
    const result = await runCore();
    expect(result.status).toBe(400);
    expect((await result.response.json()).error).toMatchObject({ code: "unsupported_tool_constraint", message: "Unsupported tool constraint: fixture target cannot preserve this constraint" });
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("finishes a normal SSE stream once and removes its client listener at EOF", async () => {
    const client = new AbortController();
    state.execute.mockImplementationOnce(async () => executorResult(new Response(
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    )));
    const result = await runCore({ signal: client.signal, body: { model: "model-a", messages: [{ role: "user", content: "offline fixture" }], stream: true } });
    expect(await result.response.text()).toContain("[DONE]");
    expect(state.pending.mock.calls.filter((args) => args[3] === false)).toHaveLength(1);
    client.abort();
    expect(state.execute.mock.calls[0][0].signal.aborted).toBe(false);
  });

  it("does not publish account success from headers when an omitted stream flag defaults to streaming", async () => {
    state.connections = [makeConnection("antigravity")];
    let upstreamController;
    const upstream = new ReadableStream({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "hello" }] } }] } })}\n\n`,
        ));
      },
    });
    state.execute.mockResolvedValueOnce(executorResult(new Response(upstream, {
      headers: { "Content-Type": "text/event-stream" },
    })));

    // Ollama and the core chat endpoint both default to streaming when the
    // request omits `stream`; successful HTTP headers are not a terminal.
    const response = await handleChat(makeRequest("antigravity/model-a", undefined, { stream: undefined }));
    expect(response.status).toBe(200);
    expect(state.clearQuotaStrikes).not.toHaveBeenCalled();

    const body = response.text();
    upstreamController.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }] } })}\n\n`,
    ));
    upstreamController.close();
    expect(await body).toContain('"finish_reason":"stop"');
    await vi.waitFor(() => expect(state.clearQuotaStrikes).toHaveBeenCalledOnce());
  });

  it("does not disguise unrelated translation exceptions as tool constraints", async () => {
    const error = new Error("fixture translation defect");
    vi.spyOn(translator, "translateRequest").mockImplementationOnce(() => { throw error; });
    await expect(runCore()).rejects.toBe(error);
  });

  it("returns coherent502 and completes pending once when a streaming Claude request gets JSON", async () => {
    const onRequestSuccess = vi.fn();
    const result = await runCore({
      sourceFormatOverride: "claude", onRequestSuccess,
      body: { model: "model-a", max_tokens: 32, messages: [{ role: "user", content: "fixture" }], stream: true },
    });
    expect(result).toMatchObject({ success: false, status: 502, error: expect.any(String) });
    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error.code).toBe("invalid_upstream_response");
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(state.pending.mock.calls.filter(args => args[3] === false)).toHaveLength(1);
  });

  it("falls back after pre-header stream contract502 without reusing the bad body", async () => {
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek")];
    state.execute.mockResolvedValueOnce(executorResult());
    state.execute.mockResolvedValueOnce(executorResult(new Response(
      'data: {"choices":[{"delta":{"content":"fallback"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    )));
    const response = await handleChat(makeRequest("test-combo", undefined, { stream: true }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fallback");
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.updates).toContainEqual(expect.objectContaining({ id: "fixture-openrouter", errorCode: 502 }));
    expect(state.pending.mock.calls.filter(args => args[3] === true)).toHaveLength(2);
    expect(state.pending.mock.calls.filter(args => args[3] === false)).toHaveLength(2);
  });

  it("reports a transport AbortError during a live stream without leaking pending or retrying", async () => {
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek")];
    state.execute.mockResolvedValueOnce(executorResult(new Response(new ReadableStream({
      pull(controller) { controller.error(new DOMException("private transport diagnostic", "AbortError")); },
    }), { headers: { "Content-Type": "text/event-stream" } })));
    const response = await handleChat(makeRequest("test-combo", undefined, { stream: true }));
    const text = await response.text();
    expect(text).toContain('"code":"invalid_upstream_response"');
    expect(text).not.toContain("private transport diagnostic");
    expect(text).not.toContain("[DONE]");
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.pending.mock.calls.filter(args => args[3] === false)).toHaveLength(1);
  });

  it("persists a model cooldown when a live HTTP 200 stream ends malformed", async () => {
    const model = "stream-malformed-model";
    state.connections = [makeConnection("openrouter")];
    state.execute.mockResolvedValueOnce(executorResult(new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    )));

    const response = await handleChat(makeRequest(`openrouter/${model}`, undefined, { stream: true }));
    const text = await response.text();

    expect(text).toContain('"code":"invalid_upstream_response"');
    await vi.waitFor(() => expect(state.updates).toContainEqual(expect.objectContaining({
      id: "fixture-openrouter",
      errorCode: 502,
      [`modelLock_${model}`]: expect.any(String),
    })));
  });

  it("releases a cancelled live stream without cooling down the provider account", async () => {
    const model = "stream-cancel-model";
    state.connections = [makeConnection("openrouter")];
    const upstreamCancel = vi.fn();
    state.execute.mockResolvedValueOnce(executorResult(new Response(new ReadableStream({
      start() {},
      cancel: upstreamCancel,
    }), { headers: { "Content-Type": "text/event-stream" } })));
    const activeBefore = __getAccountMutationStateStatsForTests().activeEntries;

    const response = await handleChat(makeRequest(`openrouter/${model}`, undefined, { stream: true }));
    await response.body.cancel("fixture client closed");

    await vi.waitFor(() => {
      expect(upstreamCancel).toHaveBeenCalledOnce();
      expect(__getAccountMutationStateStatsForTests().activeEntries).toBe(activeBefore);
    });
    expect(state.updates).toEqual([]);
  });

  it("does not let an older malformed stream cooldown overwrite a newer streaming success", async () => {
    const model = "stream-terminal-race-model";
    state.connections = [makeConnection("openrouter")];
    let olderController;
    const olderStream = new ReadableStream({
      start(controller) {
        olderController = controller;
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "older-partial" }, finish_reason: null }] })}\n\n`,
        ));
      },
    });
    const newerStream = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "newer-ok" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    state.execute
      .mockResolvedValueOnce(executorResult(new Response(olderStream, { headers: { "Content-Type": "text/event-stream" } })))
      .mockResolvedValueOnce(executorResult(new Response(newerStream, { headers: { "Content-Type": "text/event-stream" } })));

    let unfilteredReads = 0;
    let markOlderFailureRead;
    const olderFailureRead = new Promise(resolve => { markOlderFailureRead = resolve; });
    const defaultRead = state.readConnections.getMockImplementation();
    state.readConnections.mockImplementation(async (query = {}) => {
      if (query.provider === "openrouter" && query.isActive === undefined) {
        unfilteredReads += 1;
        if (unfilteredReads === 2) markOlderFailureRead();
      }
      return defaultRead(query);
    });

    const activeBefore = __getAccountMutationStateStatsForTests().activeEntries;
    const olderResponse = await handleChat(makeRequest(`openrouter/${model}`, undefined, { stream: true }));
    expect(__getAccountMutationStateStatsForTests().activeEntries).toBe(activeBefore + 2);
    const olderBody = olderResponse.text();
    const newerResponse = await handleChat(makeRequest(`openrouter/${model}`, undefined, { stream: true }));
    expect(__getAccountMutationStateStatsForTests().activeEntries).toBe(activeBefore + 2);
    expect(await newerResponse.text()).toContain("newer-ok");
    expect(__getAccountMutationStateStatsForTests().activeEntries).toBe(activeBefore + 2);

    olderController.close();
    expect(await olderBody).toContain('"code":"invalid_upstream_response"');
    await olderFailureRead;
    await Promise.resolve();

    expect(state.updates).toEqual([]);
    expect(state.connections[0]).toMatchObject({ testStatus: "active" });
    expect(state.connections[0][`modelLock_${model}`]).toBeUndefined();
  });

  it("does not let an older streaming success clear a newer provider failure", async () => {
    const model = "stream-success-race-model";
    state.connections = [makeConnection("openrouter")];
    let olderController;
    const olderStream = new ReadableStream({
      start(controller) {
        olderController = controller;
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "older-partial" }, finish_reason: null }] })}\n\n`,
        ));
      },
    });
    state.execute
      .mockResolvedValueOnce(executorResult(new Response(olderStream, { headers: { "Content-Type": "text/event-stream" } })))
      .mockResolvedValueOnce(executorResult(new Response(
        JSON.stringify({ error: { message: "newer overload" } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      )));

    let unfilteredReads = 0;
    const defaultRead = state.readConnections.getMockImplementation();
    state.readConnections.mockImplementation(async (query = {}) => {
      if (query.provider === "openrouter" && query.isActive === undefined) {
        unfilteredReads += 1;
      }
      return defaultRead(query);
    });

    const olderResponse = await handleChat(makeRequest(`openrouter/${model}`, undefined, { stream: true }));
    const olderBody = olderResponse.text();
    const newerResponse = await handleChat(makeRequest(`openrouter/${model}`));
    expect(newerResponse.status).toBe(503);
    expect(state.updates).toHaveLength(1);

    olderController.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    ));
    olderController.close();
    expect(await olderBody).toContain("older-partial");
    await Promise.resolve();

    // The stale success is rejected by the in-memory watermark before a DB
    // reload, so only the newer failure performs an unfiltered account read.
    expect(unfilteredReads).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({
      testStatus: "unavailable",
      errorCode: 503,
      lastError: "[503]: newer overload",
    });
    expect(state.connections[0][`modelLock_${model}`]).not.toBeNull();
  });

  it("keeps a pre-header client abort499 even when the returned stream media type is invalid", async () => {
    const client = new AbortController();
    state.execute.mockImplementationOnce(async () => {
      client.abort();
      return executorResult();
    });
    const result = await runCore({ signal: client.signal, body: { model: "model-a", messages: [{ role: "user", content: "fixture" }], stream: true } });
    expect(result.status).toBe(499);
    expect(state.pending.mock.calls.filter(args => args[3] === false)).toHaveLength(1);
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it("returns structured400 for a typed executor constraint", async () => {
    state.execute.mockRejectedValueOnce(new ToolCompatibilityError("fixture executor cannot preserve this constraint"));
    const result = await runCore();
    expect(result.status).toBe(400);
    expect((await result.response.json()).error.code).toBe("unsupported_tool_constraint");
  });

  it("skips account cooldown and tries a compatible model after a typed constraint", async () => {
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek")];
    state.execute.mockRejectedValueOnce(new ToolCompatibilityError("fixture target cannot preserve this constraint"));
    const response = await handleChat(makeRequest());
    expect(response.status).toBe(200);
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.updates).toEqual([]);
  });

  it("does not convert an AbortError thrown by a direct combo handler to500/fallback", async () => {
    const handler = vi.fn().mockRejectedValue(new DOMException("fixture abort", "AbortError"));
    const response = await handleComboChat({ body: {}, models: state.models, handleSingleModel: handler, log, autoSwitch: false });
    expect(response.status).toBe(499);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not start a second combo model if the signal aborts between attempts", async () => {
    const client = new AbortController();
    const handler = vi.fn(async () => { client.abort(); return new Response("{}", { status: 429 }); });
    const response = await handleComboChat({ body: {}, models: state.models, handleSingleModel: handler, log, autoSwitch: false, signal: client.signal });
    expect(response.status).toBe(499);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("preserves a bounded non-fallback error body after inspecting it", async () => {
    const handler = vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid fixture" } }), {
      status: 400,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    }));

    const response = await handleComboChat({
      body: {}, models: state.models, handleSingleModel: handler, log, autoSwitch: false,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ error: { message: "invalid fixture" } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("cancels a stalled error body and never starts fallback after caller abort", async () => {
    const client = new AbortController();
    const cancel = vi.fn();
    const handler = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 }));
    const pending = handleComboChat({
      body: {}, models: state.models, handleSingleModel: handler, log, autoSwitch: false, signal: client.signal,
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    client.abort(new DOMException("client left", "AbortError"));

    expect((await pending).status).toBe(499);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-progress retry wait and removes its listener", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const client = new AbortController();
      const remove = vi.spyOn(client.signal, "removeEventListener");
      const handler = vi.fn(async () => new Response(JSON.stringify({ error: { message: "provider capacity exhausted" } }), { status: 503 }));
      const pending = handleComboChat({ body: {}, models: state.models, handleSingleModel: handler, log, autoSwitch: false, signal: client.signal });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      client.abort();
      expect((await pending).status).toBe(499);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally { vi.useRealTimers(); }
  });

  it("stops token-refresh retries and never redispatches after a client abort", async () => {
    const client = new AbortController(); state.noAuth = false;
    state.execute.mockImplementationOnce(async () => executorResult(new Response("{}", { status: 401 })));
    state.refresh.mockImplementation(async () => { client.abort(); return null; });
    const result = await runCore({ signal: client.signal });
    expect(result.status).toBe(499);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("completes pending usage once when refresh transport aborts without a client signal", async () => {
    state.noAuth = false;
    state.execute.mockResolvedValue(executorResult(new Response("{}", { status: 401 })));
    state.refresh.mockRejectedValue(new DOMException("fixture refresh aborted", "AbortError"));
    const result = await runCore();
    expect(result.status).toBe(499);
    expect(state.pending.mock.calls.filter(args => args[3] === true)).toHaveLength(1);
    expect(state.pending.mock.calls.filter(args => args[3] === false)).toHaveLength(1);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"])("returns on client abort before an in-flight refresh can %s", async (completion) => {
    const client = new AbortController(); state.noAuth = false;
    const remove = vi.spyOn(client.signal, "removeEventListener");
    state.execute.mockResolvedValue(executorResult(new Response("{}", { status: 401 })));
    let started, releaseRefresh;
    const refreshStarted = new Promise(resolve => { started = resolve; });
    state.refresh.mockImplementation(() => {
      started();
      return new Promise((resolve, reject) => {
        releaseRefresh = () => completion === "resolve" ? resolve(null) : reject(new Error("fixture late refresh rejection"));
      });
    });
    const pending = runCore({ signal: client.signal });
    await refreshStarted;
    client.abort();
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    const settledBeforeRefreshReleased = settled;
    releaseRefresh(); // Always release the synthetic promise, including on RED.
    expect((await pending).status).toBe(499);
    await new Promise(resolve => setTimeout(resolve, 0)); // Observe a late rejection in the same test run.
    expect(settledBeforeRefreshReleased).toBe(true);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.pending.mock.calls.filter(args => args[3] === false)).toHaveLength(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("keeps a typed constraint from the post-refresh executor as structured400", async () => {
    state.noAuth = false;
    state.execute.mockImplementationOnce(async () => executorResult(new Response("{}", { status: 401 })));
    state.refresh.mockResolvedValue({ accessToken: "fixture-refreshed-token" });
    state.execute.mockRejectedValueOnce(new ToolCompatibilityError("fixture retry constraint"));
    const result = await runCore();
    expect(result.status).toBe(400);
    expect((await result.response.json()).error.code).toBe("unsupported_tool_constraint");
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it("returns499 when the client aborts while the non-streaming response body is read", async () => {
    const client = new AbortController();
    state.execute.mockImplementationOnce(async ({ signal }) => executorResult(new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(new DOMException("fixture body abort", "AbortError")), { once: true });
      },
      pull() { client.abort(); },
    }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json" } })));
    const result = await runCore({ signal: client.signal });
    expect(result.status).toBe(499);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.pending.mock.calls.filter((args) => args[3] === false)).toHaveLength(1);
  });

  it("routes a real cache-only search constraint from incompatible Claude to capable Codex", async () => {
    state.models = ["claude/claude-sonnet-4-6", "codex/gpt-5.6-sol"];
    state.connections = [makeConnection("claude"), makeConnection("codex")];
    state.execute.mockImplementationOnce(async ({ model, body, stream, credentials }) => {
      const outbound = new CodexExecutor().transformRequest(model, body, stream, credentials);
      expect(outbound.tools).toContainEqual(expect.objectContaining({ type: "web_search", external_web_access: false }));
      const completed = { type: "response.completed", response: {
        id: "resp_fixture", object: "response", model, status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } };
      return executorResult(new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
    });
    const request = new Request("http://127.0.0.1/api/v1/responses", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-combo", input: "offline fixture", tools: [{ type: "web_search", external_web_access: false }], stream: false }),
    });
    const response = await handleChat(request);
    expect(response.status).toBe(200);
    expect(state.execute).toHaveBeenCalledTimes(1); // Claude rejects before any executor call.
    expect(state.execute.mock.calls[0][0].model).toBe("gpt-5.6-sol");
    expect(state.updates).toEqual([]);
  });

  it("keeps a real Codex invalid allowed_tools rejection as400 without account cooldown", async () => {
    state.connections = [makeConnection("codex")];
    state.execute.mockImplementation(async ({ model, body, stream, credentials }) => {
      new CodexExecutor().transformRequest(model, body, stream, credentials);
      throw new Error("invalid subset must be rejected before dispatch");
    });
    const request = new Request("http://127.0.0.1/api/v1/responses", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-5.6-sol", input: "offline fixture", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }], tool_choice: { type: "allowed_tools", mode: "required", tools: [] }, stream: false }),
    });
    const response = await handleChat(request);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("unsupported_tool_constraint");
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual([]);
  });

  it("preserves the structured constraint code when every combo target rejects", async () => {
    state.connections = [makeConnection("openrouter"), makeConnection("deepseek")];
    state.execute.mockRejectedValue(new ToolCompatibilityError("fixture target constraint"));
    const response = await handleChat(makeRequest());
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("unsupported_tool_constraint");
    expect(state.updates).toEqual([]);
  });

  describe("Codex final tool constraints", () => {
    const claudeRequest = (model, tools, tool_choice = { type: "auto" }) => new Request("http://127.0.0.1/api/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 128, messages: [{ role: "user", content: "offline fixture" }], tools, tool_choice, stream: false }),
    });
    const claudeResult = () => executorResult(new Response(JSON.stringify({
      id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { "Content-Type": "application/json" } }));

    it.each([{ max_uses: 1 }, { blocked_domains: ["blocked.example.invalid"] }])(
      "returns typed400 before dispatch or account cooldown for unsupported search constraint %j", async (constraint) => {
        state.connections = [makeConnection("codex"), makeConnection("codex", { id: "unused-second-account" })];
        const dispatch = vi.fn();
        state.execute.mockImplementation(async ({ model, body, stream, credentials }) => {
          new CodexExecutor().transformRequest(model, body, stream, credentials);
          dispatch();
          return executorResult();
        });
        const response = await handleChat(claudeRequest("codex/gpt-5.6-sol", [
          { type: "web_search_20250305", name: "web_search", ...constraint },
        ]));
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("unsupported_tool_constraint");
        expect(state.execute).toHaveBeenCalledTimes(1);
        expect(dispatch).not.toHaveBeenCalled();
        expect(state.updates).toEqual([]);
      },
    );

    it.each([
      { label: "search max_uses", tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1, allowed_domains: ["docs.example.invalid"] }], choice: { type: "auto" } },
      { label: "forced hosted selector", tools: [{ type: "bash_20250124", name: "bash" }, { name: "lookup", input_schema: { type: "object" } }], choice: { type: "tool", name: "bash" } },
      { label: "required hosted tools", tools: [{ type: "bash_20250124", name: "bash" }], choice: { type: "any" } },
    ])("tries a compatible combo leg without cooldown after Codex rejects $label", async ({ tools, choice }) => {
      state.models = ["codex/gpt-5.6-sol", "claude/claude-sonnet-4-6"];
      state.connections = [makeConnection("codex"), makeConnection("claude")];
      const codexDispatch = vi.fn(); let compatibleBody;
      const original = structuredClone({ tools, choice });
      state.execute.mockImplementation(async ({ model, body, stream, credentials }) => {
        if (model.startsWith("gpt-")) {
          new CodexExecutor().transformRequest(model, body, stream, credentials);
          codexDispatch();
          return executorResult();
        }
        compatibleBody = body;
        return claudeResult();
      });
      const response = await handleChat(claudeRequest("test-combo", tools, choice));
      expect(response.status).toBe(200);
      expect(state.execute).toHaveBeenCalledTimes(2);
      expect(codexDispatch).not.toHaveBeenCalled();
      const expectedTools = structuredClone(original.tools);
      // Native Claude adds the upstream-required default tool type and its
      // existing prompt-cache marker; caller objects and constraints stay intact.
      expectedTools.forEach((tool) => { if (!tool.type) tool.type = "custom"; });
      expectedTools.at(-1).cache_control = { type: "ephemeral", ttl: "1h" };
      expect(compatibleBody.tools).toEqual(expectedTools);
      expect(compatibleBody.tool_choice).toEqual(original.choice);
      expect({ tools, choice }).toEqual(original);
      expect(state.updates).toEqual([]);
    });

    it("preserves supported domain and parallel constraints at the actual core executor boundary", async () => {
      let outbound;
      state.execute.mockImplementation(async ({ model, body, stream, credentials }) => {
        outbound = new CodexExecutor().transformRequest(model, body, stream, credentials);
        const completed = { type: "response.completed", response: {
          id: "resp_fixture", object: "response", status: "completed", model,
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        } };
        return executorResult(new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }));
      });
      const result = await runCore({
        modelInfo: { provider: "codex", model: "gpt-5.6-sol" }, sourceFormatOverride: "claude",
        credentials: { connectionId: "fixture-codex", providerSpecificData: {} },
        body: { model: "gpt-5.6-sol", messages: [{ role: "user", content: "offline fixture" }], stream: false,
          tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["docs.example.invalid"] }],
          tool_choice: { type: "auto", disable_parallel_tool_use: true } },
      });
      expect(result.success).toBe(true);
      expect(outbound.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["docs.example.invalid"] } }]);
      expect(outbound.parallel_tool_calls).toBe(false);
      expect(state.execute).toHaveBeenCalledTimes(1);
    });
  });
});
