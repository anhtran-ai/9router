import { describe, expect, it } from "vitest";
import "./registerAll.js";

import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { ToolCompatibilityError } from "../../open-sse/translator/concerns/hostedToolPolicy.js";

const CLAUDE_CLI_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  { type: "function", name: "Bash", description: "run", input_schema: { type: "object", properties: {} } },
];
const LITELLM_RESPONSES_TOOLS = [
  { type: "web_search_preview" },
  { type: "function", name: "Bash", parameters: { type: "object", properties: {} } },
];

function toCodex(tools, toolChoice) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools: structuredClone(tools),
    ...(toolChoice === undefined ? {} : { tool_choice: structuredClone(toolChoice) }),
    stream: true,
  };
  executor.transformRequest("gpt-5.6-sol", body, true, {
    connectionId: "matrix",
    providerSpecificData: {},
  });
  return body;
}

function toClaude(sourceFormat, body) {
  return translateRequest(
    sourceFormat,
    FORMATS.CLAUDE,
    "claude-opus-5",
    structuredClone(body),
    true,
    null,
    "claude",
  );
}

function toChat(tools, toolChoice, sourceFormat = FORMATS.OPENAI_RESPONSES) {
  return translateRequest(sourceFormat, FORMATS.OPENAI, "gpt-4o", {
    ...(sourceFormat === FORMATS.OPENAI
      ? { messages: [{ role: "user", content: "probe" }] }
      : { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }] }),
    tools: structuredClone(tools),
    tool_choice: structuredClone(toolChoice),
  }, true, null, "openai");
}

