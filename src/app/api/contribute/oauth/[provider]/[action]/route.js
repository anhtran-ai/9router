import { NextResponse } from "next/server";
import {
  GET as upstreamGET,
  POST as upstreamPOST,
} from "@/app/api/oauth/[provider]/[action]/route";
import { getContributorSession, isSameOrigin } from "@/lib/contributor/session";
import {
  cancelContributorInviteReservation,
  completeContributorInviteWithConnection,
  getContributorInvite,
  normalizeContributorProviderBaseUrls,
  releaseContributorInviteReservation,
  reserveContributorInvite,
  resumeContributorInviteReservation,
} from "@/lib/contributor/store";
import { GITLAB_CONFIG } from "@/lib/oauth/constants/oauth";
import { readRequestBodyBytes } from "open-sse/utils/requestBody.js";

const GET_ACTIONS = new Set([
  "authorize",
  "device-code",
  "start-proxy",
  "poll-status",
  "stop-proxy",
  "ide-status",
]);
const POST_ACTIONS = new Set(["exchange", "poll", "manual-code", "register-session"]);
const DIRECT_COMPLETION_ACTIONS = new Set(["exchange", "poll", "manual-code"]);
const CALLBACK_PROXY_PROVIDERS = new Set(["codex", "xai", "trae", "windsurf", "zed"]);
const PROXY_RESUME_ACTIONS = new Set(["register-session", "poll-status", "stop-proxy"]);
const USED_INVITE_OBSERVATION_ACTIONS = new Set(["poll-status", "stop-proxy"]);
const MAX_CONTRIBUTOR_OAUTH_BODY_BYTES = 1024 * 1024;

function rebuildContributorRequest(request, body, { json = false } = {}) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  if (json) {
    // The GitLab binding rewrites the logical JSON payload, so stale wire and
    // integrity metadata from the incoming request must not be forwarded.
    headers.delete("content-encoding");
    headers.delete("content-md5");
    headers.delete("digest");
    headers.set("content-type", "application/json");
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  });
}

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
  let rawBody = null;
  if (request.method === "POST") {
    try {
      rawBody = await readRequestBodyBytes(request, {
        maxBytes: MAX_CONTRIBUTOR_OAUTH_BODY_BYTES,
        label: "OAuth request body",
      });
      // Every contributor POST is reconstructed from the one bounded read.
      // Non-GitLab providers receive the exact logical bytes unchanged.
      request = rebuildContributorRequest(request, rawBody);
    } catch (error) {
      const status = Number(error?.status);
      if ([408, 413, 499].includes(status)) {
        return {
          error: NextResponse.json(
            { error: error.message },
            { status },
          ),
        };
      }
      return {
        error: NextResponse.json({ error: "Unable to read OAuth request body" }, { status: 400 }),
      };
    }
  }

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

  let decodedBody;
  try {
    decodedBody = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return {
      error: NextResponse.json({ error: "Invalid UTF-8 OAuth request body" }, { status: 400 }),
    };
  }
  let body;
  try {
    body = JSON.parse(decodedBody);
  } catch {
    // Preserve the upstream route's normal invalid-body response without
    // leaving an unread Request.clone() tee branch retaining the payload.
    return { request: rebuildContributorRequest(request, rawBody) };
  }
  const clientMeta = body?.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
    ? body.meta
    : {};
  return {
    request: rebuildContributorRequest(
      request,
      JSON.stringify({ ...body, meta: { ...clientMeta, baseUrl } }),
      { json: true },
    ),
  };
}

async function authorize(request, params, actions) {
  const values = await params;
  if (!actions.has(values.action)) {
    return { error: NextResponse.json({ error: "Action not allowed" }, { status: 403 }) };
  }
  const session = await getContributorSession(request, {
    // A proxy callback atomically consumes the invite before the browser can
    // observe `done`. The owning session may only poll/stop that exact
    // provider afterward; it cannot perform another OAuth side effect.
    allowUsed: USED_INVITE_OBSERVATION_ACTIONS.has(values.action),
  });
  if (!session) {
    return { error: NextResponse.json({ error: "Contribution session expired" }, { status: 401 }) };
  }
  if (!session.invite.allowedProviders.includes(values.provider)) {
    return { error: NextResponse.json({ error: "Provider not allowed by this invite" }, { status: 403 }) };
  }
  if (session.invite.status === "used") {
    const observingOwnProvider = USED_INVITE_OBSERVATION_ACTIONS.has(values.action)
      && session.invite.connection?.provider === values.provider;
    if (!observingOwnProvider) {
      return { error: NextResponse.json({ error: "Contribution is already completed" }, { status: 409 }) };
    }
  }
  return { session, values };
}

function contributorSessionId(session) {
  return session?.payload?.sessionId || session?.invite?.sessionId || null;
}

