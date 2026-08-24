import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultManifestPath = path.join(repoRoot, "docs", "CUSTOMIZATIONS.yaml");
const allowedActions = new Set(["keep", "reapply", "re-evaluate", "drop-if-upstream"]);

function validatePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`${label} must be a repository-relative path: ${value}`);
  }

  return normalized;
}

function validateBoundaryList(entries, label) {
  if (!Array.isArray(entries)) {
    throw new Error(`${label} must be an array`);
  }

  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${label}[${index}] must be an object`);
    }

    entry.path = validatePath(entry.path, `${label}[${index}].path`);
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      throw new Error(`${label}[${index}].reason must be a non-empty string`);
    }
    if (seen.has(entry.path)) {
      throw new Error(`${label} contains duplicate path: ${entry.path}`);
    }
    seen.add(entry.path);
  }

  return seen;
}

export function loadCustomizationManifest(manifestPath = defaultManifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse JSON-compatible YAML manifest ${manifestPath}: ${error.message}`);
  }

  if (manifest.schema_version !== 1) {
    throw new Error(`Unsupported customization manifest schema: ${manifest.schema_version}`);
  }
  if (typeof manifest.upstream_ref !== "string" || manifest.upstream_ref.length === 0) {
    throw new Error("upstream_ref must be a non-empty string");
  }
  if (typeof manifest.upstream_sha !== "string" || !/^[0-9a-f]{40}$/.test(manifest.upstream_sha)) {
    throw new Error("upstream_sha must be a full lowercase Git SHA");
  }
  for (const field of ["files_changed", "insertions", "deletions", "additive_total", "modified_total", "modified_runtime"]) {
    if (!Number.isInteger(manifest.fork_snapshot?.[field])) {
      throw new Error(`fork_snapshot.${field} must be an integer`);
    }
  }
  manifest.inventory_path = validatePath(manifest.inventory_path, "inventory_path");
  if (!manifest.boundaries || typeof manifest.boundaries !== "object") {
    throw new Error("boundaries must be an object");
  }

  const additive = validateBoundaryList(manifest.boundaries.additive, "boundaries.additive");
  const modified = validateBoundaryList(manifest.boundaries.modified, "boundaries.modified");
  for (const boundaryPath of additive) {
    if (modified.has(boundaryPath)) {
      throw new Error(`Path declared as both additive and modified: ${boundaryPath}`);
    }
  }

  return manifest;
}

