// Concurrency stress test — simulate many parallel saveRequestUsage / saveRequestDetail
// to verify atomic counter, no data loss, no race conditions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-concurrent-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("DB Concurrency — atomic safety", () => {
  it("100 parallel saveRequestUsage → no count loss", async () => {
    const N = 100;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.saveRequestUsage({
        provider: "openai", model: "gpt-4", connectionId: "c1",
        tokens: { prompt_tokens: 10, completion_tokens: 5 },
        endpoint: "/v1/chat", status: "ok",
      }));
    }
    await Promise.all(promises);

    const stats = await db.getUsageStats("24h");
    expect(stats.totalRequests).toBe(N);
    expect(stats.byProvider.openai.requests).toBe(N);
    expect(stats.byProvider.openai.promptTokens).toBe(N * 10);

    const hist = await db.getUsageHistory({ provider: "openai" });
    expect(hist.length).toBe(N);
  });

  it("retains independent same-millisecond requests in history, recent views and aggregates", async () => {
    const timestamp = new Date().toISOString();
    const provider = "same-millisecond-usage";
    const before = await db.getUsageStats("all");
    const entries = ["first-request", "second-request"].map((requestId) => ({
      requestId, timestamp, provider, model: "fixture-model", connectionId: "fixture-account",
      endpoint: "/v1/messages", tokens: { prompt_tokens: 10, completion_tokens: 5 }, status: "ok",
    }));

    await Promise.all(entries.map((entry) => db.saveRequestUsage(entry)));

    expect(await db.getUsageHistory({ provider })).toHaveLength(2);
    const stats = await db.getUsageStats("all");
    expect(stats.totalRequests).toBe(before.totalRequests + 2);
    expect(stats.byProvider[provider]).toMatchObject({ requests: 2, promptTokens: 20, completionTokens: 10 });
    expect(stats.recentRequests.filter((entry) => entry.provider === provider)).toHaveLength(2);
    const active = await db.getActiveRequests();
    expect(active.recentRequests.filter((entry) => entry.provider === provider)).toHaveLength(2);
  });

  it("does not treat matching request content as identity when no request ID is supplied", async () => {
    const provider = "same-content-usage";
    const entry = {
      timestamp: new Date().toISOString(), provider, model: "fixture-model",
      tokens: { prompt_tokens: 8, completion_tokens: 3 }, status: "ok",
    };

    await Promise.all([db.saveRequestUsage({ ...entry }), db.saveRequestUsage({ ...entry })]);

    expect(await db.getUsageHistory({ provider })).toHaveLength(2);
  });

  it("keeps timestamp and cost enrichment local to the usage record", async () => {
    const provider = "immutable-usage";
    const entry = Object.freeze({
      provider, model: "fixture-model", tokens: Object.freeze({ prompt_tokens: 7, completion_tokens: 2 }),
      endpoint: "/v1/messages", status: "ok",
    });

    await db.saveRequestUsage(entry);

    const history = await db.getUsageHistory({ provider });
    expect(history).toHaveLength(1);
    expect(history[0].timestamp).toEqual(expect.any(String));
    expect(history[0].cost).toBe(0);
    expect(entry).not.toHaveProperty("timestamp");
    expect(entry).not.toHaveProperty("cost");
  });

  it("200 parallel saveRequestDetail → all flushed", async () => {
    await db.updateSettings({ enableObservability: true, observabilityBatchSize: 10 });

    const N = 200;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.saveRequestDetail({
        id: `det-${i}`, provider: "openai", model: "gpt-4",
        connectionId: "c1", status: "ok",
        tokens: { prompt_tokens: 1 }, request: { i }, response: { ok: true },
      }));
    }
    await Promise.all(promises);

    // Wait for any timer-based flush
    await new Promise((r) => setTimeout(r, 6000));

    const list = await db.getRequestDetails({ provider: "openai", pageSize: 500 });
    expect(list.pagination.totalItems).toBeGreaterThanOrEqual(N);
  }, 15000);

  it("mixed concurrent: usage + details + connections + aliases", async () => {
    const ops = [];
    for (let i = 0; i < 50; i++) {
      ops.push(db.saveRequestUsage({
        provider: "anthropic", model: `m-${i % 3}`, connectionId: "c2",
        tokens: { prompt_tokens: 20 }, status: "ok",
      }));
      ops.push(db.setModelAlias(`a-${i}`, `target-${i}`));
      ops.push(db.disableModels("openai", [`d-${i}`]));
    }
    await Promise.all(ops);

    const aliases = await db.getModelAliases();
    expect(Object.keys(aliases).filter((k) => k.startsWith("a-")).length).toBe(50);

    const disabled = await db.getDisabledByProvider("openai");
    expect(disabled.length).toBeGreaterThanOrEqual(50);

    const stats = await db.getUsageStats("24h");
    expect(stats.byProvider.anthropic.requests).toBe(50);
  }, 30000);

  it("updateSettings parallel → no merge loss", async () => {
    const N = 50;
    await db.updateSettings({ counter: 0 });
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.updateSettings({ [`field${i}`]: `v${i}` }));
    }
    await Promise.all(promises);
    const s = await db.getSettings();
    for (let i = 0; i < N; i++) {
      expect(s[`field${i}`]).toBe(`v${i}`); // all updates preserved
    }
  });

  it("persists routing settings for a combo named __proto__ as ordinary data", async () => {
    const [result] = await db.importComboItems([{
      index: 0,
      name: "__proto__",
      kind: "chat",
      models: ["fixture/model"],
      strategy: { fallbackStrategy: "round-robin" },
      strategyProvided: true,
    }]);

    const settings = await db.getSettings();
    expect(result.action).toMatch(/created|updated/);
    expect(Object.prototype.hasOwnProperty.call(settings.comboStrategies, "__proto__")).toBe(true);
    expect(settings.comboStrategies.__proto__).toEqual({ fallbackStrategy: "round-robin" });
  });

  it("OAuth refresh race: parallel updateProviderConnection on same id", async () => {
    const conn = await db.createProviderConnection({
      provider: "oauth-test", authType: "oauth", email: "x@y.com",
      accessToken: "initial", refreshToken: "rt-initial",
    });

    // 20 parallel updates each with a unique field
    const N = 20;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.updateProviderConnection(conn.id, { [`marker${i}`]: i }));
    }
    await Promise.all(promises);

    const after = await db.getProviderConnectionById(conn.id);
    for (let i = 0; i < N; i++) {
      expect(after[`marker${i}`]).toBe(i); // no field lost
    }
    expect(after.refreshToken).toBe("rt-initial"); // base preserved
  });

  it("addCustomModel race: parallel duplicate adds → only 1 inserted", async () => {
    const N = 30;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.addCustomModel({ providerAlias: "racep", id: "racemodel", type: "llm", name: "r" }));
    }
    const results = await Promise.all(promises);
    const trueCount = results.filter((r) => r === true).length;
    expect(trueCount).toBe(1); // exactly one wins
    const all = await db.getCustomModels();
    expect(all.filter((m) => m.providerAlias === "racep" && m.id === "racemodel").length).toBe(1);
  });

  it("updatePricing race: parallel adds different models → all merged", async () => {
    const N = 30;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.updatePricing({ "race-prov": { [`m${i}`]: { input: i, output: i * 2 } } }));
    }
    await Promise.all(promises);
    const p = await db.getPricing();
    for (let i = 0; i < N; i++) {
      expect(p["race-prov"][`m${i}`]).toEqual({ input: i, output: i * 2 });
    }
  });

  it("daily summary aggregates correctly under parallel writes", async () => {
    const N = 50;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.saveRequestUsage({
        provider: "google", model: "gemini-pro", connectionId: "cG",
        tokens: { prompt_tokens: 100, completion_tokens: 50 },
        status: "ok",
      }));
    }
    await Promise.all(promises);

    const stats = await db.getUsageStats("7d");
    const g = stats.byProvider.google;
    expect(g).toBeDefined();
    expect(g.requests).toBe(N);
    expect(g.promptTokens).toBe(N * 100);
    expect(g.completionTokens).toBe(N * 50);
  });
});
