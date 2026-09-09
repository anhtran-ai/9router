import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { DATA_DIR } from "@/lib/dataDir";
import { getContributorInvite, isContributorSessionUsable } from "./store";

export const CONTRIBUTOR_COOKIE = "contributor_session";

function loadSecret() {
  const file = path.join(DATA_DIR, "contributor-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

let cachedSecret;
function getSecret() {
  if (!cachedSecret) cachedSecret = new TextEncoder().encode(loadSecret());
  return cachedSecret;
}

export async function createContributorSession(invite) {
  return new SignJWT({ role: "contributor", inviteId: invite.id, sessionId: invite.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(new Date(invite.expiresAt).getTime() / 1000))
    .sign(getSecret());
}

export async function getContributorSession(request, { allowUsed = false } = {}) {
  const token = request.cookies.get(CONTRIBUTOR_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.role !== "contributor" || !payload.inviteId || !payload.sessionId) return null;
    const invite = await getContributorInvite(payload.inviteId);
    if (!isContributorSessionUsable(invite, payload.sessionId, { allowUsed })) return null;
    return { payload, invite };
  } catch {
    return null;
  }
}

export function contributorCookieOptions(request, invite) {
  const secure =
    process.env.AUTH_COOKIE_SECURE === "true" ||
    request.headers.get("x-forwarded-proto") === "https";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    expires: new Date(invite.expiresAt),
  };
}

export function isSameOrigin(request) {
  // SameSite=Lax cookies are still sent on top-level cross-site GET
  // navigations. Fetch Metadata closes that gap for OAuth proxy actions while
  // preserving direct/manual navigation when browsers omit Origin entirely.
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}
