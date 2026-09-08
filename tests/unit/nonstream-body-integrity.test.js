import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import {
  convertChatStreamToOpenAIResponse,
  handleForcedSSEToJson,
} from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function args(providerResponse, extra = {}) {
  return {
    providerResponse,
    provider: "openrouter",
    model: "fixture-model",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body: { model: "fixture-model", messages: [{ role: "user", content: "hello" }], stream: false },
    stream: false,
    translatedBody: {},
    finalBody: {},
    requestStartTime: Date.now(),
    connectionId: "fixture-connection",
    apiKey: null,
    clientRawRequest: { endpoint: "/v1/chat/completions", headers: {} },
    reqLogger: {
      logProviderResponse: vi.fn(),
      logConvertedResponse: vi.fn(),
    },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    ...extra,
  };
}

afterEach(() => vi.useRealTimers());

describe("non-streaming upstream body integrity", () => {
  it.each([
    ["", /empty upstream JSON response/i],
    ["{not-json", /invalid upstream JSON response/i],
  ])("rejects invalid HTTP 200 JSON before success: %j", async (body, expected) => {
    const onRequestSuccess = vi.fn();
    const result = await handleNonStreamingResponse(args(new Response(body, {
      headers: { "content-type": "application/json" },
    }), { onRequestSuccess }));

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).toMatch(expected);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized JSON response and cancels it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start() {}, cancel });
    const result = await handleNonStreamingResponse(args(new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 * 1024 + 1),
      },
    })));

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("propagates client abort and releases a stalled JSON reader", async () => {
    const client = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    const pending = handleNonStreamingResponse(args(new Response(body, {
      headers: { "content-type": "application/json" },
    }), { signal: client.signal }));

    await Promise.resolve();
    client.abort(new DOMException("client closed", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("runs success only after a valid bounded response is normalized", async () => {
    const onRequestSuccess = vi.fn();
    const result = await handleNonStreamingResponse(args(Response.json({
      id: "chatcmpl-fixture",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { onRequestSuccess }));

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledOnce();
  });

  it.each([
    ["throws synchronously", () => { throw new Error("fixture sync cleanup failure"); }],
    ["rejects asynchronously", () => Promise.reject(new Error("fixture async cleanup failure"))],
  ])("preserves valid non-streaming JSON when success cleanup %s", async (_label, onRequestSuccess) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await handleNonStreamingResponse(args(Response.json({
        id: "chatcmpl-fixture",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { onRequestSuccess }));
      await Promise.resolve();

      expect(result.success).toBe(true);
      await expect(result.response.json()).resolves.toMatchObject({
        choices: [{ message: { content: "ok" } }],
      });
      expect(consoleError).toHaveBeenCalledWith(
        "[ChatCore] onRequestSuccess failed:",
        expect.stringContaining("cleanup failure"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects invalid UTF-8 in successful JSON and Chat/Responses SSE", async () => {
    const invalidJson = new Uint8Array([
      ...new TextEncoder().encode('{"choices":[{"message":{"role":"assistant","content":"'),
      0xff,
      ...new TextEncoder().encode('"},"finish_reason":"stop"}]}'),
    ]);
    const onRequestSuccess = vi.fn();
    const result = await handleNonStreamingResponse(args(new Response(invalidJson, {
      headers: { "content-type": "application/json" },
    }), { onRequestSuccess }));
    expect(result).toMatchObject({ success: false, status: 502 });
    expect(onRequestSuccess).not.toHaveBeenCalled();

    const invalidSse = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([
          ...new TextEncoder().encode('data: {"choices":[{"delta":{"content":"'),
          0xff,
          ...new TextEncoder().encode('"},"finish_reason":"stop"}]}\n\n'),
        ]));
        controller.close();
      },
    });
    await expect(convertChatStreamToOpenAIResponse(invalidSse, "fixture")).rejects.toBeTruthy();

    const invalidResponsesSse = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([
          ...new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"resp_'),
          0xff,
          ...new TextEncoder().encode('","status":"completed","output":[]}}\n\n'),
        ]));
        controller.close();
      },
    });
    await expect(convertResponsesStreamToJson(invalidResponsesSse)).rejects.toBeTruthy();
  });

  it("does not turn a valid forced-stream result into 502 when success cleanup rejects", async () => {
    const response = new Response([
      `data: ${JSON.stringify({
        id: "chatcmpl-fixture",
        model: "fixture-model",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    const onRequestSuccess = vi.fn(() => Promise.reject(new Error("cleanup failed")));

    const result = await handleForcedSSEToJson({
      providerResponse: response,
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      provider: "openai",
      model: "fixture-model",
      body: { stream: false },
      stream: false,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "fixture-connection",
      apiKey: null,
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      log: { line: vi.fn(), warn: vi.fn() },
    });

    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({ choices: [{ message: { content: "ok" } }] });
    expect(onRequestSuccess).toHaveBeenCalledOnce();
  });

  it("does not wait for a hanging cancel hook after a valid SSE global terminal", async () => {
    let cancelled = false;
    const event = `data: ${JSON.stringify({
      id: "chatcmpl-fixture",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(event)); },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });

    await expect(convertChatStreamToOpenAIResponse(body, "fixture-model")).resolves.toMatchObject({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});
