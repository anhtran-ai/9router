import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ToolCompatibilityError } from "../../open-sse/translator/concerns/hostedToolPolicy.js";

const openaiReasoning = {
  messages: [{ role: "assistant", content: "", reasoning_content: "private plan" }],
};
const claudeThinking = {
  messages: [{
    role: "assistant",
    content: [{ type: "thinking", thinking: "private plan", signature: "sig" }],
  }],
};

describe("assistant reasoning at request transport boundaries", () => {
  it.each([
    [FORMATS.CURSOR, "cursor"],
    [FORMATS.COMMANDCODE, "commandcode"],
    [FORMATS.KIRO, "kiro"],
  ])("fails closed for OpenAI reasoning sent to %s", (target, provider) => {
    expect(() => translateRequest(
      FORMATS.OPENAI, target, "m", structuredClone(openaiReasoning), true, null, provider,
    )).toThrowError(ToolCompatibilityError);
  });

  it.each([
    [FORMATS.CURSOR, "cursor"],
    [FORMATS.COMMANDCODE, "commandcode"],
    [FORMATS.KIRO, "kiro"],
  ])("fails closed for Claude thinking sent to %s", (target, provider) => {
    expect(() => translateRequest(
      FORMATS.CLAUDE, target, "m", structuredClone(claudeThinking), true, null, provider,
    )).toThrowError(ToolCompatibilityError);
  });

  it("preserves OpenAI reasoning as Ollama message.thinking", () => {
    const out = translateRequest(
      FORMATS.OPENAI, FORMATS.OLLAMA, "qwen3", structuredClone(openaiReasoning), true, null, "ollama",
    );
    expect(out.messages).toEqual([{ role: "assistant", content: "", thinking: "private plan" }]);
  });

  it("preserves Claude thinking text through the OpenAI bridge into Ollama", () => {
    const out = translateRequest(
      FORMATS.CLAUDE, FORMATS.OLLAMA, "qwen3", structuredClone(claudeThinking), true, null, "ollama",
    );
    expect(out.messages).toEqual([{ role: "assistant", content: "", thinking: "private plan" }]);
  });

  it("preserves reasoning alongside Ollama tool calls", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OLLAMA, "qwen3", {
      messages: [{
        role: "assistant",
        content: "",
        reasoning_content: "choose the tool",
        tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      }],
    }, true, null, "ollama");

    expect(out.messages[0]).toMatchObject({
      role: "assistant",
      thinking: "choose the tool",
      tool_calls: [{ function: { name: "lookup", arguments: {} } }],
    });
  });
});
