import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ adapter: null }));

vi.mock("../../open-sse/handlers/imageProviders/index.js", () => ({
  getImageAdapter: () => state.adapter,
}));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => null }));

const { handleImageGenerationCore } = await import(
  "../../open-sse/handlers/imageGenerationCore.js"
);

describe("image response integrity", () => {
  beforeEach(() => {
    state.adapter = null;
  });

  it("rejects an empty executor result before recording account success", async () => {
    const onRequestSuccess = vi.fn();
    state.adapter = {
      useExecutor: true,
      executeViaExecutor: vi.fn().mockResolvedValue({ candidates: [] }),
      normalize: () => ({ created: 1, data: [] }),
    };

    const result = await handleImageGenerationCore({
      body: { prompt: "empty executor result" },
      modelInfo: { provider: "antigravity", model: "gemini-3.1-flash-image" },
      credentials: { accessToken: "fixture-token" },
      onRequestSuccess,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("returned no generated image");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });
});
