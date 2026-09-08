import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { resolveGrokCliModels } from "../../open-sse/services/grokCliModels.js";
import {
  clearKimchiCatalog,
  getCachedKimchiModelMetadata,
  resolveKimchiModels,
} from "../../open-sse/services/kimchiModels.js";
import { resolveClinepassModels } from "../../open-sse/services/clinepassModels.js";
import {
  clearZedCaches,
  fetchZedAuthenticatedUser,
  fetchZedLlmToken,
  resolveZedModels,
} from "../../open-sse/shared/zedAuth.js";

const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const originalFetch = globalThis.fetch;

function trackedResponse({
  text = "{}",
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
  return {
    response: new Response(body, { status, headers }),
    body,
    cancel,
  };
}

function invalidUtf8Response() {
  return trackedResponse({
    chunks: [new Uint8Array([
      ...new TextEncoder().encode('{"models":[{"id":"'),
      0xff,
      ...new TextEncoder().encode('"}]}'),
    ])],
    leaveOpen: true,
  });
}

function zedCredentials(suffix) {
  return {
    accessToken: `zed-access-${suffix}`,
    providerSpecificData: {
      userId: `zed-user-${suffix}`,
      organizationId: `zed-org-${suffix}`,
    },
  };
}

function queueZedModelResponse(upstream, suffix) {
  proxyAwareFetch
    .mockResolvedValueOnce(Response.json({ token: `zed-llm-token-${suffix}` }))
    .mockResolvedValueOnce(upstream.response);
}

async function waitForCalls(mock, count) {
  for (let i = 0; i < 50 && mock.mock.calls.length < count; i++) {
    await Promise.resolve();
  }
  expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Grok CLI model catalog bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("times out a stalled response body and cancels it", async () => {
    vi.useFakeTimers();
    const upstream = trackedResponse({ stall: true });
    let requestSignal;
    const fetchFn = vi.fn(async (_url, init) => {
      requestSignal = init.signal;
      return upstream.response;
    });

    const pending = resolveGrokCliModels({ accessToken: "grok-stall" }, { fetchFn });
    await waitForCalls(fetchFn, 1);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toMatchObject({ models: [] });
    expect(requestSignal.aborted).toBe(true);
    expect(requestSignal.reason).toMatchObject({ name: "TimeoutError" });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("rejects an oversized model body without retaining the stream", async () => {
    const upstream = trackedResponse({
      chunks: [new Uint8Array(BODY_LIMIT_BYTES + 1)],
      leaveOpen: true,
    });

    const result = await resolveGrokCliModels(
      { accessToken: "grok-oversized" },
      { fetchFn: vi.fn(async () => upstream.response) },
    );

    expect(result).toMatchObject({ models: [] });
    expect(result.warning).toContain("exceeds");
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("rejects invalid UTF-8 rather than parsing replacement characters", async () => {
    const upstream = invalidUtf8Response();

    const result = await resolveGrokCliModels(
      { accessToken: "grok-invalid-utf8" },
      { fetchFn: vi.fn(async () => upstream.response) },
    );

    expect(result).toMatchObject({ models: [] });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("cancels a response that arrives after caller cancellation", async () => {
    let resolveFetch;
    const fetchFn = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const caller = new AbortController();
    const pending = resolveGrokCliModels(
      { accessToken: "grok-late-response" },
      { fetchFn, signal: caller.signal },
    );
    await waitForCalls(fetchFn, 1);
    caller.abort(new DOMException("client left", "AbortError"));
    await expect(pending).resolves.toMatchObject({ models: [] });

    const upstream = trackedResponse();
    resolveFetch(upstream.response);
    await Promise.resolve();
    await Promise.resolve();
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });
});

describe("Zed model catalog bounds", () => {
  beforeEach(() => {
    clearZedCaches();
    proxyAwareFetch.mockReset();
  });

  afterEach(() => {
    clearZedCaches();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("times out a stalled response body and cancels it", async () => {
    vi.useFakeTimers();
    const upstream = trackedResponse({ stall: true });
    queueZedModelResponse(upstream, "stall");

    const pending = resolveZedModels(zedCredentials("stall"), { forceRefresh: true });
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await waitForCalls(proxyAwareFetch, 2);
    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("rejects an oversized model body without retaining the stream", async () => {
    const upstream = trackedResponse({ contentLength: BODY_LIMIT_BYTES + 1 });
    queueZedModelResponse(upstream, "oversized");

    await expect(resolveZedModels(
      zedCredentials("oversized"),
      { forceRefresh: true },
    )).rejects.toMatchObject({
      name: "ModelCatalogBodyTooLargeError",
      code: "ERR_MODEL_CATALOG_BODY_TOO_LARGE",
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("rejects invalid UTF-8 rather than caching a corrupted catalog", async () => {
    const upstream = invalidUtf8Response();
    queueZedModelResponse(upstream, "invalid-utf8");

    await expect(resolveZedModels(
      zedCredentials("invalid-utf8"),
      { forceRefresh: true },
    )).rejects.toBeInstanceOf(TypeError);
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("keeps the shared fetch alive when its first caller aborts", async () => {
    let finishBody;
    const upstream = trackedResponse({ stall: true });
    const replacement = new ReadableStream({
      start(controller) {
        finishBody = () => {
          controller.enqueue(new TextEncoder().encode(
            '{"models":[{"id":"zed-shared","display_name":"Zed Shared"}]}',
          ));
          controller.close();
        };
      },
    });
    upstream.response = new Response(replacement, {
      headers: { "content-type": "application/json" },
    });
    queueZedModelResponse(upstream, "shared");
    const credentials = zedCredentials("shared");
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();

    const first = resolveZedModels(credentials, { signal: firstCaller.signal });
    const second = resolveZedModels(credentials, { signal: secondCaller.signal });
    await waitForCalls(proxyAwareFetch, 2);
    firstCaller.abort(new DOMException("first caller left", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    finishBody();
    await expect(second).resolves.toMatchObject({
      models: [{ id: "zed-shared", name: "Zed Shared" }],
    });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("cancels the shared Zed fetch as soon as its last caller aborts", async () => {
    const upstream = trackedResponse({ stall: true });
    queueZedModelResponse(upstream, "all-callers-abort");
    const credentials = zedCredentials("all-callers-abort");
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();

    const first = resolveZedModels(credentials, { signal: firstCaller.signal });
    const second = resolveZedModels(credentials, { signal: secondCaller.signal });
    await waitForCalls(proxyAwareFetch, 2);
    firstCaller.abort(new DOMException("first caller left", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(upstream.cancel).not.toHaveBeenCalled();

    secondCaller.abort(new DOMException("second caller left", "AbortError"));
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    await Promise.resolve();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("does not expose a Zed model error body in the thrown diagnostic", async () => {
    const upstream = trackedResponse({
      status: 502,
      text: '{"error":"upstream-secret-fixture"}',
    });
    queueZedModelResponse(upstream, "safe-error");

    await expect(resolveZedModels(
      zedCredentials("safe-error"),
      { forceRefresh: true },
    )).rejects.toMatchObject({
      message: "Zed models failed with HTTP 502",
      status: 502,
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("does not expose a Zed auth error body in the thrown diagnostic", async () => {
    const upstream = trackedResponse({
      status: 502,
      text: '{"error":"SENSITIVE_ZED_AUTH_BODY"}',
    });
    proxyAwareFetch.mockResolvedValueOnce(upstream.response);

    await expect(fetchZedAuthenticatedUser(
      zedCredentials("safe-auth-error"),
    )).rejects.toMatchObject({
      message: "Zed API request failed with HTTP 502",
      status: 502,
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("bounds a Zed auth request that never returns headers", async () => {
    vi.useFakeTimers();
    proxyAwareFetch.mockImplementationOnce(() => new Promise(() => {}));

    const pending = fetchZedAuthenticatedUser(zedCredentials("auth-timeout"));
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await waitForCalls(proxyAwareFetch, 1);
    const requestSignal = proxyAwareFetch.mock.calls[0][1].signal;
    await vi.advanceTimersByTimeAsync(30_000);

    await rejected;
    expect(requestSignal.aborted).toBe(true);
  });

  it("cancels a Zed auth response that arrives after its deadline", async () => {
    vi.useFakeTimers();
    const response = deferred();
    proxyAwareFetch.mockImplementationOnce(() => response.promise);

    const pending = fetchZedAuthenticatedUser(zedCredentials("late-auth-response"));
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await waitForCalls(proxyAwareFetch, 1);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;

    const upstream = trackedResponse();
    response.resolve(upstream.response);
    await Promise.resolve();
    await Promise.resolve();
    expect(upstream.cancel).toHaveBeenCalledOnce();
  });

  it("does not let an older LLM-token request overwrite a newer token", async () => {
    const credentials = zedCredentials("token-order");
    const older = deferred();
    const newer = deferred();
    proxyAwareFetch
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const olderPending = fetchZedLlmToken(credentials, { forceRefresh: true });
    await waitForCalls(proxyAwareFetch, 1);
    const newerPending = fetchZedLlmToken(credentials, { forceRefresh: true });
    await waitForCalls(proxyAwareFetch, 2);

    newer.resolve(Response.json({ token: "zed-newer-token" }));
    await expect(newerPending).resolves.toBe("zed-newer-token");
    older.resolve(Response.json({ token: "zed-older-token" }));
    await expect(olderPending).resolves.toBe("zed-older-token");

    await expect(fetchZedLlmToken(credentials)).resolves.toBe("zed-newer-token");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate the LLM-token cache from a request started before clear", async () => {
    const credentials = zedCredentials("token-clear");
    const beforeClear = deferred();
    proxyAwareFetch
      .mockImplementationOnce(() => beforeClear.promise)
      .mockResolvedValueOnce(Response.json({ token: "zed-after-clear-token" }));

    const oldPending = fetchZedLlmToken(credentials, { forceRefresh: true });
    await waitForCalls(proxyAwareFetch, 1);
    clearZedCaches();
    beforeClear.resolve(Response.json({ token: "zed-before-clear-token" }));
    await expect(oldPending).resolves.toBe("zed-before-clear-token");

    await expect(fetchZedLlmToken(credentials)).resolves.toBe("zed-after-clear-token");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("does not let an older force refresh overwrite the newer cached catalog", async () => {
    const credentials = zedCredentials("force-order");
    proxyAwareFetch
      .mockResolvedValueOnce(Response.json({ token: "zed-llm-token-force-order" }))
      .mockResolvedValueOnce(Response.json({
        models: [{ id: "zed-warm", display_name: "Zed Warm" }],
      }));
    await resolveZedModels(credentials, { forceRefresh: true });

    let resolveOlder;
    let resolveNewer;
    proxyAwareFetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewer = resolve; }));

    const older = resolveZedModels(credentials, { forceRefresh: true });
    await waitForCalls(proxyAwareFetch, 3);
    const newer = resolveZedModels(credentials, { forceRefresh: true });
    await waitForCalls(proxyAwareFetch, 4);

    resolveNewer(Response.json({
      models: [{ id: "zed-newer", display_name: "Zed Newer" }],
    }));
    await expect(newer).resolves.toMatchObject({ models: [{ id: "zed-newer" }] });

    resolveOlder(Response.json({
      models: [{ id: "zed-older", display_name: "Zed Older" }],
    }));
    await expect(older).resolves.toMatchObject({ models: [{ id: "zed-older" }] });

    await expect(resolveZedModels(credentials)).resolves.toMatchObject({
      models: [{ id: "zed-newer" }],
    });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
  });

  it("does not repopulate a cleared cache from an older in-flight request", async () => {
    const credentials = zedCredentials("clear-order");
    let resolveOldCatalog;
    proxyAwareFetch
      .mockResolvedValueOnce(Response.json({ token: "zed-llm-token-before-clear" }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldCatalog = resolve; }))
      .mockResolvedValueOnce(Response.json({ token: "zed-llm-token-after-clear" }))
      .mockResolvedValueOnce(Response.json({
        models: [{ id: "zed-after-clear", display_name: "Zed After Clear" }],
      }));

    const beforeClear = resolveZedModels(credentials, { forceRefresh: true });
    await waitForCalls(proxyAwareFetch, 2);
    clearZedCaches();

    resolveOldCatalog(Response.json({
      models: [{ id: "zed-before-clear", display_name: "Zed Before Clear" }],
    }));
    await expect(beforeClear).resolves.toMatchObject({ models: [{ id: "zed-before-clear" }] });

    await expect(resolveZedModels(credentials)).resolves.toMatchObject({
      models: [{ id: "zed-after-clear" }],
    });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
  });
});

describe("remaining live catalog callers", () => {
  beforeEach(() => {
    clearKimchiCatalog();
    proxyAwareFetch.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearKimchiCatalog();
    vi.restoreAllMocks();
  });

  it("propagates Kimchi caller cancellation through body consumption", async () => {
    const upstream = trackedResponse({ stall: true });
    proxyAwareFetch.mockResolvedValue(upstream.response);
    const caller = new AbortController();
    const pending = resolveKimchiModels(
      { accessToken: "kimchi-abort", providerSpecificData: {} },
      { forceRefresh: true, signal: caller.signal },
    );
    await waitForCalls(proxyAwareFetch, 1);
    caller.abort(new DOMException("client left", "AbortError"));

    await expect(pending).resolves.toBeNull();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("bounds the Kimchi JSON catalog body", async () => {
    const upstream = trackedResponse({ contentLength: BODY_LIMIT_BYTES + 1 });
    proxyAwareFetch.mockResolvedValue(upstream.response);

    await expect(resolveKimchiModels(
      { accessToken: "kimchi-oversized", providerSpecificData: {} },
      { forceRefresh: true },
    )).resolves.toBeNull();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("does not log Kimchi transport diagnostics verbatim", async () => {
    const reflected = "kimchi-secret-in-status-text";
    proxyAwareFetch.mockResolvedValue(new Response(null, {
      status: 502,
      statusText: reflected,
    }));
    const log = { warn: vi.fn() };

    await expect(resolveKimchiModels(
      { accessToken: "kimchi-secret-token", providerSpecificData: {} },
      { forceRefresh: true, log },
    )).resolves.toBeNull();

    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(reflected);
  });

  it("coalesces Kimchi misses while one caller can abort independently", async () => {
    const upstream = deferred();
    proxyAwareFetch.mockImplementation((_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return upstream.promise;
    });
    const credentials = { accessToken: "kimchi-shared", providerSpecificData: {} };
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();

    const first = resolveKimchiModels(credentials, { signal: firstCaller.signal });
    const second = resolveKimchiModels(credentials, { signal: secondCaller.signal });
    await waitForCalls(proxyAwareFetch, 1);
    const transportSignal = proxyAwareFetch.mock.calls[0][1].signal;
    firstCaller.abort(new DOMException("first caller left", "AbortError"));

    await expect(first).resolves.toBeNull();
    expect(transportSignal.aborted).toBe(false);
    upstream.resolve(Response.json({
      models: [{ slug: "kimchi-shared", display_name: "Kimchi Shared" }],
    }));
    await expect(second).resolves.toMatchObject({ models: [{ id: "kimchi-shared" }] });
    expect(proxyAwareFetch).toHaveBeenCalledOnce();
  });

  it("does not let an older Kimchi force refresh overwrite a newer catalog", async () => {
    const older = deferred();
    const newer = deferred();
    proxyAwareFetch
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const credentials = { accessToken: "kimchi-order", providerSpecificData: {} };

    const olderPending = resolveKimchiModels(credentials, { forceRefresh: true });
    await waitForCalls(proxyAwareFetch, 1);
    const newerPending = resolveKimchiModels(credentials, { forceRefresh: true });
    await waitForCalls(proxyAwareFetch, 2);

    newer.resolve(Response.json({ models: [{ slug: "kimchi-newer" }] }));
    await expect(newerPending).resolves.toMatchObject({ models: [{ id: "kimchi-newer" }] });
    older.resolve(Response.json({ models: [{ slug: "kimchi-older" }] }));
    await expect(olderPending).resolves.toMatchObject({ models: [{ id: "kimchi-older" }] });

    await expect(resolveKimchiModels(credentials)).resolves.toMatchObject({
      models: [{ id: "kimchi-newer" }],
    });
    expect(getCachedKimchiModelMetadata("kimchi-newer")).toMatchObject({ id: "kimchi-newer" });
    expect(getCachedKimchiModelMetadata("kimchi-older")).toBeNull();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate cleared Kimchi caches from an in-flight request", async () => {
    const older = deferred();
    proxyAwareFetch
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(Response.json({ models: [{ slug: "kimchi-after-clear" }] }));
    const credentials = { accessToken: "kimchi-clear", providerSpecificData: {} };

    const beforeClear = resolveKimchiModels(credentials, { forceRefresh: true });
    await waitForCalls(proxyAwareFetch, 1);
    clearKimchiCatalog();
    older.resolve(Response.json({ models: [{ slug: "kimchi-before-clear" }] }));
    await expect(beforeClear).resolves.toMatchObject({ models: [{ id: "kimchi-before-clear" }] });
    expect(getCachedKimchiModelMetadata("kimchi-before-clear")).toBeNull();

    await expect(resolveKimchiModels(credentials)).resolves.toMatchObject({
      models: [{ id: "kimchi-after-clear" }],
    });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("propagates ClinePass caller cancellation through body consumption", async () => {
    const upstream = trackedResponse({ stall: true });
    globalThis.fetch = vi.fn(async () => upstream.response);
    const caller = new AbortController();
    const pending = resolveClinepassModels(
      { accessToken: "cline-abort" },
      { signal: caller.signal },
    );
    await waitForCalls(globalThis.fetch, 1);
    caller.abort(new DOMException("client left", "AbortError"));

    await expect(pending).resolves.toBeNull();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("bounds the ClinePass JSON catalog body", async () => {
    const upstream = trackedResponse({ contentLength: BODY_LIMIT_BYTES + 1 });
    globalThis.fetch = vi.fn(async () => upstream.response);

    await expect(resolveClinepassModels({ accessToken: "cline-oversized" }))
      .resolves.toBeNull();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });
});
