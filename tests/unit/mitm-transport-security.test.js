import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const source = fs.readFileSync(path.join(repoRoot, "src/mitm/server.js"), "utf8");

describe("MITM outbound transport boundary", () => {
  it("verifies upstream certificates on ALPN, HTTP/2 and HTTP/1 connections", () => {
    expect(source).not.toContain("rejectUnauthorized: false");
    expect(source.match(/rejectUnauthorized:\s*true/g)).toHaveLength(3);
  });

  it("listens only on the hosts-file loopback address", () => {
    expect(source).toMatch(/server\.listen\(LOCAL_PORT,\s*["']127\.0\.0\.1["']/);
  });
});
