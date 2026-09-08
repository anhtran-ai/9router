import { PROVIDERS, PROVIDER_OAUTH } from "../../config/providers.js";
import { OAUTH_ENDPOINTS, GITHUB_COPILOT, buildKimiHeaders } from "../../config/appConstants.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { awaitWithSignal, throwIfAborted } from "../../utils/abort.js";
import { dedupRefresh } from "./dedup.js";
import { buildExternalIdpRefreshParams } from "../../../src/lib/oauth/kiroExternalIdp.js";
import {
  awaitModelCatalogResponse,
  readModelCatalogJson,
  readModelCatalogText,
} from "../modelCatalogResponse.js";

const TOKEN_REFRESH_BODY_LIMIT_BYTES = 256 * 1024;
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const COPILOT_REFRESH_TIMEOUT_MS = 10_000;
const KIRO_REFRESH_TIMEOUT_MS = 30_000;

// OAuth error bodies are controlled by remote servers and may reflect request
// credentials. Only expose fixed, recognized codes to logs; status codes are
// supplied by the local HTTP client and are safe to retain.
const SAFE_REFRESH_ERROR_CODES = new Set([
  "access_denied",
  "authorization_pending",
  "expired_token",
  "insufficient_scope",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "invalid_token",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "server_error",
  "slow_down",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_grant_type",
  // CodeBuddy's documented device-flow pending response.
  "11217",
]);

function allowlistedRefreshErrorCode(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim().toLowerCase();
  return SAFE_REFRESH_ERROR_CODES.has(normalized) ? normalized : null;
}

function refreshErrorCode(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    const direct = allowlistedRefreshErrorCode(parsed);
    if (direct) return direct;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  const candidates = [
    parsed.error?.code,
    parsed.error,
    parsed.error_code,
    parsed.code,
  ];
  for (const candidate of candidates) {
    const code = allowlistedRefreshErrorCode(candidate);
    if (code) return code;
  }
  return null;
}

function refreshFailureLog(status, upstreamValue, extra = null) {
  const details = {};
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    details.status = status;
  }
  const code = refreshErrorCode(upstreamValue);
  if (code) details.code = code;
  if (extra && typeof extra === "object") Object.assign(details, extra);
  return details;
}

function describeRefreshFailure(label, error) {
  if (error?.name === "TimeoutError") return `${label} timed out`;
  if (error?.name === "AbortError") return `${label} was aborted`;
  if (error?.code === "ERR_MODEL_CATALOG_BODY_TOO_LARGE") {
    return `${label} response was too large`;
  }
  if (error?.name === "SyntaxError") return `${label} returned malformed JSON`;
  if (error?.name === "EncodingError") return `${label} returned invalid UTF-8`;
  return `${label} failed`;
}

