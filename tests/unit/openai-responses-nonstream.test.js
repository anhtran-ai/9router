import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const coreMocks = vi.hoisted(() => ({ execute: vi.fn(), usage: vi.fn(async () => {}), success: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: () => ({ execute: coreMocks.execute, noAuth: true }) }));
vi.mock("open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => Object.fromEntries(["logClientRawRequest", "logRawRequest", "logTargetRequest", "logProviderResponse", "logConvertedResponse", "logError"].map(name => [name, vi.fn()])),
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: coreMocks.usage,
  trackPendingRequest: vi.fn(),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const chatCore = await import("../../open-sse/handlers/chatCore.js");
const { handleChatCore } = chatCore;
const { handleResponsesCore } = await import("../../open-sse/handlers/responsesHandler.js");
const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { validateResponseEnvelope } = await import("../../open-sse/translator/concerns/responseContract.js");

beforeEach(() => vi.clearAllMocks());

// A chat.completion body as returned by a chat-native upstream (e.g. op-ericding)
const CHAT_TOOL_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "cl/claude-haiku-4-5",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
    },
    finish_reason: "tool_calls"
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

describe("non-stream Chat upstream for a Responses-API client (op-ericding bug)", () => {
  it("translates chat.completion tool_calls into Responses function_call output", () => {
    // translateNonStreamingResponse(body, targetFormat=PROVIDER format, sourceFormat=CLIENT format)
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const fc = (out.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"ls\"}");
  });

  it.each([[new Set(["exec"])], [["exec"]]])("translates marked Chat tools into Responses custom_tool_call output (%j)", (customNames) => {
    const customBody = structuredClone(CHAT_TOOL_BODY);
    customBody.choices[0].message.tool_calls[0] = {
      id: "call_exec",
      type: "function",
      function: {
        name: "exec",
        arguments: "{\"input\":\"return await tools.shell({command: 'pwd'});\"}"
      }
    };
    const out = translateNonStreamingResponse(
      customBody,
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      customNames
    );
    const call = (out.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_exec",
      name: "exec",
      input: "return await tools.shell({command: 'pwd'});"
    });
    expect(out.output.some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps chat.completion text content as a Responses message item", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }]
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].type).toBe("output_text");
    expect(msg.content[0].text).toBe("hello");
  });

  it("leaves chat->chat untouched", () => {
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

describe("forced-SSE JSON path for a Responses-API client behind a chat upstream", () => {
  const sseCtx = (sourceFormat, targetFormat) => {
    const encoder = new TextEncoder();
    const raw = [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider: "op-test-chat",
      model: "gpt-x",
      body: { model: "gpt-x", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it("parses chat SSE chunks and returns a Responses function_call body", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    const fc = (json.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"pwd\"}");
  });

  it.each([[new Set(["shell"])], [["shell"]]])("returns a custom_tool_call for a marked tool (%j)", async (customNames) => {
    const ctx = sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    ctx.customToolNames = customNames;
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    const call = (json.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_9",
      name: "shell",
      input: "{\"cmd\":\"pwd\"}"
    });
  });

  it("still returns chat.completion for a plain chat client", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

const rawInput = "const value = `raw`;\nreturn value;";
const toolArgs = { input: rawInput };
const chatResult = {
  ...CHAT_TOOL_BODY,
  choices: [{ index: 0, message: { role: "assistant", content: "done", reasoning_content: "quiet reasoning", tool_calls: [
    { id: "call_exec", type: "function", function: { name: "exec", arguments: JSON.stringify(toolArgs) } },
    { id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"query":"safe"}' } },
  ] }, finish_reason: "tool_calls" }],
};
const claudeResult = {
  id: "msg_fixture", type: "message", role: "assistant", model: "fixture-model",
  content: [
    { type: "thinking", thinking: "quiet reasoning", signature: "fixture-signature" },
    { type: "text", text: "done" },
    { type: "tool_use", id: "call_exec", name: "exec", input: toolArgs },
    { type: "tool_use", id: "call_lookup", name: "lookup", input: { query: "safe" } },
  ], stop_reason: "tool_use", stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};
const geminiResult = {
  responseId: "gemini_fixture", modelVersion: "fixture-model",
  candidates: [{ content: { role: "model", parts: [
    { text: "quiet reasoning", thought: true }, { text: "done" },
    { functionCall: { id: "call_exec", name: "exec", args: toolArgs } },
    { functionCall: { id: "call_lookup", name: "lookup", args: { query: "safe" } } },
  ] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
};
const responsesResult = {
  id: "resp_fixture", object: "response", model: "fixture-model", status: "completed",
  output: [
    { id: "rs_fixture", type: "reasoning", summary: [{ type: "summary_text", text: "quiet reasoning" }], encrypted_content: "opaque-fixture" },
    { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] },
    { id: "fc_exec", type: "function_call", call_id: "call_exec", name: "exec", arguments: JSON.stringify(toolArgs) },
    { id: "fc_lookup", type: "function_call", call_id: "call_lookup", name: "lookup", arguments: '{"query":"safe"}' },
  ], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 3 } },
};
const sse = (events) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const chatSSE = (message = chatResult.choices[0].message) => [
  `data: ${JSON.stringify({ id: "chatcmpl_fixture", choices: [{ index: 0, delta: { ...message, tool_calls: message.tool_calls?.map((call, index) => ({ ...call, index })) }, finish_reason: null }] })}`,
  `data: ${JSON.stringify({ id: "chatcmpl_fixture", choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls?.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`,
  "data: [DONE]", "",
].join("\n\n");

async function runCoreResponse(upstreamBody, { provider = "groq", source = FORMATS.OPENAI_RESPONSES, contentType = "application/json", background = false } = {}) {
  const body = source === FORMATS.OPENAI_RESPONSES ? {
    model: "fixture-model", stream: false, input: [{ role: "user", content: "run tools" }],
    tools: [
      { type: "custom", name: "exec", format: { type: "text" } },
      { type: "function", name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } } },
    ],
  } : source === FORMATS.OPENAI ? {
    model: "fixture-model", stream: false, messages: [{ role: "user", content: "run tools" }],
  } : source === FORMATS.GEMINI ? {
    model: "fixture-model", stream: false, contents: [{ role: "user", parts: [{ text: "run tools" }] }],
  } : {
    model: "fixture-model", stream: false, max_tokens: 32, system: "Offline Claude fixture",
    messages: [{ role: "user", content: [{ type: "text", text: "run tools" }] }],
  };
  if (background) body.background = true;
  coreMocks.execute.mockResolvedValue({
    response: new Response(typeof upstreamBody === "string" ? upstreamBody : JSON.stringify(upstreamBody), { headers: { "Content-Type": contentType } }),
    url: "https://example.invalid/offline-only", headers: {},
  });
  const result = await handleChatCore({
    body, modelInfo: { provider, model: "fixture-model" }, credentials: { providerSpecificData: {} },
    onRequestSuccess: coreMocks.success, connectionId: "offline-fixture",
    clientRawRequest: { endpoint: source === FORMATS.CLAUDE ? "/v1/messages" : "/v1/responses", headers: { accept: "application/json" }, body },
    rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  });
  expect(coreMocks.execute).toHaveBeenCalledTimes(1);
  return { result, json: await result.response.json() };
}

describe("actual nonstream response contracts (#36 / #38)", () => {
  it.each([
    ["groq", chatResult], ["anthropic-compatible-fixture", claudeResult], ["gemini", geminiResult],
  ])("round-trips Responses custom and ordinary tools through %s JSON", async (provider, response) => {
    const { result, json } = await runCoreResponse(response, { provider });
    expect(result.success).toBe(true);
    expect(json.object).toBe("response");
    expect(json.output).toEqual([
      { type: "reasoning", summary: [{ type: "summary_text", text: "quiet reasoning" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] },
      { type: "custom_tool_call", id: "ctc_call_exec", call_id: "call_exec", name: "exec", input: rawInput },
      { type: "function_call", id: "fc_call_lookup", call_id: "call_lookup", name: "lookup", arguments: '{"query":"safe"}' },
    ]);
    expect(json.usage).toEqual({ input_tokens: 2010, output_tokens: 5, total_tokens: 2015 });
  });

  it("round-trips actual array custom metadata through forced Chat SSE", async () => {
    const { result, json } = await runCoreResponse(chatSSE(), { provider: "openai", contentType: "text/event-stream" });
    expect(coreMocks.execute.mock.calls[0][0].stream).toBe(true);
    expect(result.success).toBe(true);
    expect(json.output).toContainEqual(expect.objectContaining({ type: "custom_tool_call", call_id: "call_exec", input: rawInput }));
    expect(json.output).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_lookup" }));
    expect(json.output.some(item => item.type === "reasoning")).toBe(true);
  });

  it.each([["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]].flatMap(([separator, eol]) =>
    ["openai", "groq"].map(provider => ({ separator, eol, provider }))
  ))("collects multiline $separator SSE frames for a nonstream Chat client through $provider", async ({ eol, provider }) => {
    const raw = [
      ": fixture comment", "event: message",
      'data: {"id":"chatcmpl_multiline",',
      'data: "choices":[{"index":0,"delta":{"role":"assistant","content":"joined frame"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl_multiline","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "", "data: [DONE]", "",
    ].join(eol);
    const { result, json } = await runCoreResponse(raw, { provider, source: FORMATS.OPENAI, contentType: "text/event-stream" });
    expect(coreMocks.execute.mock.calls[0][0].stream).toBe(provider === "openai");
    expect(result.success).toBe(true);
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0]).toMatchObject({ message: { role: "assistant", content: "joined frame" }, finish_reason: "stop" });
  });

  it.each([
    ["groq", chatResult], ["gemini", geminiResult], ["openai-compatible-responses-fixture", responsesResult],
    ["anthropic-compatible-fixture", chatResult],
  ])("returns an Anthropic Message to Claude after %s JSON", async (provider, response) => {
    const { result, json } = await runCoreResponse(response, { provider, source: FORMATS.CLAUDE });
    expect(result.success).toBe(true);
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("tool_use");
    expect(json.content).toContainEqual({ type: "thinking", thinking: "quiet reasoning" });
    expect(json.content).toContainEqual({ type: "text", text: "done" });
    expect(json.content).toContainEqual({ type: "tool_use", id: "call_exec", name: "exec", input: toolArgs });
    expect(json.usage.output_tokens).toBe(5);
    expect(json).not.toHaveProperty("choices");
  });

  it.each([
    ["openai", chatSSE()],
    ["codex", sse([{ type: "response.completed", response: responsesResult }])],
  ])("returns Claude JSON for forced %s SSE without losing reasoning/tools", async (provider, response) => {
    const { result, json } = await runCoreResponse(response, { provider, source: FORMATS.CLAUDE, contentType: "text/event-stream" });
    expect(result.success).toBe(true);
    expect(json.type).toBe("message");
    expect(json.content).toContainEqual({ type: "thinking", thinking: "quiet reasoning" });
    expect(json.content).toContainEqual({ type: "tool_use", id: "call_exec", name: "exec", input: toolArgs });
    expect(json.usage.output_tokens).toBe(5);
  });

  it.each([null, {}, [], { error: { message: "unexpected upstream payload" } }, { choices: [] }].map(response => [response]))("rejects malformed HTTP200 JSON before success/usage (%j)", async (response) => {
    const { result } = await runCoreResponse(response, { provider: "anthropic-compatible-fixture", source: FORMATS.CLAUDE });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(coreMocks.success).not.toHaveBeenCalled();
    expect(coreMocks.usage).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Claude missing content", source: FORMATS.CLAUDE, provider: "anthropic-compatible-fixture", response: { type: "message", role: "assistant" } },
    { label: "Chat empty message object", source: FORMATS.OPENAI, provider: "groq", response: { choices: [{ message: {} }] } },
    { label: "Responses missing id", source: FORMATS.OPENAI_RESPONSES, provider: "openai-compatible-responses-fixture", response: { object: "response", status: "completed", output: [] } },
    { label: "Claude null non-limit content", source: FORMATS.CLAUDE, provider: "anthropic-compatible-fixture", response: { ...claudeResult, content: null, stop_reason: "end_turn" } },
    { label: "Claude missing model", source: FORMATS.CLAUDE, provider: "anthropic-compatible-fixture", response: { ...claudeResult, model: undefined } },
    { label: "Responses missing model", source: FORMATS.OPENAI_RESPONSES, provider: "openai-compatible-responses-fixture", response: { ...responsesResult, model: undefined } },
  ])("does not bypass envelope validation for native $label JSON", async ({ source, provider, response }) => {
    const { result } = await runCoreResponse(response, { source, provider });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(coreMocks.success).not.toHaveBeenCalled();
    expect(coreMocks.usage).not.toHaveBeenCalled();
  });

  it("does not emit a malformed Claude tool input when Chat tool arguments encode a primitive", async () => {
    const response = structuredClone(chatResult);
    response.choices[0].message.tool_calls[0].function.arguments = "42";
    const { result } = await runCoreResponse(response, { source: FORMATS.CLAUDE });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(coreMocks.success).not.toHaveBeenCalled();
    expect(coreMocks.usage).not.toHaveBeenCalled();
  });

  it("does not expose an upstream HTTP200 SSE error message in the public error body", async () => {
    const marker = "UPSTREAM_PRIVATE_FIXTURE_8f19_ONLY";
    const raw = sse([{ type: "error", error: { message: marker, code: "private_fixture_code" } }]) + chatSSE();
    const { result, json } = await runCoreResponse(raw, { provider: "openai", source: FORMATS.CLAUDE, contentType: "text/event-stream" });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(json.error.code).toBe("invalid_upstream_response");
    expect(JSON.stringify(json)).not.toContain(marker);
    expect(result.error).not.toContain(marker);
    expect(coreMocks.success).not.toHaveBeenCalled();
    expect(coreMocks.usage).not.toHaveBeenCalled();
  });

  it.each([null, 7].flatMap(block => [
    { label: `Claude ${JSON.stringify(block)}`, source: FORMATS.CLAUDE, provider: "anthropic-compatible-fixture", response: { ...claudeResult, content: [block] } },
    { label: `Responses ${JSON.stringify(block)}`, source: FORMATS.OPENAI_RESPONSES, provider: "openai-compatible-responses-fixture", response: { ...responsesResult, output: [block] } },
    { label: `Gemini ${JSON.stringify(block)}`, source: FORMATS.GEMINI, provider: "gemini", response: { ...geminiResult, candidates: [{ content: { role: "model", parts: [block] }, finishReason: "STOP" }] } },
  ]))("rejects a malformed native block entry ($label) before success", async ({ source, provider, response }) => {
    const { result } = await runCoreResponse(response, { source, provider });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(coreMocks.success).not.toHaveBeenCalled();
    expect(coreMocks.usage).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Chat ping-only", provider: "openai", response: 'data: {"type":"ping"}\n\n' },
    { label: "Chat malformed data", provider: "openai", response: `data: not-json\n\n${chatSSE()}` },
    { label: "Chat missing terminal", provider: "openai", response: 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n' },
    { label: "Responses missing terminal", provider: "codex", response: sse([{ type: "response.created", response: { id: "resp_partial" } }]) },
    { label: "Responses malformed terminal", provider: "codex", response: sse([{ type: "response.completed" }]) },
    { label: "Responses empty terminal envelope", provider: "codex", response: sse([{ type: "response.completed", response: {} }]) },
    { label: "Responses missing identity", provider: "codex", response: sse([{ type: "response.completed", response: { status: "completed", output: [] } }]) },
    { label: "Responses conflicting event and data type", provider: "codex", response: `event: response.completed\ndata: ${JSON.stringify({ type: "response.failed", response: responsesResult })}\n\n` },
    { label: "Responses failed", provider: "codex", response: sse([{ type: "response.failed", response: { status: "failed", error: { message: "upstream failed" } } }]) },
  ])("rejects $label SSE before success", async ({ provider, response }) => {
    const { result } = await runCoreResponse(response, { provider, source: FORMATS.CLAUDE, contentType: "text/event-stream" });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(coreMocks.success).not.toHaveBeenCalled();
    expect(coreMocks.usage).not.toHaveBeenCalled();
  });

  it("preserves rich native Responses output instead of flattening it through Chat", async () => {
    const response = structuredClone(responsesResult);
    response.output.push({ type: "web_search_call", id: "ws_fixture", status: "completed", action: { type: "search", query: "fixture" } });
    response.output.push({ type: "custom_tool_call", id: "ctc_native", call_id: "call_native", name: "exec", input: rawInput });
    const { result, json } = await runCoreResponse(sse([
      { type: "response.output_item.done", output_index: 2, item: response.output[2] },
      { type: "response.completed", response },
    ]), { provider: "codex", contentType: "text/event-stream" });
    expect(result.success).toBe(true);
    expect(json.output).toEqual(response.output);
    expect(json.model).toBe(response.model);
    expect(json.usage).toEqual(response.usage);
  });

  it("recovers omitted terminal metadata and output from known Responses created/item events", async () => {
    const response = new Response(sse([
      { type: "response.created", response: { ...responsesResult, status: "in_progress", output: [] } },
      ...responsesResult.output.map((item, output_index) => ({ type: "response.output_item.done", item, output_index })),
      { type: "response.completed", response: { id: responsesResult.id, status: "completed", usage: responsesResult.usage } },
    ]));
    expect(await convertResponsesStreamToJson(response.body)).toMatchObject(responsesResult);
  });

  it("preserves native Responses JSON fields and output while keeping the existing usage buffer", async () => {
    const response = { ...responsesResult, metadata: { fixture: "native" }, output: [
      ...responsesResult.output,
      { type: "custom_tool_call", id: "ctc_native", call_id: "call_native", name: "exec", input: rawInput },
      { type: "web_search_call", id: "ws_native", status: "completed", action: { type: "search", query: "fixture" } },
    ] };
    const { result, json } = await runCoreResponse(response, { provider: "openai-compatible-responses-fixture" });
    expect(result.success).toBe(true);
    expect(json).toEqual({ ...response, usage: { ...response.usage, input_tokens: 2010, total_tokens: 2015 } });
  });

  it.each(["queued", "in_progress"])("preserves explicitly requested native background Responses JSON (%s)", async (status) => {
    const response = { ...responsesResult, status, background: true, output: [], usage: null };
    const { result, json } = await runCoreResponse(response, { provider: "openai-compatible-responses-fixture", background: true });
    expect(coreMocks.execute.mock.calls[0][0].body.background).toBe(true);
    expect(result.success).toBe(true);
    expect(json).toEqual(response);
  });

  it("rejects a pending Responses envelope when the native client did not request a background job", async () => {
    const response = { ...responsesResult, status: "in_progress", background: true, output: [], usage: null };
    const { result } = await runCoreResponse(response, { provider: "openai-compatible-responses-fixture" });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(coreMocks.success).not.toHaveBeenCalled();
  });

  it("keeps a native Gemini JSON response free of Chat compatibility fields", async () => {
    const { result, json } = await runCoreResponse(geminiResult, { provider: "gemini", source: FORMATS.GEMINI });
    expect(result.success).toBe(true);
    expect(json).toEqual(geminiResult);
  });

  it("uses a Gemini stop reason when a Gemini JSON client is routed through Chat", async () => {
    const { result, json } = await runCoreResponse(chatResult, { source: FORMATS.GEMINI });
    expect(result.success).toBe(true);
    expect(json.candidates[0].finishReason).toBe("STOP");
    expect(json.candidates[0].content.parts).toContainEqual({ functionCall: { id: "call_exec", name: "exec", args: toolArgs } });
    expect(json).not.toHaveProperty("object");
  });

  it.each(["max_output_tokens", "content_filter"])("preserves legitimate incomplete Responses terminal (%s)", async (reason) => {
    const response = { ...responsesResult, status: "incomplete", incomplete_details: { reason }, output: [] };
    const { result, json } = await runCoreResponse(sse([{ type: "response.incomplete", response }]), { provider: "codex", contentType: "text/event-stream" });
    expect(result.success).toBe(true);
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details).toEqual({ reason });
    expect(json.output).toEqual([]);
  });

  it("maps a legitimate Responses token limit to Claude max_tokens even with empty content", async () => {
    const response = { ...responsesResult, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] };
    const { result, json } = await runCoreResponse(sse([{ type: "response.incomplete", response }]), { provider: "codex", source: FORMATS.CLAUDE, contentType: "text/event-stream" });
    expect(result.success).toBe(true);
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("max_tokens");
    expect(json.content.every(block => block.type === "text" && block.text === "")).toBe(true);
  });

  it("handles valid JSON when a forced-stream provider returns JSON to a JSON client", async () => {
    const { result, json } = await runCoreResponse(chatResult, { provider: "openai", source: FORMATS.CLAUDE });
    expect(result.success).toBe(true);
    expect(json.type).toBe("message");
    expect(json.content).toContainEqual({ type: "tool_use", id: "call_exec", name: "exec", input: toolArgs });
  });

  it("retains the token-limit result when Claude has no content for a Responses client", async () => {
    const { result, json } = await runCoreResponse({ ...claudeResult, content: null, stop_reason: "max_tokens" }, { provider: "anthropic-compatible-fixture" });
    expect(result.success).toBe(true);
    expect(json).toMatchObject({ object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
  });

  it("cancels an invalid Responses body rather than leaving the reader open", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: response.completed\ndata: not-json\n\n')); },
      cancel,
    });
    await expect(convertResponsesStreamToJson(stream)).rejects.toMatchObject({ name: "InvalidResponseError", status: 502, code: "invalid_upstream_response" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it("returns a typed 502 when the standalone Responses handler cannot collect its SSE fallback", async () => {
    const core = vi.spyOn(chatCore, "handleChatCore").mockResolvedValue({
      success: true,
      response: new Response(sse([{ type: "response.created", response: { id: "resp_partial" } }]), { headers: { "Content-Type": "text/event-stream" } }),
    });
    try {
      const result = await handleResponsesCore({ body: { model: "fixture-model", input: "hello", stream: false } });
      expect(result).toMatchObject({ success: false, status: 502, code: "invalid_upstream_response" });
      expect(result.error).toMatch(/^Invalid upstream response:/);
    } finally {
      core.mockRestore();
    }
  });

  it.each(["completed", "failed", "incomplete"])("preserves already encoded Responses %s SSE at the standalone handler boundary", async (status) => {
    const response = { ...responsesResult, status,
      ...(status === "failed" ? { error: { code: "server_error", message: "fixture failure" } } : {}),
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    };
    const raw = sse([{ type: `response.${status}`, response }]);
    const coreResult = { success: true, response: new Response(raw, { headers: { "Content-Type": "text/event-stream" } }) };
    const core = vi.spyOn(chatCore, "handleChatCore").mockResolvedValue(coreResult);
    try {
      const result = await handleResponsesCore({ body: { model: "fixture-model", input: "hello", stream: true } });
      expect(result).toBe(coreResult);
      expect(await result.response.text()).toBe(raw);
    } finally {
      core.mockRestore();
    }
  });

  it("requires Claude array content but accepts the empty streaming-start envelope", () => {
    expect(validateResponseEnvelope({ ...claudeResult, content: [], stop_reason: null }, FORMATS.CLAUDE)).toBe(FORMATS.CLAUDE);
    expect(() => validateResponseEnvelope({ ...claudeResult, content: null }, FORMATS.CLAUDE)).toThrow();
    expect(() => validateResponseEnvelope({ ...claudeResult, content: undefined }, FORMATS.CLAUDE)).toThrow();
  });

  it("preserves rich Claude-native content and legitimate empty/token-limit Messages", async () => {
    const rich = { ...claudeResult, content: [...claudeResult.content, { type: "redacted_thinking", data: "opaque-fixture" }] };
    const first = await runCoreResponse(rich, { provider: "anthropic-compatible-fixture", source: FORMATS.CLAUDE });
    expect(first.json.content).toEqual(rich.content);
    expect(first.json.stop_reason).toBe("tool_use");
    for (const content of [[], null]) {
      coreMocks.execute.mockClear();
      const empty = { ...claudeResult, content, stop_reason: "max_tokens" };
      const { result, json } = await runCoreResponse(empty, { provider: "anthropic-compatible-fixture", source: FORMATS.CLAUDE });
      expect(result.success).toBe(true);
      expect(json.type).toBe("message");
      expect(json.stop_reason).toBe("max_tokens");
      expect(json.content).toEqual(content ?? []);
    }
    const compatibilityBody = { ...claudeResult, content: null, stop_reason: "max_tokens" };
    const normalized = translateNonStreamingResponse(compatibilityBody, FORMATS.CLAUDE, FORMATS.CLAUDE);
    expect(normalized.content).toEqual([]);
    expect(compatibilityBody.content).toBeNull();
  });
});
