import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  agents: [],
  closeImpl: null,
}));

vi.mock("node:dns", () => ({
  default: { promises: { lookup: state.lookupMock } },
  promises: { lookup: state.lookupMock },
}));

vi.mock("undici", () => ({
  Agent: class FakeAgent {
    constructor() {
      this.close = vi.fn(() => state.closeImpl?.() || Promise.resolve());
      state.agents.push(this);
    }
  },
}));

const originalFetch = globalThis.fetch;
const { fetchPublic } = await import("../../src/shared/utils/ssrfGuard.js");

describe("fetchPublic dispatcher lifecycle", () => {
  beforeEach(() => {
    state.lookupMock.mockReset();
    state.lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    state.agents.length = 0;
    state.closeImpl = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("starts graceful Agent close but returns the final response before close waits on its body", async () => {
    let releaseClose;
    state.closeImpl = () => new Promise((resolve) => { releaseClose = resolve; });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("payload", { status: 200 }));

    const response = await fetchPublic("https://provider.example/result");

    expect(await response.text()).toBe("payload");
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].close).toHaveBeenCalledOnce();
    releaseClose();
  });

  it("cancels a redirect body and closes that hop before opening the next Agent", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: "https://next.example/result" }),
        body: { cancel },
      })
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await fetchPublic("https://provider.example/start");

    expect(await response.text()).toBe("ok");
    expect(cancel).toHaveBeenCalledOnce();
    expect(state.agents).toHaveLength(2);
    expect(state.agents[0].close).toHaveBeenCalledOnce();
    expect(state.agents[1].close).toHaveBeenCalledOnce();
  });
});
