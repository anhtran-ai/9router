import { FORMATS } from "../formats.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM, OPENAI_FINISH, CLAUDE_STOP, GEMINI_FINISH } from "../schema/index.js";
import { fromOpenAIFinish, toOpenAIFinish } from "./finishReason.js";
import { toOpenAIUsage } from "./usage.js";
import { ollamaBodyToOpenAI } from "../response/ollama-to-openai.js";

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hasId = value => typeof value === "string" && value.length > 0;
const hasBlocks = value => Array.isArray(value) && value.every(block => isObject(block) && hasId(block.type));
const isGemini = format => [FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY, FORMATS.VERTEX].includes(format);

export class InvalidResponseError extends Error {
  constructor(reason = "unrecognized JSON envelope") {
    super(`Invalid upstream response: ${reason}`);
    this.name = "InvalidResponseError";
    this.status = 502;
    this.code = "invalid_upstream_response";
  }
}

// Validate structural evidence before adding compatibility fields or recording
// success. Known alternate envelopes are supported; arbitrary JSON is not.
export function validateResponseEnvelope(body, expectedFormat, { allowBackground = false } = {}) {
  if (!isObject(body) || body.error) throw new InvalidResponseError();
  if (body.object === "response") {
    const pendingBackground = allowBackground && body.background === true && ["queued", "in_progress"].includes(body.status);
    if (!hasId(body.id) || !hasId(body.model) || !hasBlocks(body.output) ||
        (!["completed", "incomplete"].includes(body.status) && !pendingBackground)) {
      throw new InvalidResponseError("malformed Responses envelope or unsuccessful status");
    }
    return FORMATS.OPENAI_RESPONSES;
  }
  if (body.type === RESPONSES_ITEM.MESSAGE) {
    if (!hasId(body.id) || !hasId(body.model) || body.role !== ROLE.ASSISTANT || !hasBlocks(body.content)) {
      throw new InvalidResponseError("malformed Anthropic Message");
    }
    return FORMATS.CLAUDE;
  }
  if (Array.isArray(body.choices) && body.choices.length > 0 && body.choices.every(choice => {
    const message = choice?.message;
    return isObject(message) && (message.role == null || message.role === ROLE.ASSISTANT) &&
      (typeof message.content === "string" || message.content === null || Array.isArray(message.content) ||
       Array.isArray(message.tool_calls) || typeof message.reasoning_content === "string" || isObject(message.function_call));
  })) {
    return FORMATS.OPENAI;
  }
  const gemini = body.response || body;
  if (!gemini.error && ((Array.isArray(gemini.candidates) && gemini.candidates.length > 0 && gemini.candidates.every(candidate =>
    (Array.isArray(candidate?.content?.parts) && candidate.content.parts.every(isObject)) ||
    (!candidate?.content && typeof candidate?.finishReason === "string"))) ||
    gemini.promptFeedback?.blockReason)) {
    return FORMATS.GEMINI;
  }
  if (expectedFormat === FORMATS.OLLAMA && isObject(body.message)) return FORMATS.OLLAMA;
  throw new InvalidResponseError();
}

