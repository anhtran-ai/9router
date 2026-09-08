import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  beginAccountMutationAttempt: vi.fn(() => ({ id: 17 })),
  endAccountMutationAttempt: vi.fn(),
  recordAccountMutationSuccess: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  handleSttCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  beginAccountMutationAttempt: mocks.beginAccountMutationAttempt,
  endAccountMutationAttempt: mocks.endAccountMutationAttempt,
  recordAccountMutationSuccess: mocks.recordAccountMutationSuccess,
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo }));
vi.mock("open-sse/handlers/sttCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleSttCore: mocks.handleSttCore,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    deepgram: {
      serviceKinds: ["stt"],
      sttConfig: {
        format: "deepgram",
        baseUrl: "https://api.deepgram.com/v1/listen",
        authType: "apikey",
        authHeader: "token",
      },
    },
    localfree: {
      serviceKinds: ["stt"],
      noAuth: true,
      sttConfig: {
        format: "openai",
        baseUrl: "http://localhost:9000/v1/audio/transcriptions",
        authType: "none",
      },
    },
    huggingface: {
      serviceKinds: ["stt"],
      sttConfig: {
        format: "huggingface-asr",
        baseUrl: "https://api-inference.huggingface.co/models",
        authType: "apikey",
      },
    },
  },
}));

import {
  handleStt,
  MAX_STT_REQUEST_BODY_BYTES,
} from "@/sse/handlers/stt.js";

function multipartRequest({
  controller = new AbortController(),
  model = "deepgram/nova-3",
  audio = "audio bytes",
} = {}) {
  const formData = new FormData();
  formData.append("model", model);
  formData.append("file", new Blob([audio], { type: "audio/wav" }), "sample.wav");
  return new Request("http://localhost/v1/audio/transcriptions", {
    method: "POST",
    body: formData,
    signal: controller.signal,
  });
}

