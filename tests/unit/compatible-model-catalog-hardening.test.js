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
  return { response: new Response(body, { headers }), body, cancel };
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
      expect(options.signal).toBe(caller.signal);
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
});