function parseToolArguments(value) {
  if (value == null || value === "") return {};
  if (isObject(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (isObject(parsed)) return parsed;
  } catch { /* Fall through to the same safe contract failure. */ }
  throw new InvalidResponseError("tool arguments must encode a JSON object");
}

function rawCustomInput(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  try {
    const parsed = JSON.parse(text);
    if (isObject(parsed) && typeof parsed.input === "string") return parsed.input;
  } catch { /* A custom tool may use raw freeform input. */ }
  return text;
}

function completion(body, message, finishReason, usage) {
  return {
    id: body.id || body.responseId || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: body.created || body.created_at || Math.floor(Date.now() / 1000),
    model: body.model || body.modelVersion || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function withCalls(message, calls) {
  if (calls.length) message.tool_calls = calls;
  return message;
}

function claudeToChat(body) {
  let text = "", thinking = "";
  const calls = [];
  for (const block of body.content || []) {
    if (block.type === CLAUDE_BLOCK.TEXT) text += block.text || "";
    else if (block.type === CLAUDE_BLOCK.THINKING) thinking += block.thinking || "";
    else if (block.type === CLAUDE_BLOCK.TOOL_USE) calls.push({
      id: block.id, type: OPENAI_BLOCK.FUNCTION,
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    });
  }
  return completion(body, withCalls({ role: ROLE.ASSISTANT, content: text || (calls.length ? null : ""),
    ...(thinking ? { reasoning_content: thinking } : {}) }, calls),
  toOpenAIFinish(body.stop_reason, FORMATS.CLAUDE), toOpenAIUsage(body.usage, FORMATS.CLAUDE));
}

function geminiToChat(body) {
  const response = body.response || body;
  const candidate = response.candidates?.[0];
  let text = "", thinking = "";
  const calls = [];
  for (const part of candidate?.content?.parts || []) {
    if (part.thought === true && part.text) thinking += part.text;
    else if (typeof part.text === "string") text += part.text;
    if (part.functionCall) calls.push({
      id: part.functionCall.id || `call_${part.functionCall.name}_${Date.now()}_${calls.length}`,
      type: OPENAI_BLOCK.FUNCTION,
      function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
    });
    const image = part.inlineData || part.inline_data;
    if (image?.data) text += `\n![image](data:${image.mimeType || image.mime_type || "image/png"};base64,${image.data})\n`;
  }
  const reason = candidate ? toOpenAIFinish(candidate.finishReason, FORMATS.GEMINI) : OPENAI_FINISH.CONTENT_FILTER;
  return completion(response, withCalls({ role: ROLE.ASSISTANT, content: text || (calls.length ? null : ""),
    ...(thinking ? { reasoning_content: thinking } : {}) }, calls),
  calls.length && reason === OPENAI_FINISH.STOP ? OPENAI_FINISH.TOOL_CALLS : reason,
  toOpenAIUsage(response.usageMetadata || body.usageMetadata, FORMATS.GEMINI));
}

function responsesToChat(body) {
  let text = "", thinking = "";
  const calls = [];
  for (const item of body.output) {
    if (item.type === RESPONSES_ITEM.MESSAGE) {
      for (const block of item.content || []) if (typeof block.text === "string") text += block.text;
    } else if (item.type === RESPONSES_ITEM.REASONING) {
      thinking += (item.summary || []).map(block => block.text || "").join("");
    } else if ([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(item.type)) {
      calls.push({ id: item.call_id || item.id, type: OPENAI_BLOCK.FUNCTION, function: {
        name: item.name,
        arguments: item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL ? JSON.stringify({ input: item.input ?? "" })
          : typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      } });
    }
  }
  const rawUsage = body.usage;
  let usage;
  if (rawUsage) {
    const cacheRead = rawUsage.cache_read_input_tokens || rawUsage.cached_tokens || 0;
    const cacheCreate = rawUsage.cache_creation_input_tokens || 0;
    const input = (rawUsage.input_tokens || 0) + cacheRead + cacheCreate;
    usage = {
      prompt_tokens: input, completion_tokens: rawUsage.output_tokens || 0,
      total_tokens: input + (rawUsage.output_tokens || 0),
      ...(rawUsage.input_tokens_details ? { prompt_tokens_details: { ...rawUsage.input_tokens_details } } : {}),
      ...(rawUsage.output_tokens_details ? { completion_tokens_details: { ...rawUsage.output_tokens_details } } : {}),
    };
    if (cacheRead || cacheCreate) usage.prompt_tokens_details = {
      ...usage.prompt_tokens_details, cached_tokens: cacheRead, cache_creation_tokens: cacheCreate,
    };
  }
  const reason = body.status === "incomplete"
    ? body.incomplete_details?.reason === "content_filter" ? OPENAI_FINISH.CONTENT_FILTER : OPENAI_FINISH.LENGTH
    : calls.length ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP;
  return completion(body, withCalls({ role: ROLE.ASSISTANT, content: text || (calls.length ? null : ""),
    ...(thinking ? { reasoning_content: thinking } : {}) }, calls), reason, usage);
}

function toClaude(body) {
  const { message, finish_reason } = body.choices[0];
  const content = [];
  const thinking = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (thinking) content.push({ type: CLAUDE_BLOCK.THINKING, thinking });
  if (typeof message.content === "string" && message.content) content.push({ type: CLAUDE_BLOCK.TEXT, text: message.content });
  for (const call of message.tool_calls || []) content.push({
    type: CLAUDE_BLOCK.TOOL_USE, id: call.id || `toolu_${Date.now()}_${content.length}`,
    name: call.function?.name || call.name || "", input: parseToolArguments(call.function?.arguments ?? call.arguments),
  });
  if (!content.length) content.push({ type: CLAUDE_BLOCK.TEXT, text: "" });
  const usage = body.usage || {};
  const cacheRead = usage.prompt_tokens_details?.cached_tokens || 0;
  const cacheCreate = usage.prompt_tokens_details?.cache_creation_tokens || 0;
  const reason = message.tool_calls?.length && ![OPENAI_FINISH.LENGTH, OPENAI_FINISH.CONTENT_FILTER].includes(finish_reason)
    ? OPENAI_FINISH.TOOL_CALLS : finish_reason;
  return {
    id: String(body.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""), type: RESPONSES_ITEM.MESSAGE,
    role: ROLE.ASSISTANT, model: body.model || "unknown", content,
    stop_reason: fromOpenAIFinish(reason, FORMATS.CLAUDE), stop_sequence: null,
    usage: { input_tokens: Math.max(0, (usage.prompt_tokens || 0) - cacheRead - cacheCreate), output_tokens: usage.completion_tokens || 0,
      ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}), ...(cacheCreate ? { cache_creation_input_tokens: cacheCreate } : {}) },
  };
}

function toResponses(body, customToolNames) {
  const names = customToolNames instanceof Set ? customToolNames : new Set(Array.isArray(customToolNames) ? customToolNames : []);
  const { message, finish_reason } = body.choices[0];
  const output = [];
  const thinking = message.reasoning_content || message.reasoning;
  if (typeof thinking === "string" && thinking) output.push({ type: RESPONSES_ITEM.REASONING, summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: thinking }] });
  if (typeof message.content === "string" && message.content) output.push({ type: RESPONSES_ITEM.MESSAGE, role: ROLE.ASSISTANT,
    content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text: message.content, annotations: [] }] });
  for (const call of message.tool_calls || []) {
    const fn = call.function || {};
    const custom = names.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${call.id || ""}`, call_id: call.id || "", name: fn.name || "",
      ...(custom ? { input: rawCustomInput(fn.arguments) } : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) }),
    });
  }
  const usage = body.usage || {};
  const incomplete = [OPENAI_FINISH.LENGTH, OPENAI_FINISH.CONTENT_FILTER].includes(finish_reason);
  return {
    id: `resp_${body.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"), object: "response",
    created_at: body.created || Math.floor(Date.now() / 1000), model: body.model || "unknown",
    status: incomplete ? "incomplete" : "completed", background: false, error: null, output,
    ...(incomplete ? { incomplete_details: { reason: finish_reason === OPENAI_FINISH.LENGTH ? "max_output_tokens" : "content_filter" } } : {}),
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      ...(usage.prompt_tokens_details ? { input_tokens_details: { ...usage.prompt_tokens_details } } : {}),
      ...(usage.completion_tokens_details ? { output_tokens_details: { ...usage.completion_tokens_details } } : {}) },
  };
}