async function runTokenRefreshWithDeadline(label, timeoutMs, operation) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`${label} timed out`, "TimeoutError")),
    timeoutMs,
  );
  const pending = Promise.resolve().then(() => operation(controller.signal));
  try {
    // Keep observing `pending` if a custom fetch ignores AbortSignal and settles
    // after the deadline; this prevents a late unhandled rejection.
    return await awaitWithSignal(pending, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function readRefreshText(response, signal) {
  if (response?.body && typeof response.body.getReader === "function") {
    return readModelCatalogText(response, {
      signal,
      maxBytes: TOKEN_REFRESH_BODY_LIMIT_BYTES,
    });
  }
  // Compatibility for lightweight Response doubles. The surrounding refresh
  // deadline still bounds an abort-ignoring `.text()` implementation.
  return awaitWithSignal(response?.text?.() ?? Promise.resolve(""), signal);
}

async function readRefreshJson(response, signal) {
  if (response?.body && typeof response.body.getReader === "function") {
    return readModelCatalogJson(response, {
      signal,
      maxBytes: TOKEN_REFRESH_BODY_LIMIT_BYTES,
    });
  }
  // Compatibility for lightweight Response doubles used by integrations.
  return awaitWithSignal(response?.json?.() ?? Promise.reject(new TypeError("Missing JSON body")), signal);
}

export async function requestRefreshJson(label, url, init, log) {
  try {
    return await runTokenRefreshWithDeadline(label, TOKEN_REFRESH_TIMEOUT_MS, async (signal) => {
      const response = await awaitModelCatalogResponse(
        fetch(url, { ...init, signal }),
        signal,
      );
      if (!response.ok) {
        return {
          response,
          errorText: await readRefreshText(response, signal),
          data: null,
        };
      }
      return {
        response,
        errorText: "",
        data: await readRefreshJson(response, signal),
      };
    });
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Error during ${label}`, {
      error: describeRefreshFailure(label, error),
    });
    return { transportError: error, response: null, errorText: "", data: null };
  }
}

let _xaiServiceSingleton = null;
export async function refreshXaiToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("xai", refreshToken, async () => {
    try {
      return await runTokenRefreshWithDeadline(
        "xAI token refresh",
        TOKEN_REFRESH_TIMEOUT_MS,
        async (signal) => {
          if (!_xaiServiceSingleton) {
            const mod = await import("../../../src/lib/oauth/services/xai.js");
            _xaiServiceSingleton = new mod.XaiService();
          }
          const tokens = await _xaiServiceSingleton.refreshAccessToken(refreshToken, { signal });
          if (!tokens?.access_token) return null;
          return {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || refreshToken,
            expiresIn: tokens.expires_in,
            idToken: tokens.id_token,
          };
        },
      );
    } catch (e) {
      log?.warn?.("TOKEN_REFRESH", "xAI token refresh failed", {
        error: describeRefreshFailure("xAI token refresh", e),
      });
      const code = String(e?.oauthCode || e?.cause?.oauthCode || "");
      if (code === "invalid_grant" || code === "invalid_request") {
        return { error: "invalid_grant" };
      }
      return null;
    }
  }, log);
}

// Per-provider refresh variants for the generic path. Keys not listed fall back
// to the default form-encoded OAuth2 refresh with client_id + client_secret.
const REFRESH_PROFILES = {
  claude: {
    bodyFormat: "json",
    includeClientSecret: false,
    url: () => OAUTH_ENDPOINTS.anthropic.token,
    dedupKey: "claude",
  },
  iflow: {
    url: () => OAUTH_ENDPOINTS.iflow.token,
    dedupKey: "iflow",
    extraHeaders: (creds, cfg) => ({
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
    }),
  },
  github: {
    url: () => OAUTH_ENDPOINTS.github.token,
    dedupKey: "github",
    includeClientSecret: (cfg) => !!cfg?.clientSecret,
  },
  kimi: {
    dedupKey: "kimi",
    extraHeaders: (creds) => buildKimiHeaders(creds?.providerSpecificData?.deviceId),
  },
};

function resolveRefreshUrl(provider, config, profile) {
  if (profile?.url) {
    try { return profile.url(); } catch { /* fall through */ }
  }
  return config?.refreshUrl || PROVIDER_OAUTH[provider]?.tokenUrl || null;
}

function buildRefreshBody(profile, config, refreshToken) {
  const fmt = profile?.bodyFormat === "json" ? "json" : "form";
  const includeSecret = profile?.includeClientSecret === undefined
    ? true
    : typeof profile.includeClientSecret === "function"
      ? profile.includeClientSecret(config)
      : profile.includeClientSecret;
  const payload = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  };
  if (includeSecret && config.clientSecret) payload.client_secret = config.clientSecret;
  if (fmt === "json") return { format: "json", body: JSON.stringify(payload) };
  return { format: "form", body: new URLSearchParams(payload) };
}

export async function refreshAccessToken(provider, refreshToken, credentials, log) {
  const config = PROVIDERS[provider];
  const profile = REFRESH_PROFILES[provider] || {};
  const url = resolveRefreshUrl(provider, config, profile);

  if (!config || !url) {
    log?.warn?.("TOKEN_REFRESH", `No refresh URL configured for provider: ${provider}`);
    return null;
  }

  if (!refreshToken) {
    log?.warn?.("TOKEN_REFRESH", `No refresh token available for provider: ${provider}`);
    return null;
  }

  const dedupKey = profile.dedupKey || provider;

  return dedupRefresh(dedupKey, refreshToken, async () => {
  try {
    const { format: bodyFormat, body } = buildRefreshBody(profile, config, refreshToken);
    const headers = {
      "Content-Type": bodyFormat === "json" ? "application/json" : "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...(profile.extraHeaders ? (profile.extraHeaders(credentials, config) || {}) : {}),
    };
    const refreshResult = await requestRefreshJson(
      `${provider} token refresh`,
      url,
      { method: "POST", headers, body },
      log,
    );
    if (refreshResult.transportError) return null;
    const { response, errorText, data: tokens } = refreshResult;

    if (!response.ok) {
      log?.error?.("TOKEN_REFRESH", `Failed to refresh token for ${provider}`, {
        ...refreshFailureLog(response.status, errorText),
      });
      return null;
    }

    if (!tokens?.access_token) {
      log?.error?.("TOKEN_REFRESH", `Token refresh for ${provider} returned no access token`);
      return null;
    }

    log?.info?.("TOKEN_REFRESH", `Successfully refreshed token for ${provider}`, {
      hasNewAccessToken: true,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
      ...(profile.parse ? (profile.parse(tokens) || {}) : {}),
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Error refreshing token for ${provider}`, {
      error: describeRefreshFailure(`${provider} token refresh`, error),
    });
    return null;
  }
  }, log);
}

