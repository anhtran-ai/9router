import { afterEach, describe, expect, it, vi } from "vitest";
import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

function splitByteStream(text, splitPoints) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    start(controller) {
      for (const end of [...splitPoints, bytes.length]) {
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      }
      controller.close();
    },
  });
}

describe("OpenAI to Ollama output transform", () => {
  afterEach(() => vi.useRealTimers());

  it("preserves split UTF-8/SSE input and emits exactly one terminal object", async () => {
    const text = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "nghĩ 🌏" }, finish_reason: null }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "xong" }, finish_reason: null }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\r\n\r\n`,
      "data: [DONE]\r\n\r\n",
    ].join("");
    const encoded = new TextEncoder().encode(text);
    const globe = new TextEncoder().encode("🌏");
    const globeStart = encoded.findIndex((value, index) =>
      globe.every((part, offset) => encoded[index + offset] === part)
    );
    const response = await transformToOllama(new Response(
      splitByteStream(text, [7, globeStart + 1, globeStart + 3, encoded.length - 8]),
      { headers: { "Content-Type": "text/event-stream" } },
    ), "mix/model-max");
    const chunks = (await response.text()).trim().split("\n").map(JSON.parse);

    expect(chunks[0]).toMatchObject({ message: { content: "", thinking: "nghĩ 🌏" }, done: false });
    expect(chunks[1]).toMatchObject({ message: { content: "xong" }, done: false });
    expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({
      done: true,
      done_reason: "stop",
      prompt_eval_count: 2,
      eval_count: 3,
    });
  });

  it("converts a non-streaming OpenAI response, including reasoning and usage", async () => {
    const response = await transformToOllama(Response.json({
      model: "upstream-model",
      choices: [{
        message: { role: "assistant", content: "answer", reasoning_content: "work" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 4, completion_tokens: 5 },
    }), "requested-model");

    expect(await response.json()).toEqual({
      model: "upstream-model",
      message: { role: "assistant", content: "answer", thinking: "work" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 4,
      eval_count: 5,
    });
  });

  it("keeps usage sent after finish_reason and before DONE", async () => {
    const text = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const response = await transformToOllama(new Response(splitByteStream(text, [11, 37]), {
      headers: { "Content-Type": "text/event-stream" },
    }), "fixture");
    const chunks = (await response.text()).trim().split("\n").map(JSON.parse);

    expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({
      done: true,
      done_reason: "stop",
      prompt_eval_count: 7,
      eval_count: 2,
    });
  });

  it("fails closed when a successful SSE response is empty", async () => {
    const upstream = new Response("", {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "x-upstream": "fixture" },
    });
    const response = await transformToOllama(upstream, "fixture");
    const lines = (await response.text()).trim().split("\n").map(JSON.parse);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream")).toBe("fixture");
    expect(lines).toEqual([expect.objectContaining({
      error: expect.stringMatching(/without a terminal event/),
      code: "invalid_upstream_response",
      status: 502,
    })]);
    expect(lines.some((line) => line.done === true)).toBe(false);
    expect(upstream.body.locked).toBe(false);
  });

  it("does not treat a bare DONE sentinel as a complete model response", async () => {
    const upstream = new Response("data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    const response = await transformToOllama(upstream, "fixture");
    const error = await response.json();

    expect(error).toMatchObject({
      error: expect.stringMatching(/before any response data/),
      code: "invalid_upstream_response",
      status: 502,
    });
    expect(error.done).toBeUndefined();
    expect(upstream.body.locked).toBe(false);
  });

  it.each([
    {
      name: "a parsed error envelope",
      frame: `data: ${JSON.stringify({ error: { message: "gateway rejected the stream", code: "gateway_error" } })}\n\n`,
      message: "gateway rejected the stream",
      code: "gateway_error",
    },
    {
      name: "an event:error frame",
      frame: `event: error\ndata: ${JSON.stringify({ message: "provider stream failure", code: "provider_error" })}\n\n`,
      message: "provider stream failure",
      code: "provider_error",
    },
  ])("converts $name to a typed Ollama error and cancels the unread body", async ({ frame, message, code }) => {
    const cancel = vi.fn();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
      },
      cancel,
    });
    const upstream = new Response(source, { headers: { "Content-Type": "text/event-stream" } });
    const response = await transformToOllama(upstream, "fixture");
    const lines = (await response.text()).trim().split("\n").map(JSON.parse);

    expect(lines).toEqual([{ error: message, code, status: 502 }]);
    expect(lines.some((line) => line.done === true)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("does not synthesize success when SSE ends after only a non-terminal delta", async () => {
    const text = `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`;
    const upstream = new Response(splitByteStream(text, [5, 19, 41]), {
      headers: { "Content-Type": "text/event-stream" },
    });
    const response = await transformToOllama(upstream, "fixture");
    const lines = (await response.text()).trim().split("\n").map(JSON.parse);

    expect(lines[0]).toMatchObject({ message: { content: "partial" }, done: false });
    expect(lines.at(-1)).toMatchObject({
      error: expect.stringMatching(/without a terminal event/),
      code: "invalid_upstream_response",
      status: 502,
    });
    expect(lines.some((line) => line.done === true)).toBe(false);
    expect(upstream.body.locked).toBe(false);
  });

  it("accepts a split non-null finish_reason as terminal when EOF omits DONE", async () => {
    const text = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "complete" }, finish_reason: null }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\r\n\r\n`,
    ].join("");
    const bytes = new TextEncoder().encode(text);
    const response = await transformToOllama(new Response(
      splitByteStream(text, [1, bytes.length - 17, bytes.length - 2]),
      { status: 201, headers: { "Content-Type": "text/event-stream" } },
    ), "fixture");
    const lines = (await response.text()).trim().split("\n").map(JSON.parse);

    expect(response.status).toBe(201);
    expect(lines.filter((line) => line.done === true)).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 1,
    });
  });

  it("recognizes DONE split across transport chunks and cancels an open remainder", async () => {
    const cancel = vi.fn();
    const prefix = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] })}\n\ndata: [`;
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix));
        controller.enqueue(new TextEncoder().encode("DO"));
        controller.enqueue(new TextEncoder().encode("NE]\n\n"));
      },
      cancel,
    });
    const upstream = new Response(source, { headers: { "Content-Type": "text/event-stream" } });
    const response = await transformToOllama(upstream, "fixture");
    const lines = (await response.text()).trim().split("\n").map(JSON.parse);

    expect(lines).toEqual([expect.objectContaining({ done: true })]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("propagates downstream cancellation and releases a pending upstream read", async () => {
    const cancel = vi.fn();
    let sent = false;
    const source = new ReadableStream({
      pull(controller) {
        if (sent) return;
        sent = true;
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
        ));
      },
      cancel,
    });
    const upstream = new Response(source, { headers: { "Content-Type": "text/event-stream" } });
    const response = await transformToOllama(upstream, "fixture");
    const reader = response.body.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"done":false');
    await reader.cancel("client closed");

    expect(cancel).toHaveBeenCalledWith("client closed");
    await vi.waitFor(() => expect(upstream.body.locked).toBe(false));
  });

  it("turns a transport failure into a typed error without exposing its diagnostic", async () => {
    const upstream = new Response(new ReadableStream({
      pull(controller) {
        controller.error(new Error("private socket address and token"));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const response = await transformToOllama(upstream, "fixture");
    const body = await response.text();
    const error = JSON.parse(body);

    expect(error).toEqual({
      error: "Invalid upstream streaming response",
      code: "invalid_upstream_response",
      status: 502,
    });
    expect(body).not.toContain("private socket address");
    expect(upstream.body.locked).toBe(false);
  });

  it("preserves upstream error status and body instead of converting it to success", async () => {
    const upstream = Response.json({ error: { message: "unauthorized" } }, {
      status: 401,
      headers: { "content-encoding": "gzip", "content-length": "999" },
    });
    const response = await transformToOllama(upstream, "model");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.json()).toEqual({ error: { message: "unauthorized" } });
  });

  it("forwards an already-native media type without stale wire framing", async () => {
    const upstream = new Response('{"message":{"content":"ok"},"done":true}\n', {
      headers: {
        "content-type": "application/x-ndjson",
        "content-encoding": "gzip",
        "content-length": "999",
      },
    });

    const response = await transformToOllama(upstream, "model");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toContain('"done":true');
  });

  it("rejects an Ollama error envelope carried with HTTP 200", async () => {
    const response = await transformToOllama(Response.json({
      error: { message: "gateway returned no message", code: "empty_response" },
    }), "model");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "gateway returned no message",
      code: "empty_response",
      status: 502,
    });
  });

  it.each([
    ["an unfinished native Ollama result", { message: { role: "assistant", content: "partial" }, done: false }],
    ["an OpenAI result without a completed choice", { choices: [] }],
  ])("rejects %s carried with HTTP 200", async (_label, payload) => {
    const response = await transformToOllama(Response.json(payload), "model");

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/before completion|completed choice/),
      code: "invalid_upstream_response",
      status: 502,
    });
  });

  it("reconstructs an unknown successful JSON response without leaving a clone tee unread", async () => {
    const upstream = Response.json({ custom: true, value: "untouched" }, {
      headers: {
        "x-upstream": "fixture",
        digest: "sha-256=stale",
        "content-digest": "sha-256=:stale:",
        "repr-digest": "sha-256=:stale:",
        "content-md5": "stale",
        etag: '"stale"',
        "content-range": "bytes 0-1/99",
        trailer: "digest",
      },
    });
    const response = await transformToOllama(upstream, "model");

    expect(upstream.body.locked).toBe(false);
    expect(response.headers.get("x-upstream")).toBe("fixture");
    expect(response.headers.get("digest")).toBeNull();
    expect(response.headers.get("content-digest")).toBeNull();
    expect(response.headers.get("repr-digest")).toBeNull();
    expect(response.headers.get("content-md5")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("trailer")).toBeNull();
    expect(await response.json()).toEqual({ custom: true, value: "untouched" });
  });

  it("cancels a stalled non-streaming body promptly when the caller aborts", async () => {
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream({ start() {}, cancel }), {
      headers: { "content-type": "application/json" },
    });
    const controller = new AbortController();
    const pending = transformToOllama(upstream, "model", controller.signal);
    await Promise.resolve();

    controller.abort(new Error("private caller cancellation detail"));
    const response = await pending;
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("Invalid upstream Ollama response");
    expect(JSON.stringify(body)).not.toContain("private caller cancellation detail");
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("cancels an idle streaming body when the caller aborts", async () => {
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream({ start() {}, cancel }), {
      headers: { "content-type": "text/event-stream" },
    });
    const controller = new AbortController();
    const response = await transformToOllama(upstream, "model", controller.signal);

    controller.abort(new DOMException("client left", "AbortError"));

    await expect(response.text()).resolves.toBe("");
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it.each([
    ["malformed JSON", new TextEncoder().encode("{malformed")],
    ["invalid UTF-8", new Uint8Array([
      ...new TextEncoder().encode('{"choices":[{"message":{"content":"'),
      0xff,
      ...new TextEncoder().encode('"}}]}'),
    ])],
  ])("rejects a successful %s response instead of forwarding HTTP 200", async (_label, bytes) => {
    const upstream = new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const response = await transformToOllama(upstream, "model");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/malformed/),
      code: "invalid_upstream_response",
      status: 502,
    });
  });

  it("rejects a declared oversized non-streaming JSON response and cancels its body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start() {}, cancel });
    const upstream = new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 * 1024 + 1),
      },
    });
    const response = await transformToOllama(upstream, "model");

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/exceeds/) });
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("does not wait forever when oversized-body cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const body = new ReadableStream({ start() {}, cancel });
    const upstream = new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 * 1024 + 1),
      },
    });

    const response = await transformToOllama(upstream, "model");
    expect(response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
