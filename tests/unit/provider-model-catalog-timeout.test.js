import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformFetch = globalThis.fetch;
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

function trackedResponse({
  text = "{}",
  chunks = null,
  contentLength = null,
  stall = false,
  leaveOpen = false,
  stallCancellation = false,
  status = 200,
} = {}) {
  const encoder = new TextEncoder();
  const encodedChunks = chunks || [encoder.encode(text)];
  const cancel = vi.fn(() => (
    stallCancellation ? new Promise(() => {}) : Promise.resolve()
  ));
  const body = new ReadableStream({
    start(controller) {
      if (stall) return;
      for (const chunk of encodedChunks) controller.enqueue(chunk);
      if (!leaveOpen) controller.close();
    },
    cancel,
  });
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== null) headers.set("content-length", String(contentLength));
  const response = new Response(body, { status, headers });
  return { response, body, cancel };
}

function oversizedResponse(mode) {
  if (mode === "content-length") {
    return trackedResponse({ contentLength: BODY_LIMIT_BYTES + 1 });
  }
  return trackedResponse({
    chunks: [new Uint8Array(BODY_LIMIT_BYTES + 1)],
    leaveOpen: true,
  });
}

function controlledJsonResponse() {
  const encoder = new TextEncoder();
  const cancel = vi.fn(async () => {});
  let streamController;
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
    cancel,
  });
  return {
    response: new Response(body, { headers: { "content-type": "application/json" } }),
    body,
    cancel,
    finish(value) {
      streamController.enqueue(encoder.encode(JSON.stringify(value)));
      streamController.close();
    },
  };
}

async function expectDeadlineToSettle(pending, timeoutMs) {
  let settled = false;
  pending.finally(() => { settled = true; }).catch(() => {});
  await vi.advanceTimersByTimeAsync(timeoutMs);
  await Promise.resolve();
  expect(settled).toBe(true);
  return pending;
}

async function waitForFetch(fetchMock) {
  for (let i = 0; i < 50 && fetchMock.mock.calls.length === 0; i++) {
    await Promise.resolve();
  }
  expect(fetchMock).toHaveBeenCalledOnce();
}