// CLIProxyAPI DeviceFlowClient.RefreshToken: form body (no client_secret) + X-Msh-* headers
// Delegate to refreshAccessToken("kimi", ...) — profile carries the X-Msh headers.
export async function refreshKimiToken(refreshToken, credentials, log) {
  return refreshAccessToken("kimi", refreshToken, credentials, log);
}

export async function refreshClineToken(refreshToken, log) {
  if (!refreshToken) return null;

  return dedupRefresh("cline", refreshToken, async () => {
    try {
      const refreshResult = await requestRefreshJson("Cline token refresh", PROVIDERS.cline?.refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          refreshToken,
          grantType: "refresh_token",
          clientType: "extension",
        }),
      }, log);
      if (refreshResult.transportError) return null;
      const { response, errorText, data: body } = refreshResult;

      if (!response.ok) {
        log?.error?.("TOKEN_REFRESH", "Failed to refresh Cline token", {
          ...refreshFailureLog(response.status, errorText),
        });
        return null;
      }

      const tokens = body?.data || body;
      if (!tokens?.accessToken) {
        log?.error?.("TOKEN_REFRESH", "Cline token refresh returned no access token");
        return null;
      }

      const expiresIn = tokens.expiresAt
        ? Math.max(1, Math.floor((new Date(tokens.expiresAt).getTime() - Date.now()) / 1000))
        : (tokens.expiresIn || tokens.expires_in || 3600);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || refreshToken,
        expiresIn,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", "Error refreshing Cline token", {
        error: describeRefreshFailure("Cline token refresh", error),
      });
      return null;
    }
  }, log);
}

// Claude OAuth: JSON body, client_id only. Delegate to refreshAccessToken("claude", ...).
export async function refreshClaudeOAuthToken(refreshToken, log) {
  return refreshAccessToken("claude", refreshToken, {}, log);
}

