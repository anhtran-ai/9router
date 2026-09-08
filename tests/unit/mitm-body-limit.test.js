import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  collectBodyRaw,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_BODY_TIMEOUT_MS,
} = require("../../src/mitm/bodyLimit.js");

function request(headers = {}) {
  const stream = new PassThrough();
  stream.headers = headers;
  return stream;
}

describe("MITM request body limits", () => {
  it("exposes bounded production defaults", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(64 * 1024 * 1024);
    expect(DEFAULT_BODY_TIMEOUT_MS).toBe(30_000);
  });

  it("rejects a declared oversized body before reading", async () => {
    const req = request({ "content-length": "6" });
    await expect(collectBodyRaw(req, { maxBytes: 5, timeoutMs: 100 })).rejects.toMatchObject({
      code: "MITM_BODY_TOO_LARGE",
      statusCode: 413,
    });
  });

  it("rejects a chunked body as soon as the streamed cap is crossed", async () => {
    const req = request();
    const result = collectBodyRaw(req, { maxBytes: 5, timeoutMs: 100 });
    req.write("abc");
    req.write("def");
    await expect(result).rejects.toMatchObject({ code: "MITM_BODY_TOO_LARGE" });
    expect(req.isPaused()).toBe(true);
  });

  it("accepts a body exactly at the cap", async () => {
    const req = request({ "content-length": "5" });
    const result = collectBodyRaw(req, { maxBytes: 5, timeoutMs: 100 });
    req.end("abcde");
    await expect(result).resolves.toEqual(Buffer.from("abcde"));
  });

  it("rejects a stalled body on its absolute deadline", async () => {
    const req = request({ "content-length": "5" });
    const result = collectBodyRaw(req, { maxBytes: 5, timeoutMs: 10 });
    req.write("a");
    await expect(result).rejects.toMatchObject({
      code: "MITM_BODY_TIMEOUT",
      statusCode: 408,
    });
    req.destroy();
  });
});