async function acquireCompletionLease(session, values) {
  const { action, provider } = values;
  const sessionId = contributorSessionId(session);
  let acquired = null;
  let mode = null;
  if (DIRECT_COMPLETION_ACTIONS.has(action)) {
    const resumesProxyFallback = session.invite.status === "completing" && (
      (action === "manual-code" && provider === "xai")
      || (action === "exchange" && CALLBACK_PROXY_PROVIDERS.has(provider))
    );
    acquired = resumesProxyFallback
      ? await resumeContributorInviteReservation(session.invite.id, sessionId)
      : await reserveContributorInvite(session.invite.id, sessionId);
    mode = resumesProxyFallback && action === "exchange" ? "proxy-direct" : "direct";
  } else if (action === "start-proxy") {
    acquired = await reserveContributorInvite(session.invite.id, sessionId);
    mode = "proxy-start";
  } else if (PROXY_RESUME_ACTIONS.has(action)) {
    if (session.invite.status === "used" && USED_INVITE_OBSERVATION_ACTIONS.has(action)) {
      return {
        reservation: null,
        observationHash: session.invite.completionObservationHash || null,
        mode: "proxy-observe",
      };
    }
    acquired = await resumeContributorInviteReservation(session.invite.id, sessionId);
    mode = action === "register-session"
      ? "proxy-register"
      : action === "poll-status"
        ? "proxy-poll"
        : "proxy-stop";
  } else {
    return { reservation: null, mode: null };
  }
  if (!acquired) {
    return {
      error: NextResponse.json(
        { error: "Contribution is already in progress or completed" },
        { status: 409 },
      ),
    };
  }
  return {
    reservation: acquired.reservation || { sessionId, leaseId: acquired.leaseId },
    observationHash:
      acquired.invite?.completionLeaseHash
      || acquired.reservation?.leaseHash
      || null,
    mode,
  };
}

async function releaseReservation(session, reservation) {
  if (!reservation) return;
  await releaseContributorInviteReservation(session.invite.id, reservation);
}

async function cancelReservation(session, reservation) {
  if (!reservation) return;
  await cancelContributorInviteReservation(session.invite.id, reservation);
}

async function finalizeCompletion(
  response,
  session,
  values,
  reservation,
  observationHash,
  mode,
  completionState,
) {
  if (completionState?.committed) return response;
  if (mode === "proxy-observe") return response;
  if (!reservation) return response;

  if (mode === "proxy-start") {
    if (!response.ok) {
      await releaseReservation(session, reservation);
      return response;
    }
    let body;
    try {
      body = await response.clone().json();
    } catch {
      // The listener may already exist, so malformed success is terminal for
      // this one-time invite rather than reopening it for another side effect.
      await cancelReservation(session, reservation);
      return NextResponse.json({ error: "Invalid proxy start response" }, { status: 502 });
    }
    if (body?.success === false) {
      await releaseReservation(session, reservation);
      return response;
    }
    if (body?.success !== true) {
      await cancelReservation(session, reservation);
      return NextResponse.json({ error: "Invalid proxy start response" }, { status: 502 });
    }
    if (["codex", "xai"].includes(values.provider) && body.serverSide !== true) {
      // Contributor credentials may only be persisted through the session's
      // atomic commit callback. A fixed-port proxy without server-side
      // registration cannot ever complete safely.
      await cancelReservation(session, reservation);
      return NextResponse.json(
        { error: "Contributor proxy session was not registered" },
        { status: 409 },
      );
    }
    // A successful proxy start keeps the invite reserved across authorize,
    // register-session and polling while its callback may create a connection.
    return response;
  }

  if (mode === "proxy-register") {
    if (!response.ok) {
      await cancelReservation(session, reservation);
      return response;
    }
    try {
      const body = await response.clone().json();
      if (body?.success === true) return response;
      await cancelReservation(session, reservation);
      return body?.success === false
        ? response
        : NextResponse.json({ error: "Invalid proxy registration response" }, { status: 502 });
    } catch {
      await cancelReservation(session, reservation);
      return NextResponse.json({ error: "Invalid proxy registration response" }, { status: 502 });
    }
  }

  if (mode === "proxy-stop") {
    // Stopping a proxy is terminal. Reactivating this one-time invite races
    // with a concurrent poll whose callback may already have created a
    // connection; used/revoked are both safe terminal CAS outcomes.
    if (response.ok) await cancelReservation(session, reservation);
    return response;
  }

  if (mode === "proxy-poll") {
    if (!response.ok) return response;
    let body;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    if (body.status === "done") {
      const completedInvite = await getContributorInvite(session.invite.id);
      const sameAtomicCompletion = Boolean(
        completedInvite?.status === "used"
          && completedInvite.sessionId === contributorSessionId(session)
          && completedInvite.connection?.provider === values.provider
          && typeof observationHash === "string"
          && completedInvite.completionObservationHash === observationHash,
      );
      if (sameAtomicCompletion) return response;
      // New proxy sessions commit the credential + invite atomically inside
      // the callback. Seeing `done` while this snapshot is still completing
      // means a callback escaped the contributor commit hook; fail closed.
      return NextResponse.json(
        { error: "Proxy completion did not atomically consume the contribution" },
        { status: 409 },
      );
    }
    if (body.status === "error") {
      await cancelReservation(session, reservation);
    }
    return response;
  }

  if (!response.ok) {
    if (mode === "proxy-direct") return response;
    await releaseReservation(session, reservation);
    return response;
  }
  let body;
  try {
    body = await response.clone().json();
  } catch {
    if (mode !== "proxy-direct") await releaseReservation(session, reservation);
    return NextResponse.json({ error: "Invalid OAuth completion response" }, { status: 502 });
  }
  if (typeof body?.success !== "boolean") {
    if (mode !== "proxy-direct") await releaseReservation(session, reservation);
    return NextResponse.json({ error: "Invalid OAuth completion response" }, { status: 502 });
  }
  const completed =
    (["exchange", "poll", "manual-code"].includes(values.action) && body.success === true) ||
    (values.action === "poll-status" && body.status === "done");
  if (!completed) {
    if (mode === "proxy-direct") return response;
    await releaseReservation(session, reservation);
    return response;
  }
  // A successful completion response must have gone through the internal
  // atomic commit callback. Never mark the invite used based only on response
  // JSON: doing so would recreate the revoke-vs-persistence race.
  if (mode !== "proxy-direct") await releaseReservation(session, reservation);
  return NextResponse.json(
    { error: "OAuth completion did not atomically persist the contribution" },
    { status: 502 },
  );
}

