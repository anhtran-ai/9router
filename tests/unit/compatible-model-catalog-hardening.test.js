import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/models", () => ({ getProviderConnectionById: vi.fn() }));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn() }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn() }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn() }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: vi.fn() }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: vi.fn() }));
vi.mock("open-sse/services/grokCliModels.js", () => ({ resolveGrokCliModels: vi.fn() }));
vi.mock("open-sse/services/cursorModels.js", () => ({ resolveCursorModels: vi.fn() }));
vi.mock("open-sse/shared/zedAuth.js", () => ({ resolveZedModels: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  refreshCodexToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));

function trackedResponse({
  text = '{"data":[]}',
  chunks = null,
  contentLength = null,
  stall = false,
  leaveOpen = false,
  status = 200,
} = {}) {
  const cancel = vi.fn(async () => {});
  const body = new ReadableStream({
    start(controller) {
      if (stall) return;
      for (const chunk of chunks || [new TextEncoder().encode(text)]) {
        controller.enqueue(chunk);
      }
      if (!leaveOpen) controller.close();
    },
    cancel,
  });
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== null) headers.set("content-length", String(contentLength));
  return { response: new Response(body, { status, headers }), body, cancel };
}

function connection(overrides = {}) {
  return {
    provider: "openai-compatible-hardening-test",
    apiKey: "fixture-key",
    providerSpecificData: { baseUrl: "https://models.example.test/v1" },
    ...overrides,
  };
}

