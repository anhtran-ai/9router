import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function getInputJsonDelta(events) {
  return events.find((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta")?.delta.partial_json;
}

describe("openaiToClaudeResponse tool argument sanitization", () => {
  it("drops invalid Read pages and clamps numeric bounds", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_read", function: { name: "Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/file.js", offset: -5, limit: 999999999, pages: "" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/file.js",
      offset: 0,
      limit: 2000,
    });
  });

  it("keeps valid PDF pages", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_pdf", function: { name: "proxy_Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/doc.pdf", pages: "1-3" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/doc.pdf",
      pages: "1-3",
    });
  });

  it("waits for both id and name and preserves argument fragments received before the name", () => {
    const state = createState();
    const first = openaiToClaudeResponse({
      id: "chatcmpl-split-tool",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_split", function: { arguments: "{\"path\":" } }] } }],
    }, state);
    const second = openaiToClaudeResponse({
      id: "chatcmpl-split-tool",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: "\"a.txt\"}" } }] } }],
    }, state);
    const finished = openaiToClaudeResponse({
      id: "chatcmpl-split-tool",
      model: "test-model",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }, state);

    expect(first.some((event) => event.type === "content_block_start" && event.content_block?.type === "tool_use")).toBe(false);
    expect(second).toContainEqual(expect.objectContaining({
      type: "content_block_start",
      content_block: expect.objectContaining({ type: "tool_use", id: "toolu_split", name: "lookup" }),
    }));
    expect(JSON.parse(getInputJsonDelta(finished))).toEqual({ path: "a.txt" });
  });

  it("also waits when the function name arrives before the id", () => {
    const state = createState();
    const first = openaiToClaudeResponse({
      id: "chatcmpl-name-first",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] } }],
    }, state);
    const second = openaiToClaudeResponse({
      id: "chatcmpl-name-first",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_name_first", function: {} }] } }],
    }, state);
    const finished = openaiToClaudeResponse({
      id: "chatcmpl-name-first",
      model: "test-model",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }, state);

    expect(first.some((event) => event.type === "content_block_start" && event.content_block?.type === "tool_use")).toBe(false);
    expect(second).toContainEqual(expect.objectContaining({
      type: "content_block_start",
      content_block: expect.objectContaining({ type: "tool_use", id: "toolu_name_first", name: "lookup" }),
    }));
    expect(JSON.parse(getInputJsonDelta(finished))).toEqual({ q: "x" });
  });
});
