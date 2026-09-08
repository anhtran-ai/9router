import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState, translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ToolCompatibilityError } from "../../open-sse/translator/concerns/hostedToolPolicy.js";

const EXEC_TOOL = {
  type: "custom",
  name: "exec",
  description: "Run JavaScript code to orchestrate tool calls.",
  format: {
    type: "grammar",
    syntax: "lark",
    definition: "start: /(.|\\n)+/",
  },
};

describe("native Chat custom tools at the shared Responses request boundary", () => {
  // Executors may call this converter after Chat-to-Chat translation. It must
  // reject here too until their response paths can return native custom calls.
  it.each([
    { type: "text" },
    { type: "grammar", grammar: { syntax: "lark", definition: EXEC_TOOL.format.definition } },
    { type: "grammar", grammar: { syntax: "regex", definition: "[a-z]+" } },
  ])("rejects Responses conversion but preserves Chat custom format %j", (format) => {
    const rawInput = "const value = `raw`;\nreturn value;";
    const body = {
      messages: [
        { role: "user", content: "run" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_custom", type: "custom", custom: { name: "exec", input: rawInput } }] },
        { role: "tool", tool_call_id: "call_custom", content: "raw" },
        { role: "user", content: "continue" },
      ],
      tools: [{ type: "custom", custom: { name: "exec", description: "raw input", format } }],
      tool_choice: { type: "custom", custom: { name: "exec" } },
      parallel_tool_calls: false,
    };
    expect(() => openaiToOpenAIResponsesRequest("test-model", structuredClone(body), false, null))
      .toThrow(ToolCompatibilityError);
    const chat = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "test-model", structuredClone(body), false, null, "openai");
    expect(chat.tools).toEqual(body.tools);
    expect(chat.tool_choice).toEqual(body.tool_choice);
    expect(chat.messages[1].tool_calls).toEqual(body.messages[1].tool_calls);
  });

  it("rejects native Chat custom history even without a current declaration", () => {
    expect(() => openaiToOpenAIResponsesRequest("test-model", {
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_custom", type: "custom", custom: { name: "exec", input: "raw\ninput" } }] },
        { role: "tool", tool_call_id: "call_custom", content: "result" },
        { role: "user", content: "continue" },
      ],
    }, false)).toThrow(ToolCompatibilityError);
  });

  it("leaves an already-native Responses request on its existing passthrough path", () => {
    const body = {
      input: [{ type: "message", role: "user", content: "run" }],
      tools: [EXEC_TOOL],
      tool_choice: { type: "custom", name: "exec" },
    };
    expect(openaiToOpenAIResponsesRequest("test-model", body, true, null))
      .toEqual({ ...body, model: "test-model", stream: true });
  });
});

describe("OpenAI Chat function declarations at the shared Responses request boundary", () => {
  const functionTool = (name) => ({
    type: "function",
    function: {
      name,
      description: "Run a test function",
      parameters: { type: "object", properties: {} },
    },
  });

  const forcedFunction = (name) => ({ type: "function", function: { name } });

  const convert = (tools, toolChoice) => openaiToOpenAIResponsesRequest("test-model", {
    messages: [{ role: "user", content: "run" }],
    tools,
    tool_choice: toolChoice,
  }, false, null);

  it("rejects a forced selector whose blank function declaration is removed", () => {
    expect(() => convert([functionTool("   ")], forcedFunction("   ")))
      .toThrow(ToolCompatibilityError);
  });

  it("clamps a long function name consistently in its declaration and forced selector", () => {
    const longName = `tool_${"x".repeat(140)}`;
    const expectedName = longName.slice(0, 128);
    const out = convert([functionTool(longName)], forcedFunction(longName));

    expect(out.tools).toHaveLength(1);
    expect(out.tools[0].name).toBe(expectedName);
    expect(out.tool_choice).toEqual({ type: "function", name: expectedName });
  });

  it("rejects distinct function names that collide after the 128-character clamp", () => {
    const commonPrefix = "x".repeat(128);
    const first = `${commonPrefix}a`;
    const second = `${commonPrefix}b`;

    expect(() => convert(
      [functionTool(first), functionTool(second)],
      forcedFunction(first),
    )).toThrow(ToolCompatibilityError);
  });
});

