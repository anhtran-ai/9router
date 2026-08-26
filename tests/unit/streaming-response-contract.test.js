import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { buildOnStreamComplete, handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const encoder = new TextEncoder();
const sse = (data, event = data?.type) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const chat = (delta, finish_reason = null, usage) => ({
  id: "chatcmpl_fixture", object: "chat.completion.chunk", model: "fixture", created: 1,
  choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
});
const claudeStart = { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "fixture", content: [], usage: { input_tokens: 8, output_tokens: 0 } } };
const claudeEnd = (stop_reason = "end_turn") => [
  { type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];
const textBlock = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
  { type: "content_block_stop", index: 0 },
];
const events = (items) => items.map(item => sse(item)).join("");

async function run(input, { target = FORMATS.OPENAI, source = FORMATS.CLAUDE, contentType = "text/event-stream", provider = "openrouter", signal, persistUsage = false } = {}) {
  const body = { messages: [{ role: "user", content: "fixture" }], stream: true };
  const requestStartTime = Date.now(); const log = { line: vi.fn(), errorLine: vi.fn() };
  const completion = persistUsage ? buildOnStreamComplete({ provider, model: "fixture", body, stream: true, requestStartTime, log }).onStreamComplete : undefined;
  const trackDone = vi.fn(); const onStreamComplete = vi.fn(completion); const onRequestSuccess = vi.fn();
  let finished = false;
  const finish = () => { if (!finished) { finished = true; trackDone(); } };
  const streamController = createStreamController({ signal, onDisconnect: finish, onError: finish, log: { line: vi.fn(), errorLine: vi.fn() } });
  const providerResponse = new Response(input, { headers: contentType === null ? {} : { "Content-Type": contentType } });
  const result = await handleStreamingResponse({
    providerResponse, provider, model: "fixture", sourceFormat: source, targetFormat: target,
    body, stream: true, requestStartTime, reqLogger: {}, streamController, onRequestSuccess,
    onStreamComplete, trackDone: finish, log,
  });
  return { ...result, trackDone, onStreamComplete, onRequestSuccess, streamController };
}

function parsedData(text) {
  return text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
}

