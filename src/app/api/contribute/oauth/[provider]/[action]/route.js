import { NextResponse } from "next/server";
import {
  GET as upstreamGET,
  POST as upstreamPOST,
} from "@/app/api/oauth/[provider]/[action]/route";
import { getContributorSession, isSameOrigin } from "@/lib/contributor/session";
import {
  consumeContributorInvite,
  normalizeContributorProviderBaseUrls,
} from "@/lib/contributor/store";
import { GITLAB_CONFIG } from "@/lib/oauth/constants/oauth";

const GET_ACTIONS = new Set([
  "authorize",
  "device-code",
  "start-proxy",
  "poll-status",
  "stop-proxy",
  "ide-status",
]);
const POST_ACTIONS = new Set(["exchange", "poll", "manual-code", "register-session"]);

function approvedGitLabBaseUrl(invite) {
  const stored = normalizeContributorProviderBaseUrls(
    invite?.providerBaseUrls,
    invite?.allowedProviders || [],
  ).gitlab;
  if (stored) return stored;
  return normalizeContributorProviderBaseUrls(
    { gitlab: GITLAB_CONFIG.defaultBaseUrl },
    ["gitlab"],
  ).gitlab;
}

async function bindContributorOAuthRequest(request, session, values) {
  if (values.provider !== "gitlab" || !["authorize", "exchange"].includes(values.action)) {
    return { request };
  }

  let baseUrl;
  try {
    baseUrl = approvedGitLabBaseUrl(session.invite);
  } catch {
    return {
      error: NextResponse.json(
        { error: "Contributor GitLab origin is not approved" },
        { status: 403 },
      ),
    };
  }

  if (values.action === "authorize") {
    const url = new URL(request.url);
    // Invite holders may supply their OAuth client ID, but never the server
    // origin that receives the later authorization-code/token-bearing POST.
    url.searchParams.set("baseUrl", baseUrl);
    return {
      request: new Request(url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      }),
    };
  }

  let body;
  try {
    body = await request.clone().json();
  } catch {
    // Let the upstream route retain its normal invalid-body response.
    return { request };
  }
  const clientMeta = body?.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
    ? body.meta
    : {};
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return {
    request: new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify({ ...body, meta: { ...clientMeta, baseUrl } }),
      signal: request.signal,
    }),
  };
}

async function authorize(request, params, actions) {
  const values = await params;
  if (!actions.has(values.action)) {
    return { error: NextResponse.json({ error: "Action not allowed" }, { status: 403 }) };
  }
  const session = await getContributorSession(request);
  if (!session) {
    return { error: NextResponse.json({ error: "Contribution session expired" }, { status: 401 }) };
  }
  if (!session.invite.allowedProviders.includes(values.provider)) {
    return { error: NextResponse.json({ error: "Provider not allowed by this invite" }, { status: 403 }) };
  }
  return { session, values };
}

async function consumeOnSuccess(response, session, action) {
  if (!response.ok) return response;
  try {
    const body = await response.clone().json();
    const completed =
      (["exchange", "poll", "manual-code"].includes(action) && body.success === true) ||
      (action === "poll-status" && body.status === "done");
    if (completed) {
      await consumeContributorInvite(session.invite.id, body.connection || null);
    }
  } catch {
    // Non-JSON upstream responses are never treated as completed OAuth.
  }
  return response;
}

export async function GET(request, { params }) {
  const auth = await authorize(request, params, GET_ACTIONS);
  if (auth.error) return auth.error;
  const bound = await bindContributorOAuthRequest(request, auth.session, auth.values);
  if (bound.error) return bound.error;
  const response = await upstreamGET(bound.request, { params: Promise.resolve(auth.values) });
  return consumeOnSuccess(response, auth.session, auth.values.action);
}

export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const auth = await authorize(request, params, POST_ACTIONS);
  if (auth.error) return auth.error;
  const bound = await bindContributorOAuthRequest(request, auth.session, auth.values);
  if (bound.error) return bound.error;
  const response = await upstreamPOST(bound.request, { params: Promise.resolve(auth.values) });
  return consumeOnSuccess(response, auth.session, auth.values.action);
}
