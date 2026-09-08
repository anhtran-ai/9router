import crypto from "node:crypto";
import { getAdapter } from "@/lib/db/driver";
import { createProviderConnectionInTransaction } from "@/lib/db/repos/connectionsRepo";

const SCOPE = "contributor_invites";

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function parseInvite(row) {
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function saveInviteWithDb(db, invite) {
  db.run(
    `INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)`,
    [SCOPE, invite.id, JSON.stringify(invite)],
  );
  return invite;
}

async function saveInvite(invite) {
  const db = await getAdapter();
  return saveInviteWithDb(db, invite);
}

function secretMatchesHash(secret, expectedHash) {
  if (typeof secret !== "string" || typeof expectedHash !== "string") return false;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function getInviteRecordWithDb(db, id) {
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]);
  return { invite: parseInvite(row), value: row?.value || null };
}

function compareAndSwapInviteWithDb(db, currentValue, invite) {
  if (typeof currentValue !== "string") return false;
  const result = db.run(
    `UPDATE kv SET value = ? WHERE scope = ? AND key = ? AND value = ?`,
    [JSON.stringify(invite), SCOPE, invite.id, currentValue],
  );
  return Number(result?.changes || 0) === 1;
}

function usedInvite(invite, connection) {
  return {
    ...invite,
    status: "used",
    usedAt: new Date().toISOString(),
    connection: connection
      ? {
          id: connection.id || null,
          provider: connection.provider || null,
          email: connection.email || null,
        }
      : null,
    // Keep only the hashed reservation marker after completion. It lets the
    // owner poll the exact in-memory proxy session that performed this commit
    // without retaining the raw lease or permitting another DB mutation.
    completionObservationHash: invite.completionLeaseHash || null,
    completionLeaseHash: null,
    completionSessionId: null,
    completionStartedAt: null,
  };
}

function inviteAllowsConnectionProvider(invite, provider) {
  if (typeof provider !== "string" || !provider) return false;
  const allowedProviders = Array.isArray(invite?.allowedProviders)
    ? invite.allowedProviders
    : [];
  if (allowedProviders.includes(provider)) return true;
  // The legacy Kimi Coding device flow is selected as `kimi-coding` but is
  // intentionally persisted under the canonical `kimi` provider id.
  return provider === "kimi" && allowedProviders.includes("kimi-coding");
}

function parseContributorToken(token) {
  if (typeof token !== "string") return null;
  // createContributorInvite emits randomUUID + 32-byte base64url (43 chars).
  // Reject malformed/oversized input before a DB lookup or hash operation.
  const match = token.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  return {
    id: match[1],
    secret: match[2],
  };
}

function reservationMatches(invite, sessionId, leaseId) {
  const matchesLease = typeof leaseId === "string"
    ? secretMatchesHash(leaseId, invite?.completionLeaseHash)
    : false;
  return Boolean(
    invite?.status === "completing"
      && isInviteUnexpired(invite)
      && typeof sessionId === "string"
      && invite.completionSessionId === sessionId
      && matchesLease,
  );
}

function resumedReservationMatches(invite, reservation) {
  return Boolean(
    invite?.status === "completing"
      && isInviteUnexpired(invite)
      && typeof reservation?.sessionId === "string"
      && invite.completionSessionId === reservation.sessionId
      && typeof reservation?.leaseHash === "string"
      && invite.completionLeaseHash === reservation.leaseHash,
  );
}

/**
 * Normalize provider origins selected by an administrator when creating an
 * invite.  Only providers whose contributor flow consumes a dynamic OAuth
 * origin belong here; arbitrary invite-holder input is never persisted.
 */
