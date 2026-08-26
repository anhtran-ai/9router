import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { ToolCompatibilityError } from "../../open-sse/translator/concerns/hostedToolPolicy.js";

function normalizeRequest(tools, toolChoice) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools,
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    stream: true,
  };

  executor.transformRequest("gpt-5.5", body, true, {
    connectionId: "test-codex-tools",
    providerSpecificData: {},
  });

  return body;
}

function normalizeTools(tools) {
  return normalizeRequest(tools).tools;
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
    const inputTools = [
      {
        type: "tool_search",
        execution: "client",
        description: "Discover deferred tools",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
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
    ];
    expect(normalizeTools(structuredClone(inputTools))).toEqual(inputTools);
  });

  it("preserves hosted tool search without client fields", () => {
    expect(normalizeTools([{ type: "tool_search" }])).toEqual([{ type: "tool_search" }]);
  });

  it.each(["edit", "generate", "auto"])("preserves native image action %s and its mask", (action) => {
    const tool = {
      type: "image_generation", action,
      input_image_mask: { file_id: "file-synthetic-mask" }, output_format: "png",
    };
    const original = structuredClone(tool);
    expect(normalizeTools([tool])).toEqual([original]);
    expect(tool).toEqual(original);
  });

  it("keeps inline image masks while filtering unrelated image tool fields", () => {
    const input_image_mask = { image_url: "data:image/png;base64,c3ludGhldGlj" };
    expect(normalizeTools([{ type: "image_generation", input_image_mask, unsupported: true }])).toEqual([
      { type: "image_generation", input_image_mask },
    ]);
  });

  it.each([
    { strict: true, defer_loading: true },
    { strict: false, defer_loading: false },
    { strict: null, defer_loading: true },
  ])("keeps flat and nested function flags %j", (flags) => {
    const fn = { name: "lookup", parameters: { type: "object", properties: {} }, ...flags };
    const flat = { type: "function", ...fn };
    const nested = { type: "function", function: structuredClone(fn) };
    expect(normalizeTools([flat])).toEqual([flat]);
    expect(normalizeTools([nested])).toEqual([flat]);
    expect(nested.function).toEqual(fn);
  });

  it("prefers explicit flat function flags, including false, over nested flags", () => {
    expect(normalizeTools([{
      type: "function", strict: false, defer_loading: false,
      function: { name: "lookup", strict: true, defer_loading: true, parameters: { type: "object" } },
    }])).toEqual([{
      type: "function", name: "lookup", parameters: { type: "object" }, strict: false, defer_loading: false,
    }]);
  });

  it.each([true, false])("preserves cache-only web search with indexed_web_access=%s", (indexed) => {
    const tool = {
      type: "web_search",
      external_web_access: false,
      indexed_web_access: indexed,
      filters: { allowed_domains: ["example.com"] },
    };
    expect(normalizeTools([structuredClone(tool)])).toEqual([tool]);
  });

  it("preserves deferred MCP discovery and approval configuration", () => {
    const tool = {
      type: "mcp", server_label: "docs", server_url: "https://example.com/mcp",
      defer_loading: true, allowed_tools: ["search"], require_approval: "always",
    };
    expect(normalizeTools([structuredClone(tool)])).toEqual([tool]);
  });

  it("keeps distinct MCP configurations in order, including repeated labels", () => {
    const tools = [
      { type: "mcp", server_label: "docs", server_url: "https://example.com/docs", allowed_tools: ["search"], require_approval: "always" },
      { type: "mcp", server_label: "issues", server_url: "https://example.com/issues", allowed_tools: ["list"], require_approval: "always" },
      { type: "mcp", server_label: "docs", server_url: "https://example.com/other-docs", allowed_tools: ["read"], require_approval: "always" },
    ];
    expect(normalizeTools(structuredClone(tools))).toEqual(tools);
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
  it("does not mutate shared tool declarations when rejecting a per-tool search limit", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", allowed_domains: ["example.org"], max_uses: 1 },
      { type: "function", function: { name: "echo", description: "Echo", parameters: { type: "object" } } },
    ];
    const original = structuredClone(tools);
    expect(() => normalizeTools(tools)).toThrow(ToolCompatibilityError);
    expect(tools).toEqual(original);
  });

  it("copies equivalent domain restrictions without mutating shared combo declarations", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", allowed_domains: ["example.org"] },
      { type: "function", function: { name: "echo", description: "Echo", parameters: { type: "object" } } },
    ];
    const original = structuredClone(tools);
    const normalized = normalizeTools(tools);
    expect(tools).toEqual(original);
    expect(normalized).toEqual([
      { type: "web_search", filters: { allowed_domains: ["example.org"] } },
      { type: "function", name: "echo", description: "Echo", parameters: { type: "object" } },
    ]);
    expect(normalized[0]).not.toBe(tools[0]);
    expect(normalized[1]).not.toBe(tools[1]);
  });

  it("normalizes Claude CLI and OpenAI Platform aliases for Codex OAuth", () => {
    const tools = normalizeTools([
      { type: "web_search_preview", search_context_size: "medium" },
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

  it("collapses equivalent aliases of one capability into a single Codex tool", () => {
    const tools = normalizeTools([
      { type: "web_search_preview", filters: { allowed_domains: ["example.com"] } },
      { type: "web_search_20260209", name: "web_search", allowed_domains: ["example.com"] },
      { type: "web_search", filters: { allowed_domains: ["example.com"] } },
    ]);
    expect(tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["example.com"] } }]);
  });

  it.each([false, true])("rejects conflicting aliases instead of losing restrictions (reversed=%s)", (reversed) => {
    const tools = [
      { type: "web_search_preview", search_context_size: "medium" },
      { type: "web_search_20260209", name: "web_search", allowed_domains: ["example.com"] },
    ];
    if (reversed) tools.reverse();
    const original = structuredClone(tools);
    expect(() => normalizeTools(tools)).toThrow(ToolCompatibilityError);
    expect(tools).toEqual(original);
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
  it.each([
    { type: "mcp", server_label: "issues" },
    { type: "mcp", server_label: "issues", name: "search" },
  ])("preserves a retained MCP server selector %j", (choice) => {
    const body = normalizeRequest([
      { type: "mcp", server_label: "docs", server_url: "https://example.com/docs" },
      { type: "mcp", server_label: "issues", server_url: "https://example.com/issues" },
    ], choice);
    expect(body.tool_choice).toEqual(choice);
  });

  it.each([
    { type: "mcp", server_label: "missing", name: "search" },
    { type: "mcp", name: "search" },
  ])("rejects an MCP selector without a retained server %j", (choice) => {
    expect(() => normalizeRequest([
      { type: "mcp", server_label: "docs", server_url: "https://example.com/docs" },
    ], choice)).toThrow(ToolCompatibilityError);
  });

  it.each(["apply_patch", "web_search"])("keeps forced custom choice for %s", (name) => {
    const tool = {
      type: "custom", name,
      format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
    };
    const choice = { type: "custom", name };
    const body = normalizeRequest([structuredClone(tool)], choice);
    expect(body.tools).toEqual([tool]);
    expect(body.tool_choice).toEqual(choice);
  });

  it.each([
    { label: "no declarations", tools: [] },
    { label: "a same-named function", tools: [{ type: "function", name: "apply_patch", parameters: { type: "object" } }] },
    { label: "a different custom tool", tools: [{ type: "custom", name: "other_tool", format: { type: "text" } }] },
  ])("does not validate a custom choice against $label", ({ tools }) => {
    expect(() => normalizeRequest(tools, { type: "custom", name: "apply_patch" })).toThrow(ToolCompatibilityError);
  });

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

  it("rejects a forced hosted tool choice when the tool has no Codex equivalent", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fetch" }] }],
      tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
      tool_choice: { type: "web_fetch_20250910" },
      stream: true,
    };

    expect(() => executor.transformRequest("gpt-5.6-sol", body, true, {
      connectionId: "test-codex-unsupported-hosted-tool-choice",
      providerSpecificData: {},
    })).toThrow(ToolCompatibilityError);
  });

  it.each([undefined, [], [{ type: "bash_20250124", name: "bash" }], [{ type: "namespace", name: "empty", tools: [] }]].map(tools => ({ tools })))(
    "rejects required with no retained callable tools: $tools", ({ tools }) => {
      expect(() => normalizeRequest(tools, "required")).toThrow(ToolCompatibilityError);
    },
  );

  it.each(["auto", "none"])("keeps optional choice %s when unsupported declarations are removed", (choice) => {
    expect(normalizeRequest([{ type: "bash_20250124", name: "bash" }], choice).tool_choice).toBe(choice);
  });

  it("keeps required when a usable function survives alongside a dropped hosted tool", () => {
    const body = normalizeRequest([
      { type: "bash_20250124", name: "bash" },
      { type: "function", name: "lookup", parameters: { type: "object" } },
    ], "required");
    expect(body.tool_choice).toBe("required");
    expect(body.tools.map(tool => tool.name)).toEqual(["lookup"]);
  });

  it("validates forced function identity after normalization instead of widening to auto", () => {
    const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];
    expect(normalizeRequest(tools, { type: "function", name: "lookup" }).tool_choice).toEqual({ type: "function", name: "lookup" });
    expect(() => normalizeRequest(tools, { type: "function", name: "missing" })).toThrow(ToolCompatibilityError);
    expect(() => normalizeRequest(undefined, { type: "function", name: "lookup" })).toThrow(ToolCompatibilityError);
  });

  it("keeps a forced namespace function scoped to its actual declaration", () => {
    const tools = [{ type: "namespace", name: "docs", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }];
    const choice = { type: "function", namespace: "docs", name: "read" };
    expect(normalizeRequest(tools, choice).tool_choice).toEqual(choice);
    expect(() => normalizeRequest(tools, { ...choice, namespace: "other" })).toThrow(ToolCompatibilityError);
    expect(() => normalizeRequest(tools, { type: "function", name: "read" })).toThrow(ToolCompatibilityError);
  });
});

