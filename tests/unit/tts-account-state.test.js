import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  beginAccountMutationAttempt: vi.fn(() => ({ id: 1 })),
  endAccountMutationAttempt: vi.fn(),
  recordAccountMutationSuccess: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleTtsCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
  beginAccountMutationAttempt: mocks.beginAccountMutationAttempt,
  endAccountMutationAttempt: mocks.endAccountMutationAttempt,
  recordAccountMutationSuccess: mocks.recordAccountMutationSuccess,
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.handleTtsCore }));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: vi.fn() }));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    openai: {
      serviceKinds: ["tts"],
      ttsConfig: { authType: "apikey" },
    },
  },
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { handleTts, MAX_TTS_REQUEST_BODY_BYTES } from "@/sse/handlers/tts.js";

function ttsRequest(signal, body = { model: "openai/tts-1/alloy", input: "hello" }) {
  return new Request("http://localhost/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

describe("TTS account-state timing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "tts-1/alloy" });
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "test-key",
      connectionId: "openai-connection",
      connectionName: "OpenAI Test",
      _connection: {},
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.clearAccountError.mockResolvedValue(undefined);
  });

  it("propagates client abort as 499 without clearing or locking the account", async () => {
    const client = new AbortController();
    const request = ttsRequest(client.signal);
    let entered;
    const coreEntered = new Promise(resolve => { entered = resolve; });
    mocks.handleTtsCore.mockImplementation(({ signal }) => {
      entered();
      return new Promise(resolve => {
        signal.addEventListener("abort", () => resolve({
          success: false,
          status: 499,
          error: "Request aborted",
          response: new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
            status: 499,
            headers: { "content-type": "application/json" },
          }),
        }), { once: true });
      });
    });

    const pending = handleTts(request);
    await coreEntered;
    expect(mocks.handleTtsCore.mock.calls[0][0].signal).toBe(request.signal);
    client.abort(new DOMException("client left", "AbortError"));

    const response = await pending;
    expect(response.status).toBe(499);
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });

  it("clears account state only after core returns a validated success", async () => {
    let release;
    const validated = new Promise(resolve => { release = resolve; });
    mocks.handleTtsCore.mockImplementation(async () => {
      await validated;
      return { success: true, response: new Response(new Uint8Array([1])) };
    });

    const pending = handleTts(ttsRequest());
    await vi.waitFor(() => expect(mocks.handleTtsCore).toHaveBeenCalledOnce());
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();

    release();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "openai-connection",
      expect.objectContaining({ connectionName: "OpenAI Test" }),
      "tts-1/alloy",
      { mutationAttempt: { id: 1 } },
    );
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });

  it("preserves validated audio when account-health cleanup rejects", async () => {
    const audio = new Uint8Array([1, 2, 3]);
    mocks.handleTtsCore.mockResolvedValue({
      success: true,
      response: new Response(audio),
    });
    mocks.clearAccountError.mockRejectedValueOnce(new Error("fixture DB cleanup failed"));

    const response = await handleTts(ttsRequest());

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("does not wait for account-health cleanup that never settles", async () => {
    mocks.handleTtsCore.mockResolvedValue({
      success: true,
      response: new Response(new Uint8Array([1, 2, 3])),
    });
    mocks.clearAccountError.mockReturnValueOnce(new Promise(() => {}));

    const pending = handleTts(ttsRequest());
    await vi.waitFor(() => expect(mocks.clearAccountError).toHaveBeenCalledOnce());
    const stillPending = Symbol("still pending");
    const result = await Promise.race([pending, Promise.resolve(stillPending)]);

    expect(result).not.toBe(stillPending);
    expect(result.status).toBe(200);
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });

  it.each([
    [{ model: "openai/tts-1/alloy", input: 123 }],
    [{ model: "openai/tts-1/alloy", input: "   " }],
    [{ model: 42, input: "hello" }],
  ])("rejects invalid client input before selecting or mutating an account", async (body) => {
    const response = await handleTts(ttsRequest(undefined, body));
    expect(response.status).toBe(400);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("does not penalize an account for a provider request-validation response", async () => {
    mocks.handleTtsCore.mockResolvedValue({
      success: false,
      status: 422,
      error: "invalid voice options",
      response: new Response("invalid", { status: 422 }),
    });
    const response = await handleTts(ttsRequest());
    expect(response.status).toBe(422);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
  });

  it("caps a chunked JSON body before model or account lookup", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TTS_REQUEST_BODY_BYTES + 1));
      },
      cancel,
    });
    const request = new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    });

    const response = await handleTts(request);
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("returns 499 and releases a stalled inbound JSON body on disconnect", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const request = new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
      signal: controller.signal,
    });
    const pending = handleTts(request);
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(new DOMException("client left", "AbortError"));

    expect((await pending).status).toBe(499);
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(body.locked).toBe(false));
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("does not clear account state if cancellation lands as core reports success", async () => {
    const controller = new AbortController();
    mocks.handleTtsCore.mockImplementation(async () => {
      controller.abort(new DOMException("client left", "AbortError"));
      return { success: true, response: new Response(new Uint8Array([1])) };
    });

    const response = await handleTts(ttsRequest(controller.signal));
    expect(response.status).toBe(499);
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});
