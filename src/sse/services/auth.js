import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import { throwIfAborted } from "open-sse/utils/abort.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

// Request-order state for account cooldown writes. Attempts are assigned
// immediately before upstream dispatch by each credentialed handler. Keeping
// per-model and connection-wide success/failure IDs lets DB-boundary predicates
// reject late mutations without serializing the network calls themselves.
// Retained failure watermarks protect late streaming callbacks after their
// request wrapper has returned. Model names are client-controlled, so dormant
// entries must still be swept and capped. Active attempts are never evicted;
// the map may temporarily exceed the cap while that work is in flight.
export const ACCOUNT_MUTATION_STATE_MAX_ENTRIES = 2048;
const ACCOUNT_MUTATION_STATE_SWEEP_INTERVAL_MS = 60_000;
const accountMutationStates = new Map(); // key -> { active, latestSuccessId, latestFailureId, failureUntil, scope, generationStartId, latestAttemptId }
const dormantModelMutationKeys = new Set();
const dormantAccountMutationKeys = new Set();
let nextAccountMutationAttemptId = 0;
let nextAccountMutationSweepAt = 0;
// A cap eviction leaves a generation tombstone. Missing generations at or
// below this ID fail closed, while a recreated key rejects IDs older than its
// own generationStartId. This keeps late streaming callbacks from clearing or
// writing state after their detailed watermark was compacted.
let evictedThroughAccountMutationAttemptId = 0;

function accountMutationKey(connectionId, model) {
  return JSON.stringify([String(connectionId || ""), model ? String(model) : null]);
}

function deleteAccountMutationState(key, preserveGenerationTombstone = false) {
  const state = accountMutationStates.get(key);
  if (preserveGenerationTombstone && state) {
    evictedThroughAccountMutationAttemptId = Math.max(
      evictedThroughAccountMutationAttemptId,
      state.latestAttemptId || 0,
    );
  }
  accountMutationStates.delete(key);
  dormantModelMutationKeys.delete(key);
  dormantAccountMutationKeys.delete(key);
}

function markAccountMutationStateDormant(key, state) {
  dormantModelMutationKeys.delete(key);
  dormantAccountMutationKeys.delete(key);
  (state.scope === "account" ? dormantAccountMutationKeys : dormantModelMutationKeys).add(key);
}

function sweepDormantAccountMutationSet(keys, now, expiredOnly = false) {
  for (const key of keys) {
    const state = accountMutationStates.get(key);
    if (!state) {
      keys.delete(key);
      continue;
    }
    if (state.active > 0) {
      keys.delete(key);
      continue;
    }
    if (expiredOnly && state.failureUntil > now) continue;
    deleteAccountMutationState(key, !expiredOnly);
    if (!expiredOnly && accountMutationStates.size <= ACCOUNT_MUTATION_STATE_MAX_ENTRIES) break;
  }
}

function sweepAccountMutationStates(now = Date.now(), enforceLimit = false) {
  if (!enforceLimit && now < nextAccountMutationSweepAt) return;
  nextAccountMutationSweepAt = now + ACCOUNT_MUTATION_STATE_SWEEP_INTERVAL_MS;

  sweepDormantAccountMutationSet(dormantModelMutationKeys, now, true);
  sweepDormantAccountMutationSet(dormantAccountMutationKeys, now, true);
  if (accountMutationStates.size <= ACCOUNT_MUTATION_STATE_MAX_ENTRIES) return;

  // Prefer evicting client-controlled model keys. Account-wide watermarks are
  // bounded by the number of configured connections and protect cross-model
  // ordering, so retain them until model entries alone cannot satisfy the cap.
  sweepDormantAccountMutationSet(dormantModelMutationKeys, now);
  if (accountMutationStates.size > ACCOUNT_MUTATION_STATE_MAX_ENTRIES) {
    sweepDormantAccountMutationSet(dormantAccountMutationKeys, now);
  }
}