function describeInventoryEntry(status, entry) {
  const boundaryPath = entry.path;
  const contributor = boundaryPath.includes("contribut")
    || boundaryPath.includes("OAuthModal")
    || boundaryPath.includes("oauth-modal-api-base")
    || boundaryPath.includes("oauth-register-session");
  const combo = boundaryPath.includes("combo") || boundaryPath.includes("import-export");
  const navigation = boundaryPath.includes("customNavigation")
    || boundaryPath.endsWith("/Header.js")
    || boundaryPath.endsWith("/Sidebar.js")
    || boundaryPath.includes("custom-navigation.test.js");
  const claudePrefill = boundaryPath.includes("assistantPrefill")
    || boundaryPath.includes("assistant-prefill")
    || boundaryPath.includes("accountFallback")
    || boundaryPath.includes("account-fallback-prefill")
    || boundaryPath.endsWith("/combo.js")
    || boundaryPath.endsWith("/errorConfig.js")
    || boundaryPath.endsWith("/capabilities.js")
    || boundaryPath.includes("bugs-toClaude-context")
    || boundaryPath.includes("capabilities.test.js")
    || boundaryPath.endsWith("/claude.js");
  const codexResponses = boundaryPath.endsWith("/codex.js")
    || boundaryPath.includes("codex-tool-normalization");
  const buildLocal = boundaryPath === ".gitignore"
    || boundaryPath === "Dockerfile"
    || boundaryPath === "next.config.mjs"
    || boundaryPath === "package-lock.json"
    || boundaryPath.includes("start-contributor-local")
    || boundaryPath.includes("stop-contributor-local");

  let group = "Governance, docs, tests, and upgrade guard";
  let behavior = "Keep fork policy, evidence, and regression coverage reproducible and reviewable.";
  let action = "keep";
  let tests = "`node scripts/check-customization-boundary.mjs`; relevant documented test or review gate";

  if (contributor) {
    group = "Contributor portal, OAuth, session, store, and admin";
    behavior = "Preserve scoped contributor onboarding without exposing dashboard-admin credentials or widening provider access.";
    action = status === "A" ? "keep" : "reapply";
    tests = "`tests/unit/contributor-oauth-guard.test.js`; `tests/unit/contributor-store.test.js`; `tests/unit/oauth-register-session.test.js`; `tests/unit/oauth-modal-api-base.test.js`";
  } else if (combo) {
    group = "Combo import-export";
    behavior = "Preserve definition-only combo transfer and DB facade/repository wiring without credential or usage export.";
    action = status === "A" ? "keep" : "reapply";
    tests = "`tests/unit/combo-import-export.test.js`; customization boundary guard";
  } else if (navigation) {
    group = "Custom navigation and UI seams";
    behavior = "Preserve Contributor and Import/Export navigation through the additive registry while retaining upstream entries.";
    action = status === "A" ? "keep" : "reapply";
    tests = "`tests/unit/custom-navigation.test.js`; customization boundary guard";
  } else if (claudePrefill) {
    group = "Claude prefill and exact combo fallback";
    behavior = "Preserve Claude-target final-boundary normalization and exact prefill-only model fallback, separate from account fallback.";
    action = boundaryPath.includes("assistantPrefillPolicy") ? "keep" : "drop-if-upstream";
    tests = "`tests/translator/assistant-prefill-policy.test.js`; `tests/unit/account-fallback-prefill.test.js`; `tests/translator/bugs-toClaude-context.test.js`; `tests/unit/capabilities.test.js`";
  } else if (codexResponses) {
    group = "Codex Responses compatibility";
    behavior = "Preserve instruction hoisting and additional_tools.content normalization at the Codex OAuth executor boundary.";
    action = "drop-if-upstream";
    tests = "`tests/unit/codex-tool-normalization.test.js`; direct `cx/*` Codex CLI Responses regression";
  } else if (buildLocal) {
    group = "Build, dependency, and local scripts";
    behavior = "Preserve deterministic installs/builds and safe local Contributor start/stop workflows.";
    action = "re-evaluate";
    tests = "clean `npm ci`; production build; local helper smoke; customization boundary guard";
  }

  if (!allowedActions.has(action)) throw new Error(`Invalid inventory action for ${boundaryPath}: ${action}`);
  const category = entry.category || (boundaryPath.startsWith("tests/") ? "tests" : "additive");
  return { group, category, behavior, action, tests };
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderForkDiffInventory(manifest) {
  const rows = [
    ...manifest.boundaries.additive.map((entry) => ({ status: "A", entry })),
    ...manifest.boundaries.modified.map((entry) => ({ status: "M", entry })),
  ].sort((left, right) => left.entry.path.localeCompare(right.entry.path));
  const groupCounts = new Map();
  for (const row of rows) {
    const details = describeInventoryEntry(row.status, row.entry);
    groupCounts.set(details.group, (groupCounts.get(details.group) || 0) + 1);
  }

  const lines = [
    "# Fork diff inventory",
    "",
    "Status: Generated and guarded",
    "",
    `Snapshot date: \`${manifest.fork_snapshot.date}\``,
    "",
    `Upstream baseline: \`decolua/9router\` \`${manifest.upstream_ref}\` at \`${manifest.upstream_sha}\``,
    "",
    `Fork baseline: \`azox-ai/azox-9router\` at \`${manifest.fork_snapshot.sha}\``,
    "",
    `Baseline snapshot before this inventory file: \`${manifest.fork_snapshot.files_changed} files changed, ${manifest.fork_snapshot.insertions} insertions(+), ${manifest.fork_snapshot.deletions} deletions(-)\`; \`${manifest.fork_snapshot.additive_total}\` additive, \`${manifest.fork_snapshot.modified_total}\` modified, \`${manifest.fork_snapshot.modified_runtime}\` modified runtime seams.`,
    "",
    `Current guarded path set: \`${rows.length}\` paths. It adds \`${manifest.inventory_path}\` to the exact ${manifest.fork_snapshot.files_changed}-path baseline, so the inventory can guard its own presence.`,
    "",
    "`docs/CUSTOMIZATIONS.yaml` is the machine-readable boundary source. This document is the generated human upgrade map. Edit the registry first, then regenerate this file; the guard fails when registry, inventory, and actual fork diff disagree.",
    "",
    "## Group summary",
    "",
    "| Group | Paths | Upgrade intent |",
    "|---|---:|---|",
  ];
  for (const [group, count] of [...groupCounts].sort(([left], [right]) => left.localeCompare(right))) {
    const sample = describeInventoryEntry(rows.find((row) => describeInventoryEntry(row.status, row.entry).group === group).status, rows.find((row) => describeInventoryEntry(row.status, row.entry).group === group).entry);
    lines.push(`| ${escapeCell(group)} | ${count} | ${escapeCell(sample.action)} |`);
  }
  lines.push(
    "",
    "## Regenerate and validate",
    "",
    "Run from repository root:",
    "",
    "```bash",
    `git diff --name-status --find-renames=100% ${manifest.upstream_sha}...HEAD`,
    `git diff --stat ${manifest.upstream_sha}...HEAD`,
    "node scripts/check-customization-boundary.mjs --write-inventory",
    "node scripts/check-customization-boundary.mjs",
    "```",
    "",
    "After every fork merge or upstream upgrade, update the pinned baseline fields in `docs/CUSTOMIZATIONS.yaml`, regenerate this inventory, and review every changed action. Never copy credentials, runtime databases, or `restricted/**` material into either document.",
    "",
    "## Full path inventory",
    "",
    "| A/M | Path | Category | Why different upstream | Behavior to preserve | Upgrade action | Test or guard |",
    "|---|---|---|---|---|---|---|",
  );
  for (const { status, entry } of rows) {
    const details = describeInventoryEntry(status, entry);
    lines.push(`| ${status} | \`${escapeCell(entry.path)}\` | ${escapeCell(details.category)} | ${escapeCell(entry.reason)} | ${escapeCell(details.behavior)} | \`${details.action}\` | ${escapeCell(details.tests)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function validateInventory(manifest) {
  const inventoryPath = path.join(repoRoot, manifest.inventory_path);
  const expected = renderForkDiffInventory(manifest);
  let actual;
  try {
    actual = readFileSync(inventoryPath, "utf8");
  } catch (error) {
    return [`Cannot read fork inventory ${manifest.inventory_path}: ${error.message}`];
  }
  return actual === expected ? [] : [`${manifest.inventory_path} is stale; run node scripts/check-customization-boundary.mjs --write-inventory`];
}

export function parseNameStatus(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const fields = line.split("\t");
      if (fields.length < 2) {
        throw new Error(`Invalid git name-status line ${index + 1}: ${line}`);
      }
      return {
        status: fields[0],
        paths: fields.slice(1).map((value) => validatePath(value, `diff line ${index + 1}`)),
      };
    });
}

export function validateCustomizationDiff(manifest, entries) {
  const additive = new Set(manifest.boundaries.additive.map((entry) => entry.path));
  const modified = new Set(manifest.boundaries.modified.map((entry) => entry.path));
  const errors = [];

  for (const entry of entries) {
    const [changedPath] = entry.paths;
    if (entry.status === "A") {
      if (!additive.has(changedPath)) {
        errors.push(
          modified.has(changedPath)
            ? `A ${changedPath} is declared as an approved modified seam, expected M`
            : `A ${changedPath} is outside approved additive files`,
        );
      }
      continue;
    }

    if (entry.status === "M") {
      if (!modified.has(changedPath)) {
        errors.push(
          additive.has(changedPath)
            ? `M ${changedPath} is declared as an additive file, expected A`
            : `M ${changedPath} is outside approved modified seams`,
        );
      }
      continue;
    }

    errors.push(`${entry.status} ${entry.paths.join(" -> ")} uses a forbidden diff status`);
  }

  return errors.sort();
}

function validateCounts(manifest, entries) {
  const actualAdditive = entries.filter((entry) => entry.status === "A").length;
  const actualModified = entries.filter((entry) => entry.status === "M").length;
  const runtimePaths = new Set(
    manifest.boundaries.modified
      .filter((entry) => entry.category === "runtime")
      .map((entry) => entry.path),
  );
  const actualRuntime = entries.filter(
    (entry) => entry.status === "M" && runtimePaths.has(entry.paths[0]),
  ).length;
  const expected = manifest.counts || {};
  const errors = [];

  for (const [label, actual, declared] of [
    ["additive_total", actualAdditive, expected.additive_total],
    ["modified_total", actualModified, expected.modified_total],
    ["modified_runtime", actualRuntime, expected.modified_runtime],
  ]) {
    if (!Number.isInteger(declared)) {
      errors.push(`counts.${label} must be an integer`);
    } else if (actual !== declared) {
      errors.push(`counts.${label}=${declared}, actual=${actual}`);
    }
  }

  return { actualAdditive, actualModified, actualRuntime, errors };
}

function validateCoverage(manifest, entries) {
  const actual = new Set(entries.map((entry) => `${entry.status}\t${entry.paths[0]}`));
  const expected = [
    ...manifest.boundaries.additive.map((entry) => `A\t${entry.path}`),
    ...manifest.boundaries.modified.map((entry) => `M\t${entry.path}`),
  ];

  return expected
    .filter((entry) => !actual.has(entry))
    .map((entry) => {
      const [status, boundaryPath] = entry.split("\t");
      return `${status} ${boundaryPath} is declared but missing from the fork diff`;
    });
}

export function runBoundaryGuard({ manifestPath = defaultManifestPath, diffText, checkCounts = true } = {}) {
  const manifest = loadCustomizationManifest(manifestPath);
  const resolvedDiff = diffText ?? execFileSync(
    "git",
    ["diff", "--name-status", "--find-renames=100%", `${manifest.upstream_sha}...HEAD`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const entries = parseNameStatus(resolvedDiff);
  const errors = validateCustomizationDiff(manifest, entries);
  const counts = validateCounts(manifest, entries);
  if (checkCounts) errors.push(...counts.errors, ...validateCoverage(manifest, entries), ...validateInventory(manifest));

  if (errors.length > 0) {
    throw new Error(`Customization boundary violations:\n- ${errors.sort().join("\n- ")}`);
  }

  return { manifest, entries, counts };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      options.manifestPath = path.resolve(argv[++index] || "");
    } else if (argument === "--write-inventory") {
      options.writeInventory = true;
    } else if (argument === "--diff-file") {
      options.diffText = readFileSync(path.resolve(argv[++index] || ""), "utf8");
      options.checkCounts = false;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.writeInventory) {
      const manifest = loadCustomizationManifest(options.manifestPath);
      const inventoryPath = path.join(repoRoot, manifest.inventory_path);
      writeFileSync(inventoryPath, renderForkDiffInventory(manifest), "utf8");
      console.log(`Wrote ${manifest.inventory_path}.`);
    }
    const result = runBoundaryGuard(options);
    const target = result.manifest.counts.modified_runtime_target_approx;
    console.log(
      `Customization boundary OK: ${result.entries.length} files `
      + `(${result.counts.actualAdditive} A, ${result.counts.actualModified} M); `
      + `runtime M=${result.counts.actualRuntime} (target≈${target}).`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
