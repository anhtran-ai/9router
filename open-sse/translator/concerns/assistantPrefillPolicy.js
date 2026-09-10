import { CLAUDE_BLOCK, ROLE } from "../schema/index.js";
import { isValidClaudeSignature } from "../../utils/claudeSignature.js";

// Vertex-backed Claude routes (Antigravity) reject a conversation whose last
// message is an assistant turn:
//
//   400 invalid_request_error
//   "This model does not support assistant message prefill.
//    The conversation must end with a user message."
//
// Agentic clients (Claude Code, Cowork) legitimately send such a trailing
// assistant turn when resuming, so the request must be repaired rather than
// refused. Dropping the turn unconditionally is lossy: it can discard an
// unresolved tool_use, provider-signed reasoning, or a server tool block that
// the next turn still depends on.
//
// This policy restores the terminal-user invariant while preserving whatever
// carries meaning:
//
//   trailing tool_use        -> append synthetic error tool_result (keeps pairing)
//   signed/redacted thinking -> keep the turn, append a user continuation
//   server_tool_use          -> keep the turn, append a user continuation
//   text-only                -> keep the turn, append a user continuation
//   empty / unsigned only    -> drop the turn (nothing recoverable)

const ASSISTANT_CONTINUATION_PROMPT = "Continue from the assistant response above without repeating it.";
const INCOMPLETE_TOOL_RESULT = "Tool execution was not completed before this request continued.";

function hasText(content) {
  if (typeof content === "string") return !!content.trim();
  return Array.isArray(content) && content.some(block =>
    block?.type === CLAUDE_BLOCK.TEXT && block.text?.trim()
  );
}

// Signed reasoning is provider-owned history and redacted_thinking is an opaque
// blob that cannot be regenerated, so a turn holding one must survive. Unsigned
// or foreign-signature thinking is intentionally not preserved: Anthropic
// rejects it and the existing cleanup passes already drop it.
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

/**
 * Ensure a Claude Messages conversation ends with a user turn.
 *
 * Mutates and returns `body`. Safe to call on any request shape: a body without
 * a messages array, or one that already ends with a user turn, is returned
 * unchanged.
 *
 * @param {object} body Claude Messages request body
 * @returns {object} the same body, with the terminal-user invariant restored
 */
export function applyAssistantPrefillPolicy(body) {
  if (!Array.isArray(body?.messages)) return body;

  const trailingAssistant = body.messages.at(-1);
  if (trailingAssistant?.role !== ROLE.ASSISTANT) return body;

  // An unresolved tool_use must keep its pairing, otherwise the next request is
  // structurally invalid. Close each one with an explicit error tool_result.
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

  if (hasServerToolUse(trailingAssistant.content) || hasPreservableReasoning(trailingAssistant.content)) {
    body.messages.push({
      role: ROLE.USER,
      content: [{ type: CLAUDE_BLOCK.TEXT, text: ASSISTANT_CONTINUATION_PROMPT }],
    });
    return body;
  }

  // Nothing recoverable in the turn, so removing it loses no information.
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