function getAccountMutationStateByKey(key, create = false, scope = "model", attemptId = 0) {
  if (!key) return null;
  let state = accountMutationStates.get(key);
  if (state && state.active === 0 && state.failureUntil <= Date.now()) {
    deleteAccountMutationState(key);
    state = null;
  }
  if (!state && create) {
    const generationStartId = Number.isFinite(attemptId) ? attemptId : 0;
    state = {
      active: 0,
      latestSuccessId: 0,
      latestFailureId: 0,
      failureUntil: 0,
      scope,
      generationStartId,
      latestAttemptId: generationStartId,
    };
    accountMutationStates.set(key, state);
  }
  return state;
}

function getAccountMutationState(attempt, create = false) {
  if (!attempt?.key || !Number.isFinite(attempt.id)) return null;
  return getAccountMutationStateByKey(attempt.key, create);
}

function getConnectionMutationState(attempt, create = false) {
  if (!attempt?.accountKey || !Number.isFinite(attempt.id)) return null;
  return getAccountMutationStateByKey(attempt.accountKey, create);
}

export function beginAccountMutationAttempt(connectionId, model) {
  sweepAccountMutationStates(Date.now(), accountMutationStates.size > ACCOUNT_MUTATION_STATE_MAX_ENTRIES);
  const attempt = {
    key: accountMutationKey(connectionId, model),
    accountKey: accountMutationKey(connectionId, null),
    id: ++nextAccountMutationAttemptId,
  };
  const keys = attempt.key === attempt.accountKey
    ? [[attempt.accountKey, "account"]]
    : [[attempt.key, "model"], [attempt.accountKey, "account"]];
  for (const [key, scope] of keys) {
    const state = getAccountMutationStateByKey(key, true, scope, attempt.id);
    state.latestAttemptId = Math.max(state.latestAttemptId, attempt.id);
    state.active += 1;
    dormantModelMutationKeys.delete(key);
    dormantAccountMutationKeys.delete(key);
  }
  return attempt;
}

export function endAccountMutationAttempt(attempt) {
  for (const key of new Set([attempt?.key, attempt?.accountKey])) {
    const state = getAccountMutationStateByKey(key);
    if (!state || attempt.id < state.generationStartId) continue;
    state.active = Math.max(0, state.active - 1);
    if (state.active === 0 && state.failureUntil <= Date.now()) {
      deleteAccountMutationState(key);
    } else if (state.active === 0) {
      markAccountMutationStateDormant(key, state);
    }
  }
  sweepAccountMutationStates(Date.now(), accountMutationStates.size > ACCOUNT_MUTATION_STATE_MAX_ENTRIES);
}

export function recordAccountMutationSuccess(attempt) {
  // A streaming success callback may run after the request wrapper has already
  // released its attempt.  Do not recreate an otherwise-dead key in that case:
  // if no older request/failure is still tracked, there is nothing left for the
  // success watermark to invalidate.
  for (const key of new Set([attempt?.key, attempt?.accountKey])) {
    const state = getAccountMutationStateByKey(key);
    if (!state || attempt.id < state.generationStartId) continue;
    state.latestSuccessId = Math.max(state.latestSuccessId, attempt.id);
    // Once a newer success supersedes the latest failure, the old cooldown no
    // longer needs to retain this ordering record. Active older attempts keep
    // the state alive until their own terminal path runs.
    if (attempt.id >= state.latestFailureId) state.failureUntil = 0;
    if (state.active === 0 && state.failureUntil <= Date.now()) {
      deleteAccountMutationState(key);
    }
  }
}

// Deliberately narrow test-only visibility: tests can prove that adversarial
// model cardinality is bounded without exposing keys or request metadata.
export function __getAccountMutationStateStatsForTests() {
  sweepAccountMutationStates(Date.now(), true);
  let activeEntries = 0;
  for (const state of accountMutationStates.values()) {
    if (state.active > 0) activeEntries += 1;
  }
  return {
    size: accountMutationStates.size,
    activeEntries,
    dormantEntries: accountMutationStates.size - activeEntries,
  };
}

