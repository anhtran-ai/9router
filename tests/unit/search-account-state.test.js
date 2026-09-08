import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  beginAccountMutationAttempt: vi.fn(() => ({ id: 7 })),
  endAccountMutationAttempt: vi.fn(),
  recordAccountMutationSuccess: vi.fn(),
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  handleSearchCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  beginAccountMutationAttempt: mocks.beginAccountMutationAttempt,
  endAccountMutationAttempt: mocks.endAccountMutationAttempt,
  recordAccountMutationSuccess: mocks.recordAccountMutationSuccess,
  extractApiKey: () => null,
  isValidApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getCombos: mocks.getCombos,
}));

vi.mock("open-sse/handlers/search/index.js", () => ({
  handleSearchCore: mocks.handleSearchCore,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(),
}));

import { handleSearch } from "@/sse/handlers/search.js";

function request() {
  return new Request("http://localhost/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "tavily", query: "stable routing" }),
  });
}

describe("web search account state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getCombos.mockResolvedValue([]);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "provider-key",
      connectionId: "tavily-connection",
      connectionName: "Tavily",
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  });

  it("clears the same capability key used for selection and failures", async () => {
    mocks.handleSearchCore.mockResolvedValue({ success: true, response: Response.json({ results: [] }) });

    const response = await handleSearch(request());

    expect(response.status).toBe(200);
    expect(mocks.beginAccountMutationAttempt).toHaveBeenCalledWith("tavily-connection", "websearch:tavily");
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledWith({ id: 7 });
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "tavily-connection",
      expect.objectContaining({ connectionName: "Tavily" }),
      "websearch:tavily",
      { mutationAttempt: { id: 7 } },
    );
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledWith({ id: 7 });
  });

  it("preserves a successful search when account cleanup rejects", async () => {
    mocks.handleSearchCore.mockResolvedValue({
      success: true,
      response: Response.json({ results: [{ title: "ok" }] }),
    });
    mocks.clearAccountError.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await handleSearch(request());
    await Promise.resolve();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ results: [{ title: "ok" }] });
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledWith({ id: 7 });
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("guards a capability-scoped failure with the same attempt", async () => {
    mocks.handleSearchCore.mockResolvedValue({
      success: false,
      status: 429,
      error: "quota exceeded",
      response: Response.json({ error: "quota exceeded" }, { status: 429 }),
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });

    const response = await handleSearch(request());

    expect(response.status).toBe(429);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "tavily-connection",
      429,
      "quota exceeded",
      "tavily",
      "websearch:tavily",
      null,
      { mutationAttempt: { id: 7 } },
    );
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledWith({ id: 7 });
  });

  it("does not penalize an account when the client request is aborted", async () => {
    const controller = new AbortController();
    const req = new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "tavily", query: "cancelled search" }),
      signal: controller.signal,
    });
    mocks.handleSearchCore.mockImplementation(async () => {
      controller.abort();
      return {
        success: false,
        status: 499,
        error: "Client closed request",
        response: Response.json({ error: "Client closed request" }, { status: 499 }),
      };
    });

    const response = await handleSearch(req);

    expect(response.status).toBe(499);
    expect(mocks.handleSearchCore).toHaveBeenCalledWith(expect.objectContaining({
      signal: req.signal,
    }));
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledWith({ id: 7 });
  });
});
