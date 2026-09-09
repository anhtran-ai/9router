import { NextResponse } from "next/server";
import {
  getProvider,
  generateAuthData,
  exchangeTokens,
  requestDeviceCode,
  pollForToken
} from "@/lib/oauth/providers";
import { createProviderConnection } from "@/models";
import {
  startCodexProxy,
  stopCodexProxy,
  registerCodexSession,
  getCodexSessionStatus,
  clearCodexSession,
  startXaiProxy,
  stopXaiProxy,
  registerXaiSession,
  getXaiSessionStatus,
  claimXaiSession,
  isXaiSessionCurrent,
  clearXaiSession,
  startTraeProxy,
  stopTraeProxy,
  registerTraeSession,
  getTraeSessionStatus,
  clearTraeSession,
  startWindsurfProxy,
  stopWindsurfProxy,
  registerWindsurfSession,
  getWindsurfSessionStatus,
  clearWindsurfSession,
  startZedProxy,
  stopZedProxy,
  registerZedSession,
  getZedSessionStatus,
  clearZedSession,
} from "@/lib/oauth/utils/server";
import { detectIdeInstalled } from "@/lib/oauth/utils/ideDetect";
import { ZED_HOSTED_CONFIG } from "@/lib/oauth/constants/oauth";
import { readRequestJson } from "open-sse/utils/requestBody.js";

class OAuthConnectionCommitRejectedError extends Error {
  constructor() {
    super("Contribution reservation is no longer valid");
    this.name = "OAuthConnectionCommitRejectedError";
    this.status = 409;
  }
}

async function persistOAuthConnection(data, internalOptions = {}) {
  const commit = internalOptions?.commitProviderConnection;
  const shouldCommit = internalOptions?.shouldCommit;
  if (shouldCommit && !shouldCommit()) throw new OAuthConnectionCommitRejectedError();
  if (typeof commit !== "function") {
    const connection = await createProviderConnection(data, { shouldCommit });
    if (!connection) throw new OAuthConnectionCommitRejectedError();
    return connection;
  }
  const connection = await commit(data);
  if (!connection) throw new OAuthConnectionCommitRejectedError();
  return connection;
}

function oauthErrorStatus(error, fallback = 500) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

function oauthPublicErrorMessage(error, fallback = "OAuth request failed") {
  const status = Number(error?.status);
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  // Explicit 4xx statuses are assigned only to local validation/session
  // errors. Provider transport and response-body failures are intentionally
  // untrusted and must not cross the API boundary.
  if (Number.isInteger(status) && status >= 400 && status < 500 && message && message.length <= 512) {
    return message;
  }
  return fallback;
}

function logOAuthFailure(label, error) {
  // An upstream error can echo the submitted code, verifier, or client
  // secret. Keep logs useful without serializing the exception itself.
  console.log(`${label} (${oauthErrorStatus(error)})`);
}

const PUBLIC_POLL_FAILURES = Object.freeze({
  authorization_pending: "Authorization is pending",
  slow_down: "Authorization is pending; retry more slowly",
  access_denied: "Authorization was denied",
  expired_token: "Authorization code expired",
  invalid_request: "Authorization request is invalid",
  request_failed: "OAuth token polling failed",
  poll_failed: "OAuth token polling failed",
  invalid_response: "OAuth provider returned an invalid response",
  no_access_token: "OAuth provider did not return an access token",
  unknown_error: "OAuth token polling failed",
});

function publicPollFailure(result) {
  const upstreamCode = typeof result?.error === "string" ? result.error : "";
  const error = Object.hasOwn(PUBLIC_POLL_FAILURES, upstreamCode)
    ? upstreamCode
    : "oauth_poll_failed";
  return {
    error,
    errorDescription: PUBLIC_POLL_FAILURES[error] || "OAuth token polling failed",
    pending: error === "authorization_pending" || error === "slow_down",
  };
}

const START_PROXY_QUERY_PRIVATE_KEYS = [
  "state",
  "code_verifier",
  "codeVerifier",
  "token",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
];
const MAX_OAUTH_REQUEST_BODY_BYTES = 1024 * 1024;

function validAppPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

