const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

// h2c downgrade requests are buffered before being replayed through Next's
// HTTP/1 handler. Bound both bytes and time so an unauthenticated upgrade
// cannot turn that compatibility shim into a memory or slowloris sink.
const H2C_MAX_BODY_BYTES = 64 * 1024 * 1024;
const H2C_BODY_TIMEOUT_MS = (() => {
  const override = process.env.NODE_ENV === "test"
    ? process.env.NINEROUTER_TEST_H2C_BODY_TIMEOUT_MS
    : null;
  if (override && /^\d+$/.test(override)) {
    const parsed = Number(override);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return 30_000;
})();

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const rejectUpgrade = (status, message) => {
      try {
        socket.end(
          `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      } catch {
        socket.destroy();
      }
    };
    // This compatibility path only knows how to delimit a fixed-size body.
    // Reject chunked requests rather than replaying an empty/truncated body
    // while leaving a misleading Transfer-Encoding header on the request.
    if (req.headers["transfer-encoding"] !== undefined) {
      rejectUpgrade(400, "Bad Request");
      return true;
    }
    const rawContentLength = req.headers["content-length"];
    if (rawContentLength !== undefined && !/^\d+$/.test(String(rawContentLength))) {
      rejectUpgrade(400, "Bad Request");
      return true;
    }
    const contentLength = Number(rawContentLength || 0);
    if (!Number.isSafeInteger(contentLength)) {
      rejectUpgrade(400, "Bad Request");
      return true;
    }
    if (contentLength > H2C_MAX_BODY_BYTES) {
      rejectUpgrade(413, "Payload Too Large");
      return true;
    }
    // Ignore bytes after the declared request body instead of retaining them
    // in the replay buffer. The downgraded connection is always closed.
    const initialBody = head.subarray(0, contentLength);
    const chunks = initialBody.length ? [initialBody] : [];
    let received = initialBody.length;
    let bodyTimer = null;
    let readBody = null;
    const cleanupBodyWait = () => {
      if (bodyTimer) clearTimeout(bodyTimer);
      bodyTimer = null;
      if (readBody) socket.off("data", readBody);
      readBody = null;
    };
    const serve = () => {
      cleanupBodyWait();
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      readBody = (chunk) => {
        const remaining = contentLength - received;
        const bodyChunk = chunk.subarray(0, remaining);
        if (bodyChunk.length) chunks.push(bodyChunk);
        received += bodyChunk.length;
        if (received < contentLength) return;
        serve();
      };
      socket.on("data", readBody);
      bodyTimer = setTimeout(() => {
        cleanupBodyWait();
        socket.destroy(new Error("h2c request body timeout"));
      }, H2C_BODY_TIMEOUT_MS);
      bodyTimer.unref?.();
      socket.once("close", cleanupBodyWait);
      socket.once("error", cleanupBodyWait);
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