export async function refreshGoogleToken(refreshToken, clientId, clientSecret, log) {
  if (!refreshToken) return null;
  return dedupRefresh(`google:${clientId}`, refreshToken, async () => {
  try {
    const refreshResult = await requestRefreshJson("Google token refresh", OAUTH_ENDPOINTS.google.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    }, log);
    if (refreshResult.transportError) return null;
    const { response, errorText, data: tokens } = refreshResult;

    if (!response.ok) {
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Google token", {
        ...refreshFailureLog(response.status, errorText),
      });
      return null;
    }

    if (!tokens?.access_token) {
      log?.error?.("TOKEN_REFRESH", "Google token refresh returned no access token");
      return null;
    }
    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Google token", { hasNewAccessToken: true, expiresIn: tokens.expires_in });
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", "Error refreshing Google token", {
      error: describeRefreshFailure("Google token refresh", error),
    });
    return null;
  }
  }, log);
}

export function classifyOAuthRefreshError(errorText = "", status = 0) {
  let parsed = null;
  try {
    parsed = errorText ? JSON.parse(errorText) : null;
  } catch {
    parsed = null;
  }

  const code = parsed?.error?.code || parsed?.error || parsed?.error_code || "";
  const description = parsed?.error_description || parsed?.message || errorText || "";
  const combined = `${code} ${description}`.toLowerCase();
  const permanent = [
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
    "invalid_grant",
  ].some((marker) => combined.includes(marker));

  return { status, code, description, permanent };
}

export async function refreshCodexToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codex", refreshToken, async () => {
    try {
      const refreshResult = await requestRefreshJson("Codex token refresh", OAUTH_ENDPOINTS.openai.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: PROVIDERS.codex.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      }, log);
      if (refreshResult.transportError) return null;
      const { response, errorText, data: tokens } = refreshResult;

      if (!response.ok) {
        const failure = classifyOAuthRefreshError(errorText, response.status);
        if (failure.permanent) {
          log?.error?.("TOKEN_REFRESH", "Codex refresh token already used or invalid. Re-auth required.", {
            ...refreshFailureLog(response.status, failure.code),
          });
          const safeCode = refreshErrorCode(errorText) || "invalid_grant";
          return { error: "unrecoverable_refresh_error", code: safeCode };
        }

        log?.error?.("TOKEN_REFRESH", "Failed to refresh Codex token", {
          ...refreshFailureLog(response.status, failure.code, {
            permanent: failure.permanent,
          }),
        });
        return null;
      }

      if (!tokens?.access_token) {
        log?.error?.("TOKEN_REFRESH", "Codex token refresh returned no access token");
        return null;
      }

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Codex token", {
        hasNewAccessToken: true,
        hasNewRefreshToken: !!tokens.refresh_token,
        hasIdToken: !!tokens.id_token,
        expiresIn: tokens.expires_in,
      });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        idToken: tokens.id_token,
        expiresIn: tokens.expires_in,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", "Error refreshing Codex token", {
        error: describeRefreshFailure("Codex token refresh", error),
      });
      return null;
    }
  }, log);
}

async function resolveKiroProfileArnPatch(providerSpecificData, accessToken, refreshedArn, signal) {
  if (providerSpecificData?.profileArn) return {};
  let profileArn = refreshedArn?.trim?.() || null;
  if (!profileArn) {
    const { fetchKiroProfileArn } = await import("../../../src/lib/oauth/providers.js");
    profileArn = await awaitWithSignal(fetchKiroProfileArn(accessToken, { signal }), signal);
  }
  return profileArn ? { providerSpecificData: { profileArn } } : {};
}

