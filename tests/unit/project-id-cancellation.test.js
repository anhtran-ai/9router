import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getProjectIdForConnection,
  invalidateProjectId,
  PROJECT_ID_SHARED_FETCH_TIMEOUT_MS,
  removeConnection,
} from "../../open-sse/services/projectId.js";

const connectionIds = new Set();

function projectResponse(projectId) {
  return {
    ok: true,
    json: async () => ({ cloudaicompanionProject: { id: projectId } }),
  };
}

function track(connectionId) {
  connectionIds.add(connectionId);
  return connectionId;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const connectionId of connectionIds) removeConnection(connectionId);
  connectionIds.clear();
});

describe("project-ID request cancellation and timeout", () => {
  it("stops only the aborted caller while the shared lookup warms the cache", async () => {
    const connectionId = track("project-id-caller-abort");
    let resolveFetch;
    let sharedSignal;
    const fetchMock = vi.fn((_url, options) => {
      sharedSignal = options.signal;
      return new Promise((resolve) => { resolveFetch = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AbortController();
    const first = getProjectIdForConnection(
      connectionId,
      "access-token",
      "gemini-cli",
      { signal: client.signal, timeoutMs: 1_000 },
    );
    const aborted = expect(first).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sharedSignal).not.toBe(client.signal);
    client.abort();
    await aborted;
    expect(sharedSignal.aborted).toBe(false);

    const second = getProjectIdForConnection(
      connectionId,
      "access-token",
      "gemini-cli",
      { timeoutMs: 1_000 },
    );
    resolveFetch(projectResponse("shared-project"));

    await expect(second).resolves.toBe("shared-project");
    await expect(getProjectIdForConnection(connectionId, "access-token")).resolves.toBe("shared-project");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds one caller's wait without aborting or evicting the shared lookup", async () => {
    vi.useFakeTimers();
    const connectionId = track("project-id-caller-timeout");
    let resolveFetch;
    let sharedSignal;
    const fetchMock = vi.fn((_url, options) => {
      sharedSignal = options.signal;
      return new Promise((resolve) => { resolveFetch = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = getProjectIdForConnection(
      connectionId,
      "access-token",
      "antigravity",
      { timeoutMs: 25 },
    );
    const timedOut = expect(first).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(25);
    await timedOut;

    expect(sharedSignal.aborted).toBe(false);
    const second = getProjectIdForConnection(
      connectionId,
      "access-token",
      "antigravity",
      { timeoutMs: 1_000 },
    );
    resolveFetch(projectResponse("late-project"));

    await expect(second).resolves.toBe("late-project");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a no-waiter warm lookup only until the shared hard deadline", async () => {
    vi.useFakeTimers();
    const connectionId = track("project-id-shared-deadline");
    let sharedSignal;
    let attempt = 0;
    const fetchMock = vi.fn((_url, options) => {
      attempt += 1;
      if (attempt === 2) return Promise.resolve(projectResponse("replacement-after-deadline"));
      sharedSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("shared lookup deadline", "AbortError")),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const caller = getProjectIdForConnection(
      connectionId,
      "access-token",
      "gemini-cli",
      { timeoutMs: 25 },
    );
    const timedOut = expect(caller).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(25);
    await timedOut;
    expect(sharedSignal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(PROJECT_ID_SHARED_FETCH_TIMEOUT_MS - 25);
    expect(sharedSignal.aborted).toBe(true);
    await vi.runAllTicks();
    await expect(getProjectIdForConnection(
      connectionId,
      "new-access-token",
      "gemini-cli",
      { timeoutMs: 1_000 },
    )).resolves.toBe("replacement-after-deadline");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a pre-aborted caller before starting a network lookup", async () => {
    const connectionId = track("project-id-pre-aborted");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new AbortController();
    client.abort();

    await expect(getProjectIdForConnection(
      connectionId,
      "access-token",
      "gemini-cli",
      { signal: client.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let an abort-ignoring stale fetch populate cache after removal", async () => {
    const connectionId = track("project-id-replaced-fetch");
    const pendingFetches = [];
    const fetchMock = vi.fn((_url, options) => new Promise((resolve) => {
      pendingFetches.push({ resolve, signal: options.signal });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const stale = getProjectIdForConnection(
      connectionId,
      "old-access-token",
      "gemini-cli",
      { timeoutMs: 1_000 },
    );
    removeConnection(connectionId);
    expect(pendingFetches[0].signal.aborted).toBe(true);

    const replacement = getProjectIdForConnection(
      connectionId,
      "new-access-token",
      "gemini-cli",
      { timeoutMs: 1_000 },
    );
    pendingFetches[0].resolve(projectResponse("stale-project"));
    pendingFetches[1].resolve(projectResponse("replacement-project"));

    await expect(stale).resolves.toBeNull();
    await expect(replacement).resolves.toBe("replacement-project");
    await expect(getProjectIdForConnection(connectionId, "new-access-token")).resolves.toBe("replacement-project");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the newer cached result when an abort-ignoring replacement resolves first", async () => {
    const connectionId = track("project-id-newer-result-wins");
    const pendingFetches = [];
    const fetchMock = vi.fn((_url, options) => new Promise((resolve) => {
      pendingFetches.push({ resolve, signal: options.signal });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const stale = getProjectIdForConnection(
      connectionId,
      "old-access-token",
      "gemini-cli",
      { timeoutMs: 1_000 },
    );
    removeConnection(connectionId);
    const replacement = getProjectIdForConnection(
      connectionId,
      "new-access-token",
      "gemini-cli",
      { timeoutMs: 1_000 },
    );

    pendingFetches[1].resolve(projectResponse("replacement-project"));
    await expect(replacement).resolves.toBe("replacement-project");
    pendingFetches[0].resolve(projectResponse("stale-project"));
    await expect(stale).resolves.toBeNull();

    await expect(getProjectIdForConnection(connectionId, "new-access-token")).resolves.toBe("replacement-project");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh lookup after credential refresh invalidates an in-flight request", async () => {
    const connectionId = track("project-id-refresh-replacement");
    const pendingFetches = [];
    const fetchMock = vi.fn((_url, options) => new Promise((resolve) => {
      pendingFetches.push({ resolve, signal: options.signal });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const stale = getProjectIdForConnection(
      connectionId,
      "old-access-token",
      "gemini-cli",
      { timeoutMs: 1_000 },
    );
    invalidateProjectId(connectionId);

    expect(pendingFetches[0].signal.aborted).toBe(true);
    const replacement = getProjectIdForConnection(
      connectionId,
      "new-access-token",
      "gemini-cli",
      { timeoutMs: 1_000 },
    );

    pendingFetches[1].resolve(projectResponse("replacement-project"));
    await expect(replacement).resolves.toBe("replacement-project");
    pendingFetches[0].resolve(projectResponse("stale-project"));
    await expect(stale).resolves.toBeNull();
    await expect(getProjectIdForConnection(connectionId, "new-access-token")).resolves.toBe("replacement-project");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the onboarding attempt timeout active while parsing its response body", async () => {
    vi.useFakeTimers();
    const connectionId = track("project-id-onboard-body-timeout");
    const previousMaxAttempts = process.env.ONBOARD_MAX_ATTEMPTS;
    process.env.ONBOARD_MAX_ATTEMPTS = "1";
    let onboardSignal;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allowedTiers: [{ id: "fixture-tier", isDefault: true }] }),
      })
      .mockImplementationOnce((_url, options) => {
        onboardSignal = options.signal;
        return Promise.resolve({
          ok: true,
          json: () => new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException("onboard body timeout", "AbortError"));
            if (options.signal.aborted) abort();
            else options.signal.addEventListener("abort", abort, { once: true });
          }),
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const pending = getProjectIdForConnection(
        connectionId,
        "access-token",
        "gemini-cli",
        { timeoutMs: 30_000 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(onboardSignal.aborted).toBe(true);
      await expect(pending).resolves.toBeNull();
    } finally {
      if (previousMaxAttempts === undefined) delete process.env.ONBOARD_MAX_ATTEMPTS;
      else process.env.ONBOARD_MAX_ATTEMPTS = previousMaxAttempts;
    }
  });
});