describe("Codex Responses Lite custom tools → OpenAI Chat", () => {
  it("promotes additional_tools custom declarations into Chat tools", () => {
    const out = openaiResponsesToOpenAIRequest("cx/gpt-5.6-sol", {
      input: [
        { type: "additional_tools", role: "developer", tools: [EXEC_TOOL] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Run pwd" }] },
      ],
      tool_choice: "auto",
    }, true, null);

    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]).toMatchObject({
      type: "function",
      function: {
        name: "exec",
        parameters: {
          type: "object",
          required: ["input"],
          properties: { input: { type: "string" } },
        },
      },
    });
    expect(out._customToolNames).toEqual(["exec"]);
    expect(out.messages.some((message) => message.role === "developer")).toBe(false);
  });

  it("translates custom tool call/output history into Chat assistant/tool messages", () => {
    const program = "const result = await tools.shell({command: 'pwd'});\nreturn result;";
    const out = openaiResponsesToOpenAIRequest("cx/gpt-5.6-sol", {
      input: [
        { type: "additional_tools", role: "developer", tools: [EXEC_TOOL] },
        { type: "custom_tool_call", call_id: "call_exec_1", name: "exec", input: program },
        { type: "custom_tool_call_output", call_id: "call_exec_1", output: "/srv/app" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    }, true, null);

    const assistant = out.messages.find((message) => message.role === "assistant");
    expect(assistant.tool_calls[0]).toMatchObject({
      id: "call_exec_1",
      type: "function",
      function: { name: "exec" },
    });
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ input: program });
    expect(out.messages.find((message) => message.role === "tool")).toEqual({
      role: "tool",
      tool_call_id: "call_exec_1",
      content: "/srv/app",
    });
  });

  it("merges additional_tools with normal top-level function tools", () => {
    const out = openaiResponsesToOpenAIRequest("cx/gpt-5.6-sol", {
      input: [{ type: "additional_tools", role: "developer", tools: [EXEC_TOOL] }],
      tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }],
    }, true, null);

    expect(out.tools.map((tool) => tool.function.name)).toEqual(["search", "exec"]);
    expect(out._customToolNames).toEqual(["exec"]);
  });
});

describe("OpenAI Chat stream → Codex custom_tool_call", () => {
  it("unwraps the Chat input parameter and emits custom-tool events", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.customToolNames = new Set(["exec"]);
    const chunks = [
      {
        id: "chatcmpl-custom",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_exec_2", type: "function", function: { name: "exec", arguments: "" } }] }, finish_reason: null }],
      },
      {
        id: "chatcmpl-custom",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"input\":\"const x = await tools.shell({command: 'pwd'});\"}" } }] }, finish_reason: null }],
      },
      { id: "chatcmpl-custom", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const added = events.find((event) => event.event === "response.output_item.added");
    const delta = events.find((event) => event.event === "response.custom_tool_call_input.delta");
    const done = events.find((event) => event.event === "response.output_item.done");

    expect(added.data.item).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_exec_2",
      name: "exec",
      input: "",
    });
    expect(delta.data.delta).toBe("const x = await tools.shell({command: 'pwd'});");
    expect(done.data.item).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_exec_2",
      name: "exec",
      input: "const x = await tools.shell({command: 'pwd'});",
    });
    expect(events.some((event) => event.event === "response.function_call_arguments.delta")).toBe(false);
  });

  it("waits for the function name when id and name arrive in separate chunks", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.customToolNames = new Set(["exec"]);
    const chunks = [
      { id: "chatcmpl-split", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_split", type: "function", function: { arguments: "" } }] }, finish_reason: null }] },
      { id: "chatcmpl-split", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "exec", arguments: "{\"input\":\"return 1;\"}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-split", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const added = events.filter((event) => event.event === "response.output_item.added");
    expect(added).toHaveLength(1);
    expect(added[0].data.item).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_split",
      name: "exec",
    });
  });

  it("leaves normal Chat tool calls as Responses function_call events", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.customToolNames = new Set(["exec"]);
    const events = [
      { id: "chatcmpl-normal", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_search", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-normal", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ].flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));

    expect(events.find((event) => event.event === "response.output_item.added").data.item.type).toBe("function_call");
    expect(events.find((event) => event.event === "response.output_item.done").data.item).toMatchObject({
      type: "function_call",
      name: "search",
      arguments: "{\"q\":\"x\"}",
    });
  });

  it("assigns unique stable output indexes to reasoning, text, and parallel tools", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = [
      { id: "chatcmpl-indexes", choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] },
      { id: "chatcmpl-indexes", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] },
      { id: "chatcmpl-indexes", choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "call_a", type: "function", function: { name: "first", arguments: "{\"a\":1}" } },
        { index: 1, id: "call_b", type: "function", function: { name: "second", arguments: "{\"b\":2}" } },
      ] }, finish_reason: null }] },
      { id: "chatcmpl-indexes", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const added = events.filter((event) => event.event === "response.output_item.added");
    expect(added.map((event) => event.data.output_index)).toEqual([0, 1, 2, 3]);
    expect(new Set(added.map((event) => event.data.output_index)).size).toBe(added.length);

    const indexById = new Map(added.map((event) => [event.data.item.id, event.data.output_index]));
    for (const event of events) {
      const itemId = event.data.item_id || event.data.item?.id;
      if (itemId && indexById.has(itemId) && event.data.output_index !== undefined) {
        expect(event.data.output_index).toBe(indexById.get(itemId));
      }
    }

    const completed = events.find((event) => event.event === "response.completed");
    expect(completed.data.response.output.map((item) => item.id)).toEqual(added.map((event) => event.data.item.id));
  });
});
