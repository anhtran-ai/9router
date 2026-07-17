import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Import validated combo items atomically so combo definitions and their
// per-combo strategies can never get out of sync halfway through an import.
export async function importComboItems(items, { conflictPolicy = "update" } = {}) {
  const db = await getAdapter();
  const results = [];

  db.transaction(() => {
    const settingsRow = db.get(`SELECT data FROM settings WHERE id = 1`);
    const rawSettings = settingsRow ? parseJson(settingsRow.data, {}) : {};
    const comboStrategies = { ...(rawSettings.comboStrategies || {}) };
    let strategiesChanged = false;

    for (const item of items) {
      const row = db.get(`SELECT * FROM combos WHERE name = ?`, [item.name]);
      const existing = rowToCombo(row);

      if (existing && conflictPolicy === "skip") {
        results.push({ index: item.index, name: item.name, action: "skipped", detail: "Combo already exists" });
        continue;
      }

      const definitionChanged = !existing || existing.kind !== item.kind || !sameJson(existing.models, item.models);
      const currentStrategy = item.strategyProvided ? (comboStrategies[item.name] || {}) : null;
      const strategyChanged = item.strategyProvided && !sameJson(currentStrategy, item.strategy);

      if (existing && !definitionChanged && !strategyChanged) {
        results.push({ index: item.index, name: item.name, action: "skipped", detail: "No changes detected" });
        continue;
      }

      const now = new Date().toISOString();
      if (existing) {
        if (definitionChanged) {
          db.run(
            `UPDATE combos SET kind = ?, models = ?, updatedAt = ? WHERE id = ?`,
            [item.kind, stringifyJson(item.models), now, existing.id],
          );
        }
      } else {
        db.run(
          `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [uuidv4(), item.name, item.kind, stringifyJson(item.models), now, now],
        );
      }

      if (item.strategyProvided) {
        if (Object.keys(item.strategy).length > 0) comboStrategies[item.name] = item.strategy;
        else delete comboStrategies[item.name];
        strategiesChanged = true;
      }

      results.push({
        index: item.index,
        name: item.name,
        action: existing ? "updated" : "created",
        detail: existing ? "Definition or strategy updated" : "Combo created",
      });
    }

    if (strategiesChanged) {
      const nextSettings = { ...rawSettings, comboStrategies };
      db.run(
        `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        [stringifyJson(nextSettings)],
      );
    }
  });

  return results;
}