export async function refreshKiroToken(
  refreshToken,
  providerSpecificData,
  log,
  proxyOptions = null,
  requestOptions = null,
) {
  if (!refreshToken) return null;
  throwIfAborted(requestOptions?.signal);
  const sharedRefresh = dedupRefresh("kiro", refreshToken, async () => {
  try {
  return await runTokenRefreshWithDeadline("Kiro token refresh", KIRO_REFRESH_TIMEOUT_MS, async (refreshSignal) => {
  const authMethod = providerSpecificData?.authMethod;
  const clientId = providerSpecificData?.clientId;
  const clientSecret = providerSpecificData?.clientSecret;
  const region = providerSpecificData?.region;

  if (authMethod === "external_idp") {
    let refreshRequest;
    try {
      refreshRequest = buildExternalIdpRefreshParams(refreshToken, providerSpecificData);
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", "Invalid Kiro external_idp refresh config", {
        error: describeRefreshFailure("Kiro external_idp refresh config", error),
      });
      return null;
    }

    const response = await awaitModelCatalogResponse(proxyAwareFetch(refreshRequest.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: refreshRequest.body,
      signal: refreshSignal,
    }, proxyOptions), refreshSignal);

    if (!response.ok) {
      const errorText = await readRefreshText(response, refreshSignal);
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro external_idp token", {
        ...refreshFailureLog(response.status, errorText),
      });
      return null;
    }

    const tokens = await readRefreshJson(response, refreshSignal);
    if (!tokens?.access_token) {
      log?.error?.("TOKEN_REFRESH", "Kiro external_idp refresh returned no access token");
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro external_idp token", {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
      providerSpecificData: refreshRequest.providerSpecificData,
    };
  }

  if (clientId && clientSecret) {
    const isIDC = authMethod === "idc";
    const endpoint = isIDC && region
      ? `https://oidc.${region}.amazonaws.com/token`
      : "https://oidc.us-east-1.amazonaws.com/token";

    const response = await awaitModelCatalogResponse(proxyAwareFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId: clientId,
        clientSecret: clientSecret,
        refreshToken: refreshToken,
        grantType: "refresh_token",
      }),
      signal: refreshSignal,
    }, proxyOptions), refreshSignal);

    if (!response.ok) {
      const errorText = await readRefreshText(response, refreshSignal);
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro AWS token", {
        ...refreshFailureLog(response.status, errorText),
      });
      return null;
    }

    const tokens = await readRefreshJson(response, refreshSignal);
    if (!tokens?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "Kiro AWS refresh returned no access token");
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro AWS token", {
      hasNewAccessToken: !!tokens.accessToken,
      expiresIn: tokens.expiresIn,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || refreshToken,
      expiresIn: tokens.expiresIn,
      ...(await resolveKiroProfileArnPatch(
        providerSpecificData,
        tokens.accessToken,
        tokens.profileArn,
        refreshSignal,
      )),
    };
  }

  const response = await awaitModelCatalogResponse(proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "kiro-cli/1.0.0",
    },
    body: JSON.stringify({
      refreshToken: refreshToken,
    }),
    signal: refreshSignal,
  }, proxyOptions), refreshSignal);

  if (!response.ok) {
    const errorText = await readRefreshText(response, refreshSignal);
    log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro social token", {
      ...refreshFailureLog(response.status, errorText),
    });
    return null;
  }

  const tokens = await readRefreshJson(response, refreshSignal);
  if (!tokens?.accessToken) {
    log?.error?.("TOKEN_REFRESH", "Kiro social refresh returned no access token");
    return null;
  }

  log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro social token", {
    hasNewAccessToken: !!tokens.accessToken,
    expiresIn: tokens.expiresIn,
  });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || refreshToken,
    expiresIn: tokens.expiresIn,
    ...(await resolveKiroProfileArnPatch(
      providerSpecificData,
      tokens.accessToken,
      tokens.profileArn,
      refreshSignal,
    )),
  };
  });
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", "Error refreshing Kiro token", {
      error: describeRefreshFailure("Kiro token refresh", error),
    });
    return null;
  }
  }, log);
  return awaitWithSignal(sharedRefresh, requestOptions?.signal);
}

// iFlow: Basic Auth + client_id+client_secret in body. Delegate to refreshAccessToken("iflow", ...).
export async function refreshIflowToken(refreshToken, log) {
  return refreshAccessToken("iflow", refreshToken, {}, log);
}

