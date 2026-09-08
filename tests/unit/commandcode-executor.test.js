import { describe, it, expect, vi } from "vitest";
import {
  parseCommandCodeError,
  inspectAndWrapCommandCodeResponse,
  CommandCodeExecutor,
} from "../../open-sse/executors/commandcode.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

function createNdjsonStream(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(typeof line === "string" ? line : JSON.stringify(line) + "\n"));
      }
      controller.close();
    },
  });
}

describe("parseCommandCodeError", () => {
  it("parses user exact error payload with statusCode 503 and isRetryable", () => {
    const event = {
      type: "error",
      error: {
        type: "server_error",
        message: "Service temporarily unavailable. Please try again shortly.",
        statusCode: 503,
        isRetryable: true,
      },
    };
    const parsed = parseCommandCodeError(event);
    expect(parsed.statusCode).toBe(503);
    expect(parsed.message).toBe("Service temporarily unavailable. Please try again shortly.");
    expect(parsed.type).toBe("server_error");
  });

  it("handles string error message", () => {
    const event = {
      type: "error",
      message: "Rate limit exceeded. Please wait 30s.",
    };
    const parsed = parseCommandCodeError(event);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.message).toBe("Rate limit exceeded. Please wait 30s.");
  });

  it("handles plain error string in error property", () => {
    const event = {
      type: "error",
      error: "Unauthorized access",
    };
    const parsed = parseCommandCodeError(event);
    expect(parsed.statusCode).toBe(401);
    expect(parsed.message).toBe("Unauthorized access");
  });
});

