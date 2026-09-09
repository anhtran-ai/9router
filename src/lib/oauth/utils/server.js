import http from "http";
import { URL } from "url";
import { CODEX_CONFIG, TRAE_CONFIG, WINDSURF_CONFIG, ZED_HOSTED_CONFIG } from "../constants/oauth.js";

// Loopback origin guard for local callback proxies.
// Legit OAuth redirects are top-level navigations (no `Origin` header); a cross-site
// page issuing `fetch(..., {mode:"no-cors"})` to scan + hit 127.0.0.1 always sends
// `Origin: https://attacker`. Reject any non-loopback Origin to block login-CSRF.
function isLoopbackOrigin(origin) {
  if (!origin) return true; // navigation redirect — allow
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function proxyOwnerKey(contributorReservationHash) {
  return contributorReservationHash
    ? `contributor:${contributorReservationHash}`
    : "normal";
}

let proxyGenerationSequence = 0;

function nextProxyGeneration() {
  proxyGenerationSequence += 1;
  if (!Number.isSafeInteger(proxyGenerationSequence)) proxyGenerationSequence = 1;
  return proxyGenerationSequence;
}

function canStopProxy(
  currentOwnerKey,
  currentGeneration,
  contributorReservationHash,
  expectedGeneration,
) {
  if (!currentOwnerKey) return true;
  if (currentOwnerKey !== proxyOwnerKey(contributorReservationHash)) return false;
  return expectedGeneration == null || currentGeneration === expectedGeneration;
}

function isActiveProxyGeneration(
  server,
  activeServer,
  expectedOwnerKey,
  currentOwnerKey,
  expectedGeneration,
  currentGeneration,
) {
  return (
    server === activeServer
    && expectedOwnerKey === currentOwnerKey
    && expectedGeneration === currentGeneration
  );
}

function isSessionBoundToGeneration(session, ownerKey, generation) {
  return (
    session?._proxyOwnerKey === ownerKey
    && session?._proxyGeneration === generation
  );
}

function claimSessionForGeneration(session, ownerKey, generation) {
  if (
    !isSessionBoundToGeneration(session, ownerKey, generation)
    || session.status !== "pending"
  ) return false;
  session.status = "exchanging";
  return true;
}

function isSessionInFlight(session) {
  return session?.status === "pending" || session?.status === "exchanging";
}

function staleProxyCallbackError(provider) {
  const error = new Error(`${provider} OAuth callback no longer belongs to the active login session`);
  error.status = 409;
  error.code = "OAUTH_PROXY_STALE_GENERATION";
  return error;
}

function rejectStaleProxyCallback(res, provider) {
  const error = staleProxyCallbackError(provider);
  res.writeHead(409, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderCodexResultPage(false, error.message));
}

function clearPendingMapSessionsForGeneration(sessions, generation) {
  for (const [state, session] of sessions) {
    if (session?._proxyGeneration === generation && isSessionInFlight(session)) {
      sessions.delete(state);
    }
  }
}

function hasMapSessionForGeneration(sessions, ownerKey, generation) {
  for (const session of sessions.values()) {
    if (isSessionBoundToGeneration(session, ownerKey, generation)) return true;
  }
  return false;
}

function clearPendingSingletonSessionForGeneration(session, generation) {
  if (session?._proxyGeneration === generation && isSessionInFlight(session)) return null;
  return session;
}


/**
 * Start a local HTTP server to receive OAuth callback
 * @param {Function} onCallback - Called with query params when callback received
 * @param {number} fixedPort - Optional fixed port number (default: random)
 * @returns {Promise<{server: http.Server, port: number, close: Function}>}
 */
export function startLocalServer(onCallback, fixedPort = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);

      if (url.pathname === "/callback" || url.pathname === "/auth/callback") {
        const params = Object.fromEntries(url.searchParams);

        // Send success response to browser with auto-close attempt
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .success { color: #22c55e; font-size: 3rem; }
    h1 { margin: 1rem 0; }
    p { color: #666; }
    #countdown { font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">&#10003;</div>
    <h1>Authentication Successful</h1>
    <p id="message">Closing in <span id="countdown">3</span> seconds...</p>
  </div>
  <script>
    let count = 3;
    const countdown = document.getElementById("countdown");
    const message = document.getElementById("message");
    const timer = setInterval(() => {
      count--;
      countdown.textContent = count;
      if (count <= 0) {
        clearInterval(timer);
        window.close();
        setTimeout(() => {
          message.textContent = "Please close this tab manually.";
        }, 500);
      }
    }, 1000);
  </script>
</body>
</html>`);

        // Call callback with params
        onCallback(params);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Listen on fixed port or find available port
    const portToUse = fixedPort || 0;
    server.listen(portToUse, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        close: () => server.close(),
      });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && fixedPort) {
        reject(new Error(`Port ${fixedPort} is already in use. Please close other applications using this port.`));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Wait for callback with timeout
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object>} - Callback params
 */
export function waitForCallback(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Authentication timeout"));
      }
    }, timeoutMs);

    const onCallback = (params) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(params);
      }
    };

    // Return the callback function
    resolve.__onCallback = onCallback;
  });
}

// Singleton proxy server for Codex OAuth callback on fixed port
let codexProxyServer = null;
let codexProxyTimeout = null;
let codexProxyOwnerKey = null;
let codexProxyGeneration = null;

const CODEX_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const CODEX_PORT = CODEX_CONFIG.fixedPort;

// Pending exchange sessions keyed by state — used by server-side exchange mode
const pendingExchanges = new Map();

/**
 * Register a pending exchange session for server-side mode.
 * Modal client calls this before opening popup.
 */
export function registerCodexSession({
  state,
  codeVerifier,
  redirectUri,
  commitProviderConnection,
  contributorReservationHash,
}) {
  if (!state || !codeVerifier || !redirectUri) return false;
  const ownerKey = proxyOwnerKey(contributorReservationHash);
  if (
    !codexProxyServer
    || !codexProxyGeneration
    || codexProxyOwnerKey !== ownerKey
  ) return false;
  pendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    commitProviderConnection,
    contributorReservationHash,
    _proxyOwnerKey: ownerKey,
    _proxyGeneration: codexProxyGeneration,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Read session status (modal polls this).
 */
export function getCodexSessionStatus(state) {
  return pendingExchanges.get(state) || null;
}

/**
 * Clear a session (called after modal consumes status).
 */
export function clearCodexSession(state, expectedSession = null) {
  if (expectedSession && pendingExchanges.get(state) !== expectedSession) return false;
  return pendingExchanges.delete(state);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function proxyPublicErrorMessage(error) {
  const status = Number(error?.status);
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  // Explicit 4xx statuses are reserved for local ownership/session failures.
  // Provider exceptions can contain raw response bodies that echo credentials.
  if (Number.isInteger(status) && status >= 400 && status < 500 && message && message.length <= 512) {
    return message;
  }
  return "OAuth authentication failed";
}

function writeProxyFailure(session, res, renderPage, error) {
  const publicMessage = proxyPublicErrorMessage(error);
  session.status = "error";
  session.error = publicMessage;
  session.errorStatus = Number(error?.status) || null;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage(false, publicMessage));
}

async function persistProxyConnection(session, connectionData, shouldCommit) {
  if (shouldCommit && !shouldCommit()) {
    throw staleProxyCallbackError(connectionData.provider);
  }
  if (typeof session?.commitProviderConnection === "function") {
    const connection = await session.commitProviderConnection(connectionData);
    if (connection) return connection;
    const error = new Error("Contribution reservation is no longer valid");
    error.status = 409;
    throw error;
  }
  const { createProviderConnection } = await import("@/models");
  const connection = await createProviderConnection(connectionData, { shouldCommit });
  if (!connection) throw staleProxyCallbackError(connectionData.provider);
  return connection;
}

function renderCodexResultPage(success, message) {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  const title = success ? "Authentication Successful" : "Authentication Failed";
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}.c{text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}.i{color:${color};font-size:3rem}h1{margin:1rem 0}p{color:#666}</style>
</head><body><div class="c"><div class="i">${icon}</div><h1>${title}</h1><p>${safeMessage}</p><p>Closing in <span id="cd">3</span>s...</p>
<script>let n=3;const c=document.getElementById("cd");const t=setInterval(()=>{n--;c.textContent=n;if(n<=0){clearInterval(t);window.close();}},1000);</script>
</div></body></html>`;
}

/**
 * Start Codex proxy on fixed port 1455.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port for legacy channel-based flow.
 */
export function startCodexProxy(appPort, contributorReservationHash) {
  return new Promise((resolve) => {
    const requestedOwnerKey = proxyOwnerKey(contributorReservationHash);
    if (codexProxyOwnerKey) {
      if (codexProxyOwnerKey !== requestedOwnerKey) {
        resolve({ success: false, reason: "Codex callback proxy is already in use" });
        return;
      }
      if (!codexProxyServer) {
        resolve({ success: false, reason: "Codex callback proxy is still starting" });
        return;
      }
      resolve({ success: true });
      return;
    }
    codexProxyOwnerKey = requestedOwnerKey;
    const generation = nextProxyGeneration();
    codexProxyGeneration = generation;

    const server = http.createServer(async (req, res) => {
      if (!isActiveProxyGeneration(
        server,
        codexProxyServer,
        requestedOwnerKey,
        codexProxyOwnerKey,
        generation,
        codexProxyGeneration,
      )) {
        rejectStaleProxyCallback(res, "Codex");
        return;
      }
      const url = new URL(req.url, "http://localhost");

      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const registeredSession = state ? pendingExchanges.get(state) : null;
      if (registeredSession && !isSessionBoundToGeneration(
        registeredSession,
        requestedOwnerKey,
        generation,
      )) {
        rejectStaleProxyCallback(res, "Codex");
        return;
      }
      const session = registeredSession || null;
      if (!session && hasMapSessionForGeneration(
        pendingExchanges,
        requestedOwnerKey,
        generation,
      )) {
        rejectStaleProxyCallback(res, "Codex");
        return;
      }

      // Mode A: server-side exchange (session registered)
      if (session) {
        if (!claimSessionForGeneration(session, requestedOwnerKey, generation)) {
          rejectStaleProxyCallback(res, "Codex");
          return;
        }
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          // Lazy import to avoid circular deps
          const { exchangeTokens } = await import("../providers.js");

          const tokenData = await exchangeTokens(
            "codex",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          if (!isActiveProxyGeneration(
            server,
            codexProxyServer,
            requestedOwnerKey,
            codexProxyOwnerKey,
            generation,
            codexProxyGeneration,
          ) || !isSessionBoundToGeneration(session, requestedOwnerKey, generation)) {
            throw staleProxyCallbackError("Codex");
          }
          const connection = await persistProxyConnection(session, {
            provider: "codex",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          }, () => (
            pendingExchanges.get(state) === session
            && session.status === "exchanging"
            && isActiveProxyGeneration(
              server,
              codexProxyServer,
              requestedOwnerKey,
              codexProxyOwnerKey,
              generation,
              codexProxyGeneration,
            )
            && isSessionBoundToGeneration(session, requestedOwnerKey, generation)
          ));

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(true, "You can close this window."));
        } catch (err) {
          writeProxyFailure(session, res, renderCodexResultPage, err);
        } finally {
          if (
            session.contributorReservationHash
            && (session.status === "done" || session.errorStatus === 409)
          ) clearCodexSession(state, session);
          stopCodexProxy(session.contributorReservationHash, generation);
        }
        return;
      }

      // Mode B: legacy channel fallback — 302 redirect to app /callback
      const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopCodexProxy(contributorReservationHash, generation);
    });

    server.listen(CODEX_PORT, "127.0.0.1", () => {
      if (
        codexProxyOwnerKey !== requestedOwnerKey
        || codexProxyGeneration !== generation
      ) {
        server.close();
        resolve({ success: false, reason: "Codex callback proxy start was cancelled" });
        return;
      }
      codexProxyServer = server;
      codexProxyTimeout = setTimeout(
        () => stopCodexProxy(contributorReservationHash, generation),
        CODEX_PROXY_TIMEOUT_MS,
      );
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (
        !codexProxyServer
        && codexProxyOwnerKey === requestedOwnerKey
        && codexProxyGeneration === generation
      ) {
        clearPendingMapSessionsForGeneration(pendingExchanges, generation);
        codexProxyOwnerKey = null;
        codexProxyGeneration = null;
      }
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

/**
 * Stop the Codex proxy server and cleanup
 */
export function stopCodexProxy(contributorReservationHash, expectedGeneration) {
  if (!canStopProxy(
    codexProxyOwnerKey,
    codexProxyGeneration,
    contributorReservationHash,
    expectedGeneration,
  )) return false;
  const generation = codexProxyGeneration;
  if (codexProxyTimeout) {
    clearTimeout(codexProxyTimeout);
    codexProxyTimeout = null;
  }
  const server = codexProxyServer;
  codexProxyServer = null;
  codexProxyOwnerKey = null;
  codexProxyGeneration = null;
  if (server) server.close();
  if (generation != null) clearPendingMapSessionsForGeneration(pendingExchanges, generation);
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// xAI fixed-port proxy on 127.0.0.1:56121
// Same shape as the Codex proxy. Kept as a parallel implementation rather than
// generalizing the Codex one to keep the codex hot-path byte-equivalent.
// ───────────────────────────────────────────────────────────────────────────

let xaiProxyServer = null;
let xaiProxyTimeout = null;
let xaiProxyOwnerKey = null;
let xaiProxyGeneration = null;
const XAI_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const XAI_PROXY_PORT = 56121;
const xaiPendingExchanges = new Map();

export function registerXaiSession({
  state,
  codeVerifier,
  redirectUri,
  commitProviderConnection,
  contributorReservationHash,
}) {
  if (!state || !codeVerifier || !redirectUri) return false;
  const ownerKey = proxyOwnerKey(contributorReservationHash);
  if (
    !xaiProxyServer
    || !xaiProxyGeneration
    || xaiProxyOwnerKey !== ownerKey
  ) return false;
  xaiPendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    commitProviderConnection,
    contributorReservationHash,
    _proxyOwnerKey: ownerKey,
    _proxyGeneration: xaiProxyGeneration,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getXaiSessionStatus(state) {
  return xaiPendingExchanges.get(state) || null;
}

export function claimXaiSession(state, contributorReservationHash) {
  const session = state ? xaiPendingExchanges.get(state) : null;
  const ownerKey = proxyOwnerKey(contributorReservationHash);
  if (
    !xaiProxyServer
    || !xaiProxyGeneration
    || xaiProxyOwnerKey !== ownerKey
    || !claimSessionForGeneration(session, ownerKey, xaiProxyGeneration)
  ) return null;
  return session;
}

export function isXaiSessionCurrent(state, session, contributorReservationHash) {
  const ownerKey = proxyOwnerKey(contributorReservationHash);
  return (
    xaiPendingExchanges.get(state) === session
    && session?.status === "exchanging"
    && xaiProxyServer != null
    && xaiProxyOwnerKey === ownerKey
    && isSessionBoundToGeneration(session, ownerKey, xaiProxyGeneration)
  );
}

export function clearXaiSession(state, expectedSession = null) {
  if (expectedSession && xaiPendingExchanges.get(state) !== expectedSession) return false;
  return xaiPendingExchanges.delete(state);
}

function renderXaiResultPage(success, message) {
  return renderCodexResultPage(success, message);
}

/**
 * Start xAI proxy on fixed port 56121.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port.
 */
export function startXaiProxy(appPort, contributorReservationHash) {
  return new Promise((resolve) => {
    const requestedOwnerKey = proxyOwnerKey(contributorReservationHash);
    if (xaiProxyOwnerKey) {
      if (xaiProxyOwnerKey !== requestedOwnerKey) {
        resolve({ success: false, reason: "xAI callback proxy is already in use" });
        return;
      }
      if (!xaiProxyServer) {
        resolve({ success: false, reason: "xAI callback proxy is still starting" });
        return;
      }
      resolve({ success: true });
      return;
    }
    xaiProxyOwnerKey = requestedOwnerKey;
    const generation = nextProxyGeneration();
    xaiProxyGeneration = generation;

    const server = http.createServer(async (req, res) => {
      if (!isActiveProxyGeneration(
        server,
        xaiProxyServer,
        requestedOwnerKey,
        xaiProxyOwnerKey,
        generation,
        xaiProxyGeneration,
      )) {
        rejectStaleProxyCallback(res, "xAI");
        return;
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderXaiResultPage(false, "Cross-origin callback rejected"));
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const registeredSession = state ? xaiPendingExchanges.get(state) : null;
      if (registeredSession && !isSessionBoundToGeneration(
        registeredSession,
        requestedOwnerKey,
        generation,
      )) {
        rejectStaleProxyCallback(res, "xAI");
        return;
      }
      const session = registeredSession || null;
      if (!session && hasMapSessionForGeneration(
        xaiPendingExchanges,
        requestedOwnerKey,
        generation,
      )) {
        rejectStaleProxyCallback(res, "xAI");
        return;
      }

      // Mode A: server-side exchange
      if (session) {
        if (!claimSessionForGeneration(session, requestedOwnerKey, generation)) {
          rejectStaleProxyCallback(res, "xAI");
          return;
        }
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          const { exchangeTokens } = await import("../providers.js");

          const tokenData = await exchangeTokens(
            "xai",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          if (!isActiveProxyGeneration(
            server,
            xaiProxyServer,
            requestedOwnerKey,
            xaiProxyOwnerKey,
            generation,
            xaiProxyGeneration,
          ) || !isSessionBoundToGeneration(session, requestedOwnerKey, generation)) {
            throw staleProxyCallbackError("xAI");
          }
          const connection = await persistProxyConnection(session, {
            provider: "xai",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          }, () => (
            xaiPendingExchanges.get(state) === session
            && session.status === "exchanging"
            && isActiveProxyGeneration(
              server,
              xaiProxyServer,
              requestedOwnerKey,
              xaiProxyOwnerKey,
              generation,
              xaiProxyGeneration,
            )
            && isSessionBoundToGeneration(session, requestedOwnerKey, generation)
          ));

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(true, "You can close this window."));
        } catch (err) {
          writeProxyFailure(session, res, renderXaiResultPage, err);
        } finally {
          if (
            session.contributorReservationHash
            && (session.status === "done" || session.errorStatus === 409)
          ) clearXaiSession(state, session);
          stopXaiProxy(session.contributorReservationHash, generation);
        }
        return;
      }

      // Mode B: legacy fallback redirect
      const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopXaiProxy(contributorReservationHash, generation);
    });

    server.listen(XAI_PROXY_PORT, "127.0.0.1", () => {
      if (
        xaiProxyOwnerKey !== requestedOwnerKey
        || xaiProxyGeneration !== generation
      ) {
        server.close();
        resolve({ success: false, reason: "xAI callback proxy start was cancelled" });
        return;
      }
      xaiProxyServer = server;
      xaiProxyTimeout = setTimeout(
        () => stopXaiProxy(contributorReservationHash, generation),
        XAI_PROXY_TIMEOUT_MS,
      );
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (
        !xaiProxyServer
        && xaiProxyOwnerKey === requestedOwnerKey
        && xaiProxyGeneration === generation
      ) {
        clearPendingMapSessionsForGeneration(xaiPendingExchanges, generation);
        xaiProxyOwnerKey = null;
        xaiProxyGeneration = null;
      }
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

export function stopXaiProxy(contributorReservationHash, expectedGeneration) {
  if (!canStopProxy(
    xaiProxyOwnerKey,
    xaiProxyGeneration,
    contributorReservationHash,
    expectedGeneration,
  )) return false;
  const generation = xaiProxyGeneration;
  if (xaiProxyTimeout) {
    clearTimeout(xaiProxyTimeout);
    xaiProxyTimeout = null;
  }
  const server = xaiProxyServer;
  xaiProxyServer = null;
  xaiProxyOwnerKey = null;
  xaiProxyGeneration = null;
  if (server) server.close();
  if (generation != null) clearPendingMapSessionsForGeneration(xaiPendingExchanges, generation);
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Trae dynamic-port proxy. Singleton session (one connect at a time per provider).
// Callback path = /callback with params refreshToken + loginHost.
// ───────────────────────────────────────────────────────────────────────────

let traeProxyServer = null;
let traeProxyTimeout = null;
let traeProxyPort = null;
let traeSession = null;
let traeProxyOwnerKey = null;
let traeProxyGeneration = null;

export function registerTraeSession({ state, commitProviderConnection, contributorReservationHash }) {
  if (!state) return false;
  const ownerKey = proxyOwnerKey(contributorReservationHash);
  if (
    !traeProxyServer
    || !traeProxyGeneration
    || traeProxyOwnerKey !== ownerKey
  ) return false;
  traeSession = {
    state,
    commitProviderConnection,
    contributorReservationHash,
    _proxyOwnerKey: ownerKey,
    _proxyGeneration: traeProxyGeneration,
    status: "pending",
    createdAt: Date.now(),
  };
  return true;
}
export function getTraeSessionStatus(state) {
  if (!traeSession) return null;
  if (state && traeSession.state !== state) return null;
  return traeSession;
}
export function clearTraeSession(state, expectedSession = null) {
  if (expectedSession && traeSession !== expectedSession) return false;
  if (!state || (traeSession && traeSession.state === state)) {
    traeSession = null;
    return true;
  }
  return false;
}

export function startTraeProxy(contributorReservationHash) {
  return new Promise((resolve) => {
    const requestedOwnerKey = proxyOwnerKey(contributorReservationHash);
    if (traeProxyOwnerKey) {
      if (traeProxyOwnerKey !== requestedOwnerKey) {
        resolve({ success: false, reason: "Trae callback proxy is already in use" });
        return;
      }
      if (!traeProxyServer) {
        resolve({ success: false, reason: "Trae callback proxy is still starting" });
        return;
      }
      resolve({ success: true, port: traeProxyPort, callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}` });
      return;
    }
    traeProxyOwnerKey = requestedOwnerKey;
    const generation = nextProxyGeneration();
    traeProxyGeneration = generation;
    const server = http.createServer(async (req, res) => {
      if (!isActiveProxyGeneration(
        server,
        traeProxyServer,
        requestedOwnerKey,
        traeProxyOwnerKey,
        generation,
        traeProxyGeneration,
      )) {
        rejectStaleProxyCallback(res, "Trae");
        return;
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== TRAE_CONFIG.callbackPath && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = traeSession;
      if (!session || !isSessionBoundToGeneration(session, requestedOwnerKey, generation)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Trae login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches (legit redirects send no Origin),
      // and reject state mismatch when state is present.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      if (session.status !== "pending") {
        rejectStaleProxyCallback(res, "Trae");
        return;
      }
      const cbState = url.searchParams.get("state");
      if (cbState && session.state && cbState !== session.state) {
        rejectStaleProxyCallback(res, "Trae");
        return;
      }
      if (!claimSessionForGeneration(session, requestedOwnerKey, generation)) {
        rejectStaleProxyCallback(res, "Trae");
        return;
      }
      // Pass the raw callback query to exchangeTokens → parseTraeCallback
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const tokenData = await exchangeTokens("trae", rawCallback);
        if (!isActiveProxyGeneration(
          server,
          traeProxyServer,
          requestedOwnerKey,
          traeProxyOwnerKey,
          generation,
          traeProxyGeneration,
        ) || !isSessionBoundToGeneration(session, requestedOwnerKey, generation)) {
          throw staleProxyCallbackError("Trae");
        }
        const connection = await persistProxyConnection(session, {
          provider: "trae",
          authType: "oauth",
          ...tokenData,
          expiresAt: tokenData.expiresIn
            ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
            : null,
          testStatus: "active",
        }, () => (
          traeSession === session
          && session.status === "exchanging"
          && isActiveProxyGeneration(
            server,
            traeProxyServer,
            requestedOwnerKey,
            traeProxyOwnerKey,
            generation,
            traeProxyGeneration,
          )
          && isSessionBoundToGeneration(session, requestedOwnerKey, generation)
        ));
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        writeProxyFailure(session, res, renderCodexResultPage, err);
      } finally {
        if (
          session.contributorReservationHash
          && (session.status === "done" || session.errorStatus === 409)
        ) clearTraeSession(session.state, session);
        stopTraeProxy(session.contributorReservationHash, generation);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      if (
        traeProxyOwnerKey !== requestedOwnerKey
        || traeProxyGeneration !== generation
      ) {
        server.close();
        resolve({ success: false, reason: "Trae callback proxy start was cancelled" });
        return;
      }
      traeProxyServer = server;
      traeProxyPort = server.address().port;
      traeProxyTimeout = setTimeout(
        () => stopTraeProxy(contributorReservationHash, generation),
        TRAE_CONFIG.oauthTimeoutMs,
      );
      resolve({ success: true, port: traeProxyPort, callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}` });
    });
    server.on("error", (err) => {
      if (
        !traeProxyServer
        && traeProxyOwnerKey === requestedOwnerKey
        && traeProxyGeneration === generation
      ) {
        traeSession = clearPendingSingletonSessionForGeneration(traeSession, generation);
        traeProxyOwnerKey = null;
        traeProxyGeneration = null;
      }
      resolve({ success: false, reason: err.message });
    });
  });
}

export function stopTraeProxy(contributorReservationHash, expectedGeneration) {
  if (!canStopProxy(
    traeProxyOwnerKey,
    traeProxyGeneration,
    contributorReservationHash,
    expectedGeneration,
  )) return false;
  const generation = traeProxyGeneration;
  if (traeProxyTimeout) { clearTimeout(traeProxyTimeout); traeProxyTimeout = null; }
  const server = traeProxyServer;
  traeProxyServer = null;
  traeProxyPort = null;
  traeProxyOwnerKey = null;
  traeProxyGeneration = null;
  if (server) server.close();
  traeSession = clearPendingSingletonSessionForGeneration(traeSession, generation);
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Windsurf dynamic-port proxy. Singleton session.
// Callback path = /windsurf-auth-callback with params access_token (firebase JWT) + state.
// ───────────────────────────────────────────────────────────────────────────

let windsurfProxyServer = null;
let windsurfProxyTimeout = null;
let windsurfProxyPort = null;
let windsurfSession = null;
let windsurfProxyOwnerKey = null;
let windsurfProxyGeneration = null;

export function registerWindsurfSession({ state, commitProviderConnection, contributorReservationHash }) {
  if (!state) return false;
  const ownerKey = proxyOwnerKey(contributorReservationHash);
  if (
    !windsurfProxyServer
    || !windsurfProxyGeneration
    || windsurfProxyOwnerKey !== ownerKey
  ) return false;
  windsurfSession = {
    state,
    commitProviderConnection,
    contributorReservationHash,
    _proxyOwnerKey: ownerKey,
    _proxyGeneration: windsurfProxyGeneration,
    status: "pending",
    createdAt: Date.now(),
  };
  return true;
}
export function getWindsurfSessionStatus(state) {
  if (!windsurfSession) return null;
  if (state && windsurfSession.state !== state) return null;
  return windsurfSession;
}
export function clearWindsurfSession(state, expectedSession = null) {
  if (expectedSession && windsurfSession !== expectedSession) return false;
  if (!state || (windsurfSession && windsurfSession.state === state)) {
    windsurfSession = null;
    return true;
  }
  return false;
}

export function startWindsurfProxy(contributorReservationHash) {
  return new Promise((resolve) => {
    const requestedOwnerKey = proxyOwnerKey(contributorReservationHash);
    if (windsurfProxyOwnerKey) {
      if (windsurfProxyOwnerKey !== requestedOwnerKey) {
        resolve({ success: false, reason: "Windsurf callback proxy is already in use" });
        return;
      }
      if (!windsurfProxyServer) {
        resolve({ success: false, reason: "Windsurf callback proxy is still starting" });
        return;
      }
      resolve({ success: true, port: windsurfProxyPort, callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}` });
      return;
    }
    windsurfProxyOwnerKey = requestedOwnerKey;
    const generation = nextProxyGeneration();
    windsurfProxyGeneration = generation;
    const server = http.createServer(async (req, res) => {
      if (!isActiveProxyGeneration(
        server,
        windsurfProxyServer,
        requestedOwnerKey,
        windsurfProxyOwnerKey,
        generation,
        windsurfProxyGeneration,
      )) {
        rejectStaleProxyCallback(res, "Windsurf");
        return;
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== WINDSURF_CONFIG.callbackPath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = windsurfSession;
      if (!session || !isSessionBoundToGeneration(session, requestedOwnerKey, generation)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Windsurf login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches, and require state present + matching.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      if (session.status !== "pending") {
        rejectStaleProxyCallback(res, "Windsurf");
        return;
      }
      const cbState = url.searchParams.get("state");
      if (!cbState || !session.state || cbState !== session.state) {
        rejectStaleProxyCallback(res, "Windsurf");
        return;
      }
      if (!claimSessionForGeneration(session, requestedOwnerKey, generation)) {
        rejectStaleProxyCallback(res, "Windsurf");
        return;
      }
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const tokenData = await exchangeTokens("windsurf", rawCallback, null, null, session.state);
        if (!isActiveProxyGeneration(
          server,
          windsurfProxyServer,
          requestedOwnerKey,
          windsurfProxyOwnerKey,
          generation,
          windsurfProxyGeneration,
        ) || !isSessionBoundToGeneration(session, requestedOwnerKey, generation)) {
          throw staleProxyCallbackError("Windsurf");
        }
        const connection = await persistProxyConnection(session, {
          provider: "windsurf",
          authType: "api_key",
          ...tokenData,
          testStatus: "active",
        }, () => (
          windsurfSession === session
          && session.status === "exchanging"
          && isActiveProxyGeneration(
            server,
            windsurfProxyServer,
            requestedOwnerKey,
            windsurfProxyOwnerKey,
            generation,
            windsurfProxyGeneration,
          )
          && isSessionBoundToGeneration(session, requestedOwnerKey, generation)
        ));
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        writeProxyFailure(session, res, renderCodexResultPage, err);
      } finally {
        if (
          session.contributorReservationHash
          && (session.status === "done" || session.errorStatus === 409)
        ) clearWindsurfSession(session.state, session);
        stopWindsurfProxy(session.contributorReservationHash, generation);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      if (
        windsurfProxyOwnerKey !== requestedOwnerKey
        || windsurfProxyGeneration !== generation
      ) {
        server.close();
        resolve({ success: false, reason: "Windsurf callback proxy start was cancelled" });
        return;
      }
      windsurfProxyServer = server;
      windsurfProxyPort = server.address().port;
      windsurfProxyTimeout = setTimeout(
        () => stopWindsurfProxy(contributorReservationHash, generation),
        WINDSURF_CONFIG.oauthTimeoutMs,
      );
      resolve({ success: true, port: windsurfProxyPort, callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}` });
    });
    server.on("error", (err) => {
      if (
        !windsurfProxyServer
        && windsurfProxyOwnerKey === requestedOwnerKey
        && windsurfProxyGeneration === generation
      ) {
        windsurfSession = clearPendingSingletonSessionForGeneration(windsurfSession, generation);
        windsurfProxyOwnerKey = null;
        windsurfProxyGeneration = null;
      }
      resolve({ success: false, reason: err.message });
    });
  });
}

export function stopWindsurfProxy(contributorReservationHash, expectedGeneration) {
  if (!canStopProxy(
    windsurfProxyOwnerKey,
    windsurfProxyGeneration,
    contributorReservationHash,
    expectedGeneration,
  )) return false;
  const generation = windsurfProxyGeneration;
  if (windsurfProxyTimeout) { clearTimeout(windsurfProxyTimeout); windsurfProxyTimeout = null; }
  const server = windsurfProxyServer;
  windsurfProxyServer = null;
  windsurfProxyPort = null;
  windsurfProxyOwnerKey = null;
  windsurfProxyGeneration = null;
  if (server) server.close();
  windsurfSession = clearPendingSingletonSessionForGeneration(windsurfSession, generation);
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Zed RSA native-app proxy. Singleton session.
// Callback: GET http://127.0.0.1:<port>/?user_id=...&access_token=<RSA-encrypted>
// The proxy decrypts the access token using the private key stored in session.codeVerifier.
// ───────────────────────────────────────────────────────────────────────────

let zedProxyServer = null;
let zedProxyTimeout = null;
let zedProxyPort = null;
let zedSession = null;
let zedProxyOwnerKey = null;
let zedProxyGeneration = null;

export function registerZedSession({
  state,
  codeVerifier,
  commitProviderConnection,
  contributorReservationHash,
}) {
  if (!state || !codeVerifier) return false;
  const ownerKey = proxyOwnerKey(contributorReservationHash);
  if (
    !zedProxyServer
    || !zedProxyGeneration
    || zedProxyOwnerKey !== ownerKey
  ) return false;
  zedSession = {
    state,
    codeVerifier,
    commitProviderConnection,
    contributorReservationHash,
    _proxyOwnerKey: ownerKey,
    _proxyGeneration: zedProxyGeneration,
    status: "pending",
    createdAt: Date.now(),
  };
  return true;
}
export function getZedSessionStatus(state) {
  if (!zedSession) return null;
  if (state && zedSession.state !== state) return null;
  return zedSession;
}
export function clearZedSession(state, expectedSession = null) {
  if (expectedSession && zedSession !== expectedSession) return false;
  if (!state || (zedSession && zedSession.state === state)) {
    zedSession = null;
    return true;
  }
  return false;
}

export function startZedProxy(preferredPort = 0, contributorReservationHash) {
  return new Promise((resolve) => {
    const requestedOwnerKey = proxyOwnerKey(contributorReservationHash);
    if (zedProxyOwnerKey) {
      if (zedProxyOwnerKey !== requestedOwnerKey) {
        resolve({ success: false, reason: "Zed callback proxy is already in use" });
        return;
      }
      if (!zedProxyServer) {
        resolve({ success: false, reason: "Zed callback proxy is still starting" });
        return;
      }
      resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
      return;
    }
    zedProxyOwnerKey = requestedOwnerKey;
    const generation = nextProxyGeneration();
    zedProxyGeneration = generation;
    const server = http.createServer(async (req, res) => {
      if (!isActiveProxyGeneration(
        server,
        zedProxyServer,
        requestedOwnerKey,
        zedProxyOwnerKey,
        generation,
        zedProxyGeneration,
      )) {
        rejectStaleProxyCallback(res, "Zed");
        return;
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/" && url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      // Callback paths and query values are attacker/provider controlled and
      // may carry encrypted credentials or error text that echoes them.
      console.log("[Zed proxy] callback received");
      const session = zedSession;
      if (!session || !isSessionBoundToGeneration(session, requestedOwnerKey, generation)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Zed login session"));
        return;
      }
      // Anti-CSRF: Zed tokens are RSA-encrypted to our keypair so they can't be
      // forged cross-site, but still reject cross-origin fetches for defense-in-depth.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      if (!claimSessionForGeneration(session, requestedOwnerKey, generation)) {
        rejectStaleProxyCallback(res, "Zed");
        return;
      }
      // Pass raw callback path+query to exchangeTokens → parseZedCallbackPayload.
      // codeVerifier carries the encoded RSA private key for decryption.
      const rawCallback = url.search ? `${url.pathname}?${url.searchParams.toString()}` : url.pathname;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const tokenData = await exchangeTokens("zed", rawCallback, null, session.codeVerifier, session.state);
        if (!isActiveProxyGeneration(
          server,
          zedProxyServer,
          requestedOwnerKey,
          zedProxyOwnerKey,
          generation,
          zedProxyGeneration,
        ) || !isSessionBoundToGeneration(session, requestedOwnerKey, generation)) {
          throw staleProxyCallbackError("Zed");
        }
        const connection = await persistProxyConnection(session, {
          provider: "zed",
          authType: "oauth",
          ...tokenData,
          testStatus: "active",
        }, () => (
          zedSession === session
          && session.status === "exchanging"
          && isActiveProxyGeneration(
            server,
            zedProxyServer,
            requestedOwnerKey,
            zedProxyOwnerKey,
            generation,
            zedProxyGeneration,
          )
          && isSessionBoundToGeneration(session, requestedOwnerKey, generation)
        ));
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        writeProxyFailure(session, res, renderCodexResultPage, err);
      } finally {
        if (
          session.contributorReservationHash
          && (session.status === "done" || session.errorStatus === 409)
        ) clearZedSession(session.state, session);
        stopZedProxy(session.contributorReservationHash, generation);
      }
    });
    const tryPort = Number(preferredPort) || 0;
    server.on("error", (err) => {
      // If the preferred port (e.g. 58443) is busy, fall back to a random port.
      if (err.code === "EADDRINUSE" && tryPort !== 0) {
        console.log(`[Zed proxy] port ${tryPort} busy, falling back to random`);
        server.listen(0, "127.0.0.1", () => {
          if (
            zedProxyOwnerKey !== requestedOwnerKey
            || zedProxyGeneration !== generation
          ) {
            server.close();
            resolve({ success: false, reason: "Zed callback proxy start was cancelled" });
            return;
          }
          zedProxyServer = server;
          zedProxyPort = server.address().port;
          zedProxyTimeout = setTimeout(
            () => stopZedProxy(contributorReservationHash, generation),
            ZED_HOSTED_CONFIG.oauthTimeoutMs,
          );
          console.log(`[Zed proxy] listening on random port ${zedProxyPort}`);
          resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
        });
      } else {
        console.log(`[Zed proxy] listen error: ${err.message}`);
        if (
          !zedProxyServer
          && zedProxyOwnerKey === requestedOwnerKey
          && zedProxyGeneration === generation
        ) {
          zedSession = clearPendingSingletonSessionForGeneration(zedSession, generation);
          zedProxyOwnerKey = null;
          zedProxyGeneration = null;
        }
        resolve({ success: false, reason: err.message });
      }
    });
    server.listen(tryPort, "127.0.0.1", () => {
      if (
        zedProxyOwnerKey !== requestedOwnerKey
        || zedProxyGeneration !== generation
      ) {
        server.close();
        resolve({ success: false, reason: "Zed callback proxy start was cancelled" });
        return;
      }
      zedProxyServer = server;
      zedProxyPort = server.address().port;
      zedProxyTimeout = setTimeout(() => {
        console.log("[Zed proxy] timeout, stopping");
        stopZedProxy(contributorReservationHash, generation);
      }, ZED_HOSTED_CONFIG.oauthTimeoutMs);
      console.log(`[Zed proxy] listening on port ${zedProxyPort}`);
      resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
    });
  });
}

export function stopZedProxy(contributorReservationHash, expectedGeneration) {
  if (!canStopProxy(
    zedProxyOwnerKey,
    zedProxyGeneration,
    contributorReservationHash,
    expectedGeneration,
  )) return false;
  const generation = zedProxyGeneration;
  console.log(`[Zed proxy] stopping (port ${zedProxyPort || "-"})`);
  if (zedProxyTimeout) { clearTimeout(zedProxyTimeout); zedProxyTimeout = null; }
  const server = zedProxyServer;
  zedProxyServer = null;
  zedProxyPort = null;
  zedProxyOwnerKey = null;
  zedProxyGeneration = null;
  if (server) server.close();
  zedSession = clearPendingSingletonSessionForGeneration(zedSession, generation);
  return true;
}

