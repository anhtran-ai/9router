import { afterEach, describe, expect, it, vi } from "vitest";

const platformFetch = globalThis.fetch;

async function loadProxyFetchWithSpy() {
  const nativeFetch = vi.fn(async () => new Response("ok", { status: 200 }));
  globalThis.fetch = nativeFetch;
  vi.resetModules();
  const proxyFetch = await import("../../open-sse/utils/proxyFetch.js");
  return { nativeFetch, ...proxyFetch };
}

afterEach(() => {
  globalThis.fetch = platformFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("proxyAwareFetch explicit dispatcher boundary", () => {
  it("does not replace a caller-pinned dispatcher with an environment proxy", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "");
    const { nativeFetch, proxyAwareFetch } = await loadProxyFetchWithSpy();
    const pinnedDispatcher = { kind: "validated-address-dispatcher" };

    await proxyAwareFetch("https://public.example/resource", {
      dispatcher: pinnedDispatcher,
    });

    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(nativeFetch.mock.calls[0][1].dispatcher).toBe(pinnedDispatcher);
  });

  it("does not let the MITM-bypass host branch replace a pinned dispatcher", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "");
    const { nativeFetch, proxyAwareFetch } = await loadProxyFetchWithSpy();
    const pinnedDispatcher = { kind: "validated-address-dispatcher" };

    await proxyAwareFetch("https://api2.cursor.sh/resource", {
      dispatcher: pinnedDispatcher,
    });

    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(nativeFetch.mock.calls[0][1].dispatcher).toBe(pinnedDispatcher);
  });

  it("does not relay a caller-pinned request through a configured Vercel relay", async () => {
    const { nativeFetch, proxyAwareFetch } = await loadProxyFetchWithSpy();
    const pinnedDispatcher = { kind: "validated-address-dispatcher" };

    await proxyAwareFetch("https://public.example/resource", {
      dispatcher: pinnedDispatcher,
    }, {
      vercelRelayUrl: "https://relay.example/proxy",
    });

    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(nativeFetch.mock.calls[0][0]).toBe("https://public.example/resource");
    expect(nativeFetch.mock.calls[0][1].dispatcher).toBe(pinnedDispatcher);
    expect(new Headers(nativeFetch.mock.calls[0][1].headers).has("x-relay-target")).toBe(false);
  });

  it("matches only the exact MITM-bypass host, never an attacker-controlled suffix", async () => {
    const { shouldBypassMitmDns } = await loadProxyFetchWithSpy();

    expect(shouldBypassMitmDns("https://cloudcode-pa.googleapis.com/v1"))
      .toBe(true);
    expect(shouldBypassMitmDns("https://cloudcode-pa.googleapis.com.attacker.test/v1"))
      .toBe(false);
    expect(shouldBypassMitmDns("https://attacker.test/cloudcode-pa.googleapis.com/v1"))
      .toBe(false);
  });

  it("pins the Undici lookup to the resolved host and address", async () => {
    const { createPinnedBypassLookup } = await loadProxyFetchWithSpy();
    const lookup = createPinnedBypassLookup("api2.cursor.sh", "93.184.216.34");

    await expect(new Promise((resolve, reject) => {
      lookup("api2.cursor.sh", { all: true }, (error, records) => {
        if (error) reject(error);
        else resolve(records);
      });
    })).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);

    await expect(new Promise((resolve, reject) => {
      lookup("attacker.example", {}, (error, address) => {
        if (error) reject(error);
        else resolve(address);
      });
    })).rejects.toThrow(/unexpected DNS lookup/i);
  });

  it("keeps the caller signal attached to a bypass response body after headers", async () => {
    let bodyController;
    const nativeFetch = vi.fn(async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          bodyController = controller;
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });
    globalThis.fetch = nativeFetch;
    vi.resetModules();
    const { createBypassRequest } = await import("../../open-sse/utils/proxyFetch.js");
    const controller = new AbortController();

    const response = await createBypassRequest(
      new URL("https://api2.cursor.sh/resource"),
      "93.184.216.34",
      { signal: controller.signal },
    );
    const bodyRead = response.text();
    controller.abort(new DOMException("deadline", "AbortError"));

    await expect(bodyRead).rejects.toMatchObject({ name: "AbortError" });
    expect(nativeFetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(nativeFetch.mock.calls[0][1].dispatcher?.constructor?.name).toBe("Agent");
    expect(nativeFetch.mock.calls[0][1].headers.get("host")).toBe("api2.cursor.sh");
    expect(bodyController).toBeDefined();
  });
});
