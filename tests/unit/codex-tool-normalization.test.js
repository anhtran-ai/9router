import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

function normalizeTools(tools) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools,
    stream: true,
  };

  executor.transformRequest("gpt-5.5", body, true, {
    connectionId: "test-codex-tools",
    providerSpecificData: {},
  });

  return body.tools;
}

describe("CodexExecutor tool normalization", () => {
  it("strips only content from Codex CLI additional_tools input items", () => {
    const executor = new CodexExecutor();
    const additionalToolsItem = {
      type: "additional_tools",
      role: "developer",
      content: [{ type: "input_text", text: "Unsupported by Codex OAuth." }],
      tools: [{ type: "namespace", name: "functions", tools: [] }],
      metadata: { source: "codex-cli-0.147" },
    };
    const unknownItem = {
      type: "future_item",
      content: [{ type: "input_text", text: "Keep this untouched." }],
    };
    const userItem = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Reply with OK only." }],
    };
    const body = {
      model: "gpt-5.6-luna",
      input: [additionalToolsItem, unknownItem, userItem],
    };

    executor.transformRequest("gpt-5.6-luna", body, true, {
      connectionId: "test-codex-additional-tools-content",
      providerSpecificData: {},
    });

    expect(body.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "namespace", name: "functions", tools: [] }],
        metadata: { source: "codex-cli-0.147" },
      },
      unknownItem,
      userItem,
    ]);
  });

  it("ignores null and malformed Responses input items", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.6-luna",
      input: [null, "raw-item", [], { type: "additional_tools", content: null, tools: [] }],
    };

    expect(() => executor.transformRequest("gpt-5.6-luna", body, true, {
      connectionId: "test-codex-malformed-input",
      providerSpecificData: {},
    })).not.toThrow();

    expect(body.input).toEqual([null, "raw-item", [], { type: "additional_tools", tools: [] }]);
  });

  it("hoists Codex CLI 0.147 developer input into instructions", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.6-luna",
      instructions: "Base instructions.",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "namespace", name: "functions", tools: [] }],
        },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Follow workspace rules." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Reply with OK only." }],
        },
      ],
      stream: true,
      store: false,
    };

    executor.transformRequest("gpt-5.6-luna", body, true, {
      connectionId: "test-codex-cli-0147",
      providerSpecificData: {},
    });

    expect(body.instructions).toBe("Base instructions.\n\nFollow workspace rules.");
    expect(body.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "namespace", name: "functions", tools: [] }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with OK only." }],
      },
    ]);
  });

  it("leaves unsupported developer content for upstream validation", () => {
    const executor = new CodexExecutor();
    const developerItem = {
      type: "message",
      role: "developer",
      content: [{ type: "input_image", image_url: "https://example.com/rules.png" }],
    };
    const body = {
      model: "gpt-5.6-luna",
      input: [developerItem, { role: "user", content: "Hello" }],
    };

    executor.transformRequest("gpt-5.6-luna", body, true, {
      connectionId: "test-codex-developer-validation",
      providerSpecificData: {},
    });

    expect(body.input[0]).toEqual(developerItem);
  });

  it("preserves Responses text.format for structured outputs", () => {
    const executor = new CodexExecutor();
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    };
    const body = {
      model: "gpt-5.4-mini",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "test for session title" }] }],
      stream: true,
      metadata: { unsupported: true },
      text: {
        format: {
          type: "json_schema",
          name: "codex_output_schema",
          strict: true,
          schema,
        },
      },
    };

    executor.transformRequest("gpt-5.4-mini", body, true, {
      connectionId: "test-codex-structured-output",
      providerSpecificData: {},
    });

    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: "codex_output_schema",
        strict: true,
        schema,
      },
    });
    expect(body.metadata).toBeUndefined();
  });

  it("preserves Responses-native tool_search tools", () => {
    const tools = normalizeTools([
      {
        type: "tool_search",
        execution: "sync",
        description: "Discover deferred tools",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "namespace",
        name: "codex_app",
        description: "app tools",
        tools: [
          {
            type: "function",
            name: "automation_update",
            description: "automation",
            parameters: { type: "object", properties: {} },
            defer_loading: true,
          },
        ],
      },
      {
        type: "function",
        name: "plain_fn",
        description: "plain",
        parameters: { type: "object", properties: {} },
      },
    ]);

    expect(tools.map((tool) => `${tool.type}:${tool.name || ""}`)).toEqual([
      "tool_search:",
      "namespace:codex_app",
      "function:plain_fn",
    ]);
  });

  it("preserves hosted Responses tools", () => {
    const tools = normalizeTools([
      { type: "web_search", search_context_size: "medium" },
      { type: "image_generation", size: "1024x1024" },
      { type: "mcp", server_label: "docs", server_url: "https://example.com/mcp" },
      { type: "local_shell" },
      { type: "code_interpreter", container: { type: "auto" } },
      { type: "computer", display_width: 1024, display_height: 768, environment: "browser" },
    ]);

    expect(tools.map((tool) => tool.type)).toEqual([
      "web_search",
      "image_generation",
      "mcp",
      "local_shell",
      "code_interpreter",
      "computer",
    ]);
  });

  it("preserves custom freeform tools with format payloads", () => {
    const tools = normalizeTools([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);

    expect(tools).toEqual([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);
  });
});

