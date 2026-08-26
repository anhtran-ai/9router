import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Vitest's JSON reporter can report success:true even when a global rejection
// makes the process exit 1. Capture the independent run-level error channel.
export default class RunErrorsReporter {
  constructor(output) {
    if (!output) throw new Error("RunErrorsReporter requires an isolated output directory");
    this.path = resolve(output, "run-errors.json");
  }

  onInit(vitest) {
    this.lifecycleErrors = [];
    // Vitest 4 reports global-teardown/resource-close failures after
    // onTestRunEnd, only through this logger channel, without setting exitCode.
    // Preserve its diagnostic and capture the structured Error as late evidence.
    // The real teardown fixture protects this version-sensitive integration.
    const logError = vitest.logger.error.bind(vitest.logger);
    vitest.logger.error = (...args) => {
      if (args[0] === "error during close" && args.length > 1) {
        this.lifecycleErrors.push(this.serialize(args[1], "Lifecycle Error"));
        this.write(this.result);
        process.exitCode = process.exitCode || 1;
      }
      return logError(...args);
    };
    this.write({ completed: false, reason: null, errors: [] });
  }

  onTestRunEnd(_testModules, unhandledErrors, reason) {
    const errors = unhandledErrors.map(error => this.serialize(error));
    this.write({ completed: true, reason, errors });
  }

  onProcessTimeout() {
    this.lifecycleErrors.push(this.serialize(
      new Error("Vitest process did not close before teardown timeout"), "Process Timeout",
    ));
    this.write({ ...this.result, completed: false, reason: "interrupted" });
    process.exitCode = process.exitCode || 1;
  }

  serialize(error, type) {
    return {
      name: String(error?.name || "Error"),
      type: type || String(error?.type || "Unhandled Error"),
      message: String(error?.message ?? error),
      ...(error?.vitestTestPath ? { testPath: String(error.vitestTestPath) } : {}),
      ...(error?.vitestTestName ? { testName: String(error.vitestTestName) } : {}),
    };
  }

  write(result) {
    this.result = result;
    writeFileSync(this.path, JSON.stringify({
      schemaVersion: 1, ...result,
      reason: this.lifecycleErrors.length && result.reason !== "interrupted" ? "failed" : result.reason,
      errors: [...result.errors, ...this.lifecycleErrors],
    }, null, 2) + "\n");
  }
}