describe("outer STT request integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getModelInfo.mockResolvedValue({ provider: "deepgram", model: "nova-3" });
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "deepgram-account",
      connectionName: "Deepgram",
      apiKey: "provider-token",
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  });

  it("bounds and reparses multipart input before passing the client signal to STT core", async () => {
    mocks.handleSttCore.mockResolvedValue({
      success: true,
      response: Response.json({ text: "valid transcript" }),
    });
    const request = multipartRequest();

    const response = await handleStt(request);

    expect(response.status).toBe(200);
    expect(mocks.handleSttCore).toHaveBeenCalledWith(expect.objectContaining({
      provider: "deepgram",
      model: "nova-3",
      signal: request.signal,
      formData: expect.any(FormData),
    }));
    const passedForm = mocks.handleSttCore.mock.calls[0][0].formData;
    expect(passedForm.get("model")).toBe("deepgram/nova-3");
    expect(passedForm.get("file").size).toBeGreaterThan(0);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "deepgram",
      expect.any(Set),
      "nova-3",
      { signal: request.signal },
    );
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledWith({ id: 17 });
    expect(mocks.clearAccountError).toHaveBeenCalledOnce();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledWith({ id: 17 });
  });

  it("preserves a completed transcript when account-health cleanup rejects", async () => {
    mocks.handleSttCore.mockResolvedValue({
      success: true,
      response: Response.json({ text: "valid transcript" }),
    });
    mocks.clearAccountError.mockRejectedValueOnce(new Error("fixture DB cleanup failed"));

    const response = await handleStt(multipartRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "valid transcript" });
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("does not wait for account-health cleanup that never settles", async () => {
    mocks.handleSttCore.mockResolvedValue({
      success: true,
      response: Response.json({ text: "valid transcript" }),
    });
    mocks.clearAccountError.mockReturnValueOnce(new Promise(() => {}));

    const pending = handleStt(multipartRequest());
    await vi.waitFor(() => expect(mocks.clearAccountError).toHaveBeenCalledOnce());
    const stillPending = Symbol("still pending");
    const result = await Promise.race([pending, Promise.resolve(stillPending)]);

    expect(result).not.toBe(stillPending);
    expect(result.status).toBe(200);
    expect(mocks.recordAccountMutationSuccess).toHaveBeenCalledOnce();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledOnce();
  });

  it("rejects an oversized declared request without parsing or calling STT core", async () => {
    const request = multipartRequest();
    request.headers.set("content-length", String(MAX_STT_REQUEST_BODY_BYTES + 1));

    const response = await handleStt(request);

    expect(response.status).toBe(413);
    expect(mocks.getModelInfo).not.toHaveBeenCalled();
    expect(mocks.handleSttCore).not.toHaveBeenCalled();
  });

  it("rejects malformed multipart bytes", async () => {
    const request = new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
      body: "not a valid multipart body",
    });

    const response = await handleStt(request);

    expect(response.status).toBe(400);
    expect(mocks.handleSttCore).not.toHaveBeenCalled();
  });

  it("rejects a non-file multipart field before selecting an account", async () => {
    const formData = new FormData();
    formData.append("model", "deepgram/nova-3");
    formData.append("file", "not-an-upload");
    const response = await handleStt(new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      body: formData,
    }));

    expect(response.status).toBe(400);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
  });

  it("rejects audio over 25 MiB before selecting an account", async () => {
    const response = await handleStt(multipartRequest({
      audio: new Uint8Array((25 * 1024 * 1024) + 1),
    }));

    expect(response.status).toBe(413);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("rejects an unsafe HuggingFace model path before selecting an account", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "huggingface", model: "../private" });
    const response = await handleStt(multipartRequest({ model: "huggingface/../private" }));

    expect(response.status).toBe(400);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
  });

  it("cancels a stalled inbound stream and returns 499 on disconnect", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("--partial-boundary\r\n"));
      },
      cancel,
    });
    const request = new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=partial-boundary" },
      body,
      duplex: "half",
      signal: controller.signal,
    });

    const pending = handleStt(request);
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.body.locked).toBe(false);
    expect(mocks.handleSttCore).not.toHaveBeenCalled();
  });

  it("does not mutate account state when STT core returns 499", async () => {
    mocks.handleSttCore.mockResolvedValue({
      success: false,
      status: 499,
      error: "Request aborted",
      response: Response.json({ error: "Request aborted" }, { status: 499 }),
    });

    const response = await handleStt(multipartRequest());

    expect(response.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledWith({ id: 17 });
  });

  it("returns 499 without mutation if the client aborts as core finishes", async () => {
    const controller = new AbortController();
    mocks.handleSttCore.mockImplementation(async () => {
      controller.abort();
      return {
        success: true,
        response: Response.json({ text: "too late" }),
      };
    });

    const response = await handleStt(multipartRequest({ controller }));

    expect(response.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.recordAccountMutationSuccess).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledWith({ id: 17 });
  });

  it("preserves normal account failure handling for a real provider error", async () => {
    mocks.handleSttCore.mockResolvedValue({
      success: false,
      status: 429,
      error: "quota",
      response: Response.json({ error: "quota" }, { status: 429 }),
    });

    const response = await handleStt(multipartRequest());

    expect(response.status).toBe(429);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "deepgram-account",
      429,
      "quota",
      "deepgram",
      "nova-3",
      null,
      { mutationAttempt: { id: 17 } },
    );
    expect(mocks.endAccountMutationAttempt).toHaveBeenCalledWith({ id: 17 });
  });

  it("does not penalize an account for a completed job-level/client failure", async () => {
    mocks.handleSttCore.mockResolvedValue({
      success: false,
      status: 422,
      error: "audio could not be transcribed",
      response: Response.json({ error: "audio could not be transcribed" }, { status: 422 }),
    });

    const response = await handleStt(multipartRequest());

    expect(response.status).toBe(422);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
  });

  it("passes cancellation through a no-auth STT provider", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "localfree", model: "whisper" });
    mocks.handleSttCore.mockResolvedValue({
      success: true,
      response: Response.json({ text: "local transcript" }),
    });
    const request = multipartRequest({ model: "localfree/whisper" });

    const response = await handleStt(request);

    expect(response.status).toBe(200);
    expect(mocks.handleSttCore).toHaveBeenCalledWith(expect.objectContaining({
      provider: "localfree",
      signal: request.signal,
    }));
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.beginAccountMutationAttempt).not.toHaveBeenCalled();
  });
});
