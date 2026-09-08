/**
 * SSRF guard on POST /api/cli-tools/cowork-mcp-tools (#3782).
 *
 * Remote callers must not be able to force server-side fetches to
 * internal URLs; local-host use (self-hosted MCP servers) keeps working.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

const { POST } = await import(
  "../../src/app/api/cli-tools/cowork-mcp-tools/route.js"
);
const originalFetch = globalThis.fetch;

function remoteRequest(url) {
  return new Request("http://gateway.example.com/api/cli-tools/cowork-mcp-tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

describe("cowork-mcp-tools SSRF guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects loopback URLs from remote callers without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(remoteRequest("http://127.0.0.1:18731/internal-admin"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "URL not allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects private-network URLs from remote callers", async () => {
    for (const url of ["http://10.0.0.5/mcp", "http://192.168.1.1/mcp", "http://localhost:3000/mcp"]) {
      const res = await POST(remoteRequest(url));
      expect(res.status, `should reject ${url}`).toBe(400);
    }
  });

  it("rejects a public-looking hostname that DNS resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.20.30.40", family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(remoteRequest("https://mcp.attacker.example/rpc"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "URL not allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when DNS resolution is unavailable", async () => {
    lookupMock.mockRejectedValue(new Error("resolver unavailable"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(remoteRequest("https://unresolved.example/rpc"));

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still requires a url", async () => {
    const res = await POST(
      new Request("http://gateway.example.com/api/cli-tools/cowork-mcp-tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
  });

  it("cancels an unused auth-error body so its pinned Agent can close", async () => {
    const upstream = new Response("authenticate", { status: 401 });
    const cancel = vi.spyOn(upstream.body, "cancel");
    globalThis.fetch = vi.fn().mockResolvedValue(upstream);

    const res = await POST(remoteRequest("https://public-mcp.example/rpc"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requiresAuth: true, tools: [] });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
