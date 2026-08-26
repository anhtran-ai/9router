import { describe, expect, it } from "vitest";
import "./registerAll.js";

import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

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
  it("Claude CLI tools reach a GPT model as Codex-native types", () => {
    const body = toCodex(CLAUDE_CLI_TOOLS);
    expect(body.tools).toEqual([
      { type: "web_search" },
      { type: "function", name: "Bash", description: "run", parameters: { type: "object", properties: {} } },
    ]);
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
