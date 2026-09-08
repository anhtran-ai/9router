// Real Codex CLI requests (OpenAI Responses API: { input:[], instructions }) → providers.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { convertResponsesApiFormat } from "../../open-sse/translator/formats/responsesApi.js";
import { ToolCompatibilityError } from "../../open-sse/translator/concerns/hostedToolPolicy.js";

const R2O = (body) => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "m", body, true, null, null);
const O2R = (body) => translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "m", body, true, null, null);
const responsesToChatConverters = [
  ["registered translator", R2O],
  ["handler pre-converter", convertResponsesApiFormat],
];

describe("Codex CLI Responses → OpenAI", () => {
  it.each(responsesToChatConverters)("%s normalizes empty input to a valid user turn", (_label, convert) => {
    for (const input of ["", []]) {
      const out = convert({ input });
      expect(out.messages).toContainEqual({
        role: "user",
        content: [{ type: "text", text: "..." }],
      });
    }
  });

  it.each(responsesToChatConverters)("%s emits no empty assistant tool_calls for nameless calls", (_label, convert) => {
    const out = convert({
      input: [
        { type: "function_call", call_id: "c1", name: "", arguments: "{}" },
      ],
    });
    expect(out.messages.some((message) => Array.isArray(message.tool_calls) && message.tool_calls.length === 0)).toBe(false);
  });

  it.each(responsesToChatConverters)("%s emits string function_call arguments", (_label, convert) => {
    const out = convert({ input: [
      { type: "function_call", call_id: "c1", name: " f ", arguments: { a: 1 } },
    ] });
    const asst = out.messages.find((m) => m.tool_calls);
    expect(asst.tool_calls[0].function.name).toBe("f");
    expect(typeof asst.tool_calls[0].function.arguments).toBe("string");
    expect(JSON.parse(asst.tool_calls[0].function.arguments)).toEqual({ a: 1 });
  });

  it.each(responsesToChatConverters)("%s fails closed for an unresolved input_image file_id", (_label, convert) => {
    const request = {
      input: [{ type: "message", role: "user", content: [
        { type: "input_image", file_id: "file-abc" },
      ] }],
    };
    expect(() => convert(request)).toThrowError(ToolCompatibilityError);
  });

  it.each(responsesToChatConverters)("%s still preserves a valid input_image URL", (_label, convert) => {
    const out = convert({
      input: [{ type: "message", role: "user", content: [
        { type: "input_image", image_url: "https://example.test/image.png", detail: "high" },
      ] }],
    });
    const userMsg = out.messages.find((message) => message.role === "user");
    expect(userMsg.content).toContainEqual({
      type: "image_url",
      image_url: { url: "https://example.test/image.png", detail: "high" },
    });
  });

  it.each(responsesToChatConverters)("%s fails closed for an unresolved input_file file_id", (_label, convert) => {
    expect(() => convert({
      input: [{ type: "message", role: "user", content: [
        { type: "input_file", file_id: "file-abc" },
      ] }],
    })).toThrowError(ToolCompatibilityError);
  });

  it.each(responsesToChatConverters)("%s preserves inline input_file data", (_label, convert) => {
    const out = convert({
      input: [{ type: "message", role: "user", content: [
        { type: "input_file", file_data: "data:application/pdf;base64,AAAA", filename: "a.pdf" },
      ] }],
    });
    expect(out.messages.find((message) => message.role === "user")?.content).toContainEqual({
      type: "file",
      file: { file_data: "data:application/pdf;base64,AAAA", filename: "a.pdf" },
    });
  });

  it.each(responsesToChatConverters)("%s preserves a reasoning-only assistant turn", (_label, convert) => {
    const out = convert({ input: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "private plan" }],
        encrypted_content: "opaque-continuity",
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ] });

    expect(out.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: "",
        reasoning_content: "private plan",
        encrypted_content: "opaque-continuity",
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  });
});

describe("OpenAI → Codex Responses (reverse)", () => {
  it("maps developer messages to Responses API instructions", () => {
    const out = O2R({
      messages: [
        { role: "developer", content: "Follow the project rules." },
        { role: "user", content: "Hello" },
      ],
    });

    expect(out.instructions).toBe("Follow the project rules.");
    expect(out.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ]);
  });

  it("keeps every system and developer instruction in encounter order", () => {
    const out = O2R({
      messages: [
        { role: "system", content: "RULE_ONE" },
        { role: "developer", content: "RULE_DEV" },
        { role: "system", content: "RULE_TWO" },
        { role: "user", content: "Hello" },
      ],
    });

    expect(out.instructions).toBe("RULE_ONE\n\nRULE_DEV\n\nRULE_TWO");
  });

  // openai-responses.js:13 — clampCallId NOT applied on Responses→Chat; but here Chat→Responses must clamp
  it("call_id longer than 64 chars is clamped", () => {
    const longId = "call_" + "x".repeat(80);
    const out = O2R({
      messages: [
        { role: "assistant", content: null, tool_calls: [
          { id: longId, type: "function", function: { name: "f", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: longId, content: "ok" },
      ],
    });
    const fc = out.input.find((i) => i.type === "function_call");
    expect(fc.call_id.length).toBeLessThanOrEqual(64);
  });

  it("round-trips a reasoning-only assistant without inventing empty output_text", () => {
    const responses = O2R({ messages: [{
      role: "assistant",
      content: "",
      reasoning_content: "reasoning without an answer",
      encrypted_content: "encrypted-state",
    }] });

    expect(responses.input).toEqual([{
      type: "reasoning",
      summary: [{ type: "summary_text", text: "reasoning without an answer" }],
      encrypted_content: "encrypted-state",
    }]);

    const chat = R2O(responses);
    expect(chat.messages).toContainEqual({
      role: "assistant",
      content: "",
      reasoning_content: "reasoning without an answer",
      encrypted_content: "encrypted-state",
    });
  });
});