describe("CodexExecutor allowed tool subsets", () => {
  const fn = (name) => ({ type: "function", name, parameters: { type: "object", properties: {} } });

  it.each(["auto", "required"])("keeps the allowed subset and mode %s", (mode) => {
    const choice = { type: "allowed_tools", mode, tools: [{ type: "function", name: "read_data" }] };
    const tools = [fn("read_data"), fn("write_data")];
    const original = structuredClone({ tools, choice });
    const body = normalizeRequest(tools, choice);
    expect(body.tools).toEqual(original.tools);
    expect(body.tool_choice).toEqual(original.choice);
    expect({ tools, choice }).toEqual(original);
  });

  it("matches function/custom/hosted/MCP identities and normalizes aliases without widening", () => {
    const tools = [
      fn("read_data"), fn("write_data"), fn("apply_patch"),
      { type: "custom", name: "apply_patch", format: { type: "text" } },
      { type: "web_search_preview", filters: { allowed_domains: ["example.org"] } },
      { type: "mcp", server_label: "docs", server_url: "https://example.org/docs", allowed_tools: ["search"] },
      { type: "mcp", server_label: "issues", server_url: "https://example.org/issues" },
    ];
    const choice = {
      type: "allowed_tools", mode: "required", tools: [
        { type: "function", name: "read_data" },
        { type: "custom", name: "apply_patch" },
        { type: "web_search_preview" },
        { type: "mcp", server_label: "docs", name: "search" },
      ],
    };
    const body = normalizeRequest(tools, choice);
    expect(body.tool_choice).toEqual({
      ...choice,
      tools: [choice.tools[0], choice.tools[1], { type: "web_search" }, choice.tools[3]],
    });
    expect(choice.tools[2]).toEqual({ type: "web_search_preview" });
    const twice = normalizeRequest(body.tools, body.tool_choice);
    expect(twice.tool_choice).toEqual(body.tool_choice);
  });

  it("preserves a server-wide MCP selector without adding tool names", () => {
    const choice = { type: "allowed_tools", mode: "auto", tools: [{ type: "mcp", server_label: "docs" }] };
    expect(normalizeRequest([
      { type: "mcp", server_label: "docs", server_url: "https://example.org/docs" },
      { type: "mcp", server_label: "issues", server_url: "https://example.org/issues" },
    ], choice).tool_choice).toEqual(choice);
  });

  it.each([
    { type: "function", name: "missing" },
    { type: "custom", name: "read_data" },
    { type: "web_search" },
    { type: "mcp", server_label: "missing", name: "search" },
    { type: "mcp", name: "search" },
    { type: "web_fetch_20250910" },
    { type: "unknown", name: "web_search" },
    null,
  ])("rejects invalid or unavailable subset selector %j", (selector) => {
    const tools = [fn("read_data"), fn("web_search"), { type: "mcp", server_label: "docs", server_url: "https://example.org/docs" }];
    expect(() => normalizeRequest(tools, {
      type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read_data" }, selector],
    })).toThrow(ToolCompatibilityError);
  });

  it.each([
    { type: "allowed_tools", mode: "auto", tools: [] },
    { type: "allowed_tools", mode: "required", tools: [] },
    { type: "allowed_tools", mode: "none", tools: [{ type: "function", name: "read_data" }] },
    { type: "allowed_tools", tools: [{ type: "function", name: "read_data" }] },
    { type: "allowed_tools", mode: "auto", tools: null },
  ])("rejects malformed/empty allowed_tools %j", (choice) => {
    expect(() => normalizeRequest([fn("read_data"), fn("write_data")], choice)).toThrow(ToolCompatibilityError);
  });

  it.each([{ tools: undefined }, { tools: [] }, { tools: null }])("rejects an allowed subset without retained declarations: $tools", ({ tools }) => {
    expect(() => normalizeRequest(tools, {
      type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "read_data" }],
    })).toThrow(ToolCompatibilityError);
  });
});
