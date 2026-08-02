import { NextResponse } from "next/server";
import {
  GET as upstreamGET,
  POST as upstreamPOST,
} from "@/app/api/oauth/[provider]/[action]/route";
import { getContributorSession, isSameOrigin } from "@/lib/contributor/session";
import { consumeContributorInvite } from "@/lib/contributor/store";

const GET_ACTIONS = new Set([
  "authorize",
  "device-code",
  "start-proxy",
  "poll-status",
  "stop-proxy",
  "ide-status",
]);
const POST_ACTIONS = new Set(["exchange", "poll", "manual-code", "register-session"]);

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
  const response = await upstreamGET(request, { params: Promise.resolve(auth.values) });
  return consumeOnSuccess(response, auth.session, auth.values.action);
}

export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const auth = await authorize(request, params, POST_ACTIONS);
  if (auth.error) return auth.error;
  const response = await upstreamPOST(request, { params: Promise.resolve(auth.values) });
  return consumeOnSuccess(response, auth.session, auth.values.action);
}