async function startFixedCallbackProxy(provider, payload = {}, internalOptions = {}) {
  const appPort = validAppPort(payload.appPort ?? payload.app_port);
  if (!appPort) {
    return NextResponse.json({ error: "Invalid or missing app_port" }, { status: 400 });
  }

  const state = typeof payload.state === "string" ? payload.state : null;
  const codeVerifier = typeof (payload.codeVerifier ?? payload.code_verifier) === "string"
    ? (payload.codeVerifier ?? payload.code_verifier)
    : null;
  const redirectUri = typeof (payload.redirectUri ?? payload.redirect_uri) === "string"
    ? (payload.redirectUri ?? payload.redirect_uri)
    : null;
  const contributorCommit = typeof internalOptions?.commitProviderConnection === "function";
  if (
    contributorCommit
    && (
      !internalOptions.contributorReservationHash
      || !state
      || !codeVerifier
      || !redirectUri
    )
  ) {
    return NextResponse.json(
      { error: "Contributor proxy requires its reservation, state, codeVerifier, and redirectUri" },
      { status: 400 },
    );
  }

  const result = provider === "xai"
    ? await startXaiProxy(appPort, internalOptions.contributorReservationHash)
    : await startCodexProxy(appPort, internalOptions.contributorReservationHash);
  let serverSide = false;
  if (result.success && state && codeVerifier && redirectUri) {
    serverSide = provider === "xai"
      ? registerXaiSession({
          state,
          codeVerifier,
          redirectUri,
          commitProviderConnection: internalOptions.commitProviderConnection,
          contributorReservationHash: internalOptions.contributorReservationHash,
        })
      : registerCodexSession({
          state,
          codeVerifier,
          redirectUri,
          commitProviderConnection: internalOptions.commitProviderConnection,
          contributorReservationHash: internalOptions.contributorReservationHash,
        });
  }
  if (result.success && contributorCommit && !serverSide) {
    if (provider === "xai") stopXaiProxy(internalOptions.contributorReservationHash);
    else stopCodexProxy(internalOptions.contributorReservationHash);
    return NextResponse.json(
      { error: "Unable to register the contributor proxy session" },
      { status: 409 },
    );
  }
  return NextResponse.json({ ...result, serverSide });
}

async function completeXaiManualCode(code, state, internalOptions = {}) {
  if (!code) throw new Error("Missing xAI authorization code");
  const session = claimXaiSession(state, internalOptions.contributorReservationHash);
  if (!session) {
    const error = new Error("xAI OAuth session is missing or already being completed; restart the login flow");
    error.status = 409;
    throw error;
  }
  if (
    typeof internalOptions?.commitProviderConnection === "function"
    && (
      !internalOptions.contributorReservationHash
      || session.contributorReservationHash !== internalOptions.contributorReservationHash
    )
  ) {
    throw new OAuthConnectionCommitRejectedError();
  }
  try {
    const tokenData = await exchangeTokens(
      "xai",
      code,
      session.redirectUri,
      session.codeVerifier,
      state
    );
    if (!isXaiSessionCurrent(state, session, internalOptions.contributorReservationHash)) {
      throw new OAuthConnectionCommitRejectedError();
    }
    const connection = await persistOAuthConnection({
      provider: "xai",
      authType: "oauth",
      ...tokenData,
      expiresAt: tokenData.expiresIn
        ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
        : null,
      testStatus: "active",
    }, {
      ...internalOptions,
      shouldCommit: () => isXaiSessionCurrent(
        state,
        session,
        internalOptions.contributorReservationHash,
      ),
    });
    clearXaiSession(state, session);
    stopXaiProxy(internalOptions.contributorReservationHash, session._proxyGeneration);
    return {
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
      displayName: connection.displayName,
    };
  } catch (err) {
    clearXaiSession(state, session);
    stopXaiProxy(internalOptions.contributorReservationHash, session._proxyGeneration);
    throw err;
  }
}

/**
 * Dynamic OAuth API Route
 * Handles: authorize, exchange, device-code, poll
 */