describe("hosted tool matrix across CLIs, models and combos", () => {
  it("rejects a Claude CLI per-tool search limit that Codex cannot preserve", () => {
    expect(() => toCodex(CLAUDE_CLI_TOOLS)).toThrow(ToolCompatibilityError);
  });

  it("unconstrained Claude CLI tool aliases reach a GPT model as Codex-native types", () => {
    const body = toCodex([{ type: "web_search_20250305", name: "web_search" }, CLAUDE_CLI_TOOLS[1]]);
    expect(body.tools).toEqual([
      { type: "web_search" },
      { type: "function", name: "Bash", description: "run", parameters: { type: "object", properties: {} } },
    ]);
  });

  it("preserves Claude domain and parallel constraints through translation and the actual Codex executor", () => {
    const original = {
      model: "gpt-5.6-sol", max_tokens: 128, messages: [{ role: "user", content: "probe" }],
      tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["docs.example.invalid"] }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    };
    const body = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "gpt-5.6-sol", structuredClone(original), true, null, "codex");
    new CodexExecutor().transformRequest("gpt-5.6-sol", body, true, { connectionId: "matrix", providerSpecificData: {} });
    expect(body.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["docs.example.invalid"] } }]);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toBe("auto");
    expect(original.tools[0].allowed_domains).toEqual(["docs.example.invalid"]);
  });

  it.each([
    { tools: [{ type: "bash_20250124", name: "bash" }, { name: "lookup", input_schema: { type: "object" } }], choice: { type: "tool", name: "bash" } },
    { tools: [{ type: "bash_20250124", name: "bash" }], choice: { type: "any" } },
  ])("rejects a Claude constraint lost by final Codex filtering: $choice", ({ tools, choice }) => {
    const body = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "gpt-5.6-sol", {
      model: "gpt-5.6-sol", max_tokens: 128, messages: [{ role: "user", content: "probe" }], tools, tool_choice: choice,
    }, true, null, "codex");
    expect(() => new CodexExecutor().transformRequest("gpt-5.6-sol", body, true, { connectionId: "matrix", providerSpecificData: {} }))
      .toThrow(ToolCompatibilityError);
  });

  it.each([true, false])("preserves native Responses parallel_tool_calls=%s after final Codex filtering", (parallel_tool_calls) => {
    const body = { model: "gpt-5.6-sol", input: "probe", tools: LITELLM_RESPONSES_TOOLS, parallel_tool_calls };
    new CodexExecutor().transformRequest("gpt-5.6-sol", body, true, { connectionId: "matrix", providerSpecificData: {} });
    expect(body.parallel_tool_calls).toBe(parallel_tool_calls);
  });

  it("Codex CLI / LiteLLM Responses tools reach a Claude model as dated types", () => {
    const result = toClaude(FORMATS.OPENAI_RESPONSES, {
      model: "claude-opus-5",
      max_tokens: 128,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
      tools: LITELLM_RESPONSES_TOOLS,
    });

    expect(result.tools).toEqual([
      { type: "web_search_20250305", name: "web_search" },
      {
        name: "Bash",
        description: "",
        input_schema: { type: "object", properties: {} },
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  it("Claude CLI tools stay native when the combo routes back to a Claude model", () => {
    const result = toClaude(FORMATS.OPENAI, {
      model: "claude-opus-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "probe" }],
      tools: CLAUDE_CLI_TOOLS,
    });

    expect(result.tools[0]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
    expect(result.tools[1].name).toBe("Bash");
  });

  it("a combo request survives both legs with only function tools left when hosted support is absent", () => {
    const anthropicOnly = [
      { type: "web_fetch_20250910", name: "web_fetch" },
      { type: "function", name: "Bash", parameters: { type: "object", properties: {} } },
    ];

    expect(toCodex(anthropicOnly).tools).toEqual([
      { type: "function", name: "Bash", parameters: { type: "object", properties: {} } },
    ]);

    const claudeLeg = toClaude(FORMATS.OPENAI, {
      model: "claude-opus-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "probe" }],
      tools: anthropicOnly,
    });
    expect(claudeLeg.tools.map((tool) => tool.type ?? tool.name)).toEqual(["web_fetch_20250910", "Bash"]);
  });

  it("forced hosted tool choice is rewritten per target", () => {
    const codex = toCodex(LITELLM_RESPONSES_TOOLS, { type: "web_search_preview" });
    expect(codex.tool_choice).toEqual({ type: "web_search" });

    const claude = toClaude(FORMATS.OPENAI, {
      model: "claude-opus-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "probe" }],
      tools: LITELLM_RESPONSES_TOOLS,
      tool_choice: { type: "function", function: { name: "Bash" } },
    });
    expect(claude.tool_choice).toEqual({ type: "tool", name: "Bash" });
  });

  // #31: the OpenAI pivot can contain hosted tools, the final Chat API cannot.
  it.each([
    { type: "web_search_preview" },
    { type: "web_search_20250305", name: "web_search", max_uses: 1 },
    { type: "file_search", vector_store_ids: ["vs_test"] },
    { type: "code_interpreter", container: { type: "auto" } },
    { type: "mcp", server_label: "docs", server_url: "https://example.invalid/mcp" },
    { type: "tool_search", execution: "client", description: "discover", parameters: { type: "object" } },
  ])("removes hosted declaration and choice at the final Chat boundary: $type", (hosted) => {
    const result = toChat([hosted], { type: hosted.type });
    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
  });

  it("retains functions but disables unrelated calls when a forced hosted tool is removed", () => {
    const result = toChat(LITELLM_RESPONSES_TOOLS, { type: "web_search_preview" });
    expect(result.tools).toEqual([{
      type: "function",
      function: { name: "Bash", description: "", parameters: { type: "object", properties: {} }, strict: undefined },
    }]);
    expect(result.tool_choice).toBe("none");
  });

  it("normalizes the retained Responses function selector for Chat", () => {
    const result = toChat(LITELLM_RESPONSES_TOOLS, { type: "function", name: "Bash" });
    expect(result.tools.map((tool) => tool.type)).toEqual(["function"]);
    expect(result.tool_choice).toEqual({ type: "function", function: { name: "Bash" } });
  });

  it.each(["auto", "required"])("removes %s when no Chat tool remains", (choice) => {
    const result = toChat([{ type: "web_search_preview" }], choice);
    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
  });

  it("keeps native Chat custom tools and their forced selector intact", () => {
    const custom = { type: "custom", custom: { name: "web_search", description: "client search", format: { type: "text" } } };
    const choice = { type: "custom", custom: { name: "web_search" } };
    const result = toChat([custom, ...LITELLM_RESPONSES_TOOLS], choice, FORMATS.OPENAI);
    expect(result.tools[0]).toEqual(custom);
    expect(result.tools.map((tool) => tool.type)).toEqual(["custom", "function"]);
    expect(result.tool_choice).toEqual(choice);
  });

  it("synchronizes allowed_tools with retained Chat declarations", () => {
    const result = toChat(LITELLM_RESPONSES_TOOLS, {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "web_search_preview" }, { type: "function", name: "Bash" }],
    });
    expect(result.tool_choice).toEqual({
      type: "allowed_tools",
      allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "Bash" } }] },
    });
  });

  it.each(["auto", "required"])("does not widen an empty %s allowed subset to unrelated functions", (mode) => {
    const result = toChat(LITELLM_RESPONSES_TOOLS, {
      type: "allowed_tools",
      allowed_tools: { mode, tools: [{ type: "web_search_preview" }] },
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tool_choice).toBe("none");
  });

  it("keeps a Responses custom selector attached to its function wrapper", () => {
    const result = toChat([
      { type: "web_search_preview" }, { type: "custom", name: "echo", format: { type: "text" } },
    ], { type: "custom", name: "echo" });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].function.parameters.properties.input.type).toBe("string");
    expect(result.tool_choice).toEqual({ type: "function", function: { name: "echo" } });
  });

  it("keeps a native Chat allowed_tools subset without widening it", () => {
    const choices = { type: "allowed_tools", allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "Bash" } }] } };
    const result = toChat(LITELLM_RESPONSES_TOOLS, choices);
    expect(result.tool_choice).toEqual(choices);
  });

  it.each(["Bash", "web_search", "echo"])("preserves bare Claude client functions named %s", (name) => {
    const result = toChat([{ name, description: "client tool", input_schema: { type: "object", properties: { query: { type: "string" } } } }], { type: "tool", name }, FORMATS.OPENAI);
    expect(result.tools).toEqual([{
      type: "function", function: { name, description: "client tool", parameters: { type: "object", properties: { query: { type: "string" } } } },
    }]);
    expect(result.tool_choice).toEqual({ type: "function", function: { name } });
  });
});

