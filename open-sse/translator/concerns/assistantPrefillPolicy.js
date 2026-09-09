import { CLAUDE_BLOCK, ROLE } from "../schema/index.js";
import { isValidClaudeSignature } from "../../utils/claudeSignature.js";

const ASSISTANT_CONTINUATION_PROMPT = "Continue from the assistant response above without repeating it.";
const INCOMPLETE_TOOL_RESULT = "Tool execution was not completed before this request continued.";
const PRESERVE_HEADER = "x-9router-assistant-prefill";

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);

  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function hasText(content) {
  if (typeof content === "string") return !!content.trim();
  return Array.isArray(content) && content.some(block =>
    block?.type === CLAUDE_BLOCK.TEXT && block.text?.trim()
  );
}

// Signed reasoning is provider-owned history, and redacted_thinking is an
// opaque blob that cannot be regenerated. A trailing turn holding such a block
// must keep it and gain a user boundary rather than being dropped. Unsigned or
// foreign-signature thinking is still discarded — Anthropic rejects it, and the
// surrounding cleanup passes drop it anyway.
function hasPreservableReasoning(content) {
  return Array.isArray(content) && content.some(block =>
    block?.type === CLAUDE_BLOCK.REDACTED_THINKING ||
    (block?.type === CLAUDE_BLOCK.THINKING && isValidClaudeSignature(block.signature))
  );
}

function hasServerToolUse(content) {
  return Array.isArray(content) && content.some(block =>
    block?.type === CLAUDE_BLOCK.SERVER_TOOL_USE && block.id
  );
}

export function applyAssistantPrefillPolicy(body, rawHeaders = null) {
  if (!Array.isArray(body?.messages)) return body;
  // Explicit compatibility escape hatch: preserving assistant prefill bypasses
  // the Claude terminal-user invariant and can reproduce upstream HTTP 400s.
  if (String(getHeader(rawHeaders, PRESERVE_HEADER) || "").toLowerCase() === "preserve") return body;

  const trailingAssistant = body.messages.at(-1);
  if (trailingAssistant?.role !== ROLE.ASSISTANT) return body;

  const toolUses = Array.isArray(trailingAssistant.content)
    ? trailingAssistant.content.filter(block => block?.type === CLAUDE_BLOCK.TOOL_USE && block.id)
    : [];
  if (toolUses.length > 0) {
    body.messages.push({
      role: ROLE.USER,
      content: toolUses.map(toolUse => ({
        type: CLAUDE_BLOCK.TOOL_RESULT,
        tool_use_id: toolUse.id,
        is_error: true,
        content: INCOMPLETE_TOOL_RESULT,
      })),
    });
    return body;
  }

  // A valid Anthropic server tool block or reasoning block is provider-owned
  // history. Keep it, but still restore the terminal-user invariant used for
  // the next request.
  if (hasServerToolUse(trailingAssistant.content) || hasPreservableReasoning(trailingAssistant.content)) {
    body.messages.push({
      role: ROLE.USER,
      content: [{ type: CLAUDE_BLOCK.TEXT, text: ASSISTANT_CONTINUATION_PROMPT }],
    });
    return body;
  }

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
