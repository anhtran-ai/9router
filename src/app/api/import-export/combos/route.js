import { NextResponse } from "next/server";
import { getCombos, getSettings, importComboItems } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";
import { readRequestJson, RequestBodyError } from "open-sse/utils/requestBody.js";

export const dynamic = "force-dynamic";

const FORMAT = "9router-combos";
const FORMAT_VERSION = 1;
const MAX_ITEMS = 500;
const MAX_MODELS_PER_COMBO = 200;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;
const VALID_STRATEGIES = new Set(["fallback", "round-robin", "fusion"]);

async function readJsonWithLimit(request) {
  return readRequestJson(request, {
    maxBytes: MAX_BODY_BYTES,
    label: "Import payload",
    requireBody: true,
  });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exportStrategy(raw) {
  const fallbackStrategy = VALID_STRATEGIES.has(raw?.fallbackStrategy)
    ? raw.fallbackStrategy
    : "fallback";
  const result = { fallbackStrategy };
  if (fallbackStrategy === "fusion" && typeof raw?.judgeModel === "string" && raw.judgeModel.trim()) {
    result.judgeModel = raw.judgeModel.trim();
  }
  return result;
}

function normalizeStrategy(raw) {
  if (!isRecord(raw)) throw new Error("Combo settings must be an object");
  const fallbackStrategy = raw.fallbackStrategy || "fallback";
  if (!VALID_STRATEGIES.has(fallbackStrategy)) {
    throw new Error(`Unsupported strategy: ${fallbackStrategy}`);
  }
  const result = {};
  if (fallbackStrategy !== "fallback") result.fallbackStrategy = fallbackStrategy;
  if (fallbackStrategy === "fusion" && raw.judgeModel !== undefined) {
    if (typeof raw.judgeModel !== "string" || raw.judgeModel.length > 500) {
      throw new Error("Judge model must be a string of 500 characters or fewer");
    }
    if (raw.judgeModel.trim()) result.judgeModel = raw.judgeModel.trim();
  }
  return result;
}

function strategyForItem(item, name, strategyMap, strategyMapProvided) {
  if (Object.prototype.hasOwnProperty.call(item, "settings")) {
    return { provided: true, value: normalizeStrategy(item.settings) };
  }
  if (Object.prototype.hasOwnProperty.call(item, "strategy")) {
    return { provided: true, value: normalizeStrategy(item.strategy) };
  }
  if (strategyMapProvided) {
    const mapped = Object.prototype.hasOwnProperty.call(strategyMap, name)
      ? strategyMap[name]
      : {};
    return { provided: true, value: normalizeStrategy(mapped) };
  }
  return { provided: false, value: {} };
}

function normalizeItem(raw, index, strategyMap, strategyMapProvided) {
  if (!isRecord(raw)) throw new Error("Combo item must be an object");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new Error("Combo name is required");
  if (name.length > 128 || !VALID_NAME_REGEX.test(name)) {
    throw new Error("Combo name may only contain letters, numbers, '.', '-' and '_'");
  }

  const kind = raw.kind === undefined || raw.kind === null || raw.kind === ""
    ? null
    : raw.kind;
  if (kind !== null && (typeof kind !== "string" || kind.length > 50)) {
    throw new Error("Combo kind must be a string of 50 characters or fewer");
  }

  if (!Array.isArray(raw.models)) throw new Error("Models must be an array");
  if (raw.models.length > MAX_MODELS_PER_COMBO) {
    throw new Error(`A combo may contain at most ${MAX_MODELS_PER_COMBO} models`);
  }
  const models = raw.models.map((model) => {
    if (typeof model !== "string" || !model.trim() || model.length > 500) {
      throw new Error("Every model must be a non-empty string of 500 characters or fewer");
    }
    return model.trim();
  });
  const strategy = strategyForItem(raw, name, strategyMap, strategyMapProvided);

  return {
    index,
    name,
    kind,
    models,
    strategy: strategy.value,
    strategyProvided: strategy.provided,
  };
}

function summarize(results) {
  const summary = { total: results.length, created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const result of results) {
    if (Object.prototype.hasOwnProperty.call(summary, result.action)) summary[result.action] += 1;
  }
  return summary;
}

export async function GET() {
  try {
    const [combos, settings] = await Promise.all([getCombos(), getSettings()]);
    const comboStrategies = settings.comboStrategies || {};
    const payload = {
      format: FORMAT,
      version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      combos: combos.map((combo) => ({
        name: combo.name,
        kind: combo.kind,
        models: combo.models,
        settings: exportStrategy(comboStrategies[combo.name] || {}),
      })),
    };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[ImportExport][Combos] Export failed:", error);
    return NextResponse.json({ error: "Failed to export combos" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await readJsonWithLimit(request);
    const payload = isRecord(body) && Object.prototype.hasOwnProperty.call(body, "data")
      ? body.data
      : body;
    const conflictPolicy = body?.conflictPolicy || payload?.conflictPolicy || "update";
    if (!new Set(["update", "skip"]).has(conflictPolicy)) {
      return NextResponse.json({ error: "Invalid conflict policy" }, { status: 400 });
    }

    const rawItems = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.combos) ? payload.combos : payload?.items);
    if (!Array.isArray(rawItems)) {
      return NextResponse.json({ error: "The JSON file does not contain a combos array" }, { status: 400 });
    }
    if (rawItems.length === 0) {
      return NextResponse.json({ error: "The import file contains no combo items" }, { status: 400 });
    }
    if (rawItems.length > MAX_ITEMS) {
      return NextResponse.json({ error: `A single import may contain at most ${MAX_ITEMS} combos` }, { status: 400 });
    }

    const nestedStrategyMap = isRecord(payload?.settings?.comboStrategies)
      ? payload.settings.comboStrategies
      : null;
    const directStrategyMap = isRecord(payload?.comboStrategies) ? payload.comboStrategies : null;
    const strategyMap = nestedStrategyMap || directStrategyMap || {};
    const strategyMapProvided = Boolean(nestedStrategyMap || directStrategyMap);
    const validItems = [];
    const validationResults = [];
    const seenNames = new Set();

    rawItems.forEach((item, index) => {
      try {
        const normalized = normalizeItem(item, index, strategyMap, strategyMapProvided);
        if (seenNames.has(normalized.name)) throw new Error("Duplicate combo name in import file");
        seenNames.add(normalized.name);
        validItems.push(normalized);
      } catch (error) {
        validationResults.push({
          index,
          name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : `Item ${index + 1}`,
          action: "failed",
          detail: error.message,
        });
      }
    });

    const importResults = validItems.length > 0
      ? await importComboItems(validItems, { conflictPolicy })
      : [];
    const results = [...validationResults, ...importResults].sort((a, b) => a.index - b.index);
    for (const result of importResults) {
      if (result.action === "created" || result.action === "updated") resetComboRotation(result.name);
    }

    return NextResponse.json({
      success: true,
      conflictPolicy,
      summary: summarize(results),
      results: results.map(({ index, ...result }) => result),
    });
  } catch (error) {
    console.error("[ImportExport][Combos] Import failed:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import combos" },
      { status: error instanceof RequestBodyError ? error.status : 400 },
    );
  }
}
