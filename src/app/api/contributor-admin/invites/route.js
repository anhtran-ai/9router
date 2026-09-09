import { NextResponse } from "next/server";
import { getProviderNames } from "@/lib/oauth/providers";
import {
  createContributorInvite,
  listContributorInvites,
  revokeContributorInvite,
} from "@/lib/contributor/store";
import { isSameOrigin } from "@/lib/contributor/session";
import { readRequestJson, RequestBodyError } from "open-sse/utils/requestBody.js";
import { getPublicOrigin } from "@/lib/auth/oidc";

const MAX_BODY_BYTES = 16 * 1024;

export async function GET(request) {
  // The invite list is sensitive: guard reads with the same origin check the
  // mutating handlers use, so an ambient dashboard cookie cannot be replayed
  // from a cross-site page.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  return NextResponse.json({ invites: await listContributorInvites() });
}

export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  try {
    let body;
    try {
      body = await readRequestJson(request, {
        maxBytes: MAX_BODY_BYTES,
        label: "Invite request body",
        requireBody: true,
      });
    } catch (error) {
      const status = error instanceof RequestBodyError ? error.status : 400;
      return NextResponse.json({ error: "Invalid request body" }, { status });
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const alias = typeof body.alias === "string" ? body.alias.trim().slice(0, 100) : "";
    if (!alias) {
      return NextResponse.json({ error: "Alias is required" }, { status: 400 });
    }
    const supported = new Set(getProviderNames());
    const allowedProviders = Array.isArray(body.allowedProviders)
      ? [...new Set(body.allowedProviders.filter((id) => supported.has(id)))]
      : [];
    if (allowedProviders.length === 0) {
      return NextResponse.json({ error: "Select at least one OAuth provider" }, { status: 400 });
    }
    const { invite, token } = await createContributorInvite({
      alias,
      allowedProviders,
      expiresInMinutes: body.expiresInMinutes,
      providerBaseUrls: body.providerBaseUrls,
    });
    // Behind a reverse proxy, request.url can contain the container bind address
    // (for example 0.0.0.0:20128). POST requests from the dashboard carry the
    // browser's public Origin, which has already passed the same-origin check.
    const publicOrigin = request.headers.get("origin") || getPublicOrigin(request);
    const url = new URL(`/contribute/${token}`, publicOrigin).toString();
    const { tokenHash, ...safeInvite } = invite;
    return NextResponse.json({ invite: safeInvite, url }, { status: 201 });
  } catch (error) {
    // Validation failures are the caller's problem and must not leak an
    // internal message; only unexpected faults become a 500.
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: "Invalid request body" }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to create invite" }, { status: 500 });
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