async function runReservedOAuth(session, values, invoke) {
  const lease = await acquireCompletionLease(session, values);
  if (lease.error) return lease.error;
  if (lease.mode === "proxy-observe") {
    if (values.action === "stop-proxy") {
      // A successful callback already stopped its own listener. Keep the
      // modal's cleanup request idempotent without stopping a newer proxy.
      return NextResponse.json({ success: true });
    }
    // The atomic transaction persisted this terminal receipt on the invite.
    // Serving it directly keeps completion observable even after the in-memory
    // proxy session has been cleared or a later login has started.
    return NextResponse.json({
      status: "done",
      connectionId: session.invite.connection?.id || null,
      email: session.invite.connection?.email || null,
    });
  }
  const completionState = { committed: false };
  const internalOptions = {
    ...(lease.observationHash
      ? { contributorReservationHash: lease.observationHash }
      : {}),
    ...(lease.reservation ? {
      commitProviderConnection: async (connectionData) => {
        const connection = await completeContributorInviteWithConnection(
          session.invite.id,
          connectionData,
          lease.reservation,
        );
        if (connection) completionState.committed = true;
        return connection;
      },
    } : {}),
  };
  let response;
  try {
    response = await invoke(internalOptions);
  } catch (error) {
    // Direct exchanges and proxy start failures have no usable completion
    // response. Poll/stop errors keep the long-lived proxy lease fail-closed.
    if (lease.mode === "direct") {
      await releaseReservation(session, lease.reservation);
    } else if (lease.mode === "proxy-start" || lease.mode === "proxy-register") {
      // A thrown start is ambiguous: the listener may already exist. Keep the
      // one-time invite terminal rather than permitting duplicate side effects.
      await cancelReservation(session, lease.reservation);
    }
    throw error;
  }
  // Finalization happens outside the rollback catch. If the connection already
  // exists but the DB finalize fails, keep the invite fail-closed in completing.
  return finalizeCompletion(
    response,
    session,
    values,
    lease.reservation,
    lease.observationHash,
    lease.mode,
    completionState,
  );
}

export async function GET(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const auth = await authorize(request, params, GET_ACTIONS);
  if (auth.error) return auth.error;
  const bound = await bindContributorOAuthRequest(request, auth.session, auth.values);
  if (bound.error) return bound.error;
  return runReservedOAuth(
    auth.session,
    auth.values,
    (internalOptions) => upstreamGET(
      bound.request,
      { params: Promise.resolve(auth.values) },
      internalOptions,
    ),
  );
}

export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const auth = await authorize(request, params, POST_ACTIONS);
  if (auth.error) return auth.error;
  const bound = await bindContributorOAuthRequest(request, auth.session, auth.values);
  if (bound.error) return bound.error;
  return runReservedOAuth(
    auth.session,
    auth.values,
    (internalOptions) => upstreamPOST(
      bound.request,
      { params: Promise.resolve(auth.values) },
      internalOptions,
    ),
  );
}
