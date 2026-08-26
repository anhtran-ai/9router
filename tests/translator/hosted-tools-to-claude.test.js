import { describe, expect, it } from "vitest";

import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

function translate(tools, toolChoice) {
  return openaiToClaudeRequest("claude-opus-5", {
    messages: [{ role: "user", content: "probe" }],
    max_tokens: 64,
    tools,
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  }, true);
}

describe("OpenAI/Responses hosted tools to Claude", () => {
  it("maps LiteLLM web search and Codex computer/code tools", () => {
    const result = translate([
      { type: "web_search_preview", search_context_size: "medium", max_uses: 4 },
      { type: "computer_use_preview", display_width: 1280, display_height: 720 },
      { type: "code_interpreter", container: { type: "auto" } },
    ]);

    expect(result.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 4 },
      {
        type: "computer_20250124",
        name: "computer",
        display_width_px: 1280,
        display_height_px: 720,
        display_number: 1,
      },
      {
        type: "code_execution_20250522",
        name: "code_execution",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  it("keeps native Claude Code dated tools", () => {
    const result = translate([
      { type: "web_search_20260209", name: "web_search", allowed_domains: ["example.com"] },
      { type: "web_fetch_20250910", name: "web_fetch" },
      { type: "bash_20250124", name: "bash" },
      { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
      { type: "computer_20251124", name: "computer", display_width_px: 1440 },
    ]);

    expect(result.tools.map((tool) => tool.type)).toEqual([
      "web_search_20260209",
      "web_fetch_20250910",
      "bash_20250124",
      "text_editor_20250728",
      "computer_20251124",
    ]);
    expect(result.tools.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("drops incompatible hosted tools and their forced tool choice", () => {
    const result = translate([
      { type: "file_search", vector_store_ids: ["vs_1"] },
      { type: "image_generation" },
    ], { type: "tool", name: "file_search" });

    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
  });

  it("keeps function tools and validates forced function choice", () => {
    const valid = translate([
      { type: "function", function: { name: "echo", parameters: { type: "object" } } },
    ], { type: "function", function: { name: "echo" } });
    expect(valid.tools[0].name).toBe("echo");
    expect(valid.tool_choice).toEqual({ type: "tool", name: "echo" });

    const invalid = translate([
      { type: "function", function: { name: "echo", parameters: { type: "object" } } },
    ], { type: "function", function: { name: "missing" } });
    expect(invalid.tool_choice).toEqual({ type: "auto" });
  });
});