describe("streaming response contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([FORMATS.OPENAI, FORMATS.CLAUDE])("rejects HTTP200 JSON for incoming Claude streaming from %s", async (target) => {
    const result = await run(JSON.stringify({ error: { message: "untrusted upstream body" } }), { target, contentType: "application/json" });
    const body = await result.response.text();
    expect(result).toMatchObject({ success: false, status: 502, error: expect.any(String) });
    expect(result.response.status).toBe(502);
    expect(JSON.parse(body).error.code).toBe("invalid_upstream_response");
    expect(body).not.toContain("untrusted upstream body");
    expect(result.onRequestSuccess).not.toHaveBeenCalled();
    expect(result.trackDone).toHaveBeenCalledTimes(1);
  });

  it.each([null, "text/html", "text/event-stream-invalid"])("rejects missing/wrong media type %s without reading an unbounded body", async (contentType) => {
    const cancel = vi.fn(); const pull = vi.fn(controller => controller.error(new Error("body must not be read")));
    const result = await run(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { contentType });
    expect(result.response.status).toBe(502);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["comments", ": heartbeat\n\n"],
    ["ping-only", sse({ type: "ping" })],
    ["unknown-only", sse({ type: "future.unknown", data: "ignored" })],
    ["malformed JSON", "data: {broken\n\n"],
    ["JSON masquerading as SSE", JSON.stringify({ ok: true })],
    ["truncated text", sse(chat({ content: "partial" }))],
    ["DONE without finish", sse(chat({ content: "partial" })) + "data: [DONE]\n\n"],
    ["upstream error", sse({ error: { message: "untrusted private diagnostic" } })],
  ])("does not turn %s into a completed Claude response", async (_label, input) => {
    const result = await run(input);
    const text = await result.response.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_stop");
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain("untrusted private diagnostic");
    expect(result.onStreamComplete).not.toHaveBeenCalled();
    expect(result.onRequestSuccess).not.toHaveBeenCalled();
    expect(result.trackDone).toHaveBeenCalledTimes(1);
  });

  it.each([FORMATS.CLAUDE, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])("holds Claude terminal metadata until message_stop for %s", async (source) => {
    const result = await run(events([claudeStart, ...textBlock, claudeEnd()[0]]), { target: FORMATS.CLAUDE, source });
    const text = await result.response.text();
    expect(text).toContain(source === FORMATS.OPENAI_RESPONSES ? "response.failed" : '"error"');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text).not.toContain("event: message_stop");
    expect(text).not.toContain("event: response.completed");
    expect(result.onStreamComplete).not.toHaveBeenCalled();
  });

  it("preserves native Claude block events and finishes without an OpenAI sentinel", async () => {
    const input = [claudeStart, ...textBlock, ...claudeEnd("max_tokens")];
    const result = await run(events(input), { target: FORMATS.CLAUDE, source: FORMATS.CLAUDE });
    const text = await result.response.text();
    expect(parsedData(text)).toEqual(input);
    expect(text).not.toContain("[DONE]");
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(result.onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(result.trackDone).toHaveBeenCalledTimes(1);
  });

  it("preserves a Chat usage trailer before emitting Claude terminal/tool/reasoning events", async () => {
    const input = [
      chat({ reasoning_content: "think" }),
      chat({ tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: '{"q":"ok"}' } }] }),
      chat({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 800, completion_tokens: 30, total_tokens: 830 } },
    ].map(item => sse(item)).join("") + "data: [DONE]\n\n";
    const result = await run(input);
    const data = parsedData(await result.response.text());
    expect(data).toContainEqual(expect.objectContaining({ delta: { type: "thinking_delta", thinking: "think" } }));
    expect(data).toContainEqual(expect.objectContaining({ delta: { type: "input_json_delta", partial_json: '{"q":"ok"}' } }));
    // Existing client-facing usage buffer is retained; raw completion usage stays exact.
    expect(data.find(item => item.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 2800, output_tokens: 30 } });
    expect(result.onStreamComplete.mock.calls[0][1]).toMatchObject({ input_tokens: 800, output_tokens: 30 });
    expect(data.filter(item => item.type === "message_stop")).toHaveLength(1);
  });

  it.each([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES])("preserves legitimate Responses max_output_tokens termination for %s", async (source) => {
    const terminal = { type: "response.incomplete", response: { id: "resp_fixture", object: "response", model: "fixture", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 800, output_tokens: 30 } } };
    const result = await run(sse({ type: "response.output_text.delta", delta: "partial" }) + sse(terminal), { target: FORMATS.OPENAI_RESPONSES, source, provider: "codex" });
    const text = await result.response.text();
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("response.completed");
    if (source === FORMATS.OPENAI_RESPONSES) expect(parsedData(text)).toContainEqual(terminal);
    else expect(text).toContain(source === FORMATS.CLAUDE ? '"stop_reason":"max_tokens"' : '"finish_reason":"length"');
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it.each(["length", "content_filter"])("keeps Chat %s incomplete when translating to Responses", async (reason) => {
    const result = await run(sse(chat({}, reason, { prompt_tokens: 8, completion_tokens: 3 })), { source: FORMATS.OPENAI_RESPONSES });
    const text = await result.response.text();
    expect(text).toContain("event: response.incomplete");
    expect(text).not.toContain("event: response.completed");
  });

  it.each([FORMATS.KIRO, FORMATS.CURSOR])("accepts executor-normalized %s OpenAI SSE", async (target) => {
    const result = await run(sse(chat({ content: "adapter output" })) + sse(chat({}, "stop")) + "data: [DONE]\n\n", { target });
    const text = await result.response.text();
    expect(text).toContain("adapter output");
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("event: error");
  });

  it.each([
    { type: "response.completed", response: {} },
    { type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", output: [], status: "in_progress" } },
    { type: "response.incomplete", response: { id: "resp_fixture", object: "response", model: "fixture", output: [], status: "completed" } },
    { type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", status: "completed" } },
  ])("rejects contradictory or empty Responses terminal envelopes (%j)", async (terminal) => {
    const result = await run(sse(terminal), { target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI_RESPONSES, provider: "codex" });
    const text = await result.response.text();
    expect(text).toContain("event: response.failed");
    expect(text).not.toContain(`event: ${terminal.type}\n`);
    expect(result.onStreamComplete).not.toHaveBeenCalled();
  });

  it("retains native Responses custom call, reasoning and incomplete terminal usage", async () => {
    const terminal = { type: "response.incomplete", response: {
      id: "resp_fixture", object: "response", model: "fixture", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 800, output_tokens: 30, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 10 } },
    } };
    const input = [
      { type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "ct_fixture", call_id: "call_fixture", name: "exec", input: "" } },
      { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "print(1)" },
      { type: "response.reasoning_summary_text.delta", delta: "thinking" }, terminal,
    ];
    const result = await run(events(input), { target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI_RESPONSES, provider: "codex" });
    expect(parsedData(await result.response.text())).toEqual(input);
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(result.onStreamComplete.mock.calls[0][1]).toMatchObject({ prompt_tokens: 800, completion_tokens: 30, cached_tokens: 100, reasoning_tokens: 10 });
  });

  it("retains a Chat usage trailer in the translated Responses terminal", async () => {
    const result = await run(sse(chat({ content: "ok" })) + sse(chat({}, "stop")) + sse({ choices: [], usage: { prompt_tokens: 800, completion_tokens: 30, total_tokens: 830, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 10 } } }) + "data: [DONE]\n\n", { source: FORMATS.OPENAI_RESPONSES });
    const data = parsedData(await result.response.text());
    expect(data.find(item => item.type === "response.completed").response.usage).toEqual({ input_tokens: 800, output_tokens: 30, total_tokens: 830, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 10 } });
    expect(data.find(item => item.type === "response.completed").response.output).toEqual(data.filter(item => item.type === "response.output_item.done").map(item => item.item));
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { type: "message", role: "user", content: [] }, { type: "message", id: "msg_fixture", model: "fixture", role: "assistant" }])("rejects malformed Claude message_start envelopes (%j)", async (message) => {
    const result = await run(events([{ type: "message_start", message }, ...claudeEnd()]), { target: FORMATS.CLAUDE, source: FORMATS.CLAUDE });
    const text = await result.response.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_start");
    expect(text).not.toContain("event: message_stop");
    expect(result.onStreamComplete).not.toHaveBeenCalled();
  });

  it.each([
    [FORMATS.OPENAI_RESPONSES, sse({ type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", status: "completed", output: [] } }) + sse({ type: "response.output_text.delta", delta: "late" })],
    [FORMATS.CLAUDE, events([claudeStart, ...claudeEnd(), ...textBlock])],
    [FORMATS.OLLAMA, '{"done":true,"done_reason":"stop"}\n{"message":{"content":"late"},"done":false}\n'],
  ])("stops %s at its global terminal without inspecting unused trailing data", async (target, input) => {
    const result = await run(input, { target, contentType: target === FORMATS.OLLAMA ? "application/x-ndjson" : "text/event-stream" });
    const text = await result.response.text();
    expect(text).not.toContain("event: error");
    expect(text).not.toContain("late");
    expect(text).not.toContain("hello");
    expect(text).toContain("event: message_stop");
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("rejects Gemini data for a finished candidate before the whole stream ends", async () => {
    const result = await run(sse({ candidates: [{ index: 0, finishReason: "STOP" }] }) + sse({ candidates: [{ index: 0, content: { parts: [{ text: "late" }] } }] }), { target: FORMATS.GEMINI });
    const text = await result.response.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_stop");
    expect(result.onStreamComplete).not.toHaveBeenCalled();
  });

  it.each([
    [FORMATS.CLAUDE, "data: {broken\n\n" + events([claudeStart, ...claudeEnd()]), "text/event-stream"],
    [FORMATS.OPENAI_RESPONSES, "data: {broken\n\n" + sse({ type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", status: "completed", output: [] } }), "text/event-stream"],
    [FORMATS.OLLAMA, '{broken\n{"done":true}\n', "application/x-ndjson"],
  ])("rejects malformed %s data before a valid global terminal", async (target, input, contentType) => {
    const result = await run(input, { target, contentType });
    const text = await result.response.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_stop");
    expect(result.onStreamComplete).not.toHaveBeenCalled();
  });

  it("does not certify unfinished Gemini candidates when only one candidate ended", async () => {
    const result = await run(sse({ candidates: [
      { index: 0, finishReason: "STOP" },
      { index: 1, content: { parts: [{ text: "unfinished" }] } },
    ] }), { target: FORMATS.GEMINI });
    const text = await result.response.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_stop");
    expect(result.onStreamComplete).not.toHaveBeenCalled();
  });

  it.each([
    ["null part", { parts: [null] }, false],
    ["scalar part", { parts: ["invalid"] }, false],
    ["nested array part", { parts: [[]] }, true],
    ["non-array parts", { parts: {} }, true],
    ["null parts", { parts: null }, false],
    ["null content", null, false],
  ])("rejects native Gemini %s before completion or success usage", async (_name, content, wrapped) => {
    const response = { candidates: [{ content, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } };
    const format = wrapped ? FORMATS.ANTIGRAVITY : FORMATS.GEMINI;
    const result = await run(sse(wrapped ? { response } : response), { target: format, source: format, persistUsage: true });
    const text = await result.response.text();
    expect(text).toContain("invalid_upstream_response");
    expect(text).not.toContain('"finishReason":"STOP"');
    expect(result.onStreamComplete).not.toHaveBeenCalled();
    expect(result.onRequestSuccess).not.toHaveBeenCalled();
    expect(saveRequestUsage).not.toHaveBeenCalled();
    expect(result.trackDone).toHaveBeenCalledTimes(1);
  });

  it("preserves native Gemini valid text/tool parts and a finish-only candidate", async () => {
    const input = [
      { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "thinking", thought: true }, { functionCall: { name: "lookup", args: { q: "ok" } } }] } }] },
      { candidates: [{ index: 0, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } },
    ];
    const result = await run(events(input), { target: FORMATS.GEMINI, source: FORMATS.GEMINI, persistUsage: true });
    expect(parsedData(await result.response.text())).toEqual(input);
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(result.onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
  });

  it("preserves per-candidate delta order when Gemini finishes candidates at different times", async () => {
    const input = [
      { candidates: [{ index: 0, content: { parts: [{ text: "a" }] }, finishReason: "STOP" }, { index: 1, content: { parts: [{ text: "b1" }] } }] },
      { candidates: [{ index: 1, content: { parts: [{ text: "b2" }] } }] },
      { candidates: [{ index: 1, content: { parts: [{ text: "b3" }] }, finishReason: "STOP" }] },
    ];
    const result = await run(events(input), { target: FORMATS.GEMINI, source: FORMATS.GEMINI });
    const data = parsedData(await result.response.text());
    const candidates = data.flatMap(item => item.candidates || []);
    expect(candidates.filter(item => item.index === 1).flatMap(item => item.content?.parts || []).map(part => part.text).join("")).toBe("b1b2b3");
    expect(candidates.filter(item => item.finishReason)).toHaveLength(2);
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("preserves per-choice Chat order while holding independently finishing choices", async () => {
    const input = [
      { choices: [{ index: 0, delta: { content: "a" }, finish_reason: "stop" }, { index: 1, delta: { content: "b1" }, finish_reason: null }] },
      { choices: [{ index: 1, delta: { content: "b2" }, finish_reason: null }] },
      { choices: [{ index: 1, delta: { content: "b3" }, finish_reason: "stop" }] },
    ];
    const result = await run(events(input), { source: FORMATS.OPENAI });
    const choices = parsedData(await result.response.text()).flatMap(item => item.choices || []);
    expect(choices.filter(item => item.index === 1).map(item => item.delta.content || "").join("")).toBe("b1b2b3");
    expect(choices.filter(item => item.finish_reason)).toHaveLength(2);
  });

  it.each([FORMATS.OPENAI, FORMATS.CLAUDE])("recovers authoritative completed-only Responses text/reasoning/function/custom output for %s", async (source) => {
    const output = [
      { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "think" }] },
      { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { type: "function_call", id: "fc_fixture", call_id: "call_lookup", name: "lookup", arguments: '{"q":"ok"}' },
      { type: "custom_tool_call", id: "ct_fixture", call_id: "call_exec", name: "exec", input: "print(1)" },
    ];
    const result = await run(sse({ type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", status: "completed", output, usage: { input_tokens: 8, output_tokens: 3 } } }), { target: FORMATS.OPENAI_RESPONSES, source, provider: "codex" });
    const data = parsedData(await result.response.text());
    if (source === FORMATS.OPENAI) {
      const deltas = data.flatMap(item => item.choices || []).map(choice => choice.delta);
      expect(deltas.map(delta => delta.content || "").join("")).toBe("hello");
      expect(deltas.map(delta => delta.reasoning_content || "").join("")).toBe("think");
      const calls = deltas.flatMap(delta => delta.tool_calls || []);
      expect(calls).toContainEqual(expect.objectContaining({ id: "call_lookup", function: { name: "lookup", arguments: '{"q":"ok"}' } }));
      expect(calls).toContainEqual(expect.objectContaining({ id: "call_exec", function: { name: "exec", arguments: '{"input":"print(1)"}' } }));
    } else {
      expect(data.filter(item => item.type === "content_block_delta").map(item => item.delta.text || "").join("")).toBe("hello");
      expect(data.filter(item => item.type === "content_block_delta").map(item => item.delta.thinking || "").join("")).toBe("think");
      expect(data.filter(item => item.type === "content_block_start" && item.content_block.type === "tool_use").map(item => item.content_block.name)).toEqual(["lookup", "exec"]);
      expect(data.filter(item => item.delta?.partial_json).map(item => item.delta.partial_json)).toEqual(['{"q":"ok"}', '{"input":"print(1)"}']);
    }
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("does not replay streamed Responses output when authoritative terminal output arrives", async () => {
    const fn = { type: "function_call", id: "fc_fixture", call_id: "call_lookup", name: "lookup", arguments: '{"q":"ok"}' };
    const custom = { type: "custom_tool_call", id: "ct_fixture", call_id: "call_exec", name: "exec", input: "print(1)" };
    const input = [
      { type: "response.reasoning_summary_text.delta", delta: "think" },
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.output_item.added", item: { ...fn, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: fn.id, delta: fn.arguments },
      { type: "response.output_item.done", item: fn },
      { type: "response.output_item.added", item: { ...custom, input: "" } },
      { type: "response.custom_tool_call_input.delta", item_id: custom.id, delta: custom.input },
      { type: "response.output_item.done", item: custom },
      { type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", status: "completed", output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "think" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }, fn, custom,
      ], usage: { input_tokens: 8, output_tokens: 3 } } },
    ];
    const result = await run(events(input), { target: FORMATS.OPENAI_RESPONSES, provider: "codex" });
    const data = parsedData(await result.response.text());
    const blocks = data.filter(item => item.type === "content_block_start");
    expect(blocks.filter(item => item.content_block.type === "tool_use")).toHaveLength(2);
    expect(data.map(item => item.delta?.text || "").join("")).toBe("hello");
    expect(data.map(item => item.delta?.thinking || "").join("")).toBe("think");
    expect(data.filter(item => item.delta?.partial_json).map(item => item.delta.partial_json)).toEqual(['{"q":"ok"}', '{"input":"print(1)"}']);
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("recovers only a missing Responses terminal text suffix", async () => {
    const result = await run(sse({ type: "response.output_text.delta", delta: "hel" }) + sse({ type: "response.completed", response: {
      id: "resp_fixture", object: "response", model: "fixture", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
    } }), { target: FORMATS.OPENAI_RESPONSES, provider: "codex" });
    expect(parsedData(await result.response.text()).map(item => item.delta?.text || "").join("")).toBe("hello");
  });

  describe.each(["response.output_item.done", "response.completed"])("Responses identity at %s", (eventType) => {
    it.each([
      ["name", { name: "different_tool" }, false],
      ["type", { type: "custom_tool_call", input: "{}" }, false],
      ["item id", { id: "fc_different" }, false],
      ["call id", { call_id: "call_different" }, false],
      ["both ids at the same output index", { id: "fc_different", call_id: "call_different" }, true],
    ])("rejects changed %s without certifying the earlier invocation", async (_name, changedFields, indexed) => {
      const added = { type: "function_call", id: "fc_a", call_id: "call_a", name: "first_tool", arguments: "" };
      const changed = { ...added, arguments: "{}", ...changedFields };
      if (changed.type === "custom_tool_call") delete changed.arguments;
      const outputIndex = indexed ? { output_index: 0 } : {};
      const terminal = { type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", status: "completed", output: [changed], usage: { input_tokens: 12, output_tokens: 4 } } };
      const input = [{ type: "response.output_item.added", item: added, ...outputIndex }];
      if (eventType === "response.output_item.done") input.push({ type: eventType, item: changed, ...outputIndex });
      input.push(terminal);
      const result = await run(events(input), { target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI, provider: "codex", persistUsage: true });
      const text = await result.response.text();
      expect(text).toContain("invalid_upstream_response");
      expect(parsedData(text).some(event => event.choices?.some(choice => choice.finish_reason))).toBe(false);
      expect(result.onStreamComplete).not.toHaveBeenCalled();
      expect(result.onRequestSuccess).not.toHaveBeenCalled();
      expect(saveRequestUsage).not.toHaveBeenCalled();
      expect(result.trackDone).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects conflicting Responses item identity on native passthrough too", async () => {
    const added = { type: "custom_tool_call", id: "ct_a", call_id: "call_a", name: "first_tool", input: "" };
    const result = await run(events([
      { type: "response.output_item.added", item: added },
      { type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", status: "completed", output: [{ ...added, name: "different_tool", input: "raw" }] } },
    ]), { target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI_RESPONSES, provider: "codex", persistUsage: true });
    const text = await result.response.text();
    expect(text).toContain("invalid_upstream_response");
    expect(text).not.toContain("event: response.completed");
    expect(result.onStreamComplete).not.toHaveBeenCalled();
    expect(saveRequestUsage).not.toHaveBeenCalled();
  });

  it("keeps interleaved custom identities while normalizing arguments and mutable metadata", async () => {
    const a = { type: "custom_tool_call", id: "ct_a", call_id: "call_a", name: "exec", input: 'a\n"quoted"', status: "completed" };
    const b = { type: "custom_tool_call", id: "ct_b", call_id: "call_b", name: "exec", input: "b\\literal", status: "completed" };
    const input = [
      { type: "response.output_item.added", output_index: 0, item: { ...a, input: "", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 1, item: { ...b, input: "", status: "in_progress" } },
      { type: "response.custom_tool_call_input.delta", item_id: a.id, delta: a.input },
      { type: "response.custom_tool_call_input.delta", item_id: b.id, delta: b.input },
      { type: "response.output_item.done", output_index: 1, item: b },
      { type: "response.output_item.done", output_index: 0, item: a },
      { type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", status: "completed", output: [a, b], usage: { input_tokens: 12, output_tokens: 4 } } },
    ];
    const result = await run(events(input), { target: FORMATS.OPENAI_RESPONSES, source: FORMATS.OPENAI, provider: "codex", persistUsage: true });
    const calls = new Map();
    for (const event of parsedData(await result.response.text())) for (const call of event.choices?.[0]?.delta?.tool_calls || []) {
      const accumulated = calls.get(call.index) || { id: "", name: "", arguments: "" };
      if (call.id) accumulated.id = call.id;
      accumulated.name += call.function?.name || "";
      accumulated.arguments += call.function?.arguments || "";
      calls.set(call.index, accumulated);
    }
    expect([...calls.values()]).toEqual([a, b].map(item => ({ id: item.call_id, name: item.name, arguments: JSON.stringify({ input: item.input }) })));
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(result.onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(result.trackDone).toHaveBeenCalledTimes(1);
  });

  it.each([FORMATS.GEMINI, FORMATS.OPENAI])("preserves Gemini promptFeedback-only filtered completion for %s", async (source) => {
    const blocked = { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 0 }, modelVersion: "fixture" };
    const result = await run(sse(blocked), { target: FORMATS.GEMINI, source });
    const data = parsedData(await result.response.text());
    if (source === FORMATS.GEMINI) expect(data).toEqual([blocked]);
    else expect(data).toContainEqual(expect.objectContaining({ choices: [expect.objectContaining({ finish_reason: "content_filter" })] }));
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown SSE field names inside otherwise valid frames", async () => {
    const result = await run(`future: ignored\n${sse(chat({ content: "valid" }))}another_unknown_field\n${sse(chat({}, "stop"))}`);
    const text = await result.response.text();
    expect(text).toContain("valid");
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("event: error");
  });

  it.each([
    ["native Claude", FORMATS.CLAUDE, FORMATS.CLAUDE, events([claudeStart, ...textBlock, ...claudeEnd()]), "text/event-stream"],
    ["native Responses", FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, sse({ type: "response.completed", response: { id: "resp_fixture", object: "response", model: "fixture", status: "completed", output: [], usage: { input_tokens: 8, output_tokens: 0 } } }), "text/event-stream"],
    ["Chat DONE", FORMATS.OPENAI, FORMATS.OPENAI, sse(chat({ content: "hi" }, "stop")) + "data: [DONE]\n\n", "text/event-stream"],
    ["Ollama done", FORMATS.OLLAMA, FORMATS.CLAUDE, '{"done":true,"done_reason":"stop","prompt_eval_count":8,"eval_count":0}\n', "application/x-ndjson"],
    ["Gemini blocked prompt", FORMATS.GEMINI, FORMATS.GEMINI, sse({ promptFeedback: { blockReason: "SAFETY" } }), "text/event-stream"],
  ])("delivers %s terminal promptly when upstream keeps HTTP open", async (_name, target, source, input, contentType) => {
    let upstream; const cancel = vi.fn();
    const result = await run(new ReadableStream({ start(controller) { upstream = controller; }, cancel }), { target, source, contentType, provider: target === FORMATS.OPENAI_RESPONSES ? "codex" : "openrouter" });
    let settled = false;
    const pending = result.response.text().then(text => { settled = true; return text; });
    upstream.enqueue(encoder.encode(input));
    await new Promise(resolve => setTimeout(resolve, 25));
    const completedBeforeUpstreamEOF = settled;
    if (!cancel.mock.calls.length) upstream.close(); // Release the synthetic open stream on RED too.
    const text = await pending;
    expect(completedBeforeUpstreamEOF).toBe(true);
    expect(text).not.toContain('"code":"invalid_upstream_response"');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(result.onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(result.trackDone).toHaveBeenCalledTimes(1);
    expect(result.streamController.getError()).toBeNull();
    expect(result.streamController.signal.aborted).toBe(false);
  });

  it("accepts Ollama NDJSON and Gemini wrapped SSE without inventing an early terminal", async () => {
    const ollama = await run('{"message":{"content":"hi"},"done":false}\n{"done":true,"done_reason":"stop","prompt_eval_count":8,"eval_count":3}\n', { target: FORMATS.OLLAMA, contentType: "application/x-ndjson" });
    expect(await ollama.response.text()).toContain("event: message_stop");
    const gemini = await run(sse({ response: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 } } }), { target: FORMATS.ANTIGRAVITY });
    expect(await gemini.response.text()).toContain("event: message_stop");
  });

  it("streams complete early frames before upstream EOF and propagates downstream cancellation", async () => {
    let upstream; const cancel = vi.fn();
    const result = await run(new ReadableStream({ start(controller) { upstream = controller; }, cancel }));
    const reader = result.response.body.getReader();
    upstream.enqueue(encoder.encode(sse(chat({ content: "first" }))));
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(result.onStreamComplete).not.toHaveBeenCalled();
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.trackDone).toHaveBeenCalledTimes(1);
    result.streamController.handleComplete();
  });

  it("does not drain an entire upstream response while the client is backpressured", async () => {
    let pulled = 0; const cancel = vi.fn();
    const result = await run(new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(encoder.encode(sse(chat({ content: `frame-${pulled}` }))));
        if (pulled === 100) { controller.enqueue(encoder.encode(sse(chat({}, "stop")))); controller.close(); }
      }, cancel,
    }, { highWaterMark: 0 }));
    const reader = result.response.body.getReader();
    await reader.read();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(pulled).toBeLessThan(10);
    expect(result.onStreamComplete).not.toHaveBeenCalled();
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.trackDone).toHaveBeenCalledTimes(1);
  });

  it("preserves UTF8 and multiline JSON SSE frames split across transport chunks", async () => {
    const input = `data: {\r\ndata: "choices":[{"index":0,"delta":{"content":"chào"},"finish_reason":null}]\r\ndata: }\r\n\r\n${sse(chat({}, "stop"))}`;
    const bytes = encoder.encode(input);
    const result = await run(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
    const text = await result.response.text();
    expect(text).toContain("chào");
    expect(text).toContain("event: message_stop");
  });
});
