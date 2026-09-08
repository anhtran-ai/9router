import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createBridgeAbortController,
  fetchRouter,
  pipeSSE,
  pipeTransformedEventStream,
  pipeTransformedSSE,
} = require("../../src/mitm/handlers/base.js");
const { intercept: interceptCopilot } = require("../../src/mitm/handlers/copilot.js");
const { intercept: interceptKiro } = require("../../src/mitm/handlers/kiro.js");

const originalFetch = globalThis.fetch;

class ResponseCollector extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.writeResults = [...writeResults];
    this.chunks = [];
    this.headers = undefined;
    this.statusCode = undefined;
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.write = vi.fn((chunk) => {
      this.chunks.push(Buffer.from(chunk));
      return this.writeResults.length ? this.writeResults.shift() : true;
    });
    this.end = vi.fn((chunk) => {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
      return this;
    });
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
}

function mockRouterResponse(reader, status = 200, contentType = "text/event-stream") {
  return {
    status,
    headers: new Headers({ "content-type": contentType }),
    body: { getReader: () => reader },
  };
}

function finiteReader(chunks) {
  const results = chunks.map((value) => ({ done: false, value }));
  results.push({ done: true, value: undefined });
  return {
    read: vi.fn(async () => results.shift()),
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn(),
  };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("MITM router stream lifecycle", () => {
  it("passes the downstream abort signal into fetchRouter", async () => {
    const req = new EventEmitter();
    req.aborted = false;
    const res = new ResponseCollector();
    const bridge = createBridgeAbortController(req, res);
    globalThis.fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));

    const fetchPromise = fetchRouter({ model: "test" }, "/v1/chat/completions", {}, bridge.signal);
    await nextTurn();
    res.destroyed = true;
    res.emit("close");

    await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(globalThis.fetch.mock.calls[0][1].signal).toBe(bridge.signal);
    expect(bridge.signal.aborted).toBe(true);
    bridge.cleanup();
    expect(res.listenerCount("close")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });

  it("wires a real handler's downstream close into the in-flight router fetch", async () => {
    const req = new EventEmitter();
    Object.assign(req, {
      aborted: false,
      headers: {},
      url: "/chat/completions",
    });
    const res = new ResponseCollector();
    let fetchSignal;
    globalThis.fetch = vi.fn((_url, init) => {
      fetchSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    });

    const interceptPromise = interceptCopilot(
      req,
      res,
      Buffer.from(JSON.stringify({ model: "original" })),
      "mapped"
    );
    await nextTurn();
    res.destroyed = true;
    res.emit("close");
    await interceptPromise;

    expect(fetchSignal.aborted).toBe(true);
    expect(res.end).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });

  it("waits for downstream drain before reading the next upstream chunk", async () => {
    const reader = finiteReader([Buffer.from("first"), Buffer.from("second")]);
    const res = new ResponseCollector([false, true]);

    const pipePromise = pipeSSE(mockRouterResponse(reader, 503), res);
    await nextTurn();

    expect(res.statusCode).toBe(503);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledTimes(1);

    res.emit("drain");
    await pipePromise;

    expect(reader.read).toHaveBeenCalledTimes(3);
    expect(Buffer.concat(res.chunks).toString()).toBe("firstsecond");
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledOnce();
    expect(res.listenerCount("close")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });

  it("cancels and releases a pending upstream reader when the downstream closes", async () => {
    const reader = {
      read: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    const res = new ResponseCollector();
    const pipePromise = pipeSSE(mockRouterResponse(reader), res);
    await nextTurn();

    res.destroyed = true;
    res.emit("close");

    await expect(pipePromise).rejects.toMatchObject({ name: "AbortError" });
    await nextTurn();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });

  it.each([
    ["SSE", pipeTransformedSSE, "text/event-stream"],
    ["AWS EventStream", pipeTransformedEventStream, "application/vnd.amazon.eventstream"],
  ])("preserves non-200 status and parses a trailing %s frame without a newline", async (_name, pipe, expectedType) => {
    const encoded = new TextEncoder().encode(`data: ${JSON.stringify({ text: "tail-€" })}`);
    const euroIndex = encoded.indexOf(0xe2);
    const reader = finiteReader([
      encoded.slice(0, euroIndex + 1),
      encoded.slice(euroIndex + 1),
    ]);
    const res = new ResponseCollector();
    const transform = vi.fn((message) => message
      ? Buffer.from(`frame:${message.text}|`)
      : Buffer.from("flush"));

    await pipe(mockRouterResponse(reader, 429), res, transform, {});

    expect(res.statusCode).toBe(429);
    expect(res.headers["Content-Type"]).toBe(expectedType);
    expect(Buffer.concat(res.chunks).toString()).toBe("frame:tail-€|flush");
    expect(transform).toHaveBeenNthCalledWith(1, { text: "tail-€" }, {});
    expect(transform).toHaveBeenNthCalledWith(2, null, {});
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it("rejects and releases an upstream stream with an unbounded unterminated SSE line", async () => {
    const reader = finiteReader([
      Buffer.from(`data: ${"x".repeat(1024 * 1024 + 1)}`),
    ]);
    const res = new ResponseCollector();

    await expect(pipeTransformedSSE(
      mockRouterResponse(reader),
      res,
      vi.fn(),
      {}
    )).rejects.toThrow("Router SSE line exceeds maximum size");
    await nextTurn();

    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 in a successful router SSE event", async () => {
    const prefix = Buffer.from('data: {"choices":[{"delta":{"content":"');
    const suffix = Buffer.from('"},"finish_reason":"stop"}]}\n\n');
    const reader = finiteReader([Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix])]);
    const res = new ResponseCollector();

    await expect(pipeTransformedEventStream(
      mockRouterResponse(reader),
      res,
      vi.fn(),
      {},
    )).rejects.toThrow("invalid UTF-8");

    expect(res.end).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "data: {not-json}\n\n", /malformed JSON/],
    ["no response events", ": heartbeat\n\n", /without a valid response event/],
    [
      "content without a terminal",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
      /before a terminal event/,
    ],
  ])("rejects a successful router stream with %s instead of flushing success", async (_name, body, expectedError) => {
    const reader = finiteReader([Buffer.from(body)]);
    const res = new ResponseCollector();
    const transform = vi.fn((message) => message
      ? Buffer.from(`frame:${message.choices?.[0]?.delta?.content || "event"}|`)
      : Buffer.from("flush-success"));

    await expect(pipeTransformedEventStream(
      mockRouterResponse(reader),
      res,
      transform,
      {},
    )).rejects.toThrow(expectedError);

    expect(transform).not.toHaveBeenCalledWith(null, {});
    expect(Buffer.concat(res.chunks).toString()).not.toContain("flush-success");
    expect(res.end).not.toHaveBeenCalled();
  });

  it("rejects a successful transformed response with no body", async () => {
    const res = new ResponseCollector();
    const transform = vi.fn();
    const routerResponse = {
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: null,
      text: vi.fn(async () => ""),
    };

    await expect(pipeTransformedEventStream(routerResponse, res, transform, {}))
      .rejects.toThrow(/without a response body/);

    expect(transform).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("accepts [DONE] as the explicit terminal even when no finish_reason chunk is present", async () => {
    const content = { choices: [{ delta: { content: "complete" }, finish_reason: null }] };
    const reader = finiteReader([
      Buffer.from(`data: ${JSON.stringify(content)}\n\ndata: [DONE]\n\n`),
    ]);
    const res = new ResponseCollector();
    const transform = vi.fn((message) => message
      ? Buffer.from(`frame:${message.choices[0].delta.content}|`)
      : Buffer.from("flush"));

    await pipeTransformedEventStream(mockRouterResponse(reader), res, transform, {});

    expect(Buffer.concat(res.chunks).toString()).toBe("frame:complete|flush");
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("returns a typed Kiro EventStream exception for malformed router HTTP 200", async () => {
    const req = new EventEmitter();
    Object.assign(req, { aborted: false, headers: {}, url: "/" });
    const res = new ResponseCollector();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      "data: {not-json}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));

    await interceptKiro(
      req,
      res,
      Buffer.from(JSON.stringify({
        conversationState: {
          currentMessage: { userInputMessage: { content: "hello" } },
        },
      })),
      "mapped-model",
    );

    const output = Buffer.concat(res.chunks).toString("latin1");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/vnd.amazon.eventstream");
    expect(output).toContain(":exception-type");
    expect(output).toContain("InternalServerException");
    expect(output).toContain("9Router returned an invalid or incomplete response stream");
    expect(output).not.toContain('"handler":"kiro"');
  });
});
