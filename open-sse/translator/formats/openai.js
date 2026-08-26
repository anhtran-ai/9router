// OpenAI helper functions for translator
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK, VALID_OPENAI_CONTENT_TYPES, VALID_OPENAI_MESSAGE_TYPES } from "../schema/index.js";
import { isHostedTool } from "../concerns/hostedToolPolicy.js";

// Re-export valid-type lists (moved to schema/blocks.js) to keep existing importers working.
export { VALID_OPENAI_CONTENT_TYPES, VALID_OPENAI_MESSAGE_TYPES };

// Select only declarations retained at the final Chat Completions boundary.
// Responses custom tools wrapped as functions must use the same wrapper here.
function toChatToolSelector(choice, body) {
  if (!choice || typeof choice !== "object") return null;
  let type = choice.type;
  const name = choice.function?.name || choice.custom?.name || choice.name;
  if (type === OPENAI_BLOCK.CUSTOM && body._customToolNames?.includes(name)) {
    type = OPENAI_BLOCK.FUNCTION;
  }
  if (type !== OPENAI_BLOCK.FUNCTION && type !== OPENAI_BLOCK.CUSTOM) return null;
  if (!name || !body.tools?.some(tool => tool.type === type && tool[type]?.name === name)) return null;
  return { type, [type]: { name } };
}

// Filter messages to OpenAI standard format
// Remove: thinking, redacted_thinking, signature, and other non-OpenAI blocks
// opts.preserveCacheControl: keep cache_control on content blocks (e.g. for DashScope/alicode)
export function filterToOpenAIFormat(body, opts = {}) {
  if (!body.messages || !Array.isArray(body.messages)) return body;
  const keepCache = !!opts.preserveCacheControl;

  function stripBlock(block) {
    const { signature, cache_control, ...rest } = block;
    return keepCache && cache_control ? { ...rest, cache_control } : rest;
  }

  body.messages = body.messages.map(msg => {
    // Normalize developer role to system (many providers don't support developer)
    if (msg.role === ROLE.DEVELOPER) msg = { ...msg, role: ROLE.SYSTEM };

    // Keep tool messages as-is (OpenAI format)
    if (msg.role === ROLE.TOOL) return msg;

    // Keep assistant messages with tool_calls as-is
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) return msg;

    // Handle string content
    if (typeof msg.content === "string") return msg;

    // Handle array content
    if (Array.isArray(msg.content)) {
      const filteredContent = [];

      for (const block of msg.content) {
        // Skip thinking blocks
        if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) continue;

        // Only keep valid OpenAI content types
        if (VALID_OPENAI_CONTENT_TYPES.includes(block.type)) {
          filteredContent.push(stripBlock(block));
        } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
          // Convert tool_use to tool_calls format (handled separately)
          continue;
        } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
          // Keep tool_result but clean it
          filteredContent.push(stripBlock(block));
        }
      }
      
      // If all content was filtered, add empty text
      if (filteredContent.length === 0) {
        filteredContent.push({ type: OPENAI_BLOCK.TEXT, text: "" });
      }
      
      return { ...msg, content: filteredContent };
    }
    
    return msg;
  });
  
  // Filter out messages with only empty text (but NEVER filter tool messages)
  body.messages = body.messages.filter(msg => {
    // Always keep tool messages
    if (msg.role === ROLE.TOOL) return true;
    // Always keep assistant messages with tool_calls
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) return true;
    
    if (typeof msg.content === "string") return msg.content.trim() !== "";
    if (Array.isArray(msg.content)) {
      return msg.content.some(b => 
        (b.type === OPENAI_BLOCK.TEXT && b.text?.trim()) ||
        b.type !== OPENAI_BLOCK.TEXT
      );
    }
    return true;
  });

  // Remove empty tools array (some providers like QWEN reject it)
  if (body.tools && Array.isArray(body.tools) && body.tools.length === 0) {
    delete body.tools;
  }

  // Normalize tools to OpenAI format (from Claude, Gemini, etc.)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    body.tools = body.tools.map(tool => {
      if (!tool || typeof tool !== "object") return null;
      // Already OpenAI format
      if (tool.type === OPENAI_BLOCK.FUNCTION && tool.function) return tool;
      if (tool.type === OPENAI_BLOCK.CUSTOM && tool.custom) return tool;

      // Claude or flattened Responses function declaration.
      // An explicit client schema/description wins over a bare name alias.
      if (tool.name && (tool.type === OPENAI_BLOCK.FUNCTION || (!tool.type && (tool.input_schema || tool.description)))) {
        return {
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name: tool.name,
            description: String(tool.description || ""),
            parameters: tool.parameters || tool.input_schema || { type: "object", properties: {} },
            ...(tool.strict === undefined ? {} : { strict: tool.strict }),
          }
        };
      }

      // Hosted declarations remain in the pivot for Claude/Responses targets,
      // but Chat Completions supports only client function/custom declarations.
      if (isHostedTool(tool)) return null;
      
      // Gemini format: {functionDeclarations: [{name, description, parameters}]}
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        return tool.functionDeclarations.map(fn => ({
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name: fn.name,
            description: String(fn.description || ""),
            parameters: fn.parameters || { type: "object", properties: {} }
          }
        }));
      }
      
      return null;
    }).flat().filter(Boolean);
  }

  // Normalize tool_choice to OpenAI format
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const choice = body.tool_choice;
    // Claude format: {type: "auto|any|tool", name?: "..."}
    if (choice.type === "auto") {
      body.tool_choice = "auto";
    } else if (choice.type === "any") {
      body.tool_choice = "required";
    } else if (choice.type === "tool" && choice.name) {
      body.tool_choice = { type: OPENAI_BLOCK.FUNCTION, function: { name: choice.name } };
    }
  }

  // A filtered tool must not leave a dangling forced/allowed selector behind.
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const choice = body.tool_choice;
    const allowed = choice.allowed_tools || (Array.isArray(choice.tools) ? choice : null);
    if (allowed) {
      const tools = (allowed.tools || []).map(tool => toChatToolSelector(tool, body)).filter(Boolean);
      if (tools.length > 0) {
        body.tool_choice = { type: choice.type, allowed_tools: { mode: allowed.mode, tools } };
      } else {
        // Do not widen an empty allowed subset to unrelated tools via auto.
        body.tool_choice = "none";
      }
    } else {
      const selector = toChatToolSelector(choice, body);
      if (selector) body.tool_choice = selector;
      else body.tool_choice = "none";
    }
  }
  if (!body.tools?.length) {
    delete body.tools;
    delete body.tool_choice;
  }

  return body;
}