describe("tool constraints at actual request-format entry points", () => {
  const functions = ["read", "write"].map((name) => ({
    type: "function", function: { name, parameters: { type: "object", properties: {} } },
  }));
  const chat = (tool_choice) => ({ messages: [{ role: "user", content: "probe" }], tools: structuredClone(functions), tool_choice });
  const convert = (source, target, body, model = "test-model") => translateRequest(
    source, target, model, structuredClone(body), false, null, target === FORMATS.CLAUDE ? "claude" : target,
  );
  const responseBody = (tool_choice, tools = functions.map(({ function: fn }) => ({ type: "function", ...fn }))) => ({
    input: [{ role: "user", content: "probe" }], tools, tool_choice,
  });

  it.each([
    [FORMATS.OPENAI_RESPONSES, "none"],
    [FORMATS.CLAUDE, { type: "none" }],
    [FORMATS.GEMINI, { functionCallingConfig: { mode: "NONE" } }],
    [FORMATS.GEMINI_CLI, { functionCallingConfig: { mode: "NONE" } }],
  ])("does not enable tools when Chat none targets %s", (target, expected) => {
    const converted = convert(FORMATS.OPENAI, target, chat("none"));
    const out = converted.request || converted;
    expect(out.tools.length).toBeGreaterThan(0);
    expect(out.tool_choice ?? out.toolConfig).toEqual(expected);
  });

  it.each([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY])("keeps required and forced function choices for %s", (target) => {
    const required = convert(FORMATS.OPENAI, target, chat("required"));
    expect((required.request || required).toolConfig.functionCallingConfig).toEqual({ mode: "ANY" });
    const forced = convert(FORMATS.OPENAI, target, chat({ type: "function", function: { name: "read" } }));
    expect((forced.request || forced).toolConfig.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: ["read"] });
  });

  it.each(["auto", "required"])("preserves a Chat %s allowed subset in Responses, Claude and Gemini", (mode) => {
    const body = chat({ type: "allowed_tools", allowed_tools: { mode, tools: [{ type: "function", function: { name: "read" } }] } });
    const responses = convert(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, body);
    expect(responses.tools).toHaveLength(2);
    expect(responses.tool_choice).toEqual({ type: "allowed_tools", mode, tools: [{ type: "function", name: "read" }] });
    const claude = convert(FORMATS.OPENAI, FORMATS.CLAUDE, body);
    expect(claude.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(claude.tool_choice).toEqual({ type: mode === "required" ? "any" : "auto" });
    const gemini = convert(FORMATS.OPENAI, FORMATS.GEMINI, body);
    expect(gemini.toolConfig.functionCallingConfig).toEqual({ mode: mode === "required" ? "ANY" : "VALIDATED", allowedFunctionNames: ["read"] });
  });

  it.each([
    [{ mode: "NONE" }, "none"],
    [{ mode: "ANY", allowedFunctionNames: ["read"] }, { type: "allowed_tools", allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "read" } }] } }],
    [{ mode: "VALIDATED", allowedFunctionNames: ["read"] }, { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [{ type: "function", function: { name: "read" } }] } }],
  ])("preserves native Gemini constraints %j through the Chat pivot", (config, choice) => {
    const out = convert(FORMATS.GEMINI, FORMATS.OPENAI, {
      contents: [{ role: "user", parts: [{ text: "probe" }] }],
      tools: [{ functionDeclarations: functions.map(({ function: fn }) => fn) }],
      toolConfig: { functionCallingConfig: config },
    });
    expect(out.tools).toHaveLength(2);
    expect(out.tool_choice).toEqual(choice);
  });

  it.each(["function", "custom"])("keeps a flat Responses forced %s selector when targeting Claude", (type) => {
    const tools = type === "custom"
      ? [{ type: "custom", name: "echo", format: { type: "text" } }, { type: "function", name: "write", parameters: { type: "object" } }]
      : undefined;
    const name = type === "custom" ? "echo" : "read";
    const out = convert(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, responseBody({ type, name }, tools));
    expect(out.tool_choice).toEqual({ type: "tool", name });
  });

  it("preserves a Responses required subset when targeting Claude", () => {
    const out = convert(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, responseBody({ type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "read" }] }));
    expect(out.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(out.tool_choice).toEqual({ type: "any" });
  });

  it("rejects an unavailable forced tool instead of enabling other tools", () => {
    expect(() => convert(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, responseBody({ type: "custom", name: "read" })))
      .toThrow(ToolCompatibilityError);
  });

  it("does not use a history-only custom name to authorize a current function", () => {
    const body = responseBody({ type: "custom", name: "read" });
    body.input.unshift(
      { type: "custom_tool_call", call_id: "old_read", name: "read", input: "raw" },
      { type: "custom_tool_call_output", call_id: "old_read", output: "ok" },
    );
    expect(() => convert(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, body)).toThrow(ToolCompatibilityError);
    expect(convert(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, body).tool_choice).toBe("none");
  });

  it("does not authorize a missing function by the same-named custom wrapper at the Chat boundary", () => {
    const body = responseBody({ type: "function", name: "read" }, [{ type: "custom", name: "read", format: { type: "text" } }]);
    expect(convert(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, body).tool_choice).toBe("none");
  });

  it("does not widen a selector after Gemini name sanitization collides", () => {
    const body = chat({ type: "function", function: { name: "1read" } });
    body.tools = ["1read", "_1read"].map(name => ({ type: "function", function: { name, parameters: { type: "object" } } }));
    expect(() => convert(FORMATS.OPENAI, FORMATS.GEMINI, body)).toThrow(ToolCompatibilityError);
  });

  it("preserves parallel limits on supported targets and rejects unsupported Gemini limits", () => {
    const body = { ...chat("auto"), parallel_tool_calls: false };
    expect(convert(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, body).parallel_tool_calls).toBe(false);
    expect(convert(FORMATS.OPENAI, FORMATS.CLAUDE, body).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(() => convert(FORMATS.OPENAI, FORMATS.GEMINI, body)).toThrow(ToolCompatibilityError);
  });

  it.each([FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY])("keeps NONE from a native %s request envelope", (source) => {
    const body = { request: {
      contents: [{ role: "user", parts: [{ text: "probe" }] }],
      tools: [{ functionDeclarations: functions.map(({ function: fn }) => fn) }],
      toolConfig: { functionCallingConfig: { mode: "NONE" } },
    } };
    expect(convert(source, FORMATS.OPENAI, body).tool_choice).toBe("none");
  });

  it("keeps disabled tools through the Antigravity Claude envelope", () => {
    const out = convert(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, chat("none"), "claude-sonnet-4-5");
    expect(out.request.toolConfig.functionCallingConfig).toEqual({ mode: "NONE" });
  });

  it("keeps Responses web domain restrictions through the actual Claude pipeline", () => {
    const body = responseBody({ type: "web_search" }, [{
      type: "web_search", filters: { allowed_domains: ["docs.example.invalid"] }, external_web_access: true,
    }]);
    const originalTools = structuredClone(body.tools);
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-sonnet-4-5", body, false, null, "claude");
    expect(out.tools[0]).toMatchObject({ type: "web_search_20250305", name: "web_search", allowed_domains: ["docs.example.invalid"] });
    expect(out.tools[0].filters).toBeUndefined();
    expect(out.tool_choice).toEqual({ type: "tool", name: "web_search" });
    expect(body.tools).toEqual(originalTools);
  });

  it.each([{ external_web_access: false }, { indexed_web_access: false }, { indexed_web_access: true }])("rejects unrepresentable web access constraints through the Claude pipeline: %j", (constraint) => {
    const body = responseBody("auto", [{ type: "web_search", ...constraint }]);
    expect(() => convert(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, body)).toThrow(ToolCompatibilityError);
  });

  it("preserves native Claude none and never invents client functions for hosted declarations", () => {
    const body = {
      messages: [{ role: "user", content: "probe" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1, allowed_domains: ["docs.example.invalid"] },
        { name: "read", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "tool", name: "web_search" },
    };
    const out = convert(FORMATS.CLAUDE, FORMATS.OPENAI, body);
    expect(out.tools.map((tool) => tool.function.name)).toEqual(["read"]);
    expect(out.tool_choice).toBe("none");
    expect(convert(FORMATS.CLAUDE, FORMATS.OPENAI, { ...body, tool_choice: { type: "none" } }).tool_choice).toBe("none");
  });

  it.each(["web_search", "bash"])("keeps an actual Claude client function named %s distinct from hosted tools", (name) => {
    const body = { messages: [{ role: "user", content: "probe" }],
      tools: [{ name, input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "tool", name } };
    const chatOut = convert(FORMATS.CLAUDE, FORMATS.OPENAI, body);
    expect(chatOut.tool_choice).toEqual({ type: "function", function: { name } });
    const responses = convert(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, body);
    expect(responses.tools[0]).toMatchObject({ type: "function", name, parameters: { type: "object" } });
    expect(responses.tool_choice).toEqual({ type: "function", name });
    const gemini = convert(FORMATS.CLAUDE, FORMATS.GEMINI, body);
    expect(gemini.toolConfig.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: [name] });
  });

  it("rejects forced hosted choices removed by a non-native Claude provider's final filter", () => {
    const body = responseBody({ type: "web_search" }, [{ type: "web_search" }, { type: "function", name: "read", parameters: { type: "object" } }]);
    expect(() => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "test-model", body, false, null, "anthropic-compatible-test"))
      .toThrow(ToolCompatibilityError);
    const required = responseBody("required", [{ type: "web_search" }]);
    expect(() => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "test-model", required, false, null, "anthropic-compatible-test"))
      .toThrow(ToolCompatibilityError);
  });

  it.each([FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.KIRO, FORMATS.CURSOR, FORMATS.COMMANDCODE])("rejects native Chat custom declarations/history without a native return path for %s", (target) => {
    const custom = { type: "custom", custom: { name: "web_search", format: { type: "text" } } };
    expect(() => convert(FORMATS.OPENAI, target, { ...chat({ type: "custom", custom: { name: "web_search" } }), tools: [custom] }))
      .toThrow(ToolCompatibilityError);
    expect(() => translateRequest(FORMATS.OPENAI, target, "test-model", { ...chat("required"), tools: [custom] }, true))
      .toThrow(ToolCompatibilityError);
    expect(() => convert(FORMATS.OPENAI, target, { messages: [
      { role: "assistant", tool_calls: [{ id: "call_custom", type: "custom", custom: { name: "echo", input: "raw\ntext" } }] },
      { role: "tool", tool_call_id: "call_custom", content: "ok" },
      { role: "user", content: "continue" },
    ] })).toThrow(ToolCompatibilityError);
    custom.custom.format = { type: "grammar", grammar: { syntax: "regex", definition: "[a-z]+" } };
    expect(() => convert(FORMATS.OPENAI, target, { ...chat("required"), tools: [custom] })).toThrow(ToolCompatibilityError);
  });
});
