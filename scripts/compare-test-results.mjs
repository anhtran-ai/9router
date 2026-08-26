import { readFileSync } from "node:fs";

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
  return new Set(report.testResults.flatMap((file) => {
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
}

const [candidatePath, referencePath] = process.argv.slice(2);
if (!candidatePath || !referencePath) {
  console.error("Usage: node scripts/compare-test-results.mjs <candidate.json> <reference.json>");
  process.exit(2);
}

const candidateFailures = failureSet(candidatePath);
const referenceFailures = failureSet(referencePath);
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

console.log("No candidate regression relative to reference (assertion and suite errors).");