function toGemini(body, sourceFormat) {
  const { message, finish_reason } = body.choices[0];
  const parts = [];
  if (message.reasoning_content) parts.push({ text: message.reasoning_content, thought: true });
  if (typeof message.content === "string" && message.content) parts.push({ text: message.content });
  for (const call of message.tool_calls || []) parts.push({ functionCall: { id: call.id, name: call.function?.name, args: parseToolArguments(call.function?.arguments) } });
  const usage = body.usage || {};
  const response = { candidates: [{ index: 0, content: { role: GEMINI_ROLE.MODEL, parts },
    finishReason: finish_reason === OPENAI_FINISH.LENGTH ? GEMINI_FINISH.MAX_TOKENS
      : finish_reason === OPENAI_FINISH.CONTENT_FILTER ? GEMINI_FINISH.SAFETY : GEMINI_FINISH.STOP }],
  modelVersion: body.model, responseId: body.id,
  usageMetadata: { promptTokenCount: usage.prompt_tokens || 0, candidatesTokenCount: usage.completion_tokens || 0,
    totalTokenCount: usage.total_tokens || 0 } };
  return [FORMATS.ANTIGRAVITY, FORMATS.GEMINI_CLI].includes(sourceFormat) ? { response } : response;
}

export function normalizeNonStreamingResponse(body, upstreamFormat, clientFormat, customToolNames = null, { allowBackground = false } = {}) {
  // Some Claude-compatible M3 providers return null after spending the entire
  // token budget on thinking. Preserve that identified result, but emit valid
  // array content and do not change the caller's body or accept unrelated nulls.
  if (body?.type === RESPONSES_ITEM.MESSAGE && hasId(body.id) && hasId(body.model) &&
      body.role === ROLE.ASSISTANT && body.stop_reason === CLAUDE_STOP.MAX_TOKENS && body.content === null) {
    body = { ...body, content: [] };
  }
  const actualFormat = validateResponseEnvelope(body, upstreamFormat, {
    allowBackground: allowBackground && upstreamFormat === FORMATS.OPENAI_RESPONSES && clientFormat === FORMATS.OPENAI_RESPONSES,
  });
  if (actualFormat === clientFormat) return body;
  if (actualFormat === FORMATS.GEMINI && isGemini(clientFormat)) {
    return [FORMATS.ANTIGRAVITY, FORMATS.GEMINI_CLI].includes(clientFormat)
      ? body.response ? body : { response: body } : body.response || body;
  }
  const chat = actualFormat === FORMATS.CLAUDE ? claudeToChat(body)
    : actualFormat === FORMATS.GEMINI ? geminiToChat(body)
      : actualFormat === FORMATS.OPENAI_RESPONSES ? responsesToChat(body)
        : actualFormat === FORMATS.OLLAMA ? ollamaBodyToOpenAI(body) : body;
  if (clientFormat === FORMATS.CLAUDE) return toClaude(chat);
  if (clientFormat === FORMATS.OPENAI_RESPONSES) return toResponses(chat, customToolNames);
  if (isGemini(clientFormat)) return toGemini(chat, clientFormat);
  return chat;
}
