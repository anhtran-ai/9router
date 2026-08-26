import { describe, expect, it } from "vitest";

import {
  isHostedTool,
  renderHostedToolForClaude,
  renderHostedToolForCodex,
  resolveHostedTool,
  ToolCompatibilityError,
} from "../../open-sse/translator/concerns/hostedToolPolicy.js";

describe("hosted tool compatibility policy", () => {
  it("identifies unsupported constraints with a structured request error", () => {
    const error = new ToolCompatibilityError("the target cannot preserve this constraint");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "ToolCompatibilityError",
      status: 400,
      code: "unsupported_tool_constraint",
      message: "Unsupported tool constraint: the target cannot preserve this constraint",
    });
  });

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
      allowed_domains: ["example.com"],
    })).toEqual({
      type: "web_search",
      search_context_size: "high",
      filters: { allowed_domains: ["example.com"] },
    });
  });

  it.each([{ max_uses: 4 }, { blocked_domains: ["example.com"] }])("rejects a Claude search constraint without a Codex equivalent: %j", (constraint) => {
    const tool = { type: "web_search_20250305", name: "web_search", ...constraint };
    const original = structuredClone(tool);
    expect(() => renderHostedToolForCodex(tool)).toThrow(ToolCompatibilityError);
    expect(tool).toEqual(original);
  });

  it.each([[], [""], ["example.com/docs"], ["*.example.com"], ["https://example.com"], [false]].map(allowed_domains => ({ allowed_domains })))(
    "rejects a domain restriction that cannot be copied to Codex: $allowed_domains", ({ allowed_domains }) => {
      expect(() => renderHostedToolForCodex({ type: "web_search_20250305", allowed_domains })).toThrow(ToolCompatibilityError);
    },
  );

  it("retains matching native and Responses domain restrictions without mutating either", () => {
    const tool = {
      type: "web_search_20250305", allowed_domains: ["example.com", "docs.example.org"],
      filters: { allowed_domains: ["docs.example.org", "example.com"] },
    };
    const original = structuredClone(tool);
    const rendered = renderHostedToolForCodex(tool);
    expect(rendered.filters.allowed_domains).toEqual(tool.allowed_domains);
    expect(tool).toEqual(original);
    expect(rendered.filters).not.toBe(tool.filters);
  });

  it("rejects conflicting native and Responses domain restrictions", () => {
    expect(() => renderHostedToolForCodex({
      type: "web_search_20250305", allowed_domains: ["example.com"],
      filters: { allowed_domains: ["different.example.org"] },
    })).toThrow(ToolCompatibilityError);
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

  it.each(["web_search", "web_search_preview", "web_search_preview_2025_03_11"])("maps %s domain filters to Claude without mutating the declaration", (type) => {
    const tool = { type, filters: { allowed_domains: ["example.org", "docs.example.org"] }, external_web_access: true };
    const original = structuredClone(tool);
    expect(renderHostedToolForClaude(tool)).toEqual({
      type: "web_search_20250305", name: "web_search", allowed_domains: original.filters.allowed_domains,
    });
    expect(tool).toEqual(original);
  });

  it.each([
    { external_web_access: false },
    { filters: { allowed_domains: [] } },
    { filters: { allowed_domains: "example.org" } },
    { filters: { allowed_domains: [""] } },
    { filters: { blocked_domains: ["example.org"] } },
    { filters: { allowed_domains: ["example.org"] }, allowed_domains: ["other.example"] },
    { filters: { allowed_domains: ["example.org"] }, blocked_domains: ["other.example"] },
  ])("rejects web search constraints that Claude cannot preserve: %j", (constraints) => {
    expect(() => renderHostedToolForClaude({ type: "web_search", ...constraints })).toThrow(ToolCompatibilityError);
  });

  it.each([
    ["web_search", true], ["web_search", false],
    ["web_search_20260209", true], ["web_search_20260209", false],
  ])("rejects %s indexed_web_access=%s without assuming a Claude equivalent", (type, indexed_web_access) => {
    expect(() => renderHostedToolForClaude({ type, indexed_web_access })).toThrow(
      "Unsupported tool constraint: Claude cannot preserve indexed web access constraint"
    );
  });

  it("preserves matching hybrid domain restrictions and native Claude fields", () => {
    const tool = {
      type: "web_search_20260209", name: "web_search", max_uses: 1,
      allowed_domains: ["example.org"], filters: { allowed_domains: ["example.org"] },
      cache_control: { type: "ephemeral" },
    };
    const { filters, ...native } = tool;
    expect(renderHostedToolForClaude(tool)).toEqual(native);
    expect(tool.filters).toEqual(filters);
  });

  it("does not bypass cache-only rejection with a native Claude type", () => {
    expect(() => renderHostedToolForClaude({
      type: "web_search_20260209", name: "web_search", external_web_access: false,
    })).toThrow(ToolCompatibilityError);
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
