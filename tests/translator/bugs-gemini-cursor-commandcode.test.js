// OpenAI → Gemini / Cursor / CommandCode request translation.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ToolCompatibilityError } from "../../open-sse/translator/concerns/hostedToolPolicy.js";

const O2G = (body) => translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "m", body, true, null, "gemini");
const O2C = (body) => translateRequest(FORMATS.OPENAI, FORMATS.CURSOR, "m", body, true, null, "cursor");
const O2CC = (body) => translateRequest(FORMATS.OPENAI, FORMATS.COMMANDCODE, "m", body, true, null, "commandcode");

describe("OpenAI → Gemini", () => {
  it("keeps all system and developer messages in encounter order", () => {
    const out = O2G({
      messages: [
        { role: "system", content: "RULE_ONE" },
        { role: "developer", content: "RULE_DEV" },
        { role: "system", content: "RULE_TWO" },
        { role: "user", content: "hi" },
      ],
    });
    expect(out.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "RULE_ONE" }, { text: "RULE_DEV" }, { text: "RULE_TWO" }],
    });
  });

  it.each([
    ["", { result: { result: "" } }],
    ["0", { result: { result: 0 } }],
  ])("keeps a present tool response whose content is %j", (content, expectedResponse) => {
    const out = O2G({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [
          { id: "call_empty", type: "function", function: { name: "lookup", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "call_empty", content },
      ],
    });
    const response = out.contents
      .flatMap((message) => message.parts)
      .find((part) => part.functionResponse)?.functionResponse;
    expect(response?.id).toBe("call_empty");
    expect(response?.name).toBe("lookup");
    expect(response?.response).toEqual(expectedResponse);
  });

  it("handles prototype-like tool ids without corrupting the lookup maps", () => {
    const out = O2G({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [
          { id: "__proto__", type: "function", function: { name: "lookup", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "__proto__", content: "ok" },
      ],
    });
    const response = out.contents
      .flatMap((message) => message.parts)
      .find((part) => part.functionResponse)?.functionResponse;
    expect(response).toMatchObject({ id: "__proto__", name: "lookup" });
  });
});

describe("OpenAI → Cursor", () => {
  it("fails closed for image content unsupported by the Cursor transport", () => {
    expect(() => O2C({
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ] }],
    })).toThrowError(ToolCompatibilityError);
  });

  it("respects client max_tokens", () => {
    const out = O2C({ max_tokens: 200, messages: [{ role: "user", content: "hi" }] });
    expect(out.max_tokens).toBe(200);
  });

  it("keeps developer instructions as Cursor system context", () => {
    const out = O2C({ messages: [
      { role: "developer", content: "RULE_DEV" },
      { role: "user", content: "hi" },
    ] });
    expect(out.messages).toContainEqual({
      role: "user",
      content: "[System Instructions]\nRULE_DEV",
    });
  });

  it.each([
    { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
    { type: "file", file: { file_data: "data:application/pdf;base64,AAAA" } },
  ])("fails closed for unsupported rich content $type", (part) => {
    expect(() => O2C({ messages: [{ role: "user", content: [part] }] }))
      .toThrowError(ToolCompatibilityError);
  });
});

describe("OpenAI → CommandCode", () => {
  it("fails closed instead of silently emptying malformed tool arguments", () => {
    expect(() => O2CC({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: "{bad" } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "r" },
      ],
    })).toThrowError(ToolCompatibilityError);
  });

  it("fails closed for images unsupported by its text-only schema", () => {
    expect(() => O2CC({
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ] }],
    })).toThrowError(ToolCompatibilityError);

    expect(() => O2CC({
      messages: [{ role: "assistant", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ] }],
    })).toThrowError(ToolCompatibilityError);
  });

  it.each([
    { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
    { type: "file", file: { file_data: "data:application/pdf;base64,AAAA" } },
  ])("fails closed for unsupported rich content $type", (part) => {
    expect(() => O2CC({ messages: [{ role: "user", content: [part] }] }))
      .toThrowError(ToolCompatibilityError);
  });
});
