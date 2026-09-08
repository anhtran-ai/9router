import { makeKv } from "../../src/lib/db/helpers/kvStore.js";

const MAX_SIGNATURES = 2000;
const MAX_PERSISTED_SIGNATURES = 10_000;
const MEMORY_TTL_MS = 1000 * 60 * 60; // 1 hour
const PERSISTED_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const LEGACY_SCOPE = "gemini_thought_signatures";
const SCOPED_SCOPE = "gemini_thought_signatures_scoped_v1";

const legacySignatureKv = makeKv(LEGACY_SCOPE);
const scopedSignatureKv = makeKv(SCOPED_SCOPE);
const legacyMemorySignatures = new Map();
const scopedMemorySignatures = new Map();
let pruneCounter = 0;

function hasSessionScope(sessionId) {
  return typeof sessionId === "string" && sessionId.length > 0;
}

function scopedSignatureKey(sessionId, toolCallId) {
  return JSON.stringify([sessionId, toolCallId]);
}

function pruneMemoryExpired() {
  const now = Date.now();
  const stores = [legacyMemorySignatures, scopedMemorySignatures];
  for (const store of stores) {
    for (const [key, value] of store.entries()) {
      if (value.expiresAt <= now) store.delete(key);
    }
  }

  while (stores.reduce((total, store) => total + store.size, 0) > MAX_SIGNATURES) {
    const candidates = stores
      .map(store => ({ store, first: store.entries().next().value }))
      .filter(candidate => candidate.first);
    if (candidates.length === 0) break;
    candidates.sort((left, right) => left.first[1].expiresAt - right.first[1].expiresAt);
    candidates[0].store.delete(candidates[0].first[0]);
  }
}

async function maybePrunePersisted() {
  pruneCounter++;
  if (pruneCounter % 100 !== 0) return;

  try {
    const now = Date.now();
    const expired = [];
    const valid = [];
    for (const kv of [legacySignatureKv, scopedSignatureKv]) {
      const all = await kv.getAll();
      for (const [key, entry] of Object.entries(all)) {
        if (!entry || typeof entry.signature !== "string" || (entry.expiresAt && entry.expiresAt <= now)) {
          expired.push({ kv, key });
        } else {
          valid.push({ kv, key, createdAt: entry.createdAt || 0 });
        }
      }
    }

    for (const item of expired) {
      await item.kv.remove(item.key).catch(() => {});
    }

    if (valid.length > MAX_PERSISTED_SIGNATURES) {
      valid.sort((a, b) => b.createdAt - a.createdAt);
      const toRemove = valid.slice(MAX_PERSISTED_SIGNATURES);
      for (const item of toRemove) {
        await item.kv.remove(item.key).catch(() => {});
      }
    }
  } catch {
    // Fail-open
  }
}

/**
 * Store a thought signature for a tool_call_id with optional sessionId namespace (RAM + SQLite async)
 */
export function storeGeminiThoughtSignature(toolCallId, signature, sessionId = null) {
  if (typeof toolCallId !== "string" || !toolCallId) return;
  if (typeof signature !== "string" || !signature) return;

  const now = Date.now();
  pruneMemoryExpired();

  // Scoped and legacy entries use distinct memory maps and SQLite scopes.
  // Client-controlled ids therefore cannot forge a key in the other namespace.
  const scoped = hasSessionScope(sessionId);
  const key = scoped ? scopedSignatureKey(sessionId, toolCallId) : toolCallId;
  const memoryStore = scoped ? scopedMemorySignatures : legacyMemorySignatures;
  const kvStore = scoped ? scopedSignatureKv : legacySignatureKv;
  memoryStore.set(key, { signature, expiresAt: now + MEMORY_TTL_MS });

  // Async persist to SQLite kv table without blocking.
  kvStore.set(key, {
    signature,
    createdAt: now,
    expiresAt: now + PERSISTED_TTL_MS,
  }).catch(() => {});

  maybePrunePersisted().catch(() => {});
}

/**
 * Retrieve a thought signature by tool_call_id (RAM first, then SQLite fallback)
 */
export async function getGeminiThoughtSignature(toolCallId, sessionId = null) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;

  pruneMemoryExpired();

  if (hasSessionScope(sessionId)) {
    const sessionKey = scopedSignatureKey(sessionId, toolCallId);
    const sessionEntry = scopedMemorySignatures.get(sessionKey);
    if (sessionEntry && sessionEntry.expiresAt > Date.now()) {
      return sessionEntry.signature;
    }

    try {
      const sessionRow = await scopedSignatureKv.get(sessionKey);
      if (sessionRow && typeof sessionRow.signature === "string" && (!sessionRow.expiresAt || sessionRow.expiresAt > Date.now())) {
        scopedMemorySignatures.set(sessionKey, {
          signature: sessionRow.signature,
          expiresAt: Date.now() + MEMORY_TTL_MS,
        });
        return sessionRow.signature;
      }
    } catch {
      // Fail-open without crossing into another session's namespace.
    }
    return null;
  }

  const entry = legacyMemorySignatures.get(toolCallId);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.signature;
  }

  try {
    const row = await legacySignatureKv.get(toolCallId);
    if (row && typeof row.signature === "string") {
      if (row.expiresAt && row.expiresAt <= Date.now()) {
        legacySignatureKv.remove(toolCallId).catch(() => {});
        return null;
      }
      legacyMemorySignatures.set(toolCallId, {
        signature: row.signature,
        expiresAt: Date.now() + MEMORY_TTL_MS,
      });
      return row.signature;
    }
  } catch {
    // Fail-open
  }

  return null;
}

/**
 * Synchronous get from RAM cache only (for sync translators)
 */
export function getGeminiThoughtSignatureSync(toolCallId, sessionId = null) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;
  pruneMemoryExpired();

  if (hasSessionScope(sessionId)) {
    const sessionKey = scopedSignatureKey(sessionId, toolCallId);
    const sessionEntry = scopedMemorySignatures.get(sessionKey);
    if (sessionEntry && sessionEntry.expiresAt > Date.now()) {
      return sessionEntry.signature;
    }
    return null;
  }

  const entry = legacyMemorySignatures.get(toolCallId);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.signature;
  }
  return null;
}
