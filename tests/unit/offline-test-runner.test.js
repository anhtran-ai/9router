import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const guard = fileURLToPath(new URL("../../scripts/offline-tests/network-guard.cjs", import.meta.url));
const compare = fileURLToPath(new URL("../../scripts/compare-test-results.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "9router-offline-guard-"));

function writeRun(label, files, errors = [], overrides = {}) {
  const output = join(scratch, label);
  mkdirSync(output, { recursive: true });
  const failed = errors.length > 0 || files.some(file => file.status === "failed");
  writeFileSync(join(output, "vitest.json"), JSON.stringify({ testResults: files }));
  writeFileSync(join(output, "run-errors.json"), JSON.stringify({
    schemaVersion: 1, completed: true, reason: failed ? "failed" : "passed", errors,
    ...overrides.reporter,
  }));
  writeFileSync(join(output, "run.json"), JSON.stringify({
    repo: `/${label}`, finishedAt: new Date().toISOString(),
    exit: { code: failed ? 1 : 0, signal: null }, ...overrides.run,
  }));
  return join(output, "vitest.json");
}

function compareRuns(candidate, reference) {
  return spawnSync(process.execPath, [compare, candidate, reference], {
    encoding: "utf8", windowsHide: true, timeout: 10000,
  });
}

afterAll(() => {
  if (dirname(resolve(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith("9router-offline-guard-")) {
    throw new Error("Refusing to clean a path outside this test's temporary directory");
  }
  rmSync(scratch, { recursive: true, force: true });
});

// Intercept native dispatch before installing the guard: these negative probes
// cannot bind a wildcard socket or execute a shell even if the guard regresses.
function probe(beforeLoad, afterLoad) {
  const program = `
    const net = require('node:net');
    const cp = require('node:child_process');
    const guardPath = process.argv[1];
    // A full offline run also preloads this module. Reinstall over safe stubs.
    delete globalThis[Symbol.for('azox.9router.offline.guard')];
    delete require.cache[require.resolve(guardPath)];
    ${beforeLoad}
    require(guardPath);
    ${afterLoad}
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", program, guard], {
    encoding: "utf8",
    env: { ...process.env, AZOX_AUDIT_PROFILE: scratch, AZOX_AUDIT_NETWORK_DIR: join(scratch, "events") },
    windowsHide: true,
  }));
}

describe("offline test runner guard", () => {
  it.each(["0", "{ port: 0 }"])("pins omitted listen host for %s to loopback before dispatch", (argument) => {
    const result = probe(
      "let captured; net.Server.prototype.listen = function (...args) { captured = args; return this; };",
      `net.createServer().listen(${argument}); console.log(JSON.stringify(captured));`,
    );
    const host = typeof result[0] === "object" ? result[0].host : result[1];
    expect(host).toBe("127.0.0.1");
  });

  it.each([true, "cmd.exe"])("rejects shell option %j for an otherwise allowed executable", (shell) => {
    const result = probe(
      "let dispatched = false; cp.spawn = () => { dispatched = true; };",
      `let code; try { cp.spawn(process.execPath, ['--version'], { shell: ${JSON.stringify(shell)} }); } catch (error) { code = error.code; } console.log(JSON.stringify({ dispatched, code }));`,
    );
    expect(result).toEqual({ dispatched: false, code: "AZOX_OFFLINE_NETWORK_BLOCKED" });
  });

  it("permits direct guarded Node children without shell execution", () => {
    const result = probe(
      "cp.spawn = (command, args, options) => ({ shell: options.shell, guard: options.env.NODE_OPTIONS.includes('network-guard.cjs') });",
      "console.log(JSON.stringify(cp.spawn(process.execPath, ['--version'], { shell: false })));",
    );
    expect(result).toEqual({ shell: false, guard: true });
  });

  it("detects a new suite hook failure even when every assertion passed", () => {
    const passing = { name: "/baseline/tests/hook.test.js", status: "passed", assertionResults: [{ status: "passed", fullName: "passing assertion" }] };
    const baseline = writeRun("baseline", [passing]);
    const candidate = writeRun("candidate", [{ ...passing, name: "/candidate/tests/hook.test.js", status: "failed", message: "SYNTHETIC_AFTER_ALL_FAILURE" }]);
    let failure;
    try { execFileSync(process.execPath, [compare, candidate, baseline], { encoding: "utf8", stdio: "pipe" }); }
    catch (error) { failure = error; }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain("tests/hook.test.js :: [suite] SYNTHETIC_AFTER_ALL_FAILURE");
  });

  it("compares inherited suite errors independent of worktree location", () => {
    const [baseline, candidate] = ["old-suite", "new-suite"].map(label => writeRun(label, [{
      name: `/${label}/tests/hook.test.js`, status: "failed",
      message: `Cannot import from /${label}/tests/hook.test.js\nstack details`, assertionResults: [],
    }]));
    expect(execFileSync(process.execPath, [compare, candidate, baseline], { encoding: "utf8", stdio: "pipe" })).toContain("New candidate failures: 0");
  });

  it("detects a new global unhandled rejection while all assertions pass", () => {
    const passing = [{ name: "/fixture/tests/pass.test.js", status: "passed", assertionResults: [{ status: "passed", fullName: "passes" }] }];
    const baseline = writeRun("global-before", passing);
    const candidate = writeRun("global-after", passing, [{ name: "Error", type: "Unhandled Rejection", message: "SYNTHETIC_UNHANDLED" }]);
    const result = compareRuns(candidate, baseline);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[run] Unhandled Rejection :: Error :: SYNTHETIC_UNHANDLED");
  });

  it("compares inherited run errors independently of worktree roots", () => {
    const [baseline, candidate] = ["old-run", "new-run"].map(label => writeRun(label, [], [{
      name: "Error", type: "Unhandled Rejection", message: `Cannot load /${label}/tests/task.js`,
    }]));
    expect(compareRuns(candidate, baseline).status).toBe(0);
  });

  it.each([
    ["unfinished reporter", { reporter: { completed: false } }],
    ["interrupted run", { reporter: { reason: "interrupted" } }],
    ["abnormal process", { run: { exit: { code: 2, signal: null } } }],
    ["killed process", { run: { exit: { code: null, signal: "SIGTERM" } } }],
    ["unexplained failure", { run: { exit: { code: 1, signal: null } } }],
  ])("rejects %s instead of declaring no regression", (label, overrides) => {
    const baseline = writeRun(`complete-${label}`, []);
    const candidate = writeRun(`incomplete-${label}`, [], [], overrides);
    expect(compareRuns(candidate, baseline).status).toBe(2);
  });


  it.each(["rejection", "teardown", "timeout"])("captures a real Vitest %s outside assertion results", (kind) => {
    const reporter = fileURLToPath(new URL("../../scripts/offline-tests/run-errors-reporter.mjs", import.meta.url));
    const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
    const runs = [`real-before-${kind}`, `real-after-${kind}`].map((label, index) => {
      const output = join(scratch, label);
      const profile = join(output, "profile");
      const fixture = join(output, "fixture");
      const directories = {
        HOME: profile, USERPROFILE: profile, APPDATA: join(profile, "Roaming"), LOCALAPPDATA: join(profile, "Local"),
        DATA_DIR: join(output, "data"), TEMP: join(output, "temp"), TMP: join(output, "temp"),
      };
      for (const directory of [...Object.values(directories), join(fixture, "tests"), join(output, "network")]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFileSync(join(fixture, "tests/global-error.test.js"), [
        'test("passing assertion with background work", async () => {',
        '  expect(1).toBe(1);',
        index && kind === "rejection" ? "  Promise.reject(new Error('SR11_UNHANDLED_REJECTION'));" : "",
        "  await new Promise(resolve => setTimeout(resolve, 50));",
        "});",
      ].join("\n"));
      const setup = join(fixture, "global-setup.mjs");
      writeFileSync(setup, 'export function setup() { '
        + (index && kind === "timeout" ? 'setInterval(() => {}, 1000);' : '') + ' }\nexport function teardown() { '
        + (index && kind === "teardown" ? 'throw new Error("SR11_GLOBAL_TEARDOWN_ERROR");' : '') + ' }\n');
      const config = join(output, "vitest.config.mjs");
      writeFileSync(config, [
        "import RunErrorsReporter from " + JSON.stringify(pathToFileURL(reporter).href) + ";",
        "export default {",
        " root: " + JSON.stringify(fixture) + ", cacheDir: " + JSON.stringify(join(output, "cache")) + ",",
        ' test: { globals: true, include: ["tests/*.test.js"], pool: "forks", maxWorkers: 1, retry: 0, teardownTimeout: 1000,',
        " globalSetup: [" + JSON.stringify(setup) + "],",
        " setupFiles: [" + JSON.stringify(guard) + '], reporters: ["json", new RunErrorsReporter(' + JSON.stringify(output) + ")],",
        " outputFile: { json: " + JSON.stringify(join(output, "vitest.json")) + "} } };",
      ].join("\n"));
      const safe = new Set(["path", "systemroot", "windir", "comspec", "pathext", "number_of_processors", "processor_architecture", "os"]);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => safe.has(key.toLowerCase())));
      Object.assign(env, directories, {
        NODE_ENV: "test", CI: "1", NO_COLOR: "1", RUN_REAL: "0",
        AZOX_AUDIT_PROFILE: profile, AZOX_AUDIT_NETWORK_DIR: join(output, "network"),
        NODE_OPTIONS: '--require="' + guard.replaceAll("\\", "/") + '"',
      });
      const child = spawnSync(process.execPath, [vitest, "run", "--config", config], {
        cwd: fixture, env, windowsHide: true, encoding: "utf8", timeout: 30000,
      });
      expect(child.error).toBeUndefined();
      const reportPath = join(output, "vitest.json");
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const errors = JSON.parse(readFileSync(join(output, "run-errors.json"), "utf8"));
      writeFileSync(join(output, "run.json"), JSON.stringify({
        repo: fixture, finishedAt: new Date().toISOString(), exit: { code: child.status, signal: child.signal },
      }));
      expect(report.numPassedTests).toBe(1);
      expect(report.numFailedTests).toBe(0);
      expect(errors.completed).toBe(!(index && kind === "timeout"));
      return { path: reportPath, exit: child.status, errors };
    });
    expect(runs[0].exit).toBe(0);
    expect(runs[0].errors.errors).toEqual([]);
    expect(runs[1].exit).toBe(1);
    const message = kind === "timeout" ? "Vitest process did not close before teardown timeout"
      : kind === "teardown" ? "SR11_GLOBAL_TEARDOWN_ERROR" : "SR11_UNHANDLED_REJECTION";
    const type = kind === "timeout" ? "Process Timeout" : kind === "teardown" ? "Lifecycle Error" : "Unhandled Rejection";
    expect(runs[1].errors.errors).toEqual([expect.objectContaining({ message, type })]);
    const compared = compareRuns(runs[1].path, runs[0].path);
    expect(compared.status).toBe(kind === "timeout" ? 2 : 1);
    expect(compared.stderr).toContain(kind === "timeout" ? "Incomplete or abnormal" : message);
  }, 70000);


  it("requires run-level evidence instead of accepting legacy JSON alone", () => {
    const baseline = writeRun("legacy-reference", []);
    const candidate = writeRun("legacy-candidate", []);
    rmSync(join(dirname(candidate), "run-errors.json"));
    const result = compareRuns(candidate, baseline);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("run-errors.json");
  });
});