export function normalizeContributorProviderBaseUrls(providerBaseUrls, allowedProviders = []) {
  const normalized = {};
  if (!providerBaseUrls || typeof providerBaseUrls !== "object" || Array.isArray(providerBaseUrls)) {
    return normalized;
  }
  if (!allowedProviders.includes("gitlab") || providerBaseUrls.gitlab == null) {
    return normalized;
  }
  if (typeof providerBaseUrls.gitlab !== "string" || !providerBaseUrls.gitlab.trim()) {
    throw new Error("GitLab contributor base URL must be a non-empty HTTP(S) URL");
  }

  let parsed;
  try {
    parsed = new URL(providerBaseUrls.gitlab.trim());
  } catch {
    throw new Error("GitLab contributor base URL must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("GitLab contributor base URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("GitLab contributor base URL cannot contain credentials, query parameters, or fragments");
  }

  normalized.gitlab = parsed.toString().replace(/\/+$/, "");
  return normalized;
}

export async function createContributorInvite({
  alias,
  allowedProviders,
  expiresInMinutes = 30,
  providerBaseUrls,
}) {
  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const safeMinutes = Math.min(Math.max(Number(expiresInMinutes) || 30, 5), 1440);
  const uniqueProviders = [...new Set(allowedProviders)];
  const invite = {
    id,
    alias,
    tokenHash: hashSecret(secret),
    allowedProviders: uniqueProviders,
    providerBaseUrls: normalizeContributorProviderBaseUrls(providerBaseUrls, uniqueProviders),
    status: "active",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + safeMinutes * 60_000).toISOString(),
    usedAt: null,
    connection: null,
    sessionId: null,
    claimedAt: null,
  };
  await saveInvite(invite);
  return { invite, token: `${id}.${secret}` };
}

export async function getContributorInvite(id) {
  const db = await getAdapter();
  return parseInvite(db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]));
}

export function isInviteActive(invite) {
  return Boolean(
    invite &&
      invite.status === "active" &&
      isInviteUnexpired(invite),
  );
}