// GitHub: optional client_secret. Delegate to refreshAccessToken("github", ...).
export async function refreshGitHubToken(refreshToken, log) {
  return refreshAccessToken("github", refreshToken, {}, log);
}

export async function refreshCopilotToken(githubAccessToken, log, requestOptions = null) {
  if (!githubAccessToken) return null;
  throwIfAborted(requestOptions?.signal);
  const sharedRefresh = dedupRefresh("copilot", githubAccessToken, async () => {
    try {
      return await runTokenRefreshWithDeadline(
        "Copilot token refresh",
        COPILOT_REFRESH_TIMEOUT_MS,
        async (refreshSignal) => {
    const response = await awaitModelCatalogResponse(fetch(PROVIDER_OAUTH["github"]?.copilotTokenUrl, {
      headers: {
        "Authorization": `token ${githubAccessToken}`,
        "User-Agent": GITHUB_COPILOT.USER_AGENT,
        "Editor-Version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
        "Editor-Plugin-Version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
        "Accept": "application/json",
        "x-github-api-version": GITHUB_COPILOT.API_VERSION
      },
      signal: refreshSignal,
    }), refreshSignal);

    if (!response.ok) {
      const errorText = await readRefreshText(response, refreshSignal);
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Copilot token", {
        ...refreshFailureLog(response.status, errorText),
      });
      return null;
    }

    const data = await readRefreshJson(response, refreshSignal);
    if (!data?.token) {
      log?.error?.("TOKEN_REFRESH", "Copilot token refresh returned no token");
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Copilot token", {
      hasToken: !!data.token,
      expiresAt: data.expires_at
    });

    return {
      token: data.token,
      expiresAt: data.expires_at
    };
        },
      );
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", "Error refreshing Copilot token", {
        error: describeRefreshFailure("Copilot token refresh", error),
      });
      return null;
    }
  }, log);
  return awaitWithSignal(sharedRefresh, requestOptions?.signal);
}

// CodeBuddy (Tencent) refresh — POST /v2/plugin/auth/token/refresh with the
// refresh token carried in the X-Refresh-Token header (not a form body),
// matching the official CodeBuddy CLI. Response: { code: 0, data: <token> }.
export async function refreshCodebuddyToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codebuddy-cn", refreshToken, async () => {
    const oauth = PROVIDER_OAUTH["codebuddy-cn"] || {};
    const refreshResult = await requestRefreshJson("CodeBuddy token refresh", oauth.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": oauth.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "copilot.tencent.com",
        "X-Refresh-Token": refreshToken,
        "X-Auth-Refresh-Source": "plugin",
        "X-Product": "SaaS",
      },
      body: "{}",
    }, log);
    if (refreshResult.transportError) return null;
    const { response, errorText, data } = refreshResult;

    if (!response.ok) {
      log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy token", {
        ...refreshFailureLog(response.status, errorText),
      });
      return null;
    }

    if (!data || typeof data !== "object" || Array.isArray(data) || data.code !== 0 || !data.data?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "CodeBuddy token refresh returned no token", {
        ...refreshFailureLog(null, data),
      });
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed CodeBuddy token", {
      hasNewAccessToken: true,
      hasNewRefreshToken: !!data.data.refreshToken,
      expiresIn: data.data.expiresIn,
    });

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken || refreshToken,
      expiresIn: data.data.expiresIn,
    };
  }, log);
}

export async function refreshCodebuddyIntlToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codebuddy-intl", refreshToken, async () => {
    const oauth = PROVIDER_OAUTH["codebuddy-intl"] || {};
    const refreshResult = await requestRefreshJson("CodeBuddy intl token refresh", oauth.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": oauth.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-Refresh-Token": refreshToken,
        "X-Auth-Refresh-Source": "plugin",
        "X-Product": "SaaS",
      },
      body: "{}",
    }, log);
    if (refreshResult.transportError) return null;
    const { response, errorText, data } = refreshResult;

    if (!response.ok) {
      log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy intl token", {
        ...refreshFailureLog(response.status, errorText),
      });
      return null;
    }

    if (!data || typeof data !== "object" || Array.isArray(data) || data.code !== 0 || !data.data?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "CodeBuddy intl token refresh returned no token", {
        ...refreshFailureLog(null, data),
      });
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed CodeBuddy intl token", {
      hasNewAccessToken: true,
      hasNewRefreshToken: !!data.data.refreshToken,
      expiresIn: data.data.expiresIn,
    });

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken || refreshToken,
      expiresIn: data.data.expiresIn,
    };
  }, log);
}

// Trae refresh — POST ExchangeToken with JSON body {ClientID, RefreshToken, ClientSecret, UserID}.
// Response: {Result: {AccessToken, RefreshToken, TokenType, ExpiresAt}}.
export async function refreshTraeToken(refreshToken, credentials, log) {
  if (!refreshToken) return null;
  const oauth = PROVIDER_OAUTH.trae || {};
  const url = oauth.exchangeTokenUrl || oauth.tokenUrl;
  if (!url) {
    log?.warn?.("TOKEN_REFRESH", "No Trae exchangeTokenUrl configured");
    return null;
  }

  return dedupRefresh("trae", refreshToken, async () => {
    try {
      const refreshResult = await requestRefreshJson("Trae token refresh", url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Trae/1.0.0 antigravity-cockpit-tools",
        },
        body: JSON.stringify({
          ClientID: oauth.clientId || "ono9krqynydwx5",
          RefreshToken: refreshToken,
          ClientSecret: oauth.clientSecret || "-",
          UserID: "",
        }),
      }, log);
      if (refreshResult.transportError) return null;
      const { response, errorText, data: payload } = refreshResult;

      if (!response.ok) {
        log?.error?.("TOKEN_REFRESH", "Failed to refresh Trae token", {
          ...refreshFailureLog(response.status, errorText),
        });
        return null;
      }

      const result = payload?.Result || payload?.result || payload;
      const accessToken = result?.AccessToken || result?.accessToken;
      if (!accessToken) {
        log?.error?.("TOKEN_REFRESH", "Trae refresh returned no AccessToken", {
          ...refreshFailureLog(null, payload),
        });
        return null;
      }

      const newRefresh = result?.RefreshToken || result?.refreshToken || refreshToken;
      const expiresAt = result?.ExpiresAt || result?.expiresAt;
      let expiresIn;
      if (typeof expiresAt === "number") {
        expiresIn = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
      } else if (typeof expiresAt === "string") {
        const ms = new Date(expiresAt).getTime() - Date.now();
        expiresIn = ms > 0 ? Math.floor(ms / 1000) : undefined;
      }

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Trae token", {
        hasNewAccessToken: true,
        hasNewRefreshToken: newRefresh !== refreshToken,
        expiresIn,
      });

      return {
        accessToken,
        refreshToken: newRefresh,
        expiresIn,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", "Error refreshing Trae token", {
        error: describeRefreshFailure("Trae token refresh", error),
      });
      return null;
    }
  }, log);
}

// Zed access_token is long-lived; auth flow returns no refresh_token.
// No refresh possible — re-login required when token expires/revoked.
// Mirrors cursor/kilocode null-refresh pattern.
export function refreshZedToken() {
  return null;
}

// Windsurf apiKey is the long-lived terminal credential (no OAuth2 refresh_token
// grant yields a fresh apiKey). Refresh handled out-of-band by the caller.
// TODO(firebase): if short-lived Firebase JWT credentials must be refreshed,
// re-run RegisterUser with the refreshed Firebase JWT (separate code path).
export async function refreshWindsurfToken(credentials, log) {
  log?.info?.(
    "TOKEN_REFRESH",
    "windsurf: apiKey is long-lived (no refresh_token flow) — skipping"
  );
  return null;
}
