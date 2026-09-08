import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let tempRoot;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe("request logger session path containment", () => {
  it("keeps a Windows path-traversal model inside the logs directory", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-request-logs-"));
    vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
    vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
    vi.resetModules();
    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");

    const logger = await createRequestLogger(
      "openai",
      "openai",
      "..\\..\\..\\outside-request-logs",
    );
    const logsRoot = path.resolve(tempRoot, "logs");
    const relative = path.relative(logsRoot, logger.sessionPath);

    expect(logger.sessionPath).not.toBeNull();
    expect(path.isAbsolute(relative)).toBe(false);
    expect(relative).not.toBe("..");
    expect(relative.startsWith(`..${path.sep}`)).toBe(false);
    expect(fs.existsSync(logger.sessionPath)).toBe(true);
  });

  it("omits raw stream frames so a credential split across chunks cannot reach disk", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-request-logs-"));
    vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
    vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
    vi.resetModules();
    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");
    const logger = await createRequestLogger("openai", "claude", "test-model");

    for (const append of [
      logger.appendProviderChunk,
      logger.appendOpenAIChunk,
      logger.appendConvertedChunk,
    ]) {
      append("data: {\"access_");
      append("token\":\"split-secret\"}\n\n");
      append(new Uint8Array([115, 101, 99, 114, 101, 116]));
    }

    const contents = fs.readdirSync(logger.sessionPath)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => fs.readFileSync(path.join(logger.sessionPath, name), "utf8"));
    expect(contents).toHaveLength(3);
    for (const content of contents) {
      expect(content).toBe("[stream content omitted to prevent credential disclosure]\n");
      expect(content).not.toContain("access_");
      expect(content).not.toContain("split-secret");
    }
  });

  it("creates distinct sessions for concurrent requests in the same millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T07:30:00.123Z"));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-request-logs-"));
    vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
    vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
    vi.resetModules();
    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");

    const [first, second] = await Promise.all([
      createRequestLogger("openai", "claude", "same-model"),
      createRequestLogger("openai", "claude", "same-model"),
    ]);
    first.logRawRequest({ request: "first" });
    second.logRawRequest({ request: "second" });

    expect(first.sessionPath).not.toBe(second.sessionPath);
    expect(fs.existsSync(path.join(first.sessionPath, "2_req_source.json"))).toBe(true);
    expect(fs.existsSync(path.join(second.sessionPath, "2_req_source.json"))).toBe(true);
    expect(fs.readFileSync(path.join(first.sessionPath, "2_req_source.json"), "utf8"))
      .toContain('"request": "first"');
    expect(fs.readFileSync(path.join(second.sessionPath, "2_req_source.json"), "utf8"))
      .toContain('"request": "second"');
  });
});
