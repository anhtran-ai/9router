import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression coverage for #3714: the SSRF guard's literal-hostname/IP checks
// matched specific textual representations rather than the underlying address,
// so a different (but equivalent) representation slipped through. Each case
// below is a bypass the issue reported, or one found while fixing it.

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

const { assertPublicUrl, assertPublicUrlResolved, fetchPublic } = await import("../../src/shared/utils/ssrfGuard.js");

describe("assertPublicUrl: literal hostname/IP bypasses from #3714", () => {
  it("blocks a trailing-dot FQDN the same as the bare hostname", () => {
    expect(() => assertPublicUrl("http://localhost/")).toThrow();
    expect(() => assertPublicUrl("http://localhost./")).toThrow();
    expect(() => assertPublicUrl("http://LOCALHOST./")).toThrow();
  });

  it("blocks IPv4-mapped IPv6 loopback regardless of which textual form the URL parser picks", () => {
    // WHATWG URL parsing normalizes dotted-decimal IPv4-in-IPv6 to hex form —
    // the original regex only matched the dotted form.
    expect(() => assertPublicUrl("http://[::ffff:127.0.0.1]/")).toThrow();
    expect(() => assertPublicUrl("http://[::ffff:7f00:1]/")).toThrow(); // hex form directly
    expect(() => assertPublicUrl("http://[0000::ffff:127.0.0.1]/")).toThrow();
  });

  it("blocks IPv4-mapped IPv6 cloud metadata address (169.254.169.254)", () => {
    expect(() => assertPublicUrl("http://[::ffff:169.254.169.254]/")).toThrow();
    expect(() => assertPublicUrl("http://[::ffff:a9fe:a9fe]/")).toThrow(); // hex form
  });

  it("blocks other loopback/private/link-local/ULA IPv6 forms", () => {
    for (const url of [
      "http://[::1]/",
      "http://[::127.0.0.1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[64:ff9b::127.0.0.1]/", // NAT64 well-known prefix embedding a private IPv4
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow();
    }
  });

  it("blocks alternate IPv4 literal encodings (already normalized by the URL parser)", () => {
    for (const url of ["http://127.1/", "http://0177.0.0.1/", "http://2130706433/", "http://0x7f.0.0.1/"]) {
      expect(() => assertPublicUrl(url), url).toThrow();
    }
  });

  it("still allows public hosts, including public IPv6", () => {
    expect(() => assertPublicUrl("https://api.openai.com/v1/models")).not.toThrow();
    expect(() => assertPublicUrl("http://8.8.8.8/")).not.toThrow();
    expect(() => assertPublicUrl("https://[2001:4860:4860::8888]/")).not.toThrow();
  });

  it("blocks all non-globally-reachable IPv4 ranges, not only RFC1918", () => {
    for (const url of [
      "http://192.0.0.1/",
      "http://192.0.2.1/",
      "http://198.18.0.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://224.0.0.1/",
      "http://255.255.255.255/",
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow();
    }
  });

  it("blocks non-global IPv6 special-purpose and documentation space", () => {
    for (const url of [
      "http://[::ffff:8.8.8.8]/",
      "http://[64:ff9b::808:808]/",
      "http://[100::1]/",
      "http://[2001:db8::1]/",
      "http://[2002:0808:0808::1]/",
      "http://[3fff::1]/",
      "http://[ff02::1]/",
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow();
    }
  });

  it("rejects non-http protocols before any fetch can occur", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/file", "gopher://example.com/"]) {
      expect(() => assertPublicUrl(url), url).toThrow(/http/i);
    }
  });
});

describe("assertPublicUrlResolved: DNS-resolving hostname bypass from #3714", () => {
  beforeEach(() => { lookupMock.mockReset(); });

  it("blocks a hostname that resolves to a loopback address (nip.io-style wildcard DNS)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertPublicUrlResolved("http://127.0.0.1.nip.io/")).rejects.toThrow();
  });

  it("blocks a hostname that resolves to a private range even if one of several addresses is public", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    await expect(assertPublicUrlResolved("http://multi-a-record.example.test/")).rejects.toThrow();
  });

  it("blocks a hostname that resolves to a blocked IPv6 address", async () => {
    lookupMock.mockResolvedValue([{ address: "::1", family: 6 }]);
    await expect(assertPublicUrlResolved("http://evil.example.test/")).rejects.toThrow();
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertPublicUrlResolved("https://example.com/")).resolves.not.toThrow();
  });

  it("fails closed when DNS returns no addresses", async () => {
    lookupMock.mockResolvedValue([]);
    await expect(assertPublicUrlResolved("https://empty.example.test/")).rejects.toThrow(/no addresses/i);
  });

  it("skips DNS lookup entirely for literal IP hosts (already covered by the sync check)", async () => {
    await expect(assertPublicUrlResolved("http://127.0.0.1/")).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("honors an already-aborted caller signal before starting DNS", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(assertPublicUrlResolved("https://aborted.example.test/", {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("fails closed on a stalled DNS resolver within the internal deadline", async () => {
    lookupMock.mockImplementation(() => new Promise(() => {}));
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce((callback, delay) => {
      expect(delay).toBe(10);
      queueMicrotask(callback);
      return 1;
    });

    try {
      await expect(assertPublicUrlResolved("https://stalled.example.test/", {
        dnsTimeoutMs: 10,
      })).rejects.toThrow(/DNS resolution timed out/i);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("fetchPublic: redirect-target re-validation from #3714", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  beforeEach(() => {
    lookupMock.mockReset();
    // These tests exercise redirect-chasing, not DNS behavior — give every
    // synthetic *.example.test hostname a default public resolution so it
    // doesn't get blocked (or throw on an unmocked undefined return) before
    // reaching the redirect logic under test.
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("blocks a redirect from a validated public URL to an internal target", async () => {
    global.fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "http://127.0.0.1:9999/admin" },
    }));

    await expect(fetchPublic("https://public.example.test/redirect")).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1); // never followed the redirect
  });

  it("follows a redirect chain of public URLs, re-validating each hop", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://hop2.example.test/" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const res = await fetchPublic("https://hop1.example.test/");
    expect(await res.text()).toBe("ok");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toBe("https://hop2.example.test/");
    expect(global.fetch.mock.calls[0][1].dispatcher).toBeDefined();
    expect(global.fetch.mock.calls[1][1].dispatcher).toBeDefined();
  });

  it("does not await a redirect body cancel hook that never settles", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const redirect = new Response(new ReadableStream({ cancel }), {
      status: 302,
      headers: { Location: "https://hop2.example.test/" },
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await fetchPublic("https://hop1.example.test/");

    expect(await response.text()).toBe("ok");
    expect(cancel).toHaveBeenCalledOnce();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("strips credentials before following a cross-origin redirect", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: "https://other.example.test/next" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await fetchPublic("https://origin.example.test/start", {
      headers: {
        Authorization: "Bearer stored-provider-token",
        Cookie: "session=secret",
        "X-API-Key": "stored-api-key",
        "Mcp-Session-Id": "mcp-session-secret",
        "X-Custom-Token": "provider-custom-token",
        Accept: "application/json",
      },
    });

    const redirectedHeaders = global.fetch.mock.calls[1][1].headers;
    expect(redirectedHeaders.get("authorization")).toBeNull();
    expect(redirectedHeaders.get("cookie")).toBeNull();
    expect(redirectedHeaders.get("x-api-key")).toBeNull();
    expect(redirectedHeaders.get("mcp-session-id")).toBeNull();
    expect(redirectedHeaders.get("x-custom-token")).toBeNull();
    expect(redirectedHeaders.get("accept")).toBe("application/json");
  });

  it("keeps credentials on a same-origin redirect", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: "/next" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await fetchPublic("https://same.example.test/start", {
      headers: { Authorization: "Bearer provider-token" },
    });

    expect(global.fetch.mock.calls[1][1].headers.get("authorization")).toBe("Bearer provider-token");
  });

  it("bounds the redirect chain instead of looping forever", async () => {
    global.fetch = vi.fn(async (url) => new Response(null, {
      status: 302,
      headers: { Location: url === "https://loop.example.test/a" ? "https://loop.example.test/b" : "https://loop.example.test/a" },
    }));

    await expect(fetchPublic("https://loop.example.test/a", {}, { maxRedirects: 3 })).rejects.toThrow(/too many redirects/i);
  });

  it.each([300, 304, 305, 306])("returns non-redirect status %s even when it carries a Location header", async (status) => {
    global.fetch = vi.fn(async () => new Response(null, {
      status,
      headers: { Location: "https://other.example.test/unexpected" },
    }));

    const res = await fetchPublic("https://origin.example.test/not-modified");
    expect(res.status).toBe(status);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects the initial URL before ever calling fetch", async () => {
    global.fetch = vi.fn();
    await expect(fetchPublic("http://127.0.0.1/steal")).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("honors caller abort while DNS resolution is stalled", async () => {
    lookupMock.mockImplementation(() => new Promise(() => {}));
    global.fetch = vi.fn();
    const controller = new AbortController();

    const resultPromise = fetchPublic("https://stalled.example.test/", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
