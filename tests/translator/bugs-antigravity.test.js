// Real Antigravity-MITM requests (Gemini-internal: { request: { contents, ... } }) → OpenAI.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { ANTIGRAVITY_DEFAULT_SYSTEM } from "../../open-sse/config/appConstants.js";
import { toNumericSessionId } from "../../open-sse/utils/sessionManager.js";

const AG2O = (req) =>
  translateRequest(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, "m", { request: req }, true, null, null);

function recordThoughtSignature(callId, sessionId, signature) {
  const state = initState(FORMATS.OPENAI);
  state.sessionId = sessionId;
  const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, {
    response: {
      responseId: `response-${sessionId}`,
      modelVersion: "gemini-3.8-flash-low",
      candidates: [{
        content: {
          role: "model",
          parts: [
            { thoughtSignature: signature },
            { functionCall: { id: callId, name: "lookup", args: { query: sessionId } } },
          ],
        },
        finishReason: "STOP",
        index: 0,
      }],
    },
  }, state);

  expect(events.some((event) => event.choices?.[0]?.delta?.tool_calls?.[0]?.id === callId)).toBe(true);
}

function toolHistory(callId) {
  return {
    messages: [
      { role: "user", content: "Use the lookup tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: callId,
          type: "function",
          function: { name: "lookup", arguments: "{\"query\":\"value\"}" },
        }],
      },
      { role: "tool", tool_call_id: callId, content: "result" },
    ],
  };
}

function findFunctionCall(envelope, callId) {
  return envelope.request.contents
    .flatMap((content) => content.parts || [])
    .find((part) => part.functionCall?.id === callId);
}

describe("Antigravity → OpenAI", () => {
  // antigravity-to-openai.js — content with BOTH functionResponse and functionCall/text
  // previously returned toolResults early → dropped tool calls / text (fixed in #2225)
  it("functionResponse + functionCall in same content keeps both", () => {
    const out = AG2O({
      contents: [{
        role: "model",
        parts: [
          { functionResponse: { id: "c1", name: "prev", response: { result: "done" } } },
          { functionCall: { id: "c2", name: "next", args: {} } },
        ],
      }],
    });
    const json = JSON.stringify(out);
    expect(json, "functionCall lost when sharing content with functionResponse").toContain("\"next\"");
  });

  // antigravity-to-openai.js:167 — functionCall without id gets a random Date.now() id
  // KNOWN BUG: unstable id breaks matching with its functionResponse
  it("functionCall without id keeps a stable matchable id", () => {
    const out = AG2O({
      contents: [
        { role: "model", parts: [{ functionCall: { name: "search", args: { q: "x" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "search", response: { result: "r" } } }] },
      ],
    });
    const asst = out.messages.find((m) => m.tool_calls);
    const tool = out.messages.find((m) => m.role === "tool");
    expect(tool?.tool_call_id, "id mismatch between call and response").toBe(asst?.tool_calls?.[0]?.id);
  });

  // antigravity-to-openai.js:144-147 — signature-only part handling (regression guard)
  it("signature-only part does not produce empty text", () => {
    const out = AG2O({
      contents: [{ role: "model", parts: [{ thoughtSignature: "sig", text: "" }] }],
    });
    const asst = out.messages.find((m) => m.role === "assistant");
    const content = asst?.content;
    const hasEmpty = Array.isArray(content)
      ? content.some((c) => c.type === "text" && c.text === "")
      : content === "";
    expect(hasEmpty, "empty text part emitted").toBe(false);
  });
});

describe("Antigravity → Claude", () => {
  it("tool call input_json_delta includes Anthropic index", () => {
    const state = initState(FORMATS.CLAUDE);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.CLAUDE, {
      response: {
        responseId: "resp-1",
        modelVersion: "gemini-pro-agent",
        candidates: [{
          content: {
            role: "model",
            parts: [{ functionCall: { name: "bash", args: { command: "git status" } } }],
          },
          finishReason: "STOP",
          index: 0,
        }],
      },
    }, state);

    const jsonDelta = events.find(
      (event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta"
    );
    expect(jsonDelta).toMatchObject({ index: expect.any(Number) });
    expect(JSON.parse(jsonDelta.delta.partial_json)).toEqual({ command: "git status" });
  });
});

describe("registered OpenAI → Gemini session forwarding", () => {
  it("forwards the captured client session through Gemini CLI and replays its signature", () => {
    const callId = "call-gemini-cli-session";
    const wantedSession = "client-session-gemini-cli-a";
    const otherSession = "client-session-gemini-cli-b";
    recordThoughtSignature(callId, wantedSession, "signature-gemini-cli-a");
    // The store also keeps a legacy unscoped value. Overwrite it deliberately:
    // only a correctly forwarded session can now retrieve the wanted signature.
    recordThoughtSignature(callId, otherSession, "signature-gemini-cli-b");

    const credentials = {
      connectionId: "gemini-cli-connection",
      projectId: "gemini-cli-project",
      rawHeaders: { "x-session-id": wantedSession },
    };
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.GEMINI_CLI,
      "gemini-3.8-flash-low",
      toolHistory(callId),
      true,
      credentials,
      "gemini-cli",
      null,
      [],
      credentials.connectionId,
    );

    expect(credentials._clientSessionId).toBe(wantedSession);
    expect(out.request.sessionId).toBe(toNumericSessionId(wantedSession));
    expect(findFunctionCall(out, callId)?.thoughtSignature).toBe("signature-gemini-cli-a");
  });

  it("forwards the captured client session through non-Claude Antigravity and replays its signature", () => {
    const callId = "call-antigravity-session";
    const wantedSession = "client-session-antigravity-a";
    const otherSession = "client-session-antigravity-b";
    recordThoughtSignature(callId, wantedSession, "signature-antigravity-a");
    recordThoughtSignature(callId, otherSession, "signature-antigravity-b");

    const credentials = {
      connectionId: "antigravity-connection",
      projectId: "antigravity-project",
    };
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "gemini-3.8-flash-low",
      { ...toolHistory(callId), prompt_cache_key: wantedSession },
      true,
      credentials,
      "antigravity",
      null,
      [],
      credentials.connectionId,
    );

    expect(out.userAgent).toBe("antigravity");
    expect(credentials._clientSessionId).toBe(wantedSession);
    expect(out.request.sessionId).toBe(toNumericSessionId(wantedSession));
    expect(findFunctionCall(out, callId)?.thoughtSignature).toBe("signature-antigravity-a");
  });
});

