import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  },
}));

const originalFetch = globalThis.fetch;
const { POST } = await import("../../src/app/api/provider-nodes/validate/route.js");

function remoteRequest(baseUrl) {
  return new Request("https://gateway.example/api/provider-nodes/validate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-9r-via-proxy": "1" },
    body: JSON.stringify({ baseUrl, apiKey: "stored-provider-key" }),
  });
}

describe("provider-node validation SSRF guard", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects a hostname resolving to a private address before sending the API key", async () => {
    lookupMock.mockResolvedValue([{ address: "192.168.10.20", family: 4 }]);
    globalThis.fetch = vi.fn();

    const response = await POST(remoteRequest("https://provider.attacker.example/v1"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "URL not allowed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not forward the API key across a cross-origin redirect", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 307,
        headers: { location: "https://redirect-target.example/models" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const response = await POST(remoteRequest("https://provider.example/v1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true });
    const redirectedHeaders = globalThis.fetch.mock.calls[1][1].headers;
    expect(redirectedHeaders.get("authorization")).toBeNull();
  });

  it("cancels an unused successful response body so its pinned Agent can close", async () => {
    const upstream = new Response("unused model catalog", { status: 200 });
    const cancel = vi.spyOn(upstream.body, "cancel");
    globalThis.fetch = vi.fn().mockResolvedValue(upstream);

    const response = await POST(remoteRequest("https://provider.example/v1"));

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
