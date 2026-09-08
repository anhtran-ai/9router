import { GITLAB_CONFIG } from "../constants/oauth.js";

const GITLAB_REQUEST_TIMEOUT_MS = 15_000;
const GITLAB_RESPONSE_MAX_BYTES = 1024 * 1024;
const GITLAB_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function discardBody(response) {
  if (!response?.body || response.bodyUsed === true) return;
  try {
    const cancellation = response.body.cancel();
    cancellation?.catch?.(() => {});
  } catch { /* best-effort connection release */ }
}

function cancelReader(reader) {
  let cancellation;
  try {
    cancellation = reader.cancel();
  } catch {
    releaseReader(reader);
    return;
  }
  Promise.resolve(cancellation).catch(() => {}).finally(() => releaseReader(reader));
}

function releaseReader(reader) {
  try { reader.releaseLock?.(); } catch { /* a pending read releases after cancellation settles */ }
}

function readWithSignal(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Request aborted", "AbortError"));
  }

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Request aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([reader.read(), aborted])
    .finally(() => signal.removeEventListener("abort", onAbort));
}

async function readBoundedText(response, maxBytes, signal) {
  if (!response?.body?.getReader) {
    if (typeof response?.text === "function") return await response.text();
    if (typeof response?.json === "function") return JSON.stringify(await response.json());
    return "";
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("GitLab response body is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    releaseReader(reader);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: response.ok }).decode(bytes);
}

function switchRedirectToGet(status, method) {
  const normalized = String(method || "GET").toUpperCase();
  return (status === 303 && normalized !== "HEAD")
    || ((status === 301 || status === 302) && normalized === "POST");
}

// OAuth codes, client secrets, and bearer tokens must stay on the exact origin
// selected by the administrator. Native fetch follows 307/308 redirects with
// the original body, which would otherwise send those credentials to a second
// origin. Same-origin redirects remain supported for self-hosted GitLab paths.
async function requestGitLab(url, init, approvedOrigin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITLAB_REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  let currentUrl = new URL(url).toString();
  let currentInit = { ...init, headers: new Headers(init?.headers || {}) };
  let response;

  try {
    for (let hop = 0; ; hop++) {
      const current = new URL(currentUrl);
      if (!["http:", "https:"].includes(current.protocol) || current.origin !== approvedOrigin) {
        throw new Error("GitLab OAuth redirect origin is not approved");
      }

      response = await fetch(currentUrl, {
        ...currentInit,
        redirect: "manual",
        signal,
      });
      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers?.get?.("location")
        : null;
      if (!location) break;

      const redirectStatus = response.status;
      discardBody(response);
      response = null;
      if (hop >= GITLAB_MAX_REDIRECTS) throw new Error("GitLab OAuth redirect limit exceeded");

      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.origin !== approvedOrigin) {
        throw new Error("GitLab OAuth redirect origin is not approved");
      }
      if (switchRedirectToGet(redirectStatus, currentInit.method)) {
        const headers = new Headers(currentInit.headers);
        headers.delete("content-length");
        headers.delete("content-type");
        headers.delete("transfer-encoding");
        currentInit = { ...currentInit, method: "GET", body: undefined, headers };
      }
      currentUrl = nextUrl.toString();
    }

    const text = await readBoundedText(response, GITLAB_RESPONSE_MAX_BYTES, signal);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* retain text for status errors */ }
    return { ok: response.ok, status: response.status, text, json };
  } catch (error) {
    discardBody(response);
    if (controller.signal.aborted) {
      throw new Error("GitLab OAuth request timeout", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// GitLab Duo - Authorization Code Flow with PKCE
// Supports two login modes via loginMode metadata: "oauth" (default) or "pat"
const gitlab = {
  config: GITLAB_CONFIG,
  flowType: "authorization_code_pkce",
  buildAuthUrl: (config, redirectUri, state, codeChallenge, meta = {}) => {
    const baseUrl = meta.baseUrl || config.defaultBaseUrl;
    const clientId = meta.clientId || "";
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      scope: config.scope,
      code_challenge: codeChallenge,
      code_challenge_method: config.codeChallengeMethod,
    });
    return `${baseUrl}${config.authorizeUrlPath}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta = {}) => {
    const baseUrl = meta.baseUrl || config.defaultBaseUrl;
    const parsedBaseUrl = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
      throw new Error("GitLab base URL must use HTTP or HTTPS");
    }
    const approvedOrigin = parsedBaseUrl.origin;
    const clientId = meta.clientId || "";
    const clientSecret = meta.clientSecret || "";
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    const tokenResult = await requestGitLab(`${baseUrl}${config.tokenUrlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    }, approvedOrigin);
    if (!tokenResult.ok) {
      // An upstream error can echo the submitted authorization code or client
      // secret. Keep response bodies out of exceptions, API responses and logs.
      throw new Error(`GitLab token exchange failed (${tokenResult.status})`);
    }
    const tokens = tokenResult.json;
    if (!tokens || typeof tokens !== "object" || typeof tokens.access_token !== "string") {
      throw new Error("GitLab token exchange returned an invalid response");
    }
    // Fetch user info
    const userResult = await requestGitLab(`${baseUrl}${config.userInfoUrlPath}`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }, approvedOrigin);
    const user = userResult.ok && userResult.json && typeof userResult.json === "object"
      ? userResult.json
      : {};
    return { ...tokens, _user: user, _baseUrl: baseUrl, _clientId: clientId };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    providerSpecificData: {
      username: tokens._user?.username || "",
      email: tokens._user?.email || tokens._user?.public_email || "",
      name: tokens._user?.name || "",
      baseUrl: tokens._baseUrl,
      clientId: tokens._clientId,
      authKind: "oauth",
    },
  }),
};

export default gitlab;