function canAccountMutationAttemptClearFailure(attempt) {
  const state = getAccountMutationState(attempt);
  if (!state) return attempt.id > evictedThroughAccountMutationAttemptId;
  return attempt.id >= state.generationStartId && attempt.id >= state.latestFailureId;
}

function canAccountMutationAttemptCommitFailure(attempt) {
  const state = getAccountMutationState(attempt);
  if (!state) return attempt.id > evictedThroughAccountMutationAttemptId;
  return attempt.id >= state.generationStartId && (
    attempt.id >= state.latestSuccessId && attempt.id >= state.latestFailureId
  );
}

function canConnectionMutationAttemptClearFailure(attempt) {
  const state = getConnectionMutationState(attempt);
  if (!state) return attempt.id > evictedThroughAccountMutationAttemptId;
  return attempt.id >= state.generationStartId && attempt.id >= state.latestFailureId;
}

function canConnectionMutationAttemptCommitFailure(attempt) {
  const state = getConnectionMutationState(attempt);
  if (!state) return attempt.id > evictedThroughAccountMutationAttemptId;
  return attempt.id >= state.generationStartId && (
    attempt.id >= state.latestSuccessId && attempt.id >= state.latestFailureId
  );
}

function recordMutationFailureForKey(key, attemptId, failureUntil, scope = "model") {
  const state = getAccountMutationStateByKey(key, true, scope, attemptId);
  if (!state || attemptId < state.generationStartId || attemptId < state.latestFailureId) return;
  state.latestAttemptId = Math.max(state.latestAttemptId, attemptId);
  state.latestFailureId = attemptId;
  state.failureUntil = Math.max(Date.now(), Number(failureUntil) || 0);
  if (state.active === 0) markAccountMutationStateDormant(key, state);
}

function recordAccountMutationFailure(attempt, failureUntil, includeConnection = false) {
  if (!attempt?.key || !Number.isFinite(attempt.id)) return;
  recordMutationFailureForKey(
    attempt.key,
    attempt.id,
    failureUntil,
    attempt.key === attempt.accountKey ? "account" : "model",
  );
  if (includeConnection && attempt.accountKey !== attempt.key) {
    recordMutationFailureForKey(attempt.accountKey, attempt.id, failureUntil, "account");
  }
}

