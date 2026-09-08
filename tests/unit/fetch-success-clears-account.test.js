import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  handleFetchCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  beginAccountMutationAttempt: vi.fn(() => ({ id: 1 })),
  endAccountMutationAttempt: vi.fn(),
  recordAccountMutationSuccess: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  beginAccountMutationAttempt: mocks.beginAccountMutationAttempt,
  endAccountMutationAttempt: mocks.endAccountMutationAttempt,
  recordAccountMutationSuccess: mocks.recordAccountMutationSuccess,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getCombos: mocks.getCombos,
}));

vi.mock("open-sse/handlers/fetch/index.js", () => ({
  handleFetchCore: mocks.handleFetchCore,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrlResolved: vi.fn(async () => {}),
}));

import { handleFetch } from "@/sse/handlers/fetch.js";

describe("web fetch account state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getCombos.mockResolvedValue([]);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "jina-test-key",
      connectionId: "jina-connection",
      connectionName: "Jina Test",
      _connection: {
        testStatus: "unavailable",
        lastError: "old error",
        modelLock___all: "2026-01-01T00:00:00.000Z",
      },
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.handleFetchCore.mockResolvedValue({
      success: true,
      data: { provider: "jina-reader", content: { text: "ok" } },
    });
  });

  it("clears a stale provider lock after a successful fetch", async () => {
    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "jina-reader",
        url: "https://example.com/article",
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "jina-connection",
      expect.objectContaining({ connectionName: "Jina Test" }),
      "webfetch:jina-reader",
      { mutationAttempt: { id: 1 } },
    );
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "jina-reader",
      expect.any(Set),
      "webfetch:jina-reader",
    );
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("preserves a successful fetch when account cleanup rejects", async () => {
    mocks.clearAccountError.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "jina-reader",
        url: "https://example.com/article",
      }),
    }));
    await Promise.resolve();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ content: { text: "ok" } });
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledWith({ id: 1 });
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("scopes provider failures to web fetch", async () => {
    mocks.handleFetchCore.mockResolvedValue({
      success: false,
      status: 429,
      error: "quota exceeded",
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });

    const response = await handleFetch(new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "jina-reader",
        url: "https://example.com/article",
      }),
    }));

    expect(response.status).toBe(429);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "jina-connection",
      429,
      "quota exceeded",
      "jina-reader",
      "webfetch:jina-reader",
      null,
      { mutationAttempt: { id: 1 } },
    );
  });

  it("passes the client signal through and does not mutate account state on 499", async () => {
    mocks.handleFetchCore.mockResolvedValueOnce({
      success: false,
      status: 499,
      error: "Client closed request",
    });
    const controller = new AbortController();
    const request = new Request("http://localhost/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "jina-reader",
        url: "https://example.com/article",
      }),
      signal: controller.signal,
    });

    const response = await handleFetch(request);

    expect(response.status).toBe(499);
    expect(mocks.handleFetchCore).toHaveBeenCalledWith(expect.objectContaining({ signal: request.signal }));
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });
});