describe("Antigravity executor", () => {
  it("strips optional from nested tool schemas", () => {
    const out = new AntigravityExecutor().transformRequest("gemini-2.5-pro", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{
          functionDeclarations: [{
            name: "lookup",
            description: "Lookup a value",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Search query",
                  optional: true,
                },
              },
            },
          }],
        }],
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    const query = out.request.tools[0].functionDeclarations[0].parameters.properties.query;
    expect(query).toEqual({ type: "string", description: "Search query" });
  });

  it("does not inject the legacy Antigravity default system prompt for Gemini-backed models", () => {
    const out = openaiToAntigravityRequest("gemini-3.5-flash-low", {
      messages: [
        { role: "system", content: "USER_SYSTEM_PROMPT" },
        { role: "user", content: "hello" },
      ],
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    const system = JSON.stringify(out.request.systemInstruction);
    expect(system).toContain("USER_SYSTEM_PROMPT");
    expect(system).not.toContain(ANTIGRAVITY_DEFAULT_SYSTEM);
    expect(system).not.toContain("Please ignore the following [ignore]");
  });

  it("does not inject the legacy Antigravity default system prompt for Claude-backed models", () => {
    const out = openaiToAntigravityRequest("claude-opus-4-6-thinking", {
      messages: [
        { role: "system", content: "USER_SYSTEM_PROMPT" },
        { role: "user", content: "hello" },
      ],
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    const system = JSON.stringify(out.request.systemInstruction);
    expect(system).toContain("USER_SYSTEM_PROMPT");
    expect(system).not.toContain(ANTIGRAVITY_DEFAULT_SYSTEM);
    expect(system).not.toContain("Please ignore the following [ignore]");
  });
});
