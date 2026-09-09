import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCombos: vi.fn(),
  getSettings: vi.fn(),
  importComboItems: vi.fn(),
  resetComboRotation: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));

vi.mock("@/lib/localDb", () => ({
  getCombos: mocks.getCombos,
  getSettings: mocks.getSettings,
  importComboItems: mocks.importComboItems,
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: mocks.resetComboRotation,
}));

const route = await import("../../src/app/api/import-export/combos/route.js");

function importRequest(body, headers = {}) {
  return new Request("https://router.example/api/import-export/combos", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Combo Import/Export", () => {
  beforeEach(() => {
    mocks.getCombos.mockReset().mockResolvedValue([]);
    mocks.getSettings.mockReset().mockResolvedValue({});
    mocks.importComboItems.mockReset().mockResolvedValue([]);
    mocks.resetComboRotation.mockReset();
  });

  it("exports only combo definitions and routing strategies", async () => {
    mocks.getCombos.mockResolvedValue([
      { name: "balanced", kind: "chat", models: ["cx/gpt", "cc/claude"] },
    ]);
    mocks.getSettings.mockResolvedValue({
      comboStrategies: { balanced: { fallbackStrategy: "fusion", judgeModel: "cx/judge" } },
      apiKey: "must-not-export",
    });

    const response = await route.GET();
    const payload = await response.json();

    expect(payload).toMatchObject({
      format: "9router-combos",
      version: 1,
      combos: [{
        name: "balanced",
        kind: "chat",
        models: ["cx/gpt", "cc/claude"],
        settings: { fallbackStrategy: "fusion", judgeModel: "cx/judge" },
      }],
    });
    expect(JSON.stringify(payload)).not.toContain("must-not-export");
  });

  it("normalizes a valid import and resets rotation after creation", async () => {
    mocks.importComboItems.mockResolvedValue([
      { index: 0, name: "balanced", action: "created", detail: "Combo created" },
    ]);

    const request = importRequest({
      format: "9router-combos",
      version: 1,
      conflictPolicy: "update",
      combos: [{
        name: "balanced",
        kind: "chat",
        models: [" cx/gpt ", "cc/claude"],
        settings: { fallbackStrategy: "round-robin" },
      }],
    });
    const response = await route.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.importComboItems).toHaveBeenCalledWith([{
      index: 0,
      name: "balanced",
      kind: "chat",
      models: ["cx/gpt", "cc/claude"],
      strategy: { fallbackStrategy: "round-robin" },
      strategyProvided: true,
    }], { conflictPolicy: "update" });
    expect(mocks.resetComboRotation).toHaveBeenCalledWith("balanced");
    expect(payload.summary.created).toBe(1);
    expect(request.body.locked).toBe(false);
  });

  it("reports invalid strategies without mutating storage", async () => {
    const response = await route.POST(importRequest({
      combos: [{ name: "unsafe", models: ["cx/gpt"], settings: { fallbackStrategy: "random" } }],
    }));
    const payload = await response.json();

    expect(payload.summary.failed).toBe(1);
    expect(mocks.importComboItems).not.toHaveBeenCalled();
    expect(mocks.resetComboRotation).not.toHaveBeenCalled();
  });

  it("rejects payloads declared larger than 2 MB", async () => {
    const response = await route.POST(importRequest(
      { combos: [{ name: "small", models: ["cx/gpt"] }] },
      { "content-length": String(2 * 1024 * 1024 + 1) },
    ));
    expect(response.status).toBe(413);
    expect(mocks.importComboItems).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed payload when Content-Length is absent", async () => {
    const request = importRequest({
      combos: [{ name: "small", models: ["cx/gpt"] }],
      padding: "x".repeat(2 * 1024 * 1024),
    });
    request.headers.delete("content-length");

    const response = await route.POST(request);

    expect(response.status).toBe(413);
    expect(mocks.importComboItems).not.toHaveBeenCalled();
    expect(request.body.locked).toBe(false);
  });

  it("rejects invalid UTF-8 instead of importing replacement-decoded data", async () => {
    const request = new Request("https://router.example/api/import-export/combos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([
        0x7b, 0x22, 0x63, 0x6f, 0x6d, 0x62, 0x6f, 0x73, 0x22, 0x3a, 0x5b,
        0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22,
        0x2c, 0x22, 0x6d, 0x6f, 0x64, 0x65, 0x6c, 0x73, 0x22, 0x3a, 0x5b,
        0x22, 0x78, 0x22, 0x5d, 0x7d, 0x5d, 0x7d,
      ]),
    });

    const response = await route.POST(request);
    expect(response.status).toBe(400);
    expect(mocks.importComboItems).not.toHaveBeenCalled();
  });
});
