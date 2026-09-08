// custom-server.js is the only thing that makes x-9r-real-ip trustworthy. Boot a real
// HTTP server through it and confirm a client cannot smuggle its own peer headers in.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import { __test__ as requestDetails } from "@/lib/db/repos/requestDetailsRepo.js";

const require = createRequire(import.meta.url);

// Test seam read by custom-server only under NODE_ENV=test. Keeping this small
// makes the partial-body timeout regression deterministic and fast.
process.env.NINEROUTER_TEST_H2C_BODY_TIMEOUT_MS = "50";

let server;
let baseUrl;
let seenHeaders;

beforeAll(async () => {
  require("../../custom-server.js");
  server = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.end("ok");
  });
  // Node only promotes an Upgrade request when the server has an upgrade
  // listener. custom-server's emit wrapper intercepts h2c before this no-op.
  server.on("upgrade", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.NINEROUTER_TEST_H2C_BODY_TIMEOUT_MS;
});

async function get(headers = {}) {
  await fetch(baseUrl, { headers });
  return seenHeaders;
}

async function rawRequest(payload) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
  });
}

describe("custom-server peer header sanitizing", () => {
  it("generates a peer trust token at boot", () => {
    expect(process.env.NINEROUTER_PEER_TOKEN).toMatch(/^[0-9a-f]{48}$/);
  });

  it("replaces a client-supplied x-9r-real-ip with the socket address", async () => {
    const headers = await get({ "x-9r-real-ip": "203.0.113.55" });

    expect(headers["x-9r-real-ip"]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it("stamps the trust token so downstream can tell the wrapper ran", async () => {
    const headers = await get();

    expect(headers["x-9r-peer-token"]).toBe(process.env.NINEROUTER_PEER_TOKEN);
  });

  it("drops a client-supplied peer trust token", async () => {
    const headers = await get({ "x-9r-peer-token": "forged-token" });

    expect(headers["x-9r-peer-token"]).toBe(process.env.NINEROUTER_PEER_TOKEN);
    expect(headers["x-9r-peer-token"]).not.toBe("forged-token");
  });

  it("drops a client-supplied x-9r-via-proxy marker", async () => {
    const headers = await get({ "x-9r-via-proxy": "1" });

    expect(headers["x-9r-via-proxy"]).toBeUndefined();
  });

  it("marks via-proxy and adopts the forwarded IP for a loopback proxy hop", async () => {
    const headers = await get({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });

    expect(headers["x-9r-via-proxy"]).toBe("1");
    expect(headers["x-9r-real-ip"]).toBe("203.0.113.9");
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });

  // chat.js snapshots every client header into the request detail. Anything that grants
  // access must not survive into a record the dashboard renders and cloud sync uploads.
  it("keeps the peer token out of persisted request details", () => {
    const sanitized = requestDetails.sanitizeHeaders({
      "x-9r-peer-token": "secret",
      "x-9r-cli-token": "secret",
      "authorization": "Bearer sk-x",
      "x-9r-real-ip": "127.0.0.1",
    });

    expect(sanitized["x-9r-peer-token"]).toBeUndefined();
    expect(sanitized["x-9r-cli-token"]).toBeUndefined();
    expect(sanitized["authorization"]).toBeUndefined();
    expect(sanitized["x-9r-real-ip"]).toBe("127.0.0.1");
  });

  it("rejects an oversized h2c downgrade body before buffering it", async () => {
    const response = await rawRequest([
      "POST /v1/messages HTTP/1.1",
      "Host: 127.0.0.1",
      "Connection: Upgrade",
      "Upgrade: h2c",
      "HTTP2-Settings: AAMAAABkAAQAAP__",
      `Content-Length: ${64 * 1024 * 1024 + 1}`,
      "",
      "",
    ].join("\r\n"));

    expect(response).toContain("413 Payload Too Large");
  });

  it("rejects transfer-encoded h2c bodies that cannot be replayed safely", async () => {
    const response = await rawRequest([
      "POST /v1/messages HTTP/1.1",
      "Host: 127.0.0.1",
      "Connection: Upgrade",
      "Upgrade: h2c",
      "HTTP2-Settings: AAMAAABkAAQAAP__",
      "Transfer-Encoding: chunked",
      "",
      "0",
      "",
      "",
    ].join("\r\n"));

    expect(response).toContain("400 Bad Request");
  });

  it("closes an h2c downgrade when the declared body stalls", async () => {
    const startedAt = Date.now();
    const response = await rawRequest([
      "POST /v1/messages HTTP/1.1",
      "Host: 127.0.0.1",
      "Connection: Upgrade",
      "Upgrade: h2c",
      "HTTP2-Settings: AAMAAABkAAQAAP__",
      "Content-Length: 10",
      "",
      "x",
    ].join("\r\n"));

    expect(response).toBe("");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
