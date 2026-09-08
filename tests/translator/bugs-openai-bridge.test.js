// Expose bugs caused by OpenAI being the intermediate format: data lost/wrong on source → openai → target.
// Each test describes the EXPECTED-correct behavior. A FAIL is evidence of the bug (with source file:line).
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ToolCompatibilityError } from "../../open-sse/translator/concerns/hostedToolPolicy.js";

const T = (src, tgt, body, provider = null) =>
  translateRequest(src, tgt, "m", body, true, null, provider);

describe("bug: Claude → OpenAI bridge data loss", () => {
  it("preserves image source.type=url", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "url", url: "https://x.com/a.png" } },
      ] }],
    });
    const json = JSON.stringify(out);
    expect(json, "remote image url silently dropped").toContain("a.png");
  });

  it("thinking block survives round-trip Claude→OpenAI→Claude", () => {
    const body = {
      messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "secret reasoning", signature: "sig" },
        { type: "text", text: "answer" },
      ] }, { role: "user", content: "go" }],
    };
    const chat = T(FORMATS.CLAUDE, FORMATS.OPENAI, body);
    expect(chat.messages.find((message) => message.role === "assistant")?.reasoning_content)
      .toBe("secret reasoning");
    const out = T(FORMATS.OPENAI, FORMATS.CLAUDE, chat, "anthropic-compatible-x");
    const json = JSON.stringify(out);
    expect(json, "thinking content lost via OpenAI bridge").toContain("secret reasoning");
  });

  it("keeps a reasoning-only assistant turn through the OpenAI bridge", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "private chain", signature: "sig" }] },
        { role: "user", content: "continue" },
      ],
    };

    const chat = T(FORMATS.CLAUDE, FORMATS.OPENAI, body);
    expect(chat.messages).toContainEqual({
      role: "assistant",
      content: "",
      reasoning_content: "private chain",
    });
    const out = T(FORMATS.OPENAI, FORMATS.CLAUDE, chat, "anthropic-compatible-x");
    expect(out.messages[0].content).toContainEqual(expect.objectContaining({
      type: "thinking",
      thinking: "private chain",
    }));
  });

  it("fails closed when Claude native cannot authenticate reasoning-only bridge history", () => {
    expect(() => T(FORMATS.OPENAI, FORMATS.CLAUDE, {
      messages: [
        { role: "assistant", content: "", reasoning_content: "unsigned private chain" },
        { role: "user", content: "continue" },
      ],
    }, "claude")).toThrowError(ToolCompatibilityError);
  });

  it("fails closed when a Chat target cannot represent a tool_result image", () => {
    expect(() => T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      messages: [
        { role: "assistant", content: [
          { type: "tool_use", id: "call_1", name: "shot", input: {} },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_1", content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "ZZZ" } },
          ] },
        ] },
      ],
    })).toThrowError(ToolCompatibilityError);
  });

  it("preserves tool_result failure semantics in Chat text", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "f", input: {} }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_1", is_error: true, content: "boom" },
        ] },
      ],
    });
    const tool = out.messages.find((message) => message.role === "tool");
    expect(tool?.content).toBe("[Tool error]\nboom");
  });

  // claude-to-openai.js:24-27 — system array only takes .text, drops cache_control/non-text
  it("system array non-text parts are not silently dropped", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      system: [
        { type: "text", text: "rule1", cache_control: { type: "ephemeral" } },
        { type: "text", text: "rule2" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const sys = out.messages.find((m) => m.role === "system");
    expect(sys?.content).toContain("rule1");
    expect(sys?.content).toContain("rule2");
  });
});

describe("bug: tool_call id stability across bridge", () => {
  // toolCallHelper.js:29-31 — sanitize changes tc.id but tool_call_id in another message may drift
  it("sanitized tool id stays matched between call and result", () => {
    const out = T(FORMATS.OPENAI, FORMATS.OPENAI, {
      messages: [
        { role: "assistant", tool_calls: [
          { id: "call/with:bad*chars", type: "function", function: { name: "f", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "call/with:bad*chars", content: "ok" },
      ],
    });
    const asst = out.messages.find((m) => m.role === "assistant");
    const tool = out.messages.find((m) => m.role === "tool");
    expect(tool.tool_call_id, "id mismatch after sanitize").toBe(asst.tool_calls[0].id);
  });
});

describe("bug: empty content message handling", () => {
  // openaiHelper.js:49-51,66-71 — empty content → {text:""} then filtered out
  it("assistant message with only tool_calls is not dropped", () => {
    const out = T(FORMATS.OPENAI, FORMATS.OPENAI, {
      messages: [
        { role: "user", content: "do it" },
        { role: "assistant", content: "", tool_calls: [
          { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "call_1", content: "done" },
      ],
    });
    const asst = out.messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(asst, "assistant tool_calls message dropped").toBeTruthy();
  });
});
