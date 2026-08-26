import { describe, expect, it } from "vitest";

import {
  isHostedTool,
  renderHostedToolForClaude,
  renderHostedToolForCodex,
  resolveHostedTool,
} from "../../open-sse/translator/concerns/hostedToolPolicy.js";

describe("hosted tool compatibility policy", () => {
  it.each(["bash", "web_search", "echo"])("does not resolve explicit custom tool %s by its name", (name) => {
    const tool = { type: "custom", name, format: { type: "text" } };
    expect(resolveHostedTool(tool.type, name)).toBeNull();
    expect(isHostedTool(tool)).toBe(false);
    expect(renderHostedToolForClaude(tool)).toBeNull();
    expect(renderHostedToolForCodex(tool)).toBeNull();
  });

  it.each([
    ["web_search", "web_search"],
    ["web_search_preview", "web_search"],
    ["web_search_preview_2025_03_11", "web_search"],
    ["web_search_20250305", "web_search"],
    ["web_search_20260209", "web_search"],
    ["computer_use_preview", "computer"],
    ["computer_20251124", "computer"],
    ["computer_toolset_20260801", "computer"],
    ["code_execution_20250522", "code_execution"],
    ["tool_search_tool_regex_20251119", "tool_search"],
    ["web_fetch_20250910", "web_fetch"],
    ["bash_20250124", "bash"],
    ["text_editor_20250728", "text_editor"],
    ["memory_20250818", "memory"],
  ])("resolves %s onto canonical %s", (wireType, canonical) => {
    expect(resolveHostedTool(wireType)).toBe(canonical);
  });

  it("renders LiteLLM's Claude web-search alias for Codex OAuth", () => {
    expect(renderHostedToolForCodex({
      type: "web_search_preview",
      search_context_size: "high",
      max_uses: 4,
      allowed_domains: ["example.com"],
    })).toEqual({
      type: "web_search",
      search_context_size: "high",
    });
  });

  it("renders future dated Claude tools without version-specific changes", () => {
    expect(renderHostedToolForCodex({
      type: "web_search_20991231",
      name: "web_search",
    })).toEqual({ type: "web_search" });

    expect(renderHostedToolForClaude({
      type: "web_search_20991231",
      name: "web_search",
      allowed_domains: ["example.com"],
    })).toEqual({
      type: "web_search_20991231",
      name: "web_search",
      allowed_domains: ["example.com"],
    });
  });

  it("maps OpenAI hosted aliases onto Anthropic native tools", () => {
    expect(renderHostedToolForClaude({
      type: "web_search_preview",
      search_context_size: "medium",
      max_uses: 3,
    })).toEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
    });

    expect(renderHostedToolForClaude({
      type: "computer_use_preview",
      display_width: 1280,
      display_height: 720,
    })).toEqual({
      type: "computer_20250124",
      name: "computer",
      display_width_px: 1280,
      display_height_px: 720,
      display_number: 1,
    });

    expect(renderHostedToolForClaude({
      type: "code_interpreter",
      container: { type: "auto" },
    })).toEqual({
      type: "code_execution_20250522",
      name: "code_execution",
    });
  });

  it("keeps native Anthropic tools and drops capabilities with no safe equivalent", () => {
    const bash = { type: "bash_20250124", name: "bash" };
    const mcp = { type: "mcp_toolset", name: "project_tools" };

    expect(renderHostedToolForClaude(bash)).toEqual(bash);
    expect(renderHostedToolForClaude(mcp)).toEqual(mcp);
    expect(renderHostedToolForClaude({ type: "file_search" })).toBeNull();
    expect(renderHostedToolForCodex({ type: "web_fetch_20250910", name: "web_fetch" })).toBeNull();
    expect(renderHostedToolForCodex(mcp)).toBeNull();
    expect(renderHostedToolForCodex(bash)).toBeNull();
  });
});
