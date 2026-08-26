export const HOSTED_TOOL = {
  WEB_SEARCH: "web_search",
  WEB_FETCH: "web_fetch",
  CODE_EXECUTION: "code_execution",
  FILE_SEARCH: "file_search",
  IMAGE_GENERATION: "image_generation",
  COMPUTER: "computer",
  LOCAL_SHELL: "local_shell",
  TOOL_SEARCH: "tool_search",
  MCP: "mcp",
  BASH: "bash",
  TEXT_EDITOR: "text_editor",
  MEMORY: "memory",
};

const EXACT_ALIASES = new Map([
  ["web_search", HOSTED_TOOL.WEB_SEARCH],
  ["web_search_preview", HOSTED_TOOL.WEB_SEARCH],
  ["web_search_preview_2025_03_11", HOSTED_TOOL.WEB_SEARCH],
  ["web_fetch", HOSTED_TOOL.WEB_FETCH],
  ["code_interpreter", HOSTED_TOOL.CODE_EXECUTION],
  ["code_execution", HOSTED_TOOL.CODE_EXECUTION],
  ["file_search", HOSTED_TOOL.FILE_SEARCH],
  ["image_generation", HOSTED_TOOL.IMAGE_GENERATION],
  ["computer", HOSTED_TOOL.COMPUTER],
  ["computer_use_preview", HOSTED_TOOL.COMPUTER],
  ["local_shell", HOSTED_TOOL.LOCAL_SHELL],
  ["tool_search", HOSTED_TOOL.TOOL_SEARCH],
  ["mcp", HOSTED_TOOL.MCP],
  ["mcp_toolset", HOSTED_TOOL.MCP],
  ["bash", HOSTED_TOOL.BASH],
  ["text_editor", HOSTED_TOOL.TEXT_EDITOR],
  ["memory", HOSTED_TOOL.MEMORY],
]);

const PREFIX_ALIASES = [
  ["tool_search_tool_", HOSTED_TOOL.TOOL_SEARCH],
  ["code_execution_", HOSTED_TOOL.CODE_EXECUTION],
  ["web_search_", HOSTED_TOOL.WEB_SEARCH],
  ["web_fetch_", HOSTED_TOOL.WEB_FETCH],
  ["computer_toolset_", HOSTED_TOOL.COMPUTER],
  ["computer_", HOSTED_TOOL.COMPUTER],
  ["text_editor_", HOSTED_TOOL.TEXT_EDITOR],
  ["bash_", HOSTED_TOOL.BASH],
  ["memory_", HOSTED_TOOL.MEMORY],
];

const NAME_ALIASES = new Map([
  ["web_search", HOSTED_TOOL.WEB_SEARCH],
  ["web_fetch", HOSTED_TOOL.WEB_FETCH],
  ["code_execution", HOSTED_TOOL.CODE_EXECUTION],
  ["str_replace_based_edit_tool", HOSTED_TOOL.TEXT_EDITOR],
  ["bash", HOSTED_TOOL.BASH],
  ["memory", HOSTED_TOOL.MEMORY],
]);

function normalizeKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function resolveHostedTool(type, name = "") {
  const key = normalizeKey(type);
  if (key) {
    const exact = EXACT_ALIASES.get(key);
    if (exact) return exact;
    for (const [prefix, canonical] of PREFIX_ALIASES) {
      if (key.startsWith(prefix)) return canonical;
    }
  }

  const nameKey = normalizeKey(name);
  if (nameKey && NAME_ALIASES.has(nameKey)) return NAME_ALIASES.get(nameKey) || null;
  return null;
}

const CODEX_FIELDS = {
  [HOSTED_TOOL.WEB_SEARCH]: ["search_context_size", "user_location", "filters"],
  [HOSTED_TOOL.FILE_SEARCH]: ["vector_store_ids", "max_num_results", "ranking_options", "filters"],
  [HOSTED_TOOL.IMAGE_GENERATION]: ["background", "input_fidelity", "model", "moderation", "output_compression", "output_format", "partial_images", "quality", "size"],
  [HOSTED_TOOL.CODE_EXECUTION]: ["container"],
  [HOSTED_TOOL.COMPUTER]: ["display_width", "display_height", "environment"],
  [HOSTED_TOOL.LOCAL_SHELL]: [],
  [HOSTED_TOOL.TOOL_SEARCH]: [],
  [HOSTED_TOOL.MCP]: ["server_label", "server_url", "server_description", "connector_id", "authorization", "allowed_tools", "require_approval", "headers"],
};

