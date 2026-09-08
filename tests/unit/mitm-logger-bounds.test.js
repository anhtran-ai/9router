import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mitm-log-"));
let logger;

beforeAll(() => {
  const pathsPath = require.resolve("../../src/mitm/paths.js");
  const loggerPath = require.resolve("../../src/mitm/logger.js");
  delete require.cache[loggerPath];
  delete require.cache[pathsPath];
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    logger = require("../../src/mitm/logger.js");
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  }
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("MITM diagnostic log bounds and redaction", () => {
  it("caps streamed response bytes and redacts URL/header/body credentials", () => {
    const dumper = logger.createResponseDumper({
      url: "/chat?access_token=query-secret",
      headers: { host: "provider.example" },
    }, "bounded", { maxBodyBytes: 96 });
    dumper.writeHeader(400, {
      authorization: "Bearer header-secret",
      "set-cookie": "session=cookie-secret",
    });
    dumper.writeChunk(JSON.stringify({
      access_token: "body-secret",
      message: "Bearer echoed-secret",
      padding: "x".repeat(200),
    }));
    dumper.end();

    const output = fs.readFileSync(dumper.file, "utf8");
    expect(output).toContain("response body truncated at 96 bytes");
    expect(output).toContain("[redacted]");
    expect(output).not.toMatch(/query-secret|header-secret|cookie-secret|body-secret|echoed-secret/);
  });

  it("redacts credentials from request dumps and their filenames", () => {
    const file = logger.dumpRequest({
      method: "POST",
      url: "/oauth?code=query-code&safe=1",
      headers: { host: "provider.example", "x-api-key": "header-key" },
    }, Buffer.from(JSON.stringify({
      clientSecret: "client-secret",
      nested: { authorization: "Bearer nested-secret" },
    })), "request");

    const output = fs.readFileSync(file, "utf8");
    expect(path.basename(file)).not.toContain("query_code");
    expect(output).not.toMatch(/query-code|header-key|client-secret|nested-secret/);
    expect(output).toContain("[redacted]");
  });

  it("omits an opaque binary request instead of persisting embedded bytes", () => {
    const secret = "binary-embedded-secret";
    const file = logger.dumpRequest({
      method: "POST",
      url: "/binary",
      headers: { host: "provider.example" },
    }, Buffer.concat([Buffer.alloc(128, 0), Buffer.from(secret)]), "binary");

    const output = fs.readFileSync(file, "utf8");
    expect(output).toContain("request body omitted");
    expect(output).not.toContain(secret);
  });

  it("redacts a credential assignment inside malformed diagnostic text", () => {
    const sanitized = logger.__test__.sanitizeValue(
      'upstream error: {"access_token":"raw-secret", "clientSecret"="second-secret"',
    );
    expect(sanitized).not.toMatch(/raw-secret|second-secret/);
    expect(sanitized).toContain("[redacted]");
  });

  it("does not inflate a compressed response beyond the configured cap", () => {
    const compressed = zlib.gzipSync(Buffer.alloc(4096, "A"));
    const dumper = logger.createResponseDumper({
      url: "/compressed",
      headers: { host: "provider.example" },
    }, "compressed", { maxBodyBytes: 64 });
    dumper.writeHeader(200, { "content-encoding": "gzip" });
    dumper.writeChunk(compressed);
    dumper.end();

    expect(fs.statSync(dumper.file).size).toBeLessThan(512);
    expect(fs.readFileSync(dumper.file, "utf8")).not.toContain("A".repeat(256));
  });
});
