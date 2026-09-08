import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleEmbeddingsCore: vi.fn(),
  saveRequestUsage: vi.fn(),
  beginAccountMutationAttempt: vi.fn(() => ({ id: 1 })),
  endAccountMutationAttempt: vi.fn(),
  recordAccountMutationSuccess: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({
    apiKey: "provider-secret",
    connectionId: "connection-a",
    connectionName: "Provider A",
  }),
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  beginAccountMutationAttempt: mocks.beginAccountMutationAttempt,
  endAccountMutationAttempt: mocks.endAccountMutationAttempt,
  recordAccountMutationSuccess: mocks.recordAccountMutationSuccess,
  extractApiKey: () => "client-key",
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "openai", model: "text-embedding-3-small" }),
}));
vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: mocks.handleEmbeddingsCore,
}));
vi.mock("../../open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => Response.json({ error: message }, { status }),
  unavailableResponse: (status, message) => Response.json({ error: message }, { status }),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";

describe("embedding usage persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.handleEmbeddingsCore.mockResolvedValue({
      success: true,
      usage: { prompt_tokens: 12, total_tokens: 12 },
      response: Response.json({ data: [] }),
    });
  });

  it("records exact provider usage for successful embedding requests", async () => {
    await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "text-embedding-3-small",
      connectionId: "connection-a",
      apiKey: "client-key",
      endpoint: "/v1/embeddings",
      status: "success",
      tokens: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
    }));
  });

  it.each([
    null,
    {},
    { prompt_tokens: 0, total_tokens: 0 },
    { prompt_tokens: "12", total_tokens: 12 },
    { prompt_tokens: 12, total_tokens: 13 },
    { prompt_tokens: 12, completion_tokens: 1, total_tokens: 12 },
    { prompt_tokens: 12, total_tokens: 12, estimated: true },
  ])("does not record inexact usage %#", async (usage) => {
    mocks.handleEmbeddingsCore.mockResolvedValue({
      success: true,
      usage,
      response: Response.json({ data: [] }),
    });

    await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("passes the client signal to core and does not mutate account state on 499", async () => {
    mocks.handleEmbeddingsCore.mockResolvedValueOnce({
      success: false,
      status: 499,
      error: "Request aborted",
      response: Response.json({ error: "Request aborted" }, { status: 499 }),
    });
    const controller = new AbortController();
    const request = new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
      signal: controller.signal,
    });

    const response = await handleEmbeddings(request);

    expect(response.status).toBe(499);
    expect(mocks.handleEmbeddingsCore).toHaveBeenCalledWith(
      expect.objectContaining({ signal: request.signal }),
    );
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });
});
