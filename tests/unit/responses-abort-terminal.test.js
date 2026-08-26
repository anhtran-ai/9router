import { describe, expect, it, vi } from "vitest";

import { createDisconnectAwareStream, createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { buildAbortedResponsesTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";
import { createStreamContract } from "../../open-sse/utils/streamContract.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Minimal stream controller stub
function makeController() {
  let connected = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { connected = false; },
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe("Responses abort terminal synthesis", () => {
  it("emits response.failed + [DONE] when upstream errors (abort/stall)", async () => {
    // Upstream readable that errors mid-stream (simulates fetch abort on stall)
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
        controller.error(new Error("stream stall timeout"));
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      buildAbortedResponsesTerminalBytes
    );

    const text = await readAll(out);
    expect(text).toContain("event: response.failed");
    expect(text).toContain("data: [DONE]");
  });

  it("propagates a network failure when no client-format error callback exists", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        controller.error(new Error("socket hang up"));
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      null
    );

    await expect(readAll(out)).rejects.toThrow("socket hang up");
  });
});

describe("client cancellation stream lifecycle", () => {
  const log = { line: vi.fn(), errorLine: vi.fn() };

  it("propagates a pre-aborted client signal immediately", () => {
    const client = new AbortController(); client.abort();
    const onDisconnect = vi.fn();
    const controller = createStreamController({ signal: client.signal, onDisconnect, log });
    expect(controller.signal.aborted).toBe(true);
    expect(controller.isConnected()).toBe(false);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it.each(["handleComplete", "handleError", "handleDisconnect"])("removes its client listener on %s", (method) => {
    vi.useFakeTimers();
    try {
      const client = new AbortController();
      const add = vi.spyOn(client.signal, "addEventListener");
      const remove = vi.spyOn(client.signal, "removeEventListener");
      const controller = createStreamController({ signal: client.signal, log });
      controller[method](new Error("fixture terminal"));
      const listener = add.mock.calls.find(([event]) => event === "abort")?.[1];
      expect(listener).toBeTypeOf("function");
      expect(remove).toHaveBeenCalledWith("abort", listener);
      vi.runAllTimers();
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it("preserves the stream-stall watchdog without treating it as client cancellation", async () => {
    vi.useFakeTimers();
    try {
      const client = new AbortController();
      const onDisconnect = vi.fn(); const onError = vi.fn();
      const controller = createStreamController({ signal: client.signal, onDisconnect, onError, log });
      const upstream = new ReadableStream({ start(source) {
        controller.signal.addEventListener("abort", () => source.error(new DOMException("fixture stall abort", "AbortError")), { once: true });
      } });
      const output = pipeWithDisconnect(new Response(upstream), new TransformStream(), controller, null, 10);
      const read = output.getReader().read().then(result => ({ result }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(20);
      expect(controller.signal.aborted).toBe(true);
      expect(client.signal.aborted).toBe(false);
      expect(onDisconnect).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "stream stall timeout" }));
      expect((await read).error).toMatchObject({ message: "stream stall timeout" });
    } finally { vi.useRealTimers(); }
  });

  it("keeps raw upstream heartbeats alive while validation emits no semantic output", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const controller = createStreamController({ onError, log });
    let source;
    const upstream = new ReadableStream({ start(value) { source = value; } });
    const output = pipeWithDisconnect(new Response(upstream), createStreamContract(FORMATS.OPENAI), controller, null, 10);
    const reader = output.getReader();
    const first = reader.read();
    try {
      for (let i = 0; i < 5; i++) {
        source.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        await vi.advanceTimersByTimeAsync(8);
      }
      expect(onError).not.toHaveBeenCalled();
      expect(controller.signal.aborted).toBe(false);
      source.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      source.close();
      expect((await first).done).toBe(false);
      reader.releaseLock();
      await readAll(output);
      expect(onError).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); await reader.cancel().catch(() => {}); vi.useRealTimers(); }
  });
});
