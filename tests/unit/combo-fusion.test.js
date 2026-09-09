import { describe, it, expect, vi } from "vitest";
import { getEventListeners } from "node:events";

import { handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function okResponse(content, { delayMs = 0 } = {}) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const res = new Response(JSON.stringify(json), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  return delayMs > 0 ? new Promise((r) => setTimeout(() => r(res), delayMs)) : res;
}

function errResponse(status = 500) {
  return new Response(JSON.stringify({ error: { message: "boom" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fusion combo", () => {
  it("does not start a pre-aborted panel", async () => {
    const client = new AbortController(); client.abort();
    const handleSingleModel = vi.fn();
    const result = await handleFusionChat({ body: {}, models: ["p/a", "p/b"], handleSingleModel, log, signal: client.signal });
    expect(result.status).toBe(499);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });

  it("does not call the judge after client cancellation during the panel", async () => {
    const client = new AbortController();
    const handleSingleModel = vi.fn(async () => { await Promise.resolve(); client.abort(); return okResponse("fixture answer"); });
    const result = await handleFusionChat({ body: {}, models: ["p/a", "p/b"], handleSingleModel, log, signal: client.signal });
    expect(result.status).toBe(499);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("answers directly with a single-model panel (nothing to fuse)", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("solo"));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/only"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/only");
  });

  it("fans out to the panel then routes a synthesis turn to the judge", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model, isPanel) => {
      seen.push(model);
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true, tools: [{ name: "x" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // 3 panel calls + 1 judge call.
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
    expect(seen.slice(0, 3).sort()).toEqual(["p/a", "p/b", "p/c"]);
    expect(seen[3]).toBe("p/judge");

    // Panel calls are non-streaming with tools stripped.
    for (const [body, model, isPanel] of handleSingleModel.mock.calls.filter(([, m]) => m !== "p/judge")) {
      expect(body.stream).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(isPanel).toBe(true);
    }

    // Judge call carries every panel answer + keeps the client's stream flag.
    const [judgeBody, , isPanel] = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeBody.messages.at(-1).content;
    expect(judgeText).toContain("ans-p/a");
    expect(judgeText).toContain("ans-p/b");
    expect(judgeText).toContain("ans-p/c");
    expect(judgeText).toContain("Source 1");
    expect(judgeBody.stream).toBe(true);
    expect(isPanel).toBeUndefined();

    expect(res.ok).toBe(true);
  });

  it("defaults the judge to the first panel model when none is set", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => { seen.push(model); return okResponse(`ans-${model}`); });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/first", "p/second"],
      handleSingleModel,
      log,
    });
    // Last call is the judge; defaults to panel[0].
    expect(seen.at(-1)).toBe("p/first");
  });

  it("proceeds on quorum without waiting for a straggler (grace window)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/slow") return okResponse("slow", { delayMs: 5000 });
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`fast-${model}`);
    });

    const t0 = Date.now();
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/x", "p/y", "p/slow"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 10000 },
    });
    const elapsed = Date.now() - t0;

    // Two fast answers reach quorum; grace is 50ms, so we never wait ~5s for p/slow.
    expect(elapsed).toBeLessThan(2000);

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    expect(judgeText).toContain("fast-p/x");
    expect(judgeText).toContain("fast-p/y");
    expect(judgeText).not.toContain("slow");
  });

  it("does not count malformed HTTP 200 bodies toward quorum or abort a valid slow panel", async () => {
    vi.useFakeTimers();
    let slowAborted = false;
    const handleSingleModel = vi.fn((_body, model, isPanel, panelSignal) => {
      if (!isPanel) return okResponse("DIRECT");
      if (model === "p/not-json") return new Response("not-json", { status: 200 });
      if (model === "p/empty") return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(okResponse("valid-slow")), 50);
        panelSignal.addEventListener("abort", () => {
          slowAborted = true;
          clearTimeout(timer);
          resolve(errResponse(499));
        }, { once: true });
      });
    });

    try {
      const pending = handleFusionChat({
        body: { messages: [{ role: "user", content: "Q" }] },
        models: ["p/not-json", "p/empty", "p/valid"],
        handleSingleModel,
        log,
        tuning: { minPanel: 2, stragglerGraceMs: 5, panelHardTimeoutMs: 500 },
      });
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(slowAborted).toBe(false);
      expect(handleSingleModel.mock.calls.filter(([, model]) => model === "p/valid")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds stalled panel bodies concurrently within each panel hard timeout", async () => {
    vi.useFakeTimers();
    const cancels = [];
    const handleSingleModel = vi.fn(async () => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return new Response(new ReadableStream({ cancel }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const pending = handleFusionChat({
        body: { messages: [{ role: "user", content: "Q" }] },
        models: ["p/stall-a", "p/stall-b"],
        handleSingleModel,
        log,
        tuning: { minPanel: 2, stragglerGraceMs: 5, panelHardTimeoutMs: 25 },
      });
      await vi.advanceTimersByTimeAsync(25);

      expect((await pending).status).toBe(503);
      await Promise.resolve();
      expect(cancels).toHaveLength(2);
      expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the unfinished panel call at quorum before starting the judge", async () => {
    vi.useFakeTimers();
    const panelSignals = new Map();
    let slowAborted = false;
    let judgeObservedAbort = false;
    const handleSingleModel = vi.fn((_body, model, isPanel, panelSignal) => {
      if (isPanel) panelSignals.set(model, panelSignal);
      if (model === "p/slow") {
        return new Promise((resolve) => {
          panelSignal.addEventListener("abort", () => {
            slowAborted = true;
            resolve(errResponse(499));
          }, { once: true });
        });
      }
      if (model === "p/judge") {
        judgeObservedAbort = slowAborted;
        return okResponse("FINAL");
      }
      return okResponse(`fast-${model}`);
    });

    try {
      const pending = handleFusionChat({
        body: { messages: [{ role: "user", content: "Q" }] },
        models: ["p/x", "p/y", "p/slow"],
        handleSingleModel,
        log,
        judgeModel: "p/judge",
        tuning: { minPanel: 2, stragglerGraceMs: 5, panelHardTimeoutMs: 1000 },
      });
      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(slowAborted).toBe(true);
      expect(judgeObservedAbort).toBe(true);
      expect(panelSignals.get("p/slow").aborted).toBe(true);
      expect(panelSignals.get("p/x").aborted).toBe(false);
      expect(panelSignals.get("p/y").aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a late response from a panel provider that ignored its abort", async () => {
    vi.useFakeTimers();
    let resolveSlow;
    const slowResult = new Promise(resolve => { resolveSlow = resolve; });
    const lateCancel = vi.fn();
    const handleSingleModel = vi.fn((_body, model, isPanel) => {
      if (isPanel && model === "p/slow") return slowResult;
      return okResponse(isPanel ? `fast-${model}` : "FINAL");
    });

    try {
      const pending = handleFusionChat({
        body: { messages: [{ role: "user", content: "Q" }] },
        models: ["p/a", "p/b", "p/slow"],
        handleSingleModel,
        log,
        judgeModel: "p/judge",
        tuning: { minPanel: 2, stragglerGraceMs: 5, panelHardTimeoutMs: 1000 },
      });
      await vi.advanceTimersByTimeAsync(5);
      expect((await pending).ok).toBe(true);

      resolveSlow(new Response(new ReadableStream({ cancel: lateCancel }), { status: 200 }));
      await Promise.resolve();
      await Promise.resolve();

      expect(lateCancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts every unresolved panel call at the hard timeout", async () => {
    vi.useFakeTimers();
    const aborted = new Set();
    const handleSingleModel = vi.fn((_body, model, _isPanel, panelSignal) => {
      panelSignal.addEventListener("abort", () => aborted.add(model), { once: true });
      return new Promise(() => {});
    });

    try {
      const pending = handleFusionChat({
        body: { messages: [{ role: "user", content: "Q" }] },
        models: ["p/hang-a", "p/hang-b"],
        handleSingleModel,
        log,
        tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 100 },
      });

      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(result.status).toBe(503);
      expect(aborted).toEqual(new Set(["p/hang-a", "p/hang-b"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns promptly and aborts unresolved panel calls when the client disconnects", async () => {
    const client = new AbortController();
    const panelSignals = [];
    const handleSingleModel = vi.fn((_body, _model, _isPanel, panelSignal) => {
      panelSignals.push(panelSignal);
      return new Promise(() => {});
    });

    const pending = handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/hang-a", "p/hang-b"],
      handleSingleModel,
      log,
      signal: client.signal,
      tuning: { minPanel: 2, stragglerGraceMs: 1000, panelHardTimeoutMs: 10000 },
    });
    await Promise.resolve();
    client.abort();

    const result = await pending;
    expect(result.status).toBe(499);
    expect(panelSignals).toHaveLength(2);
    expect(panelSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("unlinks completed panel signals from later client cancellation", async () => {
    const client = new AbortController();
    const completedPanelSignals = [];
    const handleSingleModel = vi.fn((_body, model, isPanel, panelSignal) => {
      if (isPanel) completedPanelSignals.push(panelSignal);
      return okResponse(`answer-${model}`);
    });

    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      signal: client.signal,
    });
    client.abort();

    expect(completedPanelSignals).toHaveLength(2);
    expect(completedPanelSignals.every((signal) => !signal.aborted)).toBe(true);
  });

  it("releases the client listener and timeout wrappers for more than ten abort-ignoring panels", async () => {
    vi.useFakeTimers();
    const client = new AbortController();
    const models = ["p/fast-a", "p/fast-b", ...Array.from({ length: 10 }, (_, i) => `p/hang-${i}`)];
    const aborted = new Set();
    const handleSingleModel = vi.fn((_body, model, isPanel, panelSignal) => {
      if (!isPanel || model.startsWith("p/fast")) return okResponse(`answer-${model}`);
      panelSignal.addEventListener("abort", () => aborted.add(model), { once: true });
      // Deliberately ignore abort and never settle, matching the leak repro.
      return new Promise(() => {});
    });

    try {
      const pending = handleFusionChat({
        body: { messages: [{ role: "user", content: "Q" }] },
        models,
        handleSingleModel,
        log,
        signal: client.signal,
        judgeModel: "p/judge",
        tuning: { minPanel: 2, stragglerGraceMs: 5, panelHardTimeoutMs: 90_000 },
      });
      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(aborted.size).toBe(10);
      expect(getEventListeners(client.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the lone survivor directly when only one panel model succeeds", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/ok") return okResponse("lone");
      return errResponse(500);
    });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    // No judge call — single answer means there is nothing to fuse.
    const judged = handleSingleModel.mock.calls.some(([, m]) => m === "p/judge");
    expect(judged).toBe(false);
  });

  it("returns 503 when the whole panel fails", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(500));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    expect(res.status).toBe(503);
  });

  it("cancels failed panel response bodies instead of retaining them", async () => {
    const cancels = [];
    const handleSingleModel = vi.fn(async () => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return new Response(new ReadableStream({ cancel }), { status: 503 });
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(503);
    await Promise.resolve();
    expect(cancels).toHaveLength(2);
    expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it("cancels a stalled successful panel body when the client aborts", async () => {
    const client = new AbortController();
    const cancels = [];
    const handleSingleModel = vi.fn(async () => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return new Response(new ReadableStream({ cancel }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const pending = handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      signal: client.signal,
    });
    await vi.waitFor(() => expect(handleSingleModel).toHaveBeenCalledTimes(2));
    client.abort(new DOMException("client left", "AbortError"));

    expect((await pending).status).toBe(499);
    await Promise.resolve();
    expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it("flattens previous tool history and assistant tool_calls into prose for panel calls", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "find files" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "find" } }] },
          { role: "tool", tool_call_id: "c1", content: "['a.js']" },
          { role: "user", content: "describe it" }
        ],
        tools: [{ type: "function" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    // Panel calls keep every turn but tool turns are flattened to assistant prose.
    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.messages.length).toBe(4);
      expect(panelBody.messages[0]).toEqual({ role: "user", content: "find files" });
      expect(panelBody.messages[1].tool_calls).toBeUndefined();
      expect(panelBody.messages[1].content).toContain("find");
      expect(panelBody.messages[2].role).toBe("assistant");
      expect(panelBody.messages[2].content).toContain("['a.js']");
      expect(panelBody.messages[3]).toEqual({ role: "user", content: "describe it" });
    }

    // Judge call still receives the unmodified history + synthesis prompt.
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeDefined();
    const judgeBody = judgeCall[0];
    expect(judgeBody.messages.length).toBe(5); // original 4 + judge prompt turn
    expect(judgeBody.messages[1].tool_calls).toBeDefined();
    expect(judgeBody.messages[2].role).toBe("tool");
  });

  it("flattens Anthropic-style tool_use and tool_result blocks in arrays", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "run" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }
        ],
        tools: [{ name: "run", description: "d" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    const panelBody = panelCalls[0][0];
    
    expect(panelBody.tools).toBeUndefined();
    expect(panelBody.messages.length).toBe(3);
    
    // Flattened tool_use
    expect(panelBody.messages[1].content).toBe("ok\n[Called tools: run]");
    
    // Flattened tool_result
    expect(panelBody.messages[2].content).toBe("[Tool result: done]");
  });
});