function combineCommitPredicates(...predicates) {
  const active = predicates.filter((predicate) => typeof predicate === "function");
  return active.length > 0 ? () => active.every((predicate) => predicate()) : null;
}

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const signal = options?.signal || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    // Do not abandon our mutex slot on abort: resolving it before the previous
    // owner finishes would let a later selector enter the critical section.
    await currentMutex;
    throwIfAborted(signal);

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      throwIfAborted(signal);
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        throwIfAborted(signal);
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      throwIfAborted(signal);
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    throwIfAborted(signal);
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    throwIfAborted(signal);
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateConnectionWithSignal(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        }, signal);
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateConnectionWithSignal(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        }, signal);
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    throwIfAborted(signal);

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number, superseded?: boolean }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, options = {}) {
  const signal = options?.signal || null;
  const mutationAttempt = options?.mutationAttempt || null;
  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);
  const accountWideMutation = !model || !!githubResetAtMs;
  const shouldCommit = combineCommitPredicates(
    options?.shouldCommit,
    mutationAttempt ? () => canAccountMutationAttemptCommitFailure(mutationAttempt) : null,
    mutationAttempt && accountWideMutation
      ? () => canConnectionMutationAttemptCommitFailure(mutationAttempt)
      : null,
  );
  throwIfAborted(signal);
  if (!connectionId || connectionId === "noauth" || status === HTTP_STATUS.CLIENT_CLOSED_REQUEST) return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  throwIfAborted(signal);
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };
  const routingResult = { shouldFallback: true, cooldownMs };

  // Ordering guards own durable account state only. A newer request can make
  // this write stale, but it cannot change whether this request's own provider
  // error is retryable. Preserve the classification so the caller can still
  // route to another account/model without persisting an obsolete cooldown.
  if (shouldCommit && !shouldCommit()) return { ...routingResult, superseded: true };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);
  const lockUntil = new Date(Object.values(lockUpdate)[0]).getTime();
  const update = {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  };
  let includeConnectionFailure = accountWideMutation;
  const beforeCommit = (mutationAttempt || options?.beforeCommit) ? () => {
    options?.beforeCommit?.();
    if (!mutationAttempt) return;

    // A model-specific lock remains valid even if a newer request for another
    // model has updated the account. The dashboard-wide status fields do not:
    // strip those shared fields when this attempt lost connection-wide order.
    const canCommitSharedState = canConnectionMutationAttemptCommitFailure(mutationAttempt);
    includeConnectionFailure = accountWideMutation || canCommitSharedState;
    if (!accountWideMutation && !canCommitSharedState) {
      for (const key of ["testStatus", "lastError", "errorCode", "lastErrorAt", "backoffLevel"]) {
        delete update[key];
      }
    }
  } : null;
  const afterCommit = (mutationAttempt || options?.afterCommit) ? () => {
    if (mutationAttempt) {
      recordAccountMutationFailure(mutationAttempt, lockUntil, includeConnectionFailure);
    }
    options?.afterCommit?.();
  } : null;

  await updateConnectionWithSignal(connectionId, update, signal, shouldCommit, beforeCommit, afterCommit);
  if (shouldCommit && !shouldCommit()) return { ...routingResult, superseded: true };

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return routingResult;
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null, options = {}) {
  if (!connectionId || connectionId === "noauth") return;
  const mutationAttempt = options?.mutationAttempt || null;
  const shouldCommit = combineCommitPredicates(
    options?.shouldCommit,
    mutationAttempt ? () => canAccountMutationAttemptClearFailure(mutationAttempt) : null,
  );
  if (shouldCommit && !shouldCommit()) return;
  let conn = currentConnection._connection || currentConnection;
  if (options?.reloadCurrent || mutationAttempt) {
    const currentConnections = await getProviderConnections({ provider: conn.provider });
    conn = currentConnections.find((candidate) => candidate.id === connectionId) || conn;
    if (shouldCommit && !shouldCommit()) return;
  }
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  const beforeCommit = () => {
    options?.beforeCommit?.();
    if (!mutationAttempt || canConnectionMutationAttemptClearFailure(mutationAttempt)) return;

    // A success for one model may still clear its own stale lock, but it must
    // not erase a newer account-wide lock or shared error status written by a
    // different model/request on the same connection.
    delete clearObj.modelLock___all;
    for (const key of ["testStatus", "lastError", "errorCode", "lastErrorAt", "backoffLevel"]) {
      delete clearObj[key];
    }
  };
  const hasUpdates = () => Object.keys(clearObj).length > 0;
  await updateConnectionWithSignal(
    connectionId,
    clearObj,
    null,
    combineCommitPredicates(shouldCommit, hasUpdates),
    beforeCommit,
  );
}

async function updateConnectionWithSignal(
  connectionId,
  updates,
  signal,
  shouldCommit = null,
  beforeCommit = null,
  afterCommit = null,
) {
  throwIfAborted(signal);
  if (shouldCommit && !shouldCommit()) return null;
  const guardedOptions = {
    ...(signal ? { signal } : {}),
    ...(shouldCommit ? { shouldCommit } : {}),
    ...(beforeCommit ? { beforeCommit } : {}),
    ...(afterCommit ? { afterCommit } : {}),
  };
  const result = Object.keys(guardedOptions).length > 0
    ? await updateProviderConnection(connectionId, updates, guardedOptions)
    : await updateProviderConnection(connectionId, updates);
  throwIfAborted(signal);
  if (shouldCommit && !shouldCommit()) return null;
  return result;
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
