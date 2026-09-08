import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCapabilitiesForModel,
  setCatalogSource,
} from "../../open-sse/providers/capabilities.js";
import {
  __test__ as catalogSyncTest,
  buildCatalogOverrides,
} from "../../src/lib/modelCatalog/sync.js";
import { __test__ as catalogOverrideTest } from "../../open-sse/providers/catalogOverride.js";

const originalFetch = globalThis.fetch;

function trackedResponse({ text = "{}", contentLength = null, status = 200 } = {}) {
  const cancel = vi.fn(async () => {});
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
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

afterEach(() => {
  setCatalogSource(null);
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("provider-scoped model catalog modalities", () => {
  it("stores modalities on the matching provider instead of relying on a colliding bare id", () => {
    const catalog = {
      openrouter: {
        models: {
          auto: { modalities: { input: ["text", "image", "pdf"] }, limit: {} },
        },
      },
      qoder: {
        models: {
          auto: { modalities: { input: ["text"] }, limit: {} },
        },
      },
    };
    const current = { contextWindow: 128_000, maxOutput: 8_192 };
    const result = buildCatalogOverrides(catalog, [
      { provider: "openrouter", model: "auto", current },
      { provider: "qoder", model: "auto", current },
    ]);

    expect(result.models.auto).toMatchObject({ vision: true, pdf: true });
    expect(result.providers.openrouter.auto).toMatchObject({ vision: true, pdf: true });
    expect(result.providers.qoder.auto).toEqual({});
    expect(result.fallbackModels.auto).toBeUndefined();
  });

  it("keeps a unanimous fallback for custom models absent from the static registry", () => {
    const catalog = {
      gatewayA: {
        models: {
          "custom-vision": { modalities: { input: ["text", "image"] }, limit: {} },
        },
      },
      gatewayB: {
        models: {
          "custom-vision": { modalities: { input: ["text", "image"] }, limit: {} },
        },
      },
    };

    const result = buildCatalogOverrides(catalog, []);

    expect(result.fallbackModels["custom-vision"]).toEqual({ vision: true });
    expect(catalogOverrideTest.providerModalities(
      result,
      "custom-provider",
      "vendor/custom-vision:free",
    )).toEqual({ vision: true });
  });

  it("does not apply a global fallback over an explicit text-only provider record", () => {
    const snapshot = {
      fallbackModels: { auto: { vision: true } },
      providers: { qoder: { auto: {} } },
    };

    expect(catalogOverrideTest.providerModalities(snapshot, "qoder", "auto")).toBeNull();
    expect(catalogOverrideTest.providerModalities(snapshot, "custom-provider", "auto"))
      .toEqual({ vision: true });
  });

  it("does not let another provider's auto model enable unsupported media", () => {
    setCatalogSource({
      // Legacy bare-id data may still contain an ambiguous aggregate.
      getModalities: model => model === "auto" ? { vision: true, pdf: true } : null,
      getProviderModalities: provider => provider === "openrouter" ? { vision: true, pdf: true } : null,
      getLimits: () => null,
    });

    expect(getCapabilitiesForModel("openrouter", "auto")).toMatchObject({ vision: true, pdf: true });
    expect(getCapabilitiesForModel("qoder", "auto")).toMatchObject({ vision: false, pdf: false });
    expect(getCapabilitiesForModel("trae", "auto")).toMatchObject({ vision: false, pdf: false });
  });

  it("keeps model-only catalog sources working for bare-id integrations", () => {
    setCatalogSource({
      getModalities: model => model === "catalog-only-model" ? { vision: true } : null,
      getLimits: () => null,
    });

    expect(getCapabilitiesForModel(null, "catalog-only-model").vision).toBe(true);
  });

  it("applies provider-scoped catalog data to exact static model entries", () => {
    setCatalogSource({
      getModalities: () => null,
      getProviderModalities: (provider, model) => (
        provider === "poolside" && model === "laguna-s-2.1-free"
          ? { vision: true }
          : null
      ),
      getLimits: (provider, model) => (
        provider === "poolside" && model === "laguna-s-2.1-free"
          ? { contextWindow: 256_000, maxOutput: 32_000 }
          : null
      ),
    });

    expect(getCapabilitiesForModel("poolside", "laguna-s-2.1-free")).toMatchObject({
      vision: true,
      contextWindow: 256_000,
      maxOutput: 32_000,
    });
  });
});

describe("models.dev catalog transport bounds", () => {
  it("rejects a catalog larger than the sync limit and releases its body", async () => {
    const upstream = trackedResponse({
      contentLength: catalogSyncTest.catalogBodyLimitBytes + 1,
    });
    globalThis.fetch = vi.fn(async () => upstream.response);

    await expect(catalogSyncTest.fetchCatalogSnapshot(
      { accept: "application/json" },
      new AbortController().signal,
    )).rejects.toMatchObject({
      name: "ModelCatalogBodyTooLargeError",
      code: "ERR_MODEL_CATALOG_BODY_TOO_LARGE",
    });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("cancels an error response without buffering its body", async () => {
    const upstream = trackedResponse({ text: "upstream failure", status: 503 });
    globalThis.fetch = vi.fn(async () => upstream.response);

    await expect(catalogSyncTest.fetchCatalogSnapshot(
      { accept: "application/json" },
      new AbortController().signal,
    )).rejects.toThrow("HTTP 503");
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("cancels a successful response that arrives after cancellation", async () => {
    let resolveFetch;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const caller = new AbortController();
    const pending = catalogSyncTest.fetchCatalogSnapshot(
      { accept: "application/json" },
      caller.signal,
    );
    caller.abort(new DOMException("sync stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const upstream = trackedResponse();
    resolveFetch(upstream.response);
    await Promise.resolve();
    await Promise.resolve();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });
});
