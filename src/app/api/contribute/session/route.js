import { NextResponse } from "next/server";
import {
  CONTRIBUTOR_COOKIE,
  contributorCookieOptions,
  createContributorSession,
  getContributorSession,
  isSameOrigin,
} from "@/lib/contributor/session";
import { claimContributorToken } from "@/lib/contributor/store";
import { readRequestJson, RequestBodyError } from "open-sse/utils/requestBody.js";

const MAX_BODY_BYTES = 4 * 1024;

export async function GET(request) {
  const session = await getContributorSession(request);
  if (!session) {
    return NextResponse.json({ error: "Contribution session is invalid or expired" }, { status: 401 });
  }
  return NextResponse.json({
    inviteId: session.invite.id,
    allowedProviders: session.invite.allowedProviders,
    expiresAt: session.invite.expiresAt,
  });
}

export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  // This route is in PUBLIC_API_PATHS, so it runs before any authentication.
  // Use the bounded reader to cap the payload instead of buffering whatever an
  // anonymous caller sends.
  let body;
  try {
    body = await readRequestJson(request, {
      maxBytes: MAX_BODY_BYTES,
      label: "Contribution session body",
      requireBody: true,
    });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return NextResponse.json({ error: "Invalid request" }, { status });
  }
  if (!body || typeof body !== "object" || typeof body.token !== "string") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const invite = await claimContributorToken(body.token);
  if (!invite) {
    return NextResponse.json({ error: "Contribution link is invalid, used, or expired" }, { status: 401 });
  }
  const response = NextResponse.json({ success: true });
  response.cookies.set(
    CONTRIBUTOR_COOKIE,
    await createContributorSession(invite),
    contributorCookieOptions(request, invite),
  );
  return response;
}

export async function DELETE(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const response = NextResponse.json({ success: true });
  response.cookies.set(CONTRIBUTOR_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