describe("compatible /v1/models catalog hardening", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the five-second deadline active while a chunked body stalls", async () => {
    vi.useFakeTimers();
    const upstream = trackedResponse({ stall: true });
    let fetchSignal;
    globalThis.fetch = vi.fn(async (_url, init) => {
      fetchSignal = init.signal;
      return upstream.response;
    });
    const { __test__ } = await import("@/app/api/v1/models/route.js");

    const pending = __test__.fetchCompatibleModelIds(connection());
    while (globalThis.fetch.mock.calls.length === 0) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual([]);
    expect(fetchSignal.aborted).toBe(true);
    expect(fetchSignal.reason).toMatchObject({ name: "TimeoutError" });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it.each(["content-length", "chunked"])(
    "rejects an oversized body advertised via %s and unlocks it",
    async (mode) => {
      const upstream = mode === "content-length"
        ? trackedResponse({ contentLength: BODY_LIMIT_BYTES + 1 })
        : trackedResponse({
            chunks: [new Uint8Array(BODY_LIMIT_BYTES + 1)],
            leaveOpen: true,
          });
      globalThis.fetch = vi.fn(async () => upstream.response);
      const { __test__ } = await import("@/app/api/v1/models/route.js");

      await expect(__test__.fetchCompatibleModelIds(connection())).resolves.toEqual([]);
      expect(upstream.cancel).toHaveBeenCalledOnce();
      expect(upstream.body.locked).toBe(false);
    },
  );

  it("forwards caller cancellation while leaving the body unlocked", async () => {
    const upstream = trackedResponse({ stall: true });
    let fetchSignal;
    globalThis.fetch = vi.fn(async (_url, init) => {
      fetchSignal = init.signal;
      return upstream.response;
    });
    const { __test__ } = await import("@/app/api/v1/models/route.js");
    const caller = new AbortController();
    const pending = __test__.fetchCompatibleModelIds(connection(), caller.signal);

    while (globalThis.fetch.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left", "AbortError"));

    await expect(pending).resolves.toEqual([]);
    expect(fetchSignal.aborted).toBe(true);
    expect(fetchSignal.reason).toMatchObject({ name: "AbortError" });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("persists credentials refreshed by the Kiro live catalog resolver", async () => {
    const { resolveKiroModels } = await import("open-sse/services/kiroModels.js");
    const { updateProviderCredentials } = await import("@/sse/services/tokenRefresh");
    resolveKiroModels.mockReset();
    updateProviderCredentials.mockReset();
    const caller = new AbortController();
    resolveKiroModels.mockImplementation(async (_credentials, options) => {
      expect(options.signal).toBe(caller.signal);
      await options.onCredentialsRefreshed({
        accessToken: "kiro-catalog-fresh-access",
        refreshToken: "kiro-catalog-fresh-refresh",
        expiresIn: 3600,
        providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/fresh" },
      });
      return { models: [{ id: "kiro-live-model" }] };
    });
    const { __test__ } = await import("@/app/api/v1/models/route.js");
    const conn = {
      id: "kiro-catalog-connection",
      provider: "kiro",
      accessToken: "kiro-catalog-old-access",
      refreshToken: "kiro-catalog-old-refresh",
      providerSpecificData: { authMethod: "social" },
    };

    await expect(__test__.liveModelResolvers.kiro(conn, caller.signal)).resolves.toEqual({
      models: [{ id: "kiro-live-model" }],
    });
    expect(updateProviderCredentials).toHaveBeenCalledWith(conn.id, {
      accessToken: "kiro-catalog-fresh-access",
      refreshToken: "kiro-catalog-fresh-refresh",
      expiresIn: 3600,
      providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/fresh" },
      existingProviderSpecificData: { authMethod: "social" },
    });
  });

  it("forwards dashboard cancellation and merges Kiro refresh metadata", async () => {
    const { getProviderConnectionById } = await import("@/models");
    const { resolveKiroModels } = await import("open-sse/services/kiroModels.js");
    const { updateProviderCredentials } = await import("@/sse/services/tokenRefresh");
    getProviderConnectionById.mockReset();
    resolveKiroModels.mockReset();
    updateProviderCredentials.mockReset();
    const connection = {
      id: "kiro-dashboard-connection",
      provider: "kiro",
      accessToken: "kiro-dashboard-old-access",
      refreshToken: "kiro-dashboard-old-refresh",
      providerSpecificData: { authMethod: "social", region: "us-east-1" },
    };
    getProviderConnectionById.mockResolvedValue(connection);
    const caller = new AbortController();
    resolveKiroModels.mockImplementation(async (_credentials, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted).toBe(false);
      await options.onCredentialsRefreshed({
        accessToken: "kiro-dashboard-fresh-access",
        refreshToken: "kiro-dashboard-fresh-refresh",
        expiresIn: 7200,
        providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/dashboard" },
      });
      return {
        models: [{
          id: "kiro-dashboard-live",
          name: "Kiro Dashboard Live",
          upstreamModelId: "kiro-dashboard-live",
        }],
      };
    });
    const { GET } = await import("@/app/api/providers/[id]/models/route.js");

    const response = await GET(
      { signal: caller.signal },
      { params: Promise.resolve({ id: connection.id }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: "kiro",
      connectionId: connection.id,
      models: [{ id: "kiro-dashboard-live" }],
    });
    expect(updateProviderCredentials).toHaveBeenCalledWith(connection.id, {
      accessToken: "kiro-dashboard-fresh-access",
      refreshToken: "kiro-dashboard-fresh-refresh",
      expiresIn: 7200,
      providerSpecificData: {
        profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/dashboard",
      },
      existingProviderSpecificData: { authMethod: "social", region: "us-east-1" },
    });
    expect(connection.providerSpecificData).toEqual({
      authMethod: "social",
      region: "us-east-1",
      profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/dashboard",
    });
  });

  it("does not return or log an OAuth model endpoint body that reflects credentials", async () => {
    const reflected = "Bearer codex-secret-reflected-by-gateway";
    const { getProviderConnectionById } = await import("@/models");
    getProviderConnectionById.mockReset();
    getProviderConnectionById.mockResolvedValue({
      id: "codex-reflected-error",
      provider: "codex",
      accessToken: "codex-secret-reflected-by-gateway",
      providerSpecificData: {},
    });
    const upstream = trackedResponse({
      status: 502,
      text: JSON.stringify({ error: reflected }),
    });
    globalThis.fetch = vi.fn(async () => upstream.response);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { GET } = await import("@/app/api/providers/[id]/models/route.js");

    const response = await GET(
      {},
      { params: Promise.resolve({ id: "codex-reflected-error" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.warning).toBe("Failed to fetch Codex models: HTTP 502");
    expect(JSON.stringify(payload)).not.toContain(reflected);
    expect(JSON.stringify(log.mock.calls)).not.toContain(reflected);
    expect(upstream.body.locked).toBe(false);
  });

  it.each([
    ["OpenAI-compatible", connection({ id: "compatible-abort" })],
    ["Anthropic-compatible", connection({
      id: "anthropic-compatible-abort",
      provider: "anthropic-compatible-abort",
    })],
    ["generic API-key", {
      id: "openai-abort",
      provider: "openai",
      apiKey: "openai-key",
      providerSpecificData: {},
    }],
    ["OAuth", {
      id: "codex-abort",
      provider: "codex",
      accessToken: "codex-token",
      providerSpecificData: {},
    }],
    ["Ollama local", {
      id: "ollama-local-abort",
      provider: "ollama-local",
      providerSpecificData: { baseUrl: "http://127.0.0.1:11434" },
    }],
  ])("cancels a late %s catalog response when the caller leaves", async (_label, fixture) => {
    const { getProviderConnectionById } = await import("@/models");
    getProviderConnectionById.mockReset();
    getProviderConnectionById.mockResolvedValue(fixture);
    const caller = new AbortController();
    let resolveFetch;
    let fetchSignal;
    globalThis.fetch = vi.fn((_url, init) => {
      fetchSignal = init.signal;
      return new Promise((resolve) => { resolveFetch = resolve; });
    });
    const { GET } = await import("@/app/api/providers/[id]/models/route.js");

    const pending = GET(
      { signal: caller.signal },
      { params: Promise.resolve({ id: fixture.id }) },
    );
    while (globalThis.fetch.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left", "AbortError"));

    const response = await pending;
    expect(response.status).toBe(499);
    expect(fetchSignal).toBeInstanceOf(AbortSignal);
    expect(fetchSignal.aborted).toBe(true);
    const upstream = trackedResponse();
    resolveFetch(upstream.response);
    await Promise.resolve();
    await Promise.resolve();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("enforces one absolute provider-detail deadline even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    const { getProviderConnectionById } = await import("@/models");
    getProviderConnectionById.mockReset();
    getProviderConnectionById.mockResolvedValue(connection({ id: "absolute-deadline" }));
    let resolveFetch;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const { GET, __test__ } = await import("@/app/api/providers/[id]/models/route.js");

    const pending = GET(
      {},
      { params: Promise.resolve({ id: "absolute-deadline" }) },
    );
    while (globalThis.fetch.mock.calls.length === 0) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(__test__.providerModelsTimeoutMs);

    const response = await pending;
    expect(response.status).toBe(504);
    const upstream = trackedResponse();
    resolveFetch(upstream.response);
    await Promise.resolve();
    await Promise.resolve();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["oversized", () => trackedResponse({ contentLength: BODY_LIMIT_BYTES + 1 })],
    ["invalid UTF-8", () => trackedResponse({
      chunks: [new Uint8Array([
        ...new TextEncoder().encode('{"data":[{"id":"'),
        0xff,
        ...new TextEncoder().encode('"}]}'),
      ])],
      leaveOpen: true,
    })],
  ])("rejects a %s generic provider catalog and releases its body", async (_label, makeResponse) => {
    const { getProviderConnectionById } = await import("@/models");
    getProviderConnectionById.mockReset();
    getProviderConnectionById.mockResolvedValue({
      id: "openai-invalid-body",
      provider: "openai",
      apiKey: "openai-key",
      providerSpecificData: {},
    });
    const upstream = makeResponse();
    globalThis.fetch = vi.fn(async () => upstream.response);
    const { GET } = await import("@/app/api/providers/[id]/models/route.js");

    const response = await GET(
      {},
      { params: Promise.resolve({ id: "openai-invalid-body" }) },
    );

    expect(response.status).toBe(500);
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("passes the composed request deadline to Qoder and stops an abort-ignoring resolver", async () => {
    const { getProviderConnectionById } = await import("@/models");
    const { resolveQoderModels } = await import("open-sse/services/qoderModels.js");
    getProviderConnectionById.mockReset();
    resolveQoderModels.mockReset();
    getProviderConnectionById.mockResolvedValue({
      id: "qoder-detail-abort",
      provider: "qoder",
      accessToken: "qoder-token",
      providerSpecificData: { userId: "qoder-user" },
    });
    let resolverSignal;
    resolveQoderModels.mockImplementation((_credentials, options) => {
      resolverSignal = options.signal;
      return new Promise(() => {});
    });
    const caller = new AbortController();
    const { GET } = await import("@/app/api/providers/[id]/models/route.js");

    const pending = GET(
      { signal: caller.signal },
      { params: Promise.resolve({ id: "qoder-detail-abort" }) },
    );
    while (resolveQoderModels.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left", "AbortError"));

    expect((await pending).status).toBe(499);
    expect(resolverSignal).toBeInstanceOf(AbortSignal);
    expect(resolverSignal.aborted).toBe(true);
    expect(resolverSignal.reason).toMatchObject({ name: "AbortError" });
  });

  it("forwards request cancellation through the catch-all model route", async () => {
    const { getProviderConnections } = await import("@/lib/localDb");
    const { resolveQoderModels } = await import("open-sse/services/qoderModels.js");
    getProviderConnections.mockResolvedValue([{
      id: "qoder-catch-all-abort",
      provider: "qoder",
      accessToken: "qoder-token",
      providerSpecificData: {},
    }]);
    resolveQoderModels.mockReset();
    let resolverSignal;
    resolveQoderModels.mockImplementation((_credentials, options) => {
      resolverSignal = options.signal;
      return new Promise(() => {});
    });
    const caller = new AbortController();
    const { GET } = await import("@/app/api/v1/models/[...model]/route.js");

    const pending = GET(
      { signal: caller.signal },
      { params: Promise.resolve({ model: ["qd", "auto"] }) },
    );
    while (resolveQoderModels.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left", "AbortError"));

    const response = await pending;
    expect(response.status).toBe(200);
    expect(resolverSignal.aborted).toBe(true);
    expect(resolverSignal.reason).toMatchObject({ name: "AbortError" });
  });

  it("normalizes an Anthropic-compatible /messages base URL to /models", async () => {
    const upstream = trackedResponse({ text: '{"data":[{"id":"claude-test"}]}' });
    globalThis.fetch = vi.fn(async () => upstream.response);
    const { __test__ } = await import("@/app/api/v1/models/route.js");

    await expect(__test__.fetchCompatibleModelIds(connection({
      provider: "anthropic-compatible-messages-test",
      providerSpecificData: { baseUrl: "https://x.example/v1/messages" },
    }))).resolves.toEqual(["claude-test"]);
    expect(globalThis.fetch.mock.calls[0][0]).toBe("https://x.example/v1/models");
    expect(upstream.body.locked).toBe(false);
  });

  it("shares one absolute live-discovery deadline and falls back to static models", async () => {
    vi.useFakeTimers();
    const { getProviderConnections } = await import("@/lib/localDb");
    const { resolveQoderModels } = await import("open-sse/services/qoderModels.js");
    const { resolveKimchiModels } = await import("open-sse/services/kimchiModels.js");
    resolveQoderModels.mockReset();
    getProviderConnections.mockResolvedValue([
      {
        id: "qoder-never-settles",
        provider: "qoder",
        accessToken: "qoder-token",
        providerSpecificData: {},
      },
      {
        id: "kimchi-after-deadline",
        provider: "kimchi",
        accessToken: "kimchi-token",
        providerSpecificData: {},
      },
    ]);
    let resolverSignal;
    resolveQoderModels.mockImplementation((_credentials, options) => {
      resolverSignal = options.signal;
      return new Promise(() => {});
    });
    resolveKimchiModels.mockReset();
    const { buildModelsList, __test__ } = await import("@/app/api/v1/models/route.js");

    const pending = buildModelsList(["llm"]);
    while (resolveQoderModels.mock.calls.length === 0) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(__test__.liveModelDiscoveryTimeoutMs);

    const models = await pending;
    expect(resolverSignal.aborted).toBe(true);
    expect(resolverSignal.reason).toMatchObject({ name: "TimeoutError" });
    expect(resolveKimchiModels).not.toHaveBeenCalled();
    expect(models.some((model) => model.id === "qd/auto")).toBe(true);
    expect(models.some((model) => model.owned_by === "kimchi")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting for an abort-ignoring live resolver on caller cancellation", async () => {
    const { getProviderConnections } = await import("@/lib/localDb");
    const { resolveQoderModels } = await import("open-sse/services/qoderModels.js");
    resolveQoderModels.mockReset();
    getProviderConnections.mockResolvedValue([{
      id: "qoder-caller-abort",
      provider: "qoder",
      accessToken: "qoder-token",
      providerSpecificData: {},
    }]);
    let resolverSignal;
    resolveQoderModels.mockImplementation((_credentials, options) => {
      resolverSignal = options.signal;
      return new Promise(() => {});
    });
    const { buildModelsList } = await import("@/app/api/v1/models/route.js");
    const caller = new AbortController();

    const pending = buildModelsList(["llm"], { signal: caller.signal });
    while (resolveQoderModels.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left", "AbortError"));

    const models = await pending;
    expect(resolverSignal.aborted).toBe(true);
    expect(resolverSignal.reason).toMatchObject({ name: "AbortError" });
    expect(models.some((model) => model.id === "qd/auto")).toBe(true);
  });
});