describe("CodexExecutor cross-provider hosted tools", () => {
  it("normalizes Claude CLI and OpenAI Platform aliases for Codex OAuth", () => {
    const tools = normalizeTools([
      { type: "web_search_preview", search_context_size: "medium", max_uses: 5 },
      { type: "computer_use_preview", display_width: 1024, display_height: 768 },
      { type: "code_execution_20250522", name: "code_execution" },
      { type: "tool_search_tool_regex_20251119", name: "tool_search" },
    ]);

    expect(tools).toEqual([
      { type: "web_search", search_context_size: "medium" },
      { type: "computer", display_width: 1024, display_height: 768 },
      { type: "code_interpreter" },
      { type: "tool_search" },
    ]);
  });

  it("collapses aliases of one capability into a single Codex tool", () => {
    const tools = normalizeTools([
      { type: "web_search_preview", search_context_size: "medium" },
      { type: "web_search_20260209", name: "web_search", allowed_domains: ["example.com"] },
      { type: "web_search" },
    ]);

    expect(tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
  });

  it("drops Anthropic-only hosted tools instead of leaking invalid Codex types", () => {
    const tools = normalizeTools([
      { type: "web_fetch_20250910", name: "web_fetch" },
      { type: "bash_20250124", name: "bash" },
      { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
      { type: "memory_20250818", name: "memory" },
      { type: "mcp_toolset", name: "project_tools" },
      { type: "function", name: "keep_me", parameters: { type: "object" } },
    ]);

    expect(tools).toEqual([
      { type: "function", name: "keep_me", parameters: { type: "object" } },
    ]);
  });
});

describe("CodexExecutor hosted tool choice", () => {
  it("deduplicates aliases and rewrites a forced hosted tool choice", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "search" }] }],
      tools: [
        { type: "web_search_preview" },
        { type: "web_search_20260209", name: "web_search" },
      ],
      tool_choice: { type: "web_search_preview" },
      stream: true,
    };

    executor.transformRequest("gpt-5.6-sol", body, true, {
      connectionId: "test-codex-hosted-tool-choice",
      providerSpecificData: {},
    });

    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toEqual({ type: "web_search" });
  });

  it("drops a forced hosted tool choice when the tool has no Codex equivalent", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fetch" }] }],
      tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
      tool_choice: { type: "web_fetch_20250910" },
      stream: true,
    };

    executor.transformRequest("gpt-5.6-sol", body, true, {
      connectionId: "test-codex-unsupported-hosted-tool-choice",
      providerSpecificData: {},
    });

    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBeUndefined();
  });
});
