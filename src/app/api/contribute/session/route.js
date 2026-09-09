import { NextResponse } from "next/server";
import {
  CONTRIBUTOR_COOKIE,
  contributorCookieOptions,
  createContributorSession,
  getContributorSession,
  isSameOrigin,
} from "@/lib/contributor/session";
import { claimContributorToken } from "@/lib/contributor/store";

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
  let body;
  try {
    body = await request.json();
  } catch {
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