const CODEX_TYPES = {
  [HOSTED_TOOL.WEB_SEARCH]: "web_search",
  [HOSTED_TOOL.FILE_SEARCH]: "file_search",
  [HOSTED_TOOL.IMAGE_GENERATION]: "image_generation",
  [HOSTED_TOOL.CODE_EXECUTION]: "code_interpreter",
  [HOSTED_TOOL.COMPUTER]: "computer",
  [HOSTED_TOOL.LOCAL_SHELL]: "local_shell",
  [HOSTED_TOOL.TOOL_SEARCH]: "tool_search",
  [HOSTED_TOOL.MCP]: "mcp",
};

const CLAUDE_TYPES = {
  [HOSTED_TOOL.WEB_SEARCH]: "web_search_20250305",
  [HOSTED_TOOL.WEB_FETCH]: "web_fetch_20250910",
  [HOSTED_TOOL.CODE_EXECUTION]: "code_execution_20250522",
  [HOSTED_TOOL.COMPUTER]: "computer_20250124",
  [HOSTED_TOOL.TOOL_SEARCH]: "tool_search_tool_regex_20251119",
};

const CLAUDE_NAMES = {
  [HOSTED_TOOL.WEB_SEARCH]: "web_search",
  [HOSTED_TOOL.WEB_FETCH]: "web_fetch",
  [HOSTED_TOOL.CODE_EXECUTION]: "code_execution",
  [HOSTED_TOOL.COMPUTER]: "computer",
  [HOSTED_TOOL.TOOL_SEARCH]: "tool_search_tool_regex",
};

const CLAUDE_NATIVE_PREFIXES = {
  [HOSTED_TOOL.WEB_SEARCH]: ["web_search_"],
  [HOSTED_TOOL.WEB_FETCH]: ["web_fetch_"],
  [HOSTED_TOOL.CODE_EXECUTION]: ["code_execution_"],
  [HOSTED_TOOL.COMPUTER]: ["computer_", "computer_toolset_"],
  [HOSTED_TOOL.TOOL_SEARCH]: ["tool_search_tool_"],
  [HOSTED_TOOL.BASH]: ["bash_"],
  [HOSTED_TOOL.TEXT_EDITOR]: ["text_editor_"],
  [HOSTED_TOOL.MEMORY]: ["memory_"],
};

const CLAUDE_FIELDS = {
  [HOSTED_TOOL.WEB_SEARCH]: ["max_uses", "allowed_domains", "blocked_domains", "user_location", "cache_control"],
  [HOSTED_TOOL.WEB_FETCH]: ["max_uses", "allowed_domains", "blocked_domains", "citations", "max_content_tokens", "cache_control"],
  [HOSTED_TOOL.CODE_EXECUTION]: ["cache_control"],
  [HOSTED_TOOL.COMPUTER]: ["display_width_px", "display_height_px", "display_number", "cache_control"],
  [HOSTED_TOOL.TOOL_SEARCH]: ["defer_loading", "cache_control"],
};

function pickFields(tool, allowed) {
  const out = {};
  for (const field of allowed) {
    if (tool[field] !== undefined) out[field] = tool[field];
  }
  return out;
}

export function renderHostedToolForCodex(tool) {
  const canonical = resolveHostedTool(tool?.type, tool?.name);
  if (!canonical) return null;
  const type = CODEX_TYPES[canonical];
  if (!type) return null;
  if (canonical === HOSTED_TOOL.MCP && normalizeKey(tool?.type) === "mcp_toolset") return null;
  return { type, ...pickFields(tool, CODEX_FIELDS[canonical] || []) };
}

export function renderHostedToolForClaude(tool) {
  const canonical = resolveHostedTool(tool?.type, tool?.name);
  if (!canonical) return null;
  const requested = normalizeKey(tool?.type);
  const nativePrefixes = CLAUDE_NATIVE_PREFIXES[canonical] || [];
  const isNativeAnthropicType = requested === "mcp_toolset"
    || nativePrefixes.some((prefix) => requested.startsWith(prefix) && /_\d{8}$/.test(requested));
  if (isNativeAnthropicType) return { ...tool };

  const fallbackType = CLAUDE_TYPES[canonical];
  if (!fallbackType) return null;

  const rendered = {
    type: fallbackType,
    name: CLAUDE_NAMES[canonical],
    ...pickFields(tool, CLAUDE_FIELDS[canonical] || []),
  };
  if (canonical === HOSTED_TOOL.COMPUTER) {
    if (tool.display_width !== undefined) rendered.display_width_px = tool.display_width;
    if (tool.display_height !== undefined) rendered.display_height_px = tool.display_height;
    if (rendered.display_number === undefined) rendered.display_number = 1;
  }
  return rendered;
}

export function isHostedTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
  if (tool.type === "function" || tool.function) return false;
  return resolveHostedTool(tool.type, tool.name) !== null;
}