describe("inspectAndWrapCommandCodeResponse", () => {
  it("converts initial upstream 200 with error event to 503 Response", async () => {
    const ndjsonBody = createNdjsonStream([
      JSON.stringify({
        type: "error",
        error: {
          type: "server_error",
          message: "Service temporarily unavailable. Please try again shortly.",
          statusCode: 503,
          isRetryable: true,
        },
      }) + "\n",
    ]);

    const fakeResponse = new Response(ndjsonBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await inspectAndWrapCommandCodeResponse(fakeResponse, "poolside/laguna-s-2.1-free");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);

    const body = await result.json();
    expect(body.error.message).toBe("CommandCode is temporarily unavailable");
    expect(body.error.code).toBe(503);
  });

  it("does not reflect an initial upstream error message or type", async () => {
    const marker = "SENSITIVE_COMMANDCODE_UPSTREAM_ERROR";
    const source = createNdjsonStream([
      JSON.stringify({
        type: "error",
        error: { message: marker, type: marker, statusCode: 503 },
      }) + "\n",
    ]);

    const result = await inspectAndWrapCommandCodeResponse(
      new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
      "poolside/laguna-s-2.1-free",
    );
    const body = await result.json();

    expect(JSON.stringify(body)).not.toContain(marker);
    expect(body.error).toEqual({
      message: "CommandCode is temporarily unavailable",
      type: "server_error",
      code: 503,
    });
  });

  it("returns a detected error without waiting for upstream cancellation", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `${JSON.stringify({ type: "error", error: { message: "overloaded", statusCode: 503 } })}\n`,
        ));
      },
      cancel,
    });

    const result = await inspectAndWrapCommandCodeResponse(
      new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
      "poolside/laguna-s-2.1-free",
    );

    expect(result.status).toBe(503);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled first event without waiting for reader cancellation", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const source = new ReadableStream({ start() {}, cancel });

    const result = await inspectAndWrapCommandCodeResponse(
      new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
      "poolside/laguna-s-2.1-free",
      { firstFrameTimeoutMs: 10 },
    );

    expect(result.status).toBe(504);
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "upstream_stream_timeout" },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized unterminated stream prelude", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1024 * 1024 + 1)));
      },
      cancel,
    });

    const result = await inspectAndWrapCommandCodeResponse(
      new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
      "poolside/laguna-s-2.1-free",
      { firstFrameTimeoutMs: 100 },
    );

    expect(result.status).toBe(502);
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "invalid_upstream_response" },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("converts initial upstream 200 with start/start-step followed by error to 503 Response", async () => {
    const ndjsonBody = createNdjsonStream([
      JSON.stringify({ type: "start" }) + "\n",
      JSON.stringify({ type: "start-step" }) + "\n",
      JSON.stringify({
        type: "error",
        error: {
          type: "server_error",
          message: "Service temporarily unavailable. Please try again shortly.",
          statusCode: 503,
          isRetryable: true,
        },
      }) + "\n",
    ]);

    const fakeResponse = new Response(ndjsonBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await inspectAndWrapCommandCodeResponse(fakeResponse, "poolside/laguna-s-2.1-free");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);

    const body = await result.json();
    expect(body.error.message).toBe("CommandCode is temporarily unavailable");
  });

  it("streams successful responses when content is emitted", async () => {
    const ndjsonBody = createNdjsonStream([
      JSON.stringify({ type: "start" }) + "\n",
      JSON.stringify({ type: "text-delta", text: "Hello from Laguna" }) + "\n",
      JSON.stringify({ type: "finish" }) + "\n",
    ]);

    const fakeResponse = new Response(ndjsonBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await inspectAndWrapCommandCodeResponse(fakeResponse, "poolside/laguna-s-2.1-free");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);

    const text = await result.text();
    expect(text).toContain("Hello from Laguna");
    expect(text).toContain("data: [DONE]");
  });

  it("finishes when content and finish share a chunk even if upstream stays open", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `${JSON.stringify({ type: "text-delta", text: "same chunk" })}\n` +
          `${JSON.stringify({ type: "finish" })}\n`,
        ));
      },
      cancel,
    });
    const result = await inspectAndWrapCommandCodeResponse(
      new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
      "poolside/laguna-s-2.1-free",
    );

    let timeout;
    const text = await Promise.race([
      result.text(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("CommandCode output did not terminate")), 500);
      }),
    ]).finally(() => clearTimeout(timeout));

    expect(text).toContain("same chunk");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reports EOF after content without a finish event", async () => {
    const fakeResponse = new Response(createNdjsonStream([
      JSON.stringify({ type: "text-delta", text: "partial" }) + "\n",
    ]), { headers: { "Content-Type": "text/event-stream" } });

    const result = await inspectAndWrapCommandCodeResponse(fakeResponse, "poolside/laguna-s-2.1-free");
    const text = await result.text();
    expect(text).toContain("partial");
    expect(text).toContain("commandcode_missing_terminal");
  });

  it("reports a malformed trailing event instead of ending successfully", async () => {
    const fakeResponse = new Response(createNdjsonStream([
      JSON.stringify({ type: "text-delta", text: "partial" }) + "\n",
      '{"type":"finish"',
    ]), { headers: { "Content-Type": "text/event-stream" } });

    const result = await inspectAndWrapCommandCodeResponse(fakeResponse, "poolside/laguna-s-2.1-free");
    const text = await result.text();
    expect(text).toContain("commandcode_malformed_stream");
    expect(text).not.toContain("finish_reason\":\"stop");
  });

  it("terminates when an oversized line arrives after the first content event", async () => {
    const first = JSON.stringify({ type: "text-delta", text: "bounded" });
    const oversized = "x".repeat(1024 * 1024 + 1);
    const fakeResponse = new Response(createNdjsonStream([
      `${first}\n${oversized}\n`,
    ]), { headers: { "Content-Type": "text/event-stream" } });

    const result = await inspectAndWrapCommandCodeResponse(
      fakeResponse,
      "poolside/laguna-s-2.1-free",
      { firstFrameTimeoutMs: 100 },
    );
    const text = await result.text();

    expect(text).toContain("bounded");
    expect(text).toContain("commandcode_frame_too_large");
    expect(text).not.toContain("finish_reason\":\"stop");
  });
});

describe("CommandCode in Combo Fallback", () => {
  it("automatically falls back to next model when commandcode returns 503 error", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const handleSingleModel = vi.fn(async (body, modelStr) => {
      if (modelStr === "commandcode/poolside/laguna-s-2.1-free") {
        // Simulated failed CommandCode response
        return new Response(
          JSON.stringify({
            error: {
              message: "Service temporarily unavailable. Please try again shortly.",
              type: "server_error",
              code: 503,
            },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }

      if (modelStr === "openai/gpt-4o-mini") {
        // Fallback model succeeds
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ message: { role: "assistant", content: "Fallback success!" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    });

    const comboResponse = await handleComboChat({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["commandcode/poolside/laguna-s-2.1-free", "openai/gpt-4o-mini"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });

    expect(comboResponse.ok).toBe(true);
    expect(comboResponse.status).toBe(200);

    const data = await comboResponse.json();
    expect(data.choices[0].message.content).toBe("Fallback success!");
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel).toHaveBeenNthCalledWith(1, expect.anything(), "commandcode/poolside/laguna-s-2.1-free");
    expect(handleSingleModel).toHaveBeenNthCalledWith(2, expect.anything(), "openai/gpt-4o-mini");
  });
});
