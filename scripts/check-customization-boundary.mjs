import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultManifestPath = path.join(repoRoot, "docs", "CUSTOMIZATIONS.yaml");

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
    ["diff", "--name-status", "--find-renames=100%", `${manifest.upstream_ref}...HEAD`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const entries = parseNameStatus(resolvedDiff);
  const errors = validateCustomizationDiff(manifest, entries);
  const counts = validateCounts(manifest, entries);
  if (checkCounts) errors.push(...counts.errors, ...validateCoverage(manifest, entries));

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
    const result = runBoundaryGuard(parseArguments(process.argv.slice(2)));
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