// GET /api/oauth/[provider]/authorize - Generate auth URL
// GET /api/oauth/[provider]/device-code - Request device code (for device_code flow)
export async function GET(request, { params }, internalOptions = {}) {
  try {
    const { provider, action } = await params;
    const { searchParams } = new URL(request.url);

    if (action === "authorize") {
      // Authorization endpoints are GETs and their URLs are commonly retained
      // by browsers, reverse proxies and access logs. Secrets belong only in
      // the bounded POST /exchange body.
      if (searchParams.has("clientSecret") || searchParams.has("client_secret")) {
        return NextResponse.json({ error: "OAuth client secrets are not accepted in authorize URLs" }, { status: 400 });
      }
      const redirectUri = searchParams.get("redirect_uri") || "http://localhost:8080/callback";
      // Collect provider-specific public metadata (e.g. GitLab baseUrl/clientId).
      const reservedParams = new Set(["redirect_uri"]);
      const meta = {};
      searchParams.forEach((value, key) => { if (!reservedParams.has(key)) meta[key] = value; });
      // Zed: derive native_app_port from the local callback URL so the RSA keypair
      // is bound to the port the proxy is actually listening on.
      if (provider === "zed") {
        try { const p = new URL(redirectUri).port; if (p) meta.nativeAppPort = p; } catch { /* ignore */ }
      }
      const authData = await generateAuthData(provider, redirectUri, Object.keys(meta).length ? meta : undefined);
      return NextResponse.json(authData);
    }

    if (action === "start-proxy") {
      if (START_PROXY_QUERY_PRIVATE_KEYS.some((key) => searchParams.has(key))) {
        return NextResponse.json(
          { error: "OAuth state, verifier, and tokens are not accepted in start-proxy URLs" },
          { status: 400 },
        );
      }
      // Trae/Windsurf/Zed use a dynamic-port local callback server (singleton session,
      // state is registered separately via /register-session after /authorize).
      if (provider === "trae") {
        const result = await startTraeProxy(internalOptions.contributorReservationHash);
        return NextResponse.json(result);
      }
      if (provider === "windsurf") {
        const result = await startWindsurfProxy(internalOptions.contributorReservationHash);
        return NextResponse.json(result);
      }
      if (provider === "zed") {
        // Prefer ZED_HOSTED_CONFIG.defaultNativeAppPort (58443) so the browser redirect
        // matches what Zed expects; falls back to a random port if it's busy.
        const result = await startZedProxy(
          searchParams.get("native_app_port") || ZED_HOSTED_CONFIG.defaultNativeAppPort,
          internalOptions.contributorReservationHash,
        );
        return NextResponse.json(result);
      }
      if (!["codex", "xai"].includes(provider)) {
        return NextResponse.json({ error: "Proxy only supported for codex/xai/trae/windsurf/zed" }, { status: 400 });
      }
      return startFixedCallbackProxy(provider, {
        appPort: searchParams.get("app_port"),
      }, internalOptions);
    }

    if (action === "poll-status") {
      const state = searchParams.get("state");
      if (!state) {
        return NextResponse.json({ error: "Missing state" }, { status: 400 });
      }
      let session;
      if (provider === "trae") session = getTraeSessionStatus(state);
      else if (provider === "windsurf") session = getWindsurfSessionStatus(state);
      else if (provider === "zed") session = getZedSessionStatus(state);
      else if (provider === "xai") session = getXaiSessionStatus(state);
      else if (provider === "codex") session = getCodexSessionStatus(state);
      else return NextResponse.json({ error: "Poll only supported for codex/xai/trae/windsurf/zed" }, { status: 400 });
      if (!session) return NextResponse.json({ status: "unknown" });
      if (
        internalOptions?.contributorReservationHash
        && session.contributorReservationHash !== internalOptions.contributorReservationHash
      ) {
        return NextResponse.json(
          { error: "Proxy session does not belong to this contribution" },
          { status: 409 },
        );
      }
      if (session.status === "done" || session.status === "error") {
        // Proxy session objects may contain an internal persistence callback.
        // Return only the fields the browser UI consumes instead of depending
        // on JSON.stringify to silently drop function-valued internals.
        const payload = {
          status: session.status,
          ...(typeof session.connectionId === "string" ? { connectionId: session.connectionId } : {}),
          ...(typeof session.email === "string" ? { email: session.email } : {}),
          ...(typeof session.error === "string" ? { error: session.error } : {}),
        };
        if (provider === "trae") clearTraeSession(state);
        else if (provider === "windsurf") clearWindsurfSession(state);
        else if (provider === "zed") clearZedSession(state);
        else if (provider === "xai") clearXaiSession(state);
        else clearCodexSession(state);
        return NextResponse.json(payload);
      }
      return NextResponse.json({ status: session.status });
    }

    if (action === "stop-proxy") {
      let stopped;
      if (provider === "trae") stopped = stopTraeProxy(internalOptions.contributorReservationHash);
      else if (provider === "windsurf") stopped = stopWindsurfProxy(internalOptions.contributorReservationHash);
      else if (provider === "zed") stopped = stopZedProxy(internalOptions.contributorReservationHash);
      else if (provider === "xai") stopped = stopXaiProxy(internalOptions.contributorReservationHash);
      else if (provider === "codex") stopped = stopCodexProxy(internalOptions.contributorReservationHash);
      else return NextResponse.json({ error: "Proxy only supported for codex/xai/trae/windsurf/zed" }, { status: 400 });
      if (stopped === false) {
        return NextResponse.json(
          { error: "Proxy session does not belong to this contribution" },
          { status: 409 },
        );
      }
      return NextResponse.json({ success: true });
    }

    if (action === "ide-status") {
      // Detect whether the IDE is installed locally (used by import-token UX).
      if (provider !== "trae" && provider !== "windsurf") {
        return NextResponse.json({ error: "ide-status only supported for trae/windsurf" }, { status: 400 });
      }
      const status = await detectIdeInstalled(provider);
      return NextResponse.json(status);
    }

    if (action === "device-code") {
      const providerData = getProvider(provider);
      if (providerData.flowType !== "device_code") {
        return NextResponse.json({ error: "Provider does not support device code flow" }, { status: 400 });
      }

      const authData = await generateAuthData(provider, null);
      const startUrl = searchParams.get("start_url");
      const region = searchParams.get("region");
      const authMethod = searchParams.get("auth_method");
      const deviceOptions = provider === "kiro"
        ? {
            ...(startUrl ? { startUrl } : {}),
            ...(region ? { region } : {}),
            ...(authMethod ? { authMethod } : {}),
          }
        : undefined;
      
      // Providers that don't use PKCE for device code (Grok CLI HAR: plain device_code, no challenge)
      const noPkceDeviceProviders = [
        "github",
        "kiro",
        "kimi",
        "kimi-coding",
        "kilocode",
        "codebuddy-cn",
        "codebuddy-intl",
        "qoder",
        "grok-cli",
      ];
      let deviceData;
      if (noPkceDeviceProviders.includes(provider)) {
        deviceData = await requestDeviceCode(provider, undefined, deviceOptions);
      } else {
        // Qwen and other PKCE providers
        deviceData = await requestDeviceCode(provider, authData.codeChallenge, deviceOptions);
      }

      return NextResponse.json({
        ...deviceData,
        // Prefer the verifier the provider's requestDeviceCode generated for
        // itself (qoder rolls its own PKCE pair); fall back to the generic one.
        codeVerifier: deviceData.codeVerifier || authData.codeVerifier,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    logOAuthFailure("OAuth GET error", error);
    return NextResponse.json(
      { error: oauthPublicErrorMessage(error) },
      { status: oauthErrorStatus(error) },
    );
  }
}

// POST /api/oauth/[provider]/exchange - Exchange code for tokens and save
// POST /api/oauth/[provider]/poll - Poll for token (device_code flow)
export async function POST(request, { params }, internalOptions = {}) {
  try {
    const { provider, action } = await params;
    let body;
    try {
      body = await readRequestJson(request, {
        maxBytes: MAX_OAUTH_REQUEST_BODY_BYTES,
        label: "OAuth request body",
        requireBody: true,
      });
    } catch (error) {
      const status = Number(error?.status);
      if ([408, 413, 499].includes(status)) {
        return NextResponse.json({ error: error.message }, { status });
      }
      return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 });
    }

    if (action === "start-proxy") {
      const searchParams = new URL(request.url).searchParams;
      if (START_PROXY_QUERY_PRIVATE_KEYS.some((key) => searchParams.has(key))) {
        return NextResponse.json(
          { error: "OAuth state, verifier, and tokens are not accepted in start-proxy URLs" },
          { status: 400 },
        );
      }
      if (!["codex", "xai"].includes(provider)) {
        return NextResponse.json(
          { error: "POST start-proxy is only supported for codex/xai" },
          { status: 400 },
        );
      }
      return startFixedCallbackProxy(provider, body, internalOptions);
    }

    if (action === "register-session") {
      // Session state and Zed's RSA private-key verifier must stay in the POST
      // body so browser, reverse-proxy, and access logs never retain them.
      const searchParams = new URL(request.url).searchParams;
      if (START_PROXY_QUERY_PRIVATE_KEYS.some((key) => searchParams.has(key))) {
        return NextResponse.json(
          { error: "OAuth state, verifier, and tokens are not accepted in register-session URLs" },
          { status: 400 },
        );
      }
      const state = body?.state;
      if (!state) return NextResponse.json({ error: "Missing state" }, { status: 400 });
      if (
        typeof internalOptions?.commitProviderConnection === "function"
        && !internalOptions.contributorReservationHash
      ) {
        return NextResponse.json(
          { error: "Missing contributor proxy reservation" },
          { status: 409 },
        );
      }
      let ok = false;
      if (provider === "trae") ok = registerTraeSession({
        state,
        commitProviderConnection: internalOptions.commitProviderConnection,
        contributorReservationHash: internalOptions.contributorReservationHash,
      });
      else if (provider === "windsurf") ok = registerWindsurfSession({
        state,
        commitProviderConnection: internalOptions.commitProviderConnection,
        contributorReservationHash: internalOptions.contributorReservationHash,
      });
      else if (provider === "zed") ok = registerZedSession({
        state,
        codeVerifier: body?.codeVerifier,
        commitProviderConnection: internalOptions.commitProviderConnection,
        contributorReservationHash: internalOptions.contributorReservationHash,
      });
      else return NextResponse.json({ error: "register-session only supported for trae/windsurf/zed" }, { status: 400 });
      if (!ok && typeof internalOptions?.commitProviderConnection === "function") {
        if (provider === "trae") stopTraeProxy(internalOptions.contributorReservationHash);
        else if (provider === "windsurf") stopWindsurfProxy(internalOptions.contributorReservationHash);
        else stopZedProxy(internalOptions.contributorReservationHash);
      }
      return NextResponse.json({ success: ok });
    }

    if (action === "exchange") {
      const { code, redirectUri, codeVerifier, state, meta } = body;

      // Trae/Windsurf: code is either a raw callback URL or a pasted token.
      // exchangeTokens() handles both paths; no PKCE, skip codex JWT extraction.
      if (provider === "trae" || provider === "windsurf") {
        const token = typeof code === "string" ? code.trim() : "";
        if (!token) {
          return NextResponse.json({ error: "Missing token or callback URL" }, { status: 400 });
        }
        try {
          const tokenData = await exchangeTokens(provider, token, null, null, state);
          const connection = await persistOAuthConnection({
            provider,
            authType: provider === "windsurf" ? "api_key" : "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          }, internalOptions);
          return NextResponse.json({
            success: true,
            connection: {
              id: connection.id,
              provider: connection.provider,
              email: connection.email,
              displayName: connection.displayName,
            }
          });
        } catch (err) {
          logOAuthFailure("OAuth exchange error", err);
          return NextResponse.json(
            { error: oauthPublicErrorMessage(err) },
            { status: oauthErrorStatus(err) },
          );
        }
      }

      // Detect if "code" is actually a raw JWT access token (starts with eyJ)
      if (code && code.startsWith("eyJ") && code.includes(".")) {
        const { extractCodexAccountInfo } = await import("@/lib/oauth/providers");
        const info = extractCodexAccountInfo(code);

        // Also decode JWT directly for ChatGPT website tokens which use
        // top-level account_id/plan_type instead of nested openai auth claims
        let directPayload = {};
        try {
          const b64 = code.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
          const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
          directPayload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        } catch {}

        const accountId = info.chatgptAccountId || directPayload.account_id;
        const planType = info.chatgptPlanType || directPayload.plan_type;
        const email = info.email || directPayload.email;

        const providerSpecificData = { authMethod: "access_token" };
        if (accountId) providerSpecificData.chatgptAccountId = accountId;
        if (planType) providerSpecificData.chatgptPlanType = planType;

        const connection = await persistOAuthConnection({
          provider,
          authType: "access_token",
          accessToken: code,
          email: email || null,
          providerSpecificData,
          testStatus: "active",
        }, internalOptions);

        return NextResponse.json({
          success: true,
          connection: {
            id: connection.id,
            provider: connection.provider,
            email: connection.email,
            displayName: connection.displayName,
          }
        });
      }

      // Cline and ClinePass use authorization_code without PKCE. Kimchi returns a browser token.
      const noPkceExchangeProviders = ["cline", "clinepass", "kimchi"];
      if (!code || !redirectUri || (!codeVerifier && !noPkceExchangeProviders.includes(provider))) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
      }

      // Exchange code for tokens (meta carries provider-specific params, e.g. gitlab clientId/baseUrl)
      const tokenData = await exchangeTokens(provider, code, redirectUri, codeVerifier, state, meta);

      // Save to database
      const connection = await persistOAuthConnection({
        provider,
        authType: "oauth",
        ...tokenData,
        expiresAt: tokenData.expiresIn 
          ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString() 
          : null,
        testStatus: "active",
      }, internalOptions);

      return NextResponse.json({ 
        success: true, 
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.displayName,
        }
      });
    }

    if (action === "poll") {
      const { deviceCode, codeVerifier, extraData } = body;

      if (!deviceCode) {
        return NextResponse.json({ error: "Missing device code" }, { status: 400 });
      }

      // Providers that don't use PKCE for device code
      const noPkceProviders = ["github", "kimi", "kimi-coding", "kilocode", "codebuddy-cn", "codebuddy-intl"];
      let result;
      if (noPkceProviders.includes(provider)) {
        // kimi needs extraData._kimiDeviceId for stable X-Msh-Device-Id (CLIProxyAPI parity)
        result = await pollForToken(provider, deviceCode, null, extraData);
      } else if (provider === "kiro") {
        // Kiro needs extraData (clientId, clientSecret) from device code response
        result = await pollForToken(provider, deviceCode, null, extraData);
      } else if (provider === "qoder") {
        // Qoder needs both the PKCE verifier (codeVerifier) and the machineId
        // captured at device-code time (extraData._qoderMachineId) so
        // mapTokens can persist it for COSY signing.
        if (!codeVerifier) {
          return NextResponse.json({ error: "Missing code verifier" }, { status: 400 });
        }
        result = await pollForToken(provider, deviceCode, codeVerifier, extraData);
      } else {
        // Qwen and other PKCE providers
        if (!codeVerifier) {
          return NextResponse.json({ error: "Missing code verifier" }, { status: 400 });
        }
        result = await pollForToken(provider, deviceCode, codeVerifier);
      }

      if (result.success) {
        // Save to database (legacy kimi-coding OAuth → dual-auth kimi)
        const providerId = provider === "kimi-coding" ? "kimi" : provider;
        const connection = await persistOAuthConnection({
          provider: providerId,
          authType: "oauth",
          ...result.tokens,
          expiresAt: result.tokens.expiresIn 
            ? new Date(Date.now() + result.tokens.expiresIn * 1000).toISOString() 
            : null,
          testStatus: "active",
        }, internalOptions);

        return NextResponse.json({ 
          success: true, 
          connection: {
            id: connection.id,
            provider: connection.provider,
          }
        });
      }

      // Still pending or error - don't create a connection. Provider payloads
      // may reflect the submitted device code or client secret, so return only
      // stable public codes and descriptions.
      const publicFailure = publicPollFailure(result);
      return NextResponse.json({
        success: false,
        ...publicFailure,
      });
    }

    if (action === "manual-code") {
      if (provider !== "xai") {
        return NextResponse.json({ error: "Manual code only supported for xai" }, { status: 400 });
      }
      const { code, state } = body;
      const connection = await completeXaiManualCode(
        String(code || "").trim(),
        String(state || "").trim(),
        internalOptions,
      );
      return NextResponse.json({ success: true, connection });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    logOAuthFailure("OAuth POST error", error);
    return NextResponse.json(
      { error: oauthPublicErrorMessage(error) },
      { status: oauthErrorStatus(error) },
    );
  }
}
