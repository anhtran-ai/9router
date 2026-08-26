import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  connections: [], updates: [], execute: vi.fn(), refresh: vi.fn(), pending: vi.fn(), noAuth: true,
  models: ["openrouter/model-a", "deepseek/model-b"],
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: state.execute, refreshCredentials: state.refresh, noAuth: state.noAuth }),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false, comboStrategy: "fallback" })),
  getProviderConnections: vi.fn(async ({ provider, isActive } = {}) => structuredClone(state.connections.filter(
    (connection) => (!provider || connection.provider === provider) && (isActive === undefined || connection.isActive === isActive),
  ))),
  updateProviderConnection: vi.fn(async (id, update) => {
    state.updates.push({ id, ...structuredClone(update) });
    Object.assign(state.connections.find((connection) => connection.id === id) || {}, update);
  }),
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
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://example.invalid" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("open-sse/utils/requestLogger.js", () => ({
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
    state.execute.mockReset().mockImplementation(async () => executorResult());
    state.refresh.mockReset();
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
      // Native Claude adds its existing default prompt-cache marker to the last
      // declaration; all caller restrictions must otherwise remain identical.
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
