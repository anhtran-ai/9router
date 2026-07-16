import { NextResponse } from "next/server";
import { getProviderNames } from "@/lib/oauth/providers";
import {
  createContributorInvite,
  listContributorInvites,
  revokeContributorInvite,
} from "@/lib/contributor/store";
import { isSameOrigin } from "@/lib/contributor/session";

export async function GET() {
  return NextResponse.json({ invites: await listContributorInvites() });
}

export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  try {
    const body = await request.json();
    const supported = new Set(getProviderNames());
    const allowedProviders = Array.isArray(body.allowedProviders)
      ? [...new Set(body.allowedProviders.filter((id) => supported.has(id)))]
      : [];
    if (allowedProviders.length === 0) {
      return NextResponse.json({ error: "Select at least one OAuth provider" }, { status: 400 });
    }
    const { invite, token } = await createContributorInvite({
      allowedProviders,
      expiresInMinutes: body.expiresInMinutes,
    });
    const url = new URL(`/contribute/${token}`, request.url).toString();
    const { tokenHash, ...safeInvite } = invite;
    return NextResponse.json({ invite: safeInvite, url }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing invite id" }, { status: 400 });
  const revoked = await revokeContributorInvite(id);
  return NextResponse.json({ success: revoked }, { status: revoked ? 200 : 409 });
}
