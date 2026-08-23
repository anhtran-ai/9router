import { CLAUDE_BLOCK, ROLE } from "../schema/index.js";

const ASSISTANT_CONTINUATION_PROMPT = "Continue from the assistant response above without repeating it.";
const PRESERVE_HEADER = "x-9router-assistant-prefill";

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);

  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function hasBlock(content, type) {
  return Array.isArray(content) && content.some(block => block?.type === type);
}

function hasText(content) {
  if (typeof content === "string") return !!content.trim();
  return Array.isArray(content) && content.some(block =>
    block?.type === CLAUDE_BLOCK.TEXT && block.text?.trim()
  );
}

export function applyAssistantPrefillPolicy(body, rawHeaders = null) {
  if (!Array.isArray(body?.messages)) return body;
  if (String(getHeader(rawHeaders, PRESERVE_HEADER) || "").toLowerCase() === "preserve") return body;

  const trailingAssistant = body.messages.at(-1);
  if (trailingAssistant?.role !== ROLE.ASSISTANT) return body;
  if (hasBlock(trailingAssistant.content, CLAUDE_BLOCK.TOOL_USE)) return body;

  if (!hasText(trailingAssistant.content)) {
    body.messages.pop();
    return body;
  }

  body.messages.push({
    role: ROLE.USER,
    content: [{ type: CLAUDE_BLOCK.TEXT, text: ASSISTANT_CONTINUATION_PROMPT }],
  });
  return body;
}