function isInviteUnexpired(invite) {
  const expiresAt = Date.parse(invite?.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export async function validateContributorToken(token) {
  const parsed = parseContributorToken(token);
  if (!parsed) return null;
  const invite = await getContributorInvite(parsed.id);
  if (!isInviteActive(invite)) return null;
  if (!secretMatchesHash(parsed.secret, invite.tokenHash)) return null;
  return invite;
}

export function isContributorSessionUsable(invite, sessionId, { allowUsed = false } = {}) {
  if (!invite || invite.sessionId !== sessionId || !isInviteUnexpired(invite)) {
    return false;
  }
  if (allowUsed && invite.status === "used") return true;
  return invite.status === "active" || (
    invite.status === "completing"
      && invite.completionSessionId === sessionId
      && typeof invite.completionLeaseHash === "string"
  );
}

export async function claimContributorToken(token) {
  const parsed = parseContributorToken(token);
  if (!parsed) return null;
  const db = await getAdapter();
  let claimed = null;
  const { invite, value } = getInviteRecordWithDb(db, parsed.id);
  if (!isInviteActive(invite) || invite.sessionId) return null;
  if (!secretMatchesHash(parsed.secret, invite.tokenHash)) return null;
  const candidate = {
    ...invite,
    sessionId: crypto.randomUUID(),
    claimedAt: new Date().toISOString(),
  };
  // The value predicate is the cross-process CAS. Every supported adapter
  // exposes SQLite's affected-row count, so only one active snapshot can win.
  if (compareAndSwapInviteWithDb(db, value, candidate)) claimed = candidate;
  return claimed;
}

/**
 * Reserve the invite before an OAuth action that may create a connection.
 * The raw lease is returned to the route but only its hash is persisted.
 */
export async function reserveContributorInvite(id, sessionId) {
  if (!id || typeof sessionId !== "string" || !sessionId) return null;
  const db = await getAdapter();
  const leaseId = crypto.randomBytes(32).toString("base64url");
  const { invite, value } = getInviteRecordWithDb(db, id);
  if (!isInviteActive(invite) || invite.sessionId !== sessionId) return null;
  const reserved = {
    ...invite,
    status: "completing",
    completionLeaseHash: hashSecret(leaseId),
    completionObservationHash: null,
    completionSessionId: sessionId,
    completionStartedAt: new Date().toISOString(),
  };
  return compareAndSwapInviteWithDb(db, value, reserved)
    ? { invite: reserved, leaseId }
    : null;
}

/** Resume a long-lived proxy reservation without exposing its raw lease. */
export async function resumeContributorInviteReservation(id, sessionId) {
  if (!id || typeof sessionId !== "string" || !sessionId) return null;
  const invite = await getContributorInvite(id);
  if (
    invite?.status !== "completing"
      || !isInviteUnexpired(invite)
      || invite.sessionId !== sessionId
      || invite.completionSessionId !== sessionId
      || typeof invite.completionLeaseHash !== "string"
  ) {
    return null;
  }
  return {
    invite,
    reservation: {
      sessionId,
      leaseHash: invite.completionLeaseHash,
    },
  };
}

export async function listContributorInvites() {
  const db = await getAdapter();
  return db
    .all(`SELECT value FROM kv WHERE scope = ?`, [SCOPE])
    .map(parseInvite)
    .filter(Boolean)
    .map(({
      tokenHash,
      completionLeaseHash,
      completionObservationHash,
      completionSessionId,
      completionStartedAt,
      ...invite
    }) => ({
      ...invite,
      status:
        ["active", "completing"].includes(invite.status) && !isInviteUnexpired(invite)
          ? "expired"
          : invite.status,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function consumeContributorInvite(id, connection = null, reservation = null) {
  const db = await getAdapter();
  const { invite, value } = getInviteRecordWithDb(db, id);
  const ownsReservation = reservation
    ? (
        reservationMatches(invite, reservation.sessionId, reservation.leaseId)
        || resumedReservationMatches(invite, reservation)
      )
    : isInviteActive(invite);
  if (!ownsReservation) return false;
  return compareAndSwapInviteWithDb(db, value, usedInvite(invite, connection));
}

/**
 * Persist a contributor-authorized credential and consume its one-time invite
 * at one SQLite transaction boundary. Revocation and completion therefore have
 * a deterministic winner: a revoked/expired/stale lease performs no connection
 * mutation, while a committed connection makes the invite terminally `used`.
 */
export async function completeContributorInviteWithConnection(id, connectionData, reservation) {
  if (!id || !connectionData || typeof connectionData !== "object" || !reservation) return null;
  const db = await getAdapter();
  let connection = null;

  db.transaction(() => {
    const { invite, value } = getInviteRecordWithDb(db, id);
    const ownsReservation = (
      reservationMatches(invite, reservation.sessionId, reservation.leaseId)
      || resumedReservationMatches(invite, reservation)
    );
    if (
      !ownsReservation
        || !isInviteUnexpired(invite)
        || !inviteAllowsConnectionProvider(invite, connectionData.provider)
    ) return;

    const candidate = createProviderConnectionInTransaction(db, connectionData);
    if (!compareAndSwapInviteWithDb(db, value, usedInvite(invite, candidate))) {
      // This should be unreachable while the synchronous transaction owns the
      // database write lock. Throwing is still essential: every adapter rolls
      // the transaction back, including a connection dedup/update performed
      // immediately above.
      throw new Error("Contributor completion lost its reservation during commit");
    }
    connection = candidate;
  });

  return connection;
}

export async function releaseContributorInviteReservation(id, reservation) {
  if (!reservation) return false;
  const db = await getAdapter();
  const { invite, value } = getInviteRecordWithDb(db, id);
  if (
    !reservationMatches(invite, reservation.sessionId, reservation.leaseId)
      && !resumedReservationMatches(invite, reservation)
  ) return false;
  return compareAndSwapInviteWithDb(db, value, {
    ...invite,
    status: "active",
    completionLeaseHash: null,
    completionObservationHash: null,
    completionSessionId: null,
    completionStartedAt: null,
  });
}

/**
 * Permanently cancel a proxy completion lease. Once a callback listener has
 * been started, returning the invite to active is unsafe: a callback may have
 * created a connection concurrently with stop/poll finalization.
 */
export async function cancelContributorInviteReservation(id, reservation) {
  if (!reservation) return false;
  const db = await getAdapter();
  const { invite, value } = getInviteRecordWithDb(db, id);
  if (
    !reservationMatches(invite, reservation.sessionId, reservation.leaseId)
      && !resumedReservationMatches(invite, reservation)
  ) return false;
  return compareAndSwapInviteWithDb(db, value, {
    ...invite,
    status: "revoked",
    revokedAt: new Date().toISOString(),
    completionLeaseHash: null,
    completionObservationHash: null,
    completionSessionId: null,
    completionStartedAt: null,
  });
}

export async function revokeContributorInvite(id) {
  const db = await getAdapter();
  const { invite, value } = getInviteRecordWithDb(db, id);
  if (!invite || !["active", "completing"].includes(invite.status)) return false;
  return compareAndSwapInviteWithDb(db, value, {
    ...invite,
    status: "revoked",
    revokedAt: new Date().toISOString(),
    completionLeaseHash: null,
    completionObservationHash: null,
    completionSessionId: null,
    completionStartedAt: null,
  });
}
