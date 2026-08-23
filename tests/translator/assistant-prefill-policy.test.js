import { describe, expect, it } from "vitest";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { DEFAULT_CAPABILITIES, MODEL_CAPABILITIES, PATTERN_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

const continuationPattern = /continue.*without repeating/i;

function translated(messages, options = {}) {
  return prepareClaudeRequest({
    model: options.model || "claude-opus-6",
    messages: structuredClone(messages),
  }, options.provider || "anthropic", null, null, options.headers || null);
}

function passthrough(messages, options = {}) {
  return normalizeClaudePassthrough({
    model: options.model || "claude-quill-5",
    messages: structuredClone(messages),
  }, options.model || "claude-quill-5", options.headers || null);
}

const paths = [
  ["translated Claude target", translated],
  ["native Claude passthrough", passthrough],
];

it("removes assistant prefill from model capabilities", () => {
  expect(JSON.stringify({ DEFAULT_CAPABILITIES, MODEL_CAPABILITIES, PATTERN_CAPABILITIES }))
    .not.toContain("assistantPrefill");
});

describe.each(paths)("assistant prefill policy — %s", (_name, run) => {
  it("normalizes trailing text for future model ids", () => {
    const out = run([
      { role: "user", content: "Start" },
      { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
    ]);

    expect(out.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(out.messages.at(-1).content)).toMatch(continuationPattern);
  });

  it("normalizes aliases that do not contain claude", () => {
    const out = run([
      { role: "user", content: "Start" },
      { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
    ], { model: "primary-writing-model" });

    expect(out.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
  });

  it.each([
    ["empty", []],
    ["thinking-only", [{ type: "thinking", thinking: "Draft", signature: "invalid" }]],
  ])("drops %s trailing assistant", (_case, content) => {
    const out = run([
      { role: "user", content: "Start" },
      { role: "assistant", content },
    ]);

    expect(out.messages).toHaveLength(1);
    expect(out.messages.at(-1).role).toBe("user");
  });

  it("keeps trailing assistant tool_use unchanged", () => {
    const toolUse = { type: "tool_use", id: "tool-1", name: "lookup", input: {} };
    const out = run([
      { role: "user", content: "Start" },
      { role: "assistant", content: [toolUse] },
    ]);

    expect(out.messages).toHaveLength(2);
    expect(out.messages.at(-1)).toEqual({ role: "assistant", content: [expect.objectContaining(toolUse)] });
  });

  it("keeps final user unchanged", () => {
    const out = run([{ role: "user", content: "Start" }]);

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
  });

  it("preserves exact assistant prefill when header opts in", () => {
    const messages = [
      { role: "user", content: "Start" },
      { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
    ];
    const out = run(messages, {
      headers: { "x-9router-assistant-prefill": "preserve" },
    });

    expect(out.messages).toHaveLength(2);
    expect(out.messages.at(-1).role).toBe("assistant");
  });
});
