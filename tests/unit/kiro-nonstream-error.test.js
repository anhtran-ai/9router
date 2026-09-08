import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const {
  convertChatStreamToOpenAIResponse,
  handleForcedSSEToJson,
  parseSSEToOpenAIResponse
} = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

describe("Kiro non-streaming error propagation", () => {
  it("prefers a terminal SSE error over earlier semantic chunks", () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
      'data: {"error":{"message":"Kiro transport failed","code":"kiro_missing_terminal"}}',
      "data: [DONE]"
    ].join("\n\n");

    expect(parseSSEToOpenAIResponse(raw, "kiro")).toEqual({
      error: {
        message: "Kiro transport failed",
        code: "kiro_missing_terminal"
      }
    });
  });

  it("returns 502 instead of collapsing a failed Kiro SSE stream into stop", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    const raw = [
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
      'data: {"error":{"message":"Kiro stream ended incompletely","code":"kiro_missing_terminal"}}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
      },
      cancel,
    });
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      provider: "kiro",
      model: "kr/claude-opus-4.8",
      body: { model: "kr/claude-opus-4.8", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    });
    const json = await result.response.json();

    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    // The parser retains upstream diagnostics internally, but a provider's
    // HTTP200 error payload must not be reflected into the public response.
    expect(json.error).toMatchObject({
      message: "Invalid upstream response: upstream SSE reported an error",
      code: "invalid_upstream_response"
    });
    expect(json).not.toHaveProperty("choices");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it("finishes and cancels a non-closing Chat SSE stream at DONE", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"id":"chatcmpl-done","model":"fixture","choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n")));
      },
      cancel,
    });

    const result = await handleForcedSSEToJson({
      providerResponse: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      provider: "kiro",
      model: "fixture",
      body: { model: "fixture", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({
      id: "chatcmpl-done",
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it("rejects and cancels a non-closing named SSE error event", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: error\ndata: {"message":"named event failure","type":"server_error"}\n\n'
        ));
      },
      cancel,
    });

    const result = await handleForcedSSEToJson({
      providerResponse: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      provider: "commandcode",
      model: "fixture",
      body: { model: "fixture", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(await result.response.json()).toMatchObject({
      error: { code: "invalid_upstream_response" },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it("keeps a trailing usage chunk after finish_reason, then cancels at DONE", async () => {
    const cancel = vi.fn();
    let pull = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      pull(controller) {
        if (pull++ === 0) {
          controller.enqueue(encoder.encode(
            'data: {"id":"chatcmpl-usage","model":"fixture","choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'
          ));
        } else {
          controller.enqueue(encoder.encode(
            'data: {"id":"chatcmpl-usage","model":"fixture","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\ndata: [DONE]\n\n'
          ));
        }
      },
      cancel,
    });

    const result = await handleForcedSSEToJson({
      providerResponse: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      provider: "commandcode",
      model: "fixture",
      body: { model: "fixture", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });
    const json = await result.response.json();

    expect(result.success).toBe(true);
    expect(json.choices[0]).toMatchObject({ message: { content: "done" }, finish_reason: "stop" });
    expect(json.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it("keeps enforcing the event cap after a choice-level finish_reason", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
          "data: [DONE]",
          "",
        ].join("\n\n")));
      },
      cancel,
    });

    await expect(convertChatStreamToOpenAIResponse(stream, "fixture", { maxEvents: 1 }))
      .rejects.toThrow("exceeded 1 events");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("propagates caller abort while waiting for a trailer after finish_reason", async () => {
    const cancel = vi.fn();
    let resolveWaitingForTrailer;
    let pullCount = 0;
    const waitingForTrailer = new Promise(resolve => { resolveWaitingForTrailer = resolve; });
    const stream = new ReadableStream({
      pull(controller) {
        if (pullCount++ === 0) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'
          ));
          return;
        }
        resolveWaitingForTrailer();
        return new Promise(() => {});
      },
      cancel,
    });
    const abortController = new AbortController();
    const abortReason = new DOMException("client disconnected", "AbortError");
    const pending = convertChatStreamToOpenAIResponse(stream, "fixture", {
      signal: abortController.signal,
      stallTimeoutMs: 1_000,
    });

    await waitingForTrailer;
    abortController.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it.each([
    ["bytes", { maxBytes: 8 }, "exceeded 8 bytes"],
    ["events", { maxEvents: 1 }, "exceeded 1 events"],
  ])("cancels Chat SSE that exceeds the collection %s cap", async (_kind, options, message) => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{"content":"b"},"finish_reason":null}]}',
          "",
        ].join("\n\n")));
      },
      cancel,
    });

    await expect(convertChatStreamToOpenAIResponse(stream, "fixture", options))
      .rejects.toThrow(message);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("cancels a stalled Chat SSE collector", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull: () => new Promise(() => {}), cancel });

    await expect(convertChatStreamToOpenAIResponse(stream, "fixture", { stallTimeoutMs: 10 }))
      .rejects.toThrow(/stalled/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
