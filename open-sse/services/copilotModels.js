/**
 * GitHub Copilot model catalog fetcher.
 *
 * Calls Copilot's `GET /models` endpoint to get the live catalog for an
 * authenticated account, so `/v1/models` reflects what the account can
 * actually use (e.g. newly shipped `claude-opus-4.8`, `gpt-5.5`) instead of
 * the hand-maintained static registry, which inevitably lags behind.
 *
 * Returns chat-capable models the account's policy allows. Embeddings and
 * disabled models are filtered out.
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { GITHUB_COPILOT } from "../config/appConstants.js";
import { refreshCopilotToken } from "./tokenRefresh.js";
import {
  cancelModelCatalogBody,
  readModelCatalogJson,
  readModelCatalogText,
  runModelCatalogRefresh,
} from "./modelCatalogResponse.js";

const MODELS_URL = "https://api.githubcopilot.com/models";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes per credential

/** @type {Map<string, { expiresAt: number, models: any[] }>} */
const catalogCache = new Map();

function cacheKey(credentials) {
  return credentials?.providerSpecificData?.copilotToken
    || credentials?.accessToken
    || "copilot-anonymous";
}

function buildHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "vscode-chat",
    "editor-version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
    "editor-plugin-version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
    "user-agent": GITHUB_COPILOT.USER_AGENT,
    "x-github-api-version": GITHUB_COPILOT.API_VERSION,
  };
}

async function fetchCatalogRaw(token, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException("Copilot model catalog timed out", "TimeoutError")),
    FETCH_TIMEOUT_MS,
  );
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let response;
  try {
    response = await proxyAwareFetch(MODELS_URL, {
      method: "GET",
      headers: buildHeaders(token),
      cache: "no-store",
      signal: requestSignal,
    });
    if (!response.ok) {
      try {
        await readModelCatalogText(response, { signal: requestSignal });
      } catch (error) {
        error.status = response.status;
        throw error;
      }
      const err = new Error(`Copilot /models returned ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const data = await readModelCatalogJson(response, { signal: requestSignal });
    return Array.isArray(data?.data) ? data.data : [];
  } catch (error) {
    if (requestSignal.aborted) {
      cancelModelCatalogBody(response, error);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Keep only chat models the account is allowed to use. The static registry
// surfaced disabled/embedding entries inconsistently; here we trust upstream.
function expandCatalog(raw) {
  const seen = new Set();
  const models = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    if (m.capabilities?.type !== "chat") continue;
    if (m.policy && m.policy.state !== "enabled") continue;
    const id = m.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: m.name || id });
  }
  return models;
}

/**
 * Resolve the live Copilot model catalog for a connection.
 *
 * @param {object} credentials Connection record (accessToken, refreshToken,
 *   providerSpecificData {copilotToken, copilotTokenExpiresAt}).
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh] Bypass the per-credential cache.
 * @param {AbortSignal} [options.signal] Cancel this caller's catalog/refresh wait.
 * @param {object}  [options.log] Logger.
 * @param {function} [options.onCredentialsRefreshed] Persist a refreshed
 *   Copilot token back to your store. Called with `{ copilotToken,
 *   copilotTokenExpiresAt }` whenever a 401 triggers a refresh.
 * @returns {Promise<{ models: object[] } | null>}
 */
export async function resolveCopilotModels(credentials, options = {}) {
  const token = credentials?.providerSpecificData?.copilotToken || credentials?.accessToken;
  if (!token) {
    options.log?.debug?.("COPILOT_MODELS", "No copilotToken/accessToken; skipping live fetch");
    return null;
  }

  const key = cacheKey(credentials);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) {
      return { models: cached.models };
    }
  }

  let raw;
  try {
    raw = await fetchCatalogRaw(token, options.signal);
  } catch (err) {
    if (options.signal?.aborted) {
      options.log?.debug?.("COPILOT_MODELS", "Caller aborted live model fetch");
      return null;
    }
    // A 401/403 means the Copilot token is stale — refresh from the GitHub
    // access token and retry once.
    if (err && (err.status === 401 || err.status === 403) && credentials.accessToken) {
      options.log?.info?.("COPILOT_MODELS", `Got ${err.status}; refreshing Copilot token`);
      let refreshed;
      try {
        refreshed = await runModelCatalogRefresh(
          (refreshSignal) => refreshCopilotToken(
            credentials.accessToken,
            options.log,
            { signal: refreshSignal },
          ),
          {
            signal: options.signal,
            timeoutMs: FETCH_TIMEOUT_MS,
            label: "Copilot model catalog token refresh",
          },
        );
      } catch (refreshError) {
        const detail = options.signal?.aborted
          ? "Caller aborted Copilot token refresh"
          : `Copilot token refresh failed: ${refreshError?.message || refreshError}`;
        options.log?.warn?.("COPILOT_MODELS", detail);
        return null;
      }
      if (options.signal?.aborted) return null;
      if (refreshed?.token) {
        if (typeof options.onCredentialsRefreshed === "function") {
          try {
            await runModelCatalogRefresh(
              () => options.onCredentialsRefreshed({
                copilotToken: refreshed.token,
                copilotTokenExpiresAt: refreshed.expiresAt,
              }),
              {
                signal: options.signal,
                timeoutMs: FETCH_TIMEOUT_MS,
                label: "Copilot model catalog credential persistence",
              },
            );
          } catch (e) {
            options.log?.warn?.("COPILOT_MODELS", `onCredentialsRefreshed failed: ${e?.message || e}`);
          }
        }
        if (options.signal?.aborted) return null;
        try {
          raw = await fetchCatalogRaw(refreshed.token, options.signal);
        } catch (err2) {
          options.log?.warn?.("COPILOT_MODELS", `Retry after refresh failed: ${err2?.message || err2}`);
          return null;
        }
      } else {
        options.log?.warn?.("COPILOT_MODELS", "Token refresh did not return a token");
        return null;
      }
    } else {
      options.log?.warn?.("COPILOT_MODELS", `Live model fetch failed: ${err?.message || err}`);
      return null;
    }
  }

  const models = expandCatalog(raw);
  if (!models.length) return null;

  catalogCache.set(key, { expiresAt: now + CACHE_TTL_MS, models });
  return { models };
}

export function clearCopilotModelCache() {
  catalogCache.clear();
}
