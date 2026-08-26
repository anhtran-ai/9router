import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const guard = fileURLToPath(new URL("../../scripts/offline-tests/network-guard.cjs", import.meta.url));
const compare = fileURLToPath(new URL("../../scripts/compare-test-results.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "9router-offline-guard-"));

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
    const baseline = join(scratch, "baseline.json");
    const candidate = join(scratch, "candidate.json");
    const passing = { name: "/baseline/tests/hook.test.js", status: "passed", assertionResults: [{ status: "passed", fullName: "passing assertion" }] };
    writeFileSync(baseline, JSON.stringify({ testResults: [passing] }));
    writeFileSync(candidate, JSON.stringify({ testResults: [{ ...passing, name: "/candidate/tests/hook.test.js", status: "failed", message: "SYNTHETIC_AFTER_ALL_FAILURE" }] }));
    let failure;
    try { execFileSync(process.execPath, [compare, candidate, baseline], { encoding: "utf8", stdio: "pipe" }); }
    catch (error) { failure = error; }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain("tests/hook.test.js :: [suite] SYNTHETIC_AFTER_ALL_FAILURE");
  });

  it("compares inherited suite errors independent of worktree location", () => {
    const baseline = join(scratch, "old-suite.json");
    const candidate = join(scratch, "new-suite.json");
    for (const [file, root] of [[baseline, "/baseline"], [candidate, "/candidate"]]) {
      writeFileSync(file, JSON.stringify({ testResults: [{ name: `${root}/tests/hook.test.js`, status: "failed", message: `Cannot import from ${root}/tests/hook.test.js\nstack details`, assertionResults: [] }] }));
    }
    expect(execFileSync(process.execPath, [compare, candidate, baseline], { encoding: "utf8", stdio: "pipe" })).toContain("New candidate failures: 0");
  });
});