describe("live provider model catalog body deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("ALL_PROXY", "");
    vi.stubEnv("NO_PROXY", "");
  });

  afterEach(() => {
    vi.doUnmock("../../open-sse/services/tokenRefresh.js");
    globalThis.fetch = platformFetch;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("bounds Qoder JSON consumption after response headers", async () => {
    let upstream;
    let fetchSignal;
    const fetchMock = vi.fn(async (_url, init) => {
      fetchSignal = init.signal;
      upstream = trackedResponse({ stall: true });
      return upstream.response;
    });
    globalThis.fetch = fetchMock;
    const { resolveQoderModels } = await import("../../open-sse/services/qoderModels.js");

    const pending = resolveQoderModels({
      accessToken: "dt-timeout-fixture",
      providerSpecificData: { userId: "user-timeout-fixture" },
    }, { forceRefresh: true });

    await waitForFetch(fetchMock);
    await expect(expectDeadlineToSettle(pending, 15_000)).resolves.toBeNull();
    expect(fetchSignal.aborted).toBe(true);
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("bounds Qoder response headers when the transport ignores abort", async () => {
    let fetchSignal;
    const fetchMock = vi.fn((_url, init) => {
      fetchSignal = init.signal;
      return new Promise(() => {});
    });
    globalThis.fetch = fetchMock;
    const { resolveQoderModels } = await import("../../open-sse/services/qoderModels.js");

    const pending = resolveQoderModels({
      accessToken: "dt-header-timeout-fixture",
      providerSpecificData: { userId: "user-header-timeout-fixture" },
    }, { forceRefresh: true });

    await waitForFetch(fetchMock);
    await expect(expectDeadlineToSettle(pending, 15_000)).resolves.toBeNull();
    expect(fetchSignal.aborted).toBe(true);
  });

  it("disposes a Qoder response that arrives after the header deadline", async () => {
    let resolveFetch;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    globalThis.fetch = fetchMock;
    const { resolveQoderModels } = await import("../../open-sse/services/qoderModels.js");

    const pending = resolveQoderModels({
      accessToken: "dt-late-header-fixture",
      providerSpecificData: { userId: "user-late-header-fixture" },
    }, { forceRefresh: true });

    await waitForFetch(fetchMock);
    await expect(expectDeadlineToSettle(pending, 15_000)).resolves.toBeNull();

    const late = trackedResponse({ text: '{"chat":[]}' });
    resolveFetch(late.response);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.cancel).toHaveBeenCalledOnce();
    expect(late.body.locked).toBe(false);
  });

  it("bounds Qoder PAT exchange body consumption before catalog lookup", async () => {
    let upstream;
    let fetchSignal;
    const fetchMock = vi.fn(async (_url, init) => {
      fetchSignal = init.signal;
      upstream = trackedResponse({ stall: true });
      return upstream.response;
    });
    globalThis.fetch = fetchMock;
    const { resolveQoderModels } = await import("../../open-sse/services/qoderModels.js");

    const pending = resolveQoderModels({
      apiKey: "pt-timeout-fixture",
      providerSpecificData: { userId: "user-timeout-fixture" },
    }, { forceRefresh: true });

    await waitForFetch(fetchMock);
    await expect(expectDeadlineToSettle(pending, 15_000)).resolves.toBeNull();
    expect(fetchSignal.aborted).toBe(true);
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it.each(["content-length", "chunked"])(
    "rejects an oversized Qoder catalog advertised via %s and unlocks it",
    async (mode) => {
      const upstream = oversizedResponse(mode);
      globalThis.fetch = vi.fn(async () => upstream.response);
      const { resolveQoderModels } = await import("../../open-sse/services/qoderModels.js");

      await expect(resolveQoderModels({
        accessToken: `dt-qoder-${mode}`,
        providerSpecificData: { userId: `qoder-user-${mode}` },
      }, { forceRefresh: true })).resolves.toBeNull();

      expect(upstream.cancel).toHaveBeenCalledOnce();
      expect(upstream.body.locked).toBe(false);
    },
  );

  it.each(["first", "second"])(
    "keeps a shared Qoder catalog alive when the %s caller aborts",
    async (abortedCaller) => {
      const upstream = controlledJsonResponse();
      const fetchMock = vi.fn(async () => upstream.response);
      globalThis.fetch = fetchMock;
      const { resolveQoderModels } = await import("../../open-sse/services/qoderModels.js");
      const credentials = {
        accessToken: "dt-shared-qoder",
        providerSpecificData: { userId: "shared-qoder-user" },
      };
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = resolveQoderModels(credentials, { signal: firstController.signal });
      const second = resolveQoderModels(credentials, { signal: secondController.signal });
      const aborted = abortedCaller === "first" ? first : second;
      const survivor = abortedCaller === "first" ? second : first;
      const controller = abortedCaller === "first" ? firstController : secondController;
      const rejected = expect(aborted).rejects.toMatchObject({ name: "AbortError" });

      await waitForFetch(fetchMock);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      controller.abort(new DOMException(`${abortedCaller} caller left`, "AbortError"));
      await rejected;
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(upstream.cancel).not.toHaveBeenCalled();

      upstream.finish({ chat: [{ key: "qmodel_shared", display_name: "Shared" }] });
      await expect(survivor).resolves.toMatchObject({
        models: [{ id: "qmodel_shared", name: "Shared" }],
      });
      expect(upstream.cancel).not.toHaveBeenCalled();
      expect(upstream.body.locked).toBe(false);
    },
  );

  it("cancels an abandoned shared Qoder fetch and lets a later caller retry", async () => {
    const abandoned = trackedResponse({ stall: true });
    const retry = trackedResponse({
      text: '{"chat":[{"key":"qmodel_retry","display_name":"Retry"}]}',
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(abandoned.response)
      .mockResolvedValueOnce(retry.response);
    globalThis.fetch = fetchMock;
    const { resolveQoderModels } = await import("../../open-sse/services/qoderModels.js");
    const credentials = {
      accessToken: "dt-abandoned-qoder",
      providerSpecificData: { userId: "abandoned-qoder-user" },
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = resolveQoderModels(credentials, { signal: firstController.signal });
    const second = resolveQoderModels(credentials, { signal: secondController.signal });
    const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const secondRejected = expect(second).rejects.toMatchObject({ name: "AbortError" });

    await waitForFetch(fetchMock);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    firstController.abort();
    secondController.abort();
    await Promise.all([firstRejected, secondRejected]);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    await expect(resolveQoderModels(credentials)).resolves.toMatchObject({
      models: [{ id: "qmodel_retry", name: "Retry" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(abandoned.cancel).toHaveBeenCalledOnce();
    expect(abandoned.body.locked).toBe(false);
    expect(retry.body.locked).toBe(false);
  });

  it("does not let an older force refresh overwrite a newer Qoder catalog", async () => {
    const older = controlledJsonResponse();
    const newer = controlledJsonResponse();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(older.response)
      .mockResolvedValueOnce(newer.response);
    globalThis.fetch = fetchMock;
    const { resolveQoderModels } = await import("../../open-sse/services/qoderModels.js");
    const credentials = {
      accessToken: "dt-force-order-qoder",
      providerSpecificData: { userId: "force-order-qoder-user" },
    };

    const olderPending = resolveQoderModels(credentials, { forceRefresh: true });
    while (fetchMock.mock.calls.length < 1) await Promise.resolve();
    const newerPending = resolveQoderModels(credentials, { forceRefresh: true });
    while (fetchMock.mock.calls.length < 2) await Promise.resolve();

    newer.finish({ chat: [{ key: "qmodel_newer", display_name: "Newer" }] });
    await expect(newerPending).resolves.toMatchObject({ models: [{ id: "qmodel_newer" }] });
    older.finish({ chat: [{ key: "qmodel_older", display_name: "Older" }] });
    await expect(olderPending).resolves.toMatchObject({ models: [{ id: "qmodel_older" }] });

    await expect(resolveQoderModels(credentials)).resolves.toMatchObject({
      models: [{ id: "qmodel_newer" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(older.body.locked).toBe(false);
    expect(newer.body.locked).toBe(false);
  });

  it("coalesces Kiro misses while one caller can abort independently", async () => {
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
      refreshKiroToken: vi.fn(),
    }));
    const upstream = controlledJsonResponse();
    let transportSignal;
    const fetchMock = vi.fn(async (_url, init) => {
      transportSignal = init.signal;
      return upstream.response;
    });
    globalThis.fetch = fetchMock;
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");
    const credentials = {
      accessToken: "kiro-shared",
      providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/shared" },
    };
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();

    const first = resolveKiroModels(credentials, { signal: firstCaller.signal });
    const second = resolveKiroModels(credentials, { signal: secondCaller.signal });
    await waitForFetch(fetchMock);
    firstCaller.abort(new DOMException("first caller left", "AbortError"));

    await expect(first).resolves.toBeNull();
    expect(transportSignal.aborted).toBe(false);
    upstream.finish({ models: [{ modelId: "kiro-shared", modelName: "Kiro Shared" }] });
    await expect(second).resolves.toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: "kiro-shared" })]),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not let an older Kiro force refresh overwrite a newer catalog", async () => {
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
      refreshKiroToken: vi.fn(),
    }));
    const older = controlledJsonResponse();
    const newer = controlledJsonResponse();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(older.response)
      .mockResolvedValueOnce(newer.response);
    globalThis.fetch = fetchMock;
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");
    const credentials = {
      accessToken: "kiro-order",
      providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/order" },
    };

    const olderPending = resolveKiroModels(credentials, { forceRefresh: true });
    await waitForFetch(fetchMock);
    const newerPending = resolveKiroModels(credentials, { forceRefresh: true });
    while (fetchMock.mock.calls.length < 2) await Promise.resolve();

    newer.finish({ models: [{ modelId: "kiro-newer" }] });
    await expect(newerPending).resolves.toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: "kiro-newer" })]),
    });
    older.finish({ models: [{ modelId: "kiro-older" }] });
    await expect(olderPending).resolves.toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: "kiro-older" })]),
    });

    await expect(resolveKiroModels(credentials)).resolves.toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: "kiro-newer" })]),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["invalidate", "clear"])(
    "does not repopulate a Kiro cache after %s during an in-flight request",
    async (mode) => {
      vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
        refreshKiroToken: vi.fn(),
      }));
      const older = controlledJsonResponse();
      const newer = controlledJsonResponse();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(older.response)
        .mockResolvedValueOnce(newer.response);
      globalThis.fetch = fetchMock;
      const {
        clearKiroModelCache,
        invalidateKiroModelCache,
        resolveKiroModels,
      } = await import("../../open-sse/services/kiroModels.js");
      const credentials = {
        accessToken: `kiro-${mode}`,
        providerSpecificData: {
          profileArn: `arn:aws:codewhisperer:us-east-1:1:profile/${mode}`,
        },
      };

      const beforeReset = resolveKiroModels(credentials, { forceRefresh: true });
      await waitForFetch(fetchMock);
      if (mode === "clear") clearKiroModelCache();
      else invalidateKiroModelCache(credentials);
      older.finish({ models: [{ modelId: "kiro-before-reset" }] });
      await expect(beforeReset).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "kiro-before-reset" })]),
      });

      const afterReset = resolveKiroModels(credentials);
      while (fetchMock.mock.calls.length < 2) await Promise.resolve();
      newer.finish({ models: [{ modelId: "kiro-after-reset" }] });
      await expect(afterReset).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "kiro-after-reset" })]),
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("interprets Qoder PAT expires_in as seconds and reuses the cached job token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ token: "jt-cache-fixture", expires_in: 86_400 }))
      .mockResolvedValueOnce(Response.json({ id: "qoder-user-fixture" }));
    globalThis.fetch = fetchMock;
    const { resolveQoderCredentials } = await import("../../open-sse/services/qoderModels.js");
    const credentials = { apiKey: "pt-cache-fixture", providerSpecificData: {} };

    const first = await resolveQoderCredentials(credentials);
    const second = await resolveQoderCredentials(credentials);

    expect(first.providerSpecificData.userId).toBe("qoder-user-fixture");
    expect(second.providerSpecificData.userId).toBe("qoder-user-fixture");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries Qoder userinfo after a transient failure without re-exchanging the PAT", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ token: "jt-recovery-fixture", expires_in: 86_400 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: "qoder-recovered-user" }));
    globalThis.fetch = fetchMock;
    const { resolveQoderCredentials } = await import("../../open-sse/services/qoderModels.js");
    const credentials = { apiKey: "pt-recovery-fixture", providerSpecificData: {} };

    expect((await resolveQoderCredentials(credentials)).providerSpecificData.userId).toBe("");
    expect((await resolveQoderCredentials(credentials)).providerSpecificData.userId)
      .toBe("qoder-recovered-user");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("jobToken/exchange")))
      .toHaveLength(1);
  });

  it("bounds Kiro JSON consumption and removes the caller abort listener", async () => {
    let upstream;
    let fetchSignal;
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    // Kiro only needs token refresh after a 401. Avoid importing the global
    // fetch patch here so this test can observe the exact signal passed to its
    // catalog transport.
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
      refreshKiroToken: vi.fn(),
    }));
    const fetchMock = vi.fn(async (_url, init) => {
      fetchSignal = init.signal;
      upstream = trackedResponse({ stall: true });
      return upstream.response;
    });
    globalThis.fetch = fetchMock;
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");

    const pending = resolveKiroModels({
      accessToken: "kiro-timeout-fixture",
      providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/test" },
    }, { forceRefresh: true, signal: caller.signal });

    await waitForFetch(fetchMock);
    await expect(expectDeadlineToSettle(pending, 30_000)).resolves.toBeNull();
    expect(fetchSignal.aborted).toBe(true);
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
    expect(add).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });

  it.each(["content-length", "chunked"])(
    "rejects an oversized Kiro catalog advertised via %s and unlocks it",
    async (mode) => {
      vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
        refreshKiroToken: vi.fn(),
      }));
      const upstream = oversizedResponse(mode);
      globalThis.fetch = vi.fn(async () => upstream.response);
      const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");

      await expect(resolveKiroModels({
        accessToken: `kiro-${mode}`,
        providerSpecificData: { profileArn: `arn:aws:codewhisperer:us-east-1:1:profile/${mode}` },
      }, { forceRefresh: true })).resolves.toBeNull();

      expect(upstream.cancel).toHaveBeenCalledOnce();
      expect(upstream.body.locked).toBe(false);
    },
  );

  it("parses a valid Kiro catalog and unlocks the successful body", async () => {
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
      refreshKiroToken: vi.fn(),
    }));
    const upstream = trackedResponse({
      text: '{"models":[{"modelId":"claude-live","modelName":"Claude Live"}]}',
    });
    globalThis.fetch = vi.fn(async () => upstream.response);
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");

    const result = await resolveKiroModels({
      accessToken: "kiro-success",
      providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/success" },
    }, { forceRefresh: true });

    expect(result.models.some((model) => model.id === "claude-live")).toBe(true);
    expect(upstream.cancel).not.toHaveBeenCalled();
    expect(upstream.body.locked).toBe(false);
  });

  it("does not log a Kiro error body that reflects the bearer token", async () => {
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
      refreshKiroToken: vi.fn(),
    }));
    const reflected = "Bearer kiro-secret-reflected-by-upstream";
    const upstream = trackedResponse({
      status: 502,
      text: JSON.stringify({ message: reflected }),
    });
    globalThis.fetch = vi.fn(async () => upstream.response);
    const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");

    await expect(resolveKiroModels({
      accessToken: "kiro-secret-reflected-by-upstream",
      providerSpecificData: {
        profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/reflected-error",
      },
    }, { forceRefresh: true, log })).resolves.toBeNull();

    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(reflected);
    expect(upstream.body.locked).toBe(false);
  });

  it("propagates Kiro caller cancellation to a stalled body", async () => {
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
      refreshKiroToken: vi.fn(),
    }));
    const upstream = trackedResponse({ stall: true });
    let fetchSignal;
    const fetchMock = vi.fn(async (_url, init) => {
      fetchSignal = init.signal;
      return upstream.response;
    });
    globalThis.fetch = fetchMock;
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");
    const caller = new AbortController();
    const pending = resolveKiroModels({
      accessToken: "kiro-caller-abort",
      providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/abort" },
    }, { forceRefresh: true, signal: caller.signal });

    while (fetchMock.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left", "AbortError"));
    await expect(pending).resolves.toBeNull();
    expect(fetchSignal.aborted).toBe(true);
    expect(fetchSignal.reason).toMatchObject({ name: "AbortError" });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("bounds a hanging Kiro refresh after a 401 and observes its late rejection", async () => {
    let refreshSignal;
    let rejectLate;
    const refreshKiroToken = vi.fn((...args) => {
      refreshSignal = args[4]?.signal;
      return new Promise((_, reject) => { rejectLate = reject; });
    });
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({ refreshKiroToken }));
    const fetchMock = vi.fn(async () => new Response("expired", { status: 401 }));
    globalThis.fetch = fetchMock;
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");

    const pending = resolveKiroModels({
      accessToken: "kiro-refresh-deadline",
      refreshToken: "kiro-refresh-deadline-old",
      providerSpecificData: {
        profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/refresh-deadline",
      },
    }, { forceRefresh: true });

    await waitForFetch(fetchMock);
    while (refreshKiroToken.mock.calls.length === 0) await Promise.resolve();
    await expect(expectDeadlineToSettle(pending, 30_000)).resolves.toBeNull();
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    expect(refreshSignal.aborted).toBe(true);
    expect(refreshSignal.reason).toMatchObject({ name: "TimeoutError" });

    rejectLate(new Error("late Kiro refresh failure"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("stops waiting for a hanging Kiro refresh when its caller aborts", async () => {
    let refreshSignal;
    let resolveLate;
    const refreshKiroToken = vi.fn((...args) => {
      refreshSignal = args[4]?.signal;
      return new Promise((resolve) => { resolveLate = resolve; });
    });
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({ refreshKiroToken }));
    globalThis.fetch = vi.fn(async () => new Response("expired", { status: 401 }));
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");
    const caller = new AbortController();
    const pending = resolveKiroModels({
      accessToken: "kiro-refresh-abort",
      refreshToken: "kiro-refresh-abort-old",
      providerSpecificData: {
        profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/refresh-abort",
      },
    }, { forceRefresh: true, signal: caller.signal });

    while (refreshKiroToken.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left", "AbortError"));

    await expect(pending).resolves.toBeNull();
    expect(refreshSignal.aborted).toBe(true);
    expect(refreshSignal.reason).toMatchObject({ name: "AbortError" });
    resolveLate({ accessToken: "too-late" });
    await Promise.resolve();
  });

  it("stops waiting for Kiro credential persistence when its caller aborts", async () => {
    const refreshKiroToken = vi.fn(async () => ({
      accessToken: "kiro-persist-abort-fresh",
      refreshToken: "kiro-persist-abort-fresh-refresh",
    }));
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({ refreshKiroToken }));
    const fetchMock = vi.fn(async () => new Response("expired", { status: 401 }));
    globalThis.fetch = fetchMock;
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");
    const caller = new AbortController();
    let rejectLate;
    const onCredentialsRefreshed = vi.fn(() => new Promise((_, reject) => {
      rejectLate = reject;
    }));
    const pending = resolveKiroModels({
      accessToken: "kiro-persist-abort-old",
      refreshToken: "kiro-persist-abort-old-refresh",
      providerSpecificData: {
        profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/persist-abort",
      },
    }, {
      forceRefresh: true,
      signal: caller.signal,
      onCredentialsRefreshed,
    });

    while (onCredentialsRefreshed.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left during persistence", "AbortError"));

    await expect(pending).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    rejectLate(new Error("late Kiro persistence failure"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("keeps Copilot's internal timeout when a caller signal is supplied", async () => {
    let upstream;
    let fetchSignal;
    const caller = new AbortController();
    const fetchMock = vi.fn(async (_url, init) => {
      fetchSignal = init.signal;
      upstream = trackedResponse({ stall: true });
      return upstream.response;
    });
    globalThis.fetch = fetchMock;
    const { resolveCopilotModels } = await import("../../open-sse/services/copilotModels.js");

    const pending = resolveCopilotModels({
      accessToken: "github-timeout-fixture",
      providerSpecificData: { copilotToken: "copilot-timeout-fixture" },
    }, { forceRefresh: true, signal: caller.signal });

    await waitForFetch(fetchMock);
    await expect(expectDeadlineToSettle(pending, 10_000)).resolves.toBeNull();
    expect(caller.signal.aborted).toBe(false);
    expect(fetchSignal.aborted).toBe(true);
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it.each(["content-length", "chunked"])(
    "rejects an oversized Copilot catalog advertised via %s and unlocks it",
    async (mode) => {
      const upstream = oversizedResponse(mode);
      globalThis.fetch = vi.fn(async () => upstream.response);
      const { resolveCopilotModels } = await import("../../open-sse/services/copilotModels.js");

      await expect(resolveCopilotModels({
        accessToken: `github-${mode}`,
        providerSpecificData: { copilotToken: `copilot-${mode}` },
      }, { forceRefresh: true })).resolves.toBeNull();

      expect(upstream.cancel).toHaveBeenCalledOnce();
      expect(upstream.body.locked).toBe(false);
    },
  );

  it("parses a valid Copilot catalog and unlocks the successful body", async () => {
    const upstream = trackedResponse({
      text: '{"data":[{"id":"gpt-live","name":"GPT Live","capabilities":{"type":"chat"},"policy":{"state":"enabled"}}]}',
    });
    globalThis.fetch = vi.fn(async () => upstream.response);
    const { resolveCopilotModels } = await import("../../open-sse/services/copilotModels.js");

    await expect(resolveCopilotModels({
      accessToken: "github-success",
      providerSpecificData: { copilotToken: "copilot-success" },
    }, { forceRefresh: true })).resolves.toEqual({
      models: [{ id: "gpt-live", name: "GPT Live" }],
    });
    expect(upstream.cancel).not.toHaveBeenCalled();
    expect(upstream.body.locked).toBe(false);
  });

  it("propagates Copilot caller cancellation to a stalled body", async () => {
    const upstream = trackedResponse({ stall: true });
    let fetchSignal;
    const fetchMock = vi.fn(async (_url, init) => {
      fetchSignal = init.signal;
      return upstream.response;
    });
    globalThis.fetch = fetchMock;
    const { resolveCopilotModels } = await import("../../open-sse/services/copilotModels.js");
    const caller = new AbortController();
    const pending = resolveCopilotModels({
      accessToken: "github-caller-abort",
      providerSpecificData: { copilotToken: "copilot-caller-abort" },
    }, { forceRefresh: true, signal: caller.signal });

    while (fetchMock.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left", "AbortError"));
    await expect(pending).resolves.toBeNull();
    expect(fetchSignal.aborted).toBe(true);
    expect(fetchSignal.reason).toMatchObject({ name: "AbortError" });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("bounds a hanging Copilot refresh after a 403", async () => {
    let refreshSignal;
    const refreshCopilotToken = vi.fn((...args) => {
      refreshSignal = args[2]?.signal;
      return new Promise(() => {});
    });
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({ refreshCopilotToken }));
    globalThis.fetch = vi.fn(async () => new Response("expired", { status: 403 }));
    const { resolveCopilotModels } = await import("../../open-sse/services/copilotModels.js");

    const pending = resolveCopilotModels({
      accessToken: "github-refresh-deadline",
      providerSpecificData: { copilotToken: "copilot-refresh-deadline-old" },
    }, { forceRefresh: true });

    while (refreshCopilotToken.mock.calls.length === 0) await Promise.resolve();
    await expect(expectDeadlineToSettle(pending, 10_000)).resolves.toBeNull();
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    expect(refreshSignal.aborted).toBe(true);
    expect(refreshSignal.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("stops waiting for a hanging Copilot refresh when its caller aborts", async () => {
    let refreshSignal;
    let rejectLate;
    const refreshCopilotToken = vi.fn((...args) => {
      refreshSignal = args[2]?.signal;
      return new Promise((_, reject) => { rejectLate = reject; });
    });
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({ refreshCopilotToken }));
    globalThis.fetch = vi.fn(async () => new Response("expired", { status: 401 }));
    const { resolveCopilotModels } = await import("../../open-sse/services/copilotModels.js");
    const caller = new AbortController();
    const pending = resolveCopilotModels({
      accessToken: "github-refresh-abort",
      providerSpecificData: { copilotToken: "copilot-refresh-abort-old" },
    }, { forceRefresh: true, signal: caller.signal });

    while (refreshCopilotToken.mock.calls.length === 0) await Promise.resolve();
    caller.abort(new DOMException("client left", "AbortError"));

    await expect(pending).resolves.toBeNull();
    expect(refreshSignal.aborted).toBe(true);
    expect(refreshSignal.reason).toMatchObject({ name: "AbortError" });
    rejectLate(new Error("late Copilot refresh failure"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("bounds Copilot credential persistence before giving the retry a fresh deadline", async () => {
    const refreshCopilotToken = vi.fn(async () => ({
      token: "copilot-persist-timeout-fresh",
      expiresAt: 12345,
    }));
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({ refreshCopilotToken }));
    const retry = trackedResponse({ stall: true });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("expired", { status: 403 }))
      .mockResolvedValueOnce(retry.response);
    globalThis.fetch = fetchMock;
    const { resolveCopilotModels } = await import("../../open-sse/services/copilotModels.js");
    let rejectLate;
    const onCredentialsRefreshed = vi.fn(() => new Promise((_, reject) => {
      rejectLate = reject;
    }));
    const pending = resolveCopilotModels({
      accessToken: "github-persist-timeout",
      providerSpecificData: { copilotToken: "copilot-persist-timeout-old" },
    }, {
      forceRefresh: true,
      onCredentialsRefreshed,
    });
    let settled = false;
    pending.finally(() => { settled = true; }).catch(() => {});

    while (onCredentialsRefreshed.mock.calls.length === 0) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    while (fetchMock.mock.calls.length < 2) await Promise.resolve();

    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retry.cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await expect(expectDeadlineToSettle(pending, 1)).resolves.toBeNull();
    expect(retry.cancel).toHaveBeenCalledOnce();
    expect(retry.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    rejectLate(new Error("late Copilot persistence failure"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("bounds the real Kiro refresh response body", async () => {
    vi.doUnmock("../../open-sse/services/tokenRefresh.js");
    const upstream = trackedResponse({ stall: true });
    let refreshSignal;
    const fetchMock = vi.fn(async (_url, init) => {
      refreshSignal = init.signal;
      return upstream.response;
    });
    globalThis.fetch = fetchMock;
    const { refreshKiroToken } = await import("../../open-sse/services/tokenRefresh.js");

    const pending = refreshKiroToken(
      "kiro-real-refresh-timeout",
      { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/real-timeout" },
    );

    await waitForFetch(fetchMock);
    await expect(expectDeadlineToSettle(pending, 30_000)).resolves.toBeNull();
    expect(refreshSignal.aborted).toBe(true);
    expect(refreshSignal.reason).toMatchObject({ name: "TimeoutError" });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("bounds the real Copilot refresh response body", async () => {
    vi.doUnmock("../../open-sse/services/tokenRefresh.js");
    const upstream = trackedResponse({ stall: true });
    let refreshSignal;
    const fetchMock = vi.fn(async (_url, init) => {
      refreshSignal = init.signal;
      return upstream.response;
    });
    globalThis.fetch = fetchMock;
    const { refreshCopilotToken } = await import("../../open-sse/services/tokenRefresh.js");

    const pending = refreshCopilotToken("copilot-real-refresh-timeout");

    await waitForFetch(fetchMock);
    await expect(expectDeadlineToSettle(pending, 10_000)).resolves.toBeNull();
    expect(refreshSignal.aborted).toBe(true);
    expect(refreshSignal.reason).toMatchObject({ name: "TimeoutError" });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("keeps a deduplicated Copilot refresh alive when one caller aborts", async () => {
    vi.doUnmock("../../open-sse/services/tokenRefresh.js");
    const upstream = controlledJsonResponse();
    const fetchMock = vi.fn(async () => upstream.response);
    globalThis.fetch = fetchMock;
    const { refreshCopilotToken } = await import("../../open-sse/services/tokenRefresh.js");
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = refreshCopilotToken(
      "copilot-shared-refresh",
      null,
      { signal: firstController.signal },
    );
    const second = refreshCopilotToken(
      "copilot-shared-refresh",
      null,
      { signal: secondController.signal },
    );
    const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });

    await waitForFetch(fetchMock);
    firstController.abort(new DOMException("first caller left", "AbortError"));
    await firstRejected;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(upstream.cancel).not.toHaveBeenCalled();

    upstream.finish({ token: "shared-token", expires_at: 12345 });
    await expect(second).resolves.toEqual({ token: "shared-token", expiresAt: 12345 });
    expect(upstream.cancel).not.toHaveBeenCalled();
    expect(upstream.body.locked).toBe(false);
  });

  it.each(["kiro", "copilot"])(
    "does not start a %s refresh for an already-aborted caller",
    async (provider) => {
      vi.doUnmock("../../open-sse/services/tokenRefresh.js");
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
      const { refreshCopilotToken, refreshKiroToken } = await import(
        "../../open-sse/services/tokenRefresh.js"
      );
      const caller = new AbortController();
      caller.abort(new DOMException("caller already left", "AbortError"));

      const pending = provider === "kiro"
        ? refreshKiroToken(
          `kiro-pre-abort-${provider}`,
          { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/pre-abort" },
          null,
          null,
          { signal: caller.signal },
        )
        : refreshCopilotToken(
          `copilot-pre-abort-${provider}`,
          null,
          { signal: caller.signal },
        );

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["kiro", "copilot"])(
    "rejects an oversized %s refresh body and releases the stream",
    async (provider) => {
      vi.doUnmock("../../open-sse/services/tokenRefresh.js");
      const upstream = oversizedResponse("chunked");
      globalThis.fetch = vi.fn(async () => upstream.response);
      const { refreshCopilotToken, refreshKiroToken } = await import(
        "../../open-sse/services/tokenRefresh.js"
      );

      const result = provider === "kiro"
        ? await refreshKiroToken(
          "kiro-real-refresh-oversized",
          { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/real-oversized" },
        )
        : await refreshCopilotToken("copilot-real-refresh-oversized");

      expect(result).toBeNull();
      expect(upstream.cancel).toHaveBeenCalledOnce();
      expect(upstream.body.locked).toBe(false);
    },
  );

  it("keeps timeout and oversize failures distinguishable in the shared reader", async () => {
    const { readModelCatalogJson } = await import(
      "../../open-sse/services/modelCatalogResponse.js"
    );
    const oversized = oversizedResponse("content-length");
    await expect(readModelCatalogJson(oversized.response)).rejects.toMatchObject({
      name: "ModelCatalogBodyTooLargeError",
      code: "ERR_MODEL_CATALOG_BODY_TOO_LARGE",
    });

    const stalled = trackedResponse({ stall: true });
    const controller = new AbortController();
    const pending = readModelCatalogJson(stalled.response, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    controller.abort(new DOMException("catalog deadline", "TimeoutError"));
    await rejected;
    expect(stalled.cancel).toHaveBeenCalledOnce();
    expect(stalled.body.locked).toBe(false);
  });

  it("does not let a broken cancellation hook extend the body deadline", async () => {
    const { readModelCatalogJson } = await import(
      "../../open-sse/services/modelCatalogResponse.js"
    );
    const upstream = trackedResponse({ stall: true, stallCancellation: true });
    const controller = new AbortController();
    const pending = readModelCatalogJson(upstream.response, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });

    controller.abort(new DOMException("catalog deadline", "TimeoutError"));

    await rejected;
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("rejects invalid UTF-8 in a syntactically valid model catalog JSON envelope", async () => {
    const { readModelCatalogJson } = await import(
      "../../open-sse/services/modelCatalogResponse.js"
    );
    const upstream = trackedResponse({
      chunks: [new Uint8Array([
        ...new TextEncoder().encode('{"models":[{"id":"'),
        0xff,
        ...new TextEncoder().encode('"}]}'),
      ])],
      leaveOpen: true,
    });

    await expect(readModelCatalogJson(upstream.response)).rejects.toBeInstanceOf(TypeError);
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });
});
