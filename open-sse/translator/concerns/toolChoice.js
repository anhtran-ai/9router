import { ToolCompatibilityError, resolveHostedTool } from "./hostedToolPolicy.js";

// Preserve declaration identity inside the synchronous Responses → Chat pivot.
// A history-only custom name must not authorize a same-named function selector.
const customWrappers = new WeakSet();
export function markCustomToolWrapper(tool) {
  customWrappers.add(tool);
  return tool;
}
export function isCustomToolWrapper(tool) {
  return customWrappers.has(tool);
}

function identity(tool) {
  if (!tool || typeof tool !== "object") return {};
  if (customWrappers.has(tool)) return { type: "custom", name: tool.function?.name };
  if (tool.type === "custom") return { type: "custom", name: tool.custom?.name || tool.name };
  if (tool.type === "function" || tool.function || (!tool.type && tool.name)) {
    return { type: "function", name: tool.function?.name || tool.name };
  }
  return { type: resolveHostedTool(tool.type) || tool.type, name: tool.name, server_label: tool.server_label };
}

function unsupported(reason) {
  throw new ToolCompatibilityError(reason);
}

export function rejectNativeCustomTools(body) {
  if ((Array.isArray(body.tools) && body.tools.some(tool => tool?.type === "custom")) ||
    (Array.isArray(body.messages) && body.messages.some(message =>
      Array.isArray(message.tool_calls) && message.tool_calls.some(call => call?.type === "custom")))) {
    unsupported("native Chat custom calls require a Chat target with compatible response semantics");
  }
}

function parseChoice(choice) {
  if (choice === undefined || choice === null) return null;
  if (typeof choice === "string") {
    if (["auto", "none", "required"].includes(choice)) return { mode: choice };
    unsupported("unrecognized tool selection mode");
  }
  if (typeof choice !== "object") unsupported("invalid tool selection");
  if (["auto", "none", "any"].includes(choice.type)) {
    return { mode: choice.type === "any" ? "required" : choice.type };
  }
  if (choice.type === "allowed_tools") {
    const allowed = choice.allowed_tools || choice;
    if (!["auto", "required"].includes(allowed.mode) || !Array.isArray(allowed.tools) || !allowed.tools.length) {
      unsupported("invalid or empty allowed tool subset");
    }
    return { mode: allowed.mode, selectors: allowed.tools, forced: false };
  }
  return { mode: "required", selectors: [choice], forced: true };
}

function matchSelector(selector, bindings) {
  if (!selector || typeof selector !== "object") unsupported("invalid tool selector");
  const type = selector.type;
  const name = selector.function?.name || selector.custom?.name || selector.name;
  if (["function", "custom", "tool"].includes(type) && (typeof name !== "string" || !name)) {
    unsupported("named tool selector requires a name");
  }
  const canonical = ["function", "custom", "tool"].includes(type) ? type : resolveHostedTool(type);
  if (!canonical) unsupported("unrecognized tool selector");
  const matches = bindings.filter(({ source }) => {
    const candidate = identity(source);
    if (type === "tool") return candidate.name === name;
    if (candidate.type !== canonical) return false;
    if (canonical === "function" || canonical === "custom") return candidate.name === name;
    return canonical !== "mcp" || !selector.server_label || candidate.server_label === selector.server_label;
  });
  if (matches.length !== 1 || !matches[0].target) {
    unsupported("selected tool is unavailable or ambiguous on the target");
  }
  return matches[0];
}

function responsesSelector(binding, sourceSelector) {
  const tool = binding.target;
  const target = identity(tool);
  if (target.type === "function" || target.type === "custom") return { type: target.type, name: target.name };
  return {
    type: tool.type,
    ...(target.type === "mcp" && sourceSelector.server_label ? { server_label: sourceSelector.server_label } : {}),
    ...(target.type === "mcp" && sourceSelector.name ? { name: sourceSelector.name } : {}),
  };
}

// Bind source declarations to their rendered counterparts before translating a
// constraint. Dropped tools and name collisions must never turn into unrestricted auto.
export function translateToolChoice(choice, bindings, target) {
  const parsed = parseChoice(choice);
  const tools = bindings.map(binding => binding.target).filter(Boolean);
  if (!parsed) return { tools };
  if (target === "gemini" && parsed.mode !== "none" && choice?.disable_parallel_tool_use === true && tools.length) {
    unsupported("Gemini cannot enforce disabled parallel tool calling");
  }
  if (parsed.mode === "required" && !tools.length) unsupported("required tool calling has no compatible target tool");
  const selected = parsed.selectors?.map(selector => matchSelector(selector, bindings));
  if (selected && target !== "responses") {
    const chosenNames = new Set(selected.map(binding => binding.target.name));
    for (const name of chosenNames) {
      if (!name || tools.filter(tool => tool.name === name).length !== 1) {
        unsupported("selected tool name is ambiguous after translation");
      }
    }
  }
  if (target === "responses") {
    const selectors = selected?.map((binding, index) => responsesSelector(binding, parsed.selectors[index]));
    return { tools, choice: selectors
      ? parsed.forced ? selectors[0] : { type: "allowed_tools", mode: parsed.mode, tools: selectors }
      : parsed.mode };
  }
  if (target === "claude") {
    const disableParallel = typeof choice === "object" && choice?.disable_parallel_tool_use !== undefined
      ? { disable_parallel_tool_use: choice.disable_parallel_tool_use } : {};
    return {
      tools: selected && !parsed.forced ? tools.filter(tool => selected.some(binding => binding.target === tool)) : tools,
      choice: parsed.forced
        ? { type: "tool", name: selected[0].target.name, ...disableParallel }
        : { type: parsed.mode === "required" ? "any" : parsed.mode, ...disableParallel },
    };
  }
  return {
    tools,
    choice: { functionCallingConfig: {
      mode: parsed.mode === "none" ? "NONE" : parsed.mode === "required" ? "ANY" : selected ? "VALIDATED" : "AUTO",
      ...(selected ? { allowedFunctionNames: [...new Set(selected.map(binding => binding.target.name))] } : {}),
    } },
  };
}

export function geminiToolChoiceToChat(config, tools) {
  if (!config) return undefined;
  const mode = config.mode || "AUTO";
  if (mode === "NONE") return "none";
  if (!["AUTO", "ANY", "VALIDATED"].includes(mode)) unsupported("unrecognized Gemini tool selection mode");
  if (config.allowedFunctionNames !== undefined && !Array.isArray(config.allowedFunctionNames)) {
    unsupported("invalid Gemini allowed function subset");
  }
  const names = config.allowedFunctionNames || [];
  if (!names.length) return mode === "ANY" ? "required" : "auto";
  if (mode === "AUTO" || names.some(name => !tools?.some(tool => tool.function?.name === name))) {
    unsupported("Gemini allowed function subset is unavailable");
  }
  return { type: "allowed_tools", allowed_tools: {
    mode: mode === "ANY" ? "required" : "auto",
    tools: names.map(name => ({ type: "function", function: { name } })),
  } };
}
