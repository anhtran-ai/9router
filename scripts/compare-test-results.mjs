import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function normalizeTestPath(name) {
  const normalized = String(name || "").replaceAll("\\", "/");
  const marker = "/tests/";
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex >= 0
    ? `tests/${normalized.slice(markerIndex + marker.length)}`
    : normalized;
}

function failureSet(resultPath) {
  const report = JSON.parse(readFileSync(resultPath, "utf8"));
  const directory = dirname(resolve(resultPath));
  const run = JSON.parse(readFileSync(resolve(directory, "run.json"), "utf8"));
  const runErrors = JSON.parse(readFileSync(resolve(directory, "run-errors.json"), "utf8"));
  if (!Array.isArray(report.testResults) || typeof run.repo !== "string" || !run.repo
      || !run.finishedAt || !run.exit || run.exit.signal != null || ![0, 1].includes(run.exit.code)
      || runErrors.schemaVersion !== 1 || runErrors.completed !== true
      || !["passed", "failed"].includes(runErrors.reason) || !Array.isArray(runErrors.errors)) {
    throw new Error(`Incomplete or abnormal offline run: ${directory}`);
  }
  const failures = new Set(report.testResults.flatMap((file) => {
    const failures = (file.assertionResults || [])
      .filter((assertion) => assertion.status === "failed")
      .map((assertion) => `${normalizeTestPath(file.name)} :: ${assertion.fullName}`);
    // afterAll/beforeAll/collection errors may fail a suite with zero failed
    // assertions. Compare their first-line identity as well, excluding cwd drift.
    if (file.status === "failed" && (file.message || failures.length === 0)) {
      const filePath = String(file.name).replaceAll("\\", "/");
      const marker = filePath.lastIndexOf("/tests/");
      let message = String(file.message || "Suite failed without assertion details").split(/\r?\n/)[0].replaceAll("\\", "/");
      if (marker >= 0) message = message.replaceAll(filePath.slice(0, marker + 1), "");
      failures.push(`${normalizeTestPath(file.name)} :: [suite] ${message}`);
    }
    return failures;
  }));
  const repo = run.repo.replaceAll("\\", "/").replace(/\/$/, "");
  for (const error of runErrors.errors) {
    if (!error || typeof error.message !== "string" || typeof error.name !== "string" || typeof error.type !== "string") {
      throw new Error(`Malformed run-level error evidence: ${directory}`);
    }
    const message = error.message.split(/\r?\n/)[0].replaceAll("\\", "/").replaceAll(`${repo}/`, "");
    const context = [error.testPath ? normalizeTestPath(error.testPath) : "", error.testName || ""].filter(Boolean).join(" :: ");
    failures.add(`[run] ${error.type} :: ${error.name} :: ${message}${context ? ` :: ${context}` : ""}`);
  }
  if ((run.exit.code === 1 && failures.size === 0) || (run.exit.code === 0 && failures.size > 0)) {
    throw new Error(`Process exit does not match recorded failures: ${directory}`);
  }
  return failures;
}

const [candidatePath, referencePath] = process.argv.slice(2);
if (!candidatePath || !referencePath) {
  console.error("Usage: node scripts/compare-test-results.mjs <candidate.json> <reference.json>");
  process.exit(2);
}

let candidateFailures;
let referenceFailures;
try {
  candidateFailures = failureSet(candidatePath);
  referenceFailures = failureSet(referencePath);
} catch (error) {
  console.error(`Cannot compare complete offline evidence: ${error.message}`);
  console.error("Run both references with the current offline runner and keep vitest.json, run.json and run-errors.json together.");
  process.exit(2);
}
const regressions = [...candidateFailures].filter((failure) => !referenceFailures.has(failure)).sort();
const referenceFailuresFixed = [...referenceFailures].filter((failure) => !candidateFailures.has(failure)).sort();

console.log(`Candidate failures: ${candidateFailures.size}`);
console.log(`Reference failures: ${referenceFailures.size}`);
console.log(`New candidate failures: ${regressions.length}`);
console.log(`Reference failures absent from candidate: ${referenceFailuresFixed.length}`);

if (regressions.length > 0) {
  console.error("\nRegressions relative to reference:");
  regressions.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("No candidate regression relative to reference (assertion, suite and run-level errors).");
