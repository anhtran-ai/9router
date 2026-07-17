import crypto from "node:crypto";
import { getAdapter } from "@/lib/db/driver";

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

async function saveInvite(invite) {
  const db = await getAdapter();
  db.run(
    `INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)`,
    [SCOPE, invite.id, JSON.stringify(invite)],
  );
  return invite;
}

export async function createContributorInvite({ alias, allowedProviders, expiresInMinutes = 30 }) {
  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const safeMinutes = Math.min(Math.max(Number(expiresInMinutes) || 30, 5), 1440);
  const invite = {
    id,
    alias,
    tokenHash: hashSecret(secret),
    allowedProviders: [...new Set(allowedProviders)],
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
      new Date(invite.expiresAt).getTime() > Date.now(),
  );
}

export async function validateContributorToken(token) {
  if (typeof token !== "string") return null;
  const separator = token.indexOf(".");
  if (separator < 1) return null;
  const id = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  const invite = await getContributorInvite(id);
  if (!isInviteActive(invite)) return null;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(invite.tokenHash, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  return invite;
}

export async function claimContributorToken(token) {
  const invite = await validateContributorToken(token);
  if (!invite || invite.sessionId) return null;
  const claimed = {
    ...invite,
    sessionId: crypto.randomUUID(),
    claimedAt: new Date().toISOString(),
  };
  await saveInvite(claimed);
  return claimed;
}

export async function listContributorInvites() {
  const db = await getAdapter();
  return db
    .all(`SELECT value FROM kv WHERE scope = ?`, [SCOPE])
    .map(parseInvite)
    .filter(Boolean)
    .map(({ tokenHash, ...invite }) => ({
      ...invite,
      status:
        invite.status === "active" && new Date(invite.expiresAt).getTime() <= Date.now()
          ? "expired"
          : invite.status,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function consumeContributorInvite(id, connection = null) {
  const invite = await getContributorInvite(id);
  if (!isInviteActive(invite)) return false;
  await saveInvite({
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
  });
  return true;
}

export async function revokeContributorInvite(id) {
  const invite = await getContributorInvite(id);
  if (!invite || invite.status !== "active") return false;
  await saveInvite({ ...invite, status: "revoked", revokedAt: new Date().toISOString() });
  return true;
}
