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

function openStreamResponse(chunks, contentType) {
  const cancel = vi.fn();
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      // Deliberately leave the stream open, as Streamable HTTP servers do.
    },
    cancel,
  });
  return {
    cancel,
    response: new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    }),
  };
}

describe("cowork-mcp-tools SSRF guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
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

  it("bounds stalled DNS lookup within the remote MCP probe", async () => {
    vi.useFakeTimers();
    lookupMock.mockImplementation(() => new Promise(() => {}));
    globalThis.fetch = vi.fn();

    const responsePromise = POST(remoteRequest("https://dns-stall.example/rpc"));
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await responsePromise;

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "URL not allowed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports timeout and cancels a tools/list body that ignores the abort signal", async () => {
    vi.useFakeTimers();
    const bodyCancel = vi.fn();
    const stalledListResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      bodyUsed: false,
      body: { cancel: bodyCancel },
      json: () => new Promise(() => {}),
    };
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-06-18", capabilities: {} },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(stalledListResponse);

    const responsePromise = POST(remoteRequest("https://8.8.8.8/rpc"));
    for (let i = 0; i < 100 && globalThis.fetch.mock.calls.length < 3; i++) {
      await Promise.resolve();
    }
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8_000);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ error: "timeout", tools: [] });
    expect(bodyCancel).toHaveBeenCalledOnce();
  });

  it("does not send initialized until the initialize body completes and times it out if stalled", async () => {
    vi.useFakeTimers();
    const bodyCancel = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      bodyUsed: false,
      body: { cancel: bodyCancel },
      json: () => new Promise(() => {}),
    });

    const responsePromise = POST(remoteRequest("https://8.8.8.8/rpc"));
    for (let i = 0; i < 20 && globalThis.fetch.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8_000);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ error: "timeout", tools: [] });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(bodyCancel).toHaveBeenCalledOnce();
  });

  it("returns as soon as matching SSE frames arrive even when both response streams stay open", async () => {
    const initMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    const listMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "streamed-tool", description: "from SSE" }] },
    });
    const initStream = openStreamResponse([
      ": keepalive\r\n\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{}}\r\n\r\nda",
      `ta: ${initMessage}\r\n\r\n`,
    ], "text/event-stream; charset=utf-8");
    const listStream = openStreamResponse([
      "event: message\n",
      `data: ${listMessage.slice(0, 35)}`,
      `${listMessage.slice(35)}\n\n`,
    ], "text/event-stream");
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(initStream.response)
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(listStream.response);

    const response = await POST(remoteRequest("https://8.8.8.8/rpc"));

    expect(await response.json()).toEqual({
      tools: [{ name: "streamed-tool", description: "from SSE" }],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(initStream.cancel).toHaveBeenCalledOnce();
    expect(listStream.cancel).toHaveBeenCalledOnce();
    expect(initStream.response.body.locked).toBe(false);
    expect(listStream.response.body.locked).toBe(false);
  });

  it("returns a complete JSON response without waiting for an open body to close", async () => {
    const listStream = openStreamResponse([JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "open-json-tool" }] },
    })], "application/json");
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-06-18", capabilities: {} },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(listStream.response);

    const response = await POST(remoteRequest("https://8.8.8.8/rpc"));

    expect(await response.json()).toEqual({
      tools: [{ name: "open-json-tool", description: "" }],
    });
    expect(listStream.cancel).toHaveBeenCalledOnce();
    expect(listStream.response.body.locked).toBe(false);
  });

  it("still times out and releases an open SSE stream with no matching response", async () => {
    vi.useFakeTimers();
    const stalledStream = openStreamResponse([
      ": keepalive\n\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n",
    ], "text/event-stream");
    globalThis.fetch = vi.fn().mockResolvedValueOnce(stalledStream.response);

    const responsePromise = POST(remoteRequest("https://8.8.8.8/rpc"));
    for (let i = 0; i < 100 && globalThis.fetch.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(8_000);
    const response = await responsePromise;

    expect(await response.json()).toEqual({ error: "timeout", tools: [] });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(stalledStream.cancel).toHaveBeenCalledOnce();
    expect(stalledStream.response.body.locked).toBe(false);
  });

  it("caps unmatched open SSE responses before parsing unbounded data", async () => {
    const oversizedStream = openStreamResponse([
      `data: ${"x".repeat(4 * 1024 * 1024 + 1)}`,
    ], "text/event-stream");
    globalThis.fetch = vi.fn().mockResolvedValueOnce(oversizedStream.response);

    const response = await POST(remoteRequest("https://8.8.8.8/rpc"));

    expect(await response.json()).toEqual({
      error: "MCP response body is too large",
      tools: [],
    });
    expect(oversizedStream.cancel).toHaveBeenCalledOnce();
    expect(oversizedStream.response.body.locked).toBe(false);
  });

  it("releases initialize and tools/list reader locks after parsing", async () => {
    const initResponse = new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: {} },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const listResponse = new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "safe-tool" }] },
    }), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(initResponse)
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(listResponse);

    const response = await POST(remoteRequest("https://8.8.8.8/rpc"));

    expect(await response.json()).toEqual({
      tools: [{ name: "safe-tool", description: "" }],
    });
    expect(initResponse.body.locked).toBe(false);
    expect(listResponse.body.locked).toBe(false);
  });
});
