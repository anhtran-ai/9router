import { describe, expect, it } from "vitest";

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
});
