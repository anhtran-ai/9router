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
  return new Set(report.testResults.flatMap((file) =>
    file.assertionResults
      .filter((assertion) => assertion.status === "failed")
      .map((assertion) => `${normalizeTestPath(file.name)} :: ${assertion.fullName}`)
  ));
}

const [candidatePath, upstreamPath] = process.argv.slice(2);
if (!candidatePath || !upstreamPath) {
  console.error("Usage: node scripts/compare-test-results.mjs <candidate.json> <upstream.json>");
  process.exit(2);
}

const candidateFailures = failureSet(candidatePath);
const upstreamFailures = failureSet(upstreamPath);
const regressions = [...candidateFailures].filter((failure) => !upstreamFailures.has(failure)).sort();
const upstreamFailuresFixed = [...upstreamFailures].filter((failure) => !candidateFailures.has(failure)).sort();

console.log(`Candidate failures: ${candidateFailures.size}`);
console.log(`Clean-upstream failures: ${upstreamFailures.size}`);
console.log(`New candidate failures: ${regressions.length}`);
console.log(`Upstream failures absent from candidate: ${upstreamFailuresFixed.length}`);

if (regressions.length > 0) {
  console.error("\nRegressions relative to clean upstream:");
  regressions.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("No candidate regression relative to clean upstream.");
