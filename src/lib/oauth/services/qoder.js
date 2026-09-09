import {
  QODER_DEVICE_TOKEN_URL,
  QODER_LOGIN_URL,
  QODER_USERINFO_URL,
} from "../../qoder/constants.js";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

/**
 * Qoder OAuth Service
 * Implements the device-token flow:
 *   1. Generate PKCE pair + nonce + machine_id locally.
 *   2. Open https://qoder.com/device/selectAccounts?challenge=...&nonce=...
 *      in the user's browser.
 *   3. Poll openapi.qoder.sh/api/v1/deviceToken/poll until the user authorizes
 *      and the upstream returns a `dt-...` access token.
 *
 * Tokens live ~30 days; refresh is a no-op (the upstream refresh endpoint
 * returns 403 for our flow). Users re-run login when expired.
 *
 * Mirrors the structure of KiroService — the COSY signing / WAF-bypass body
 * encoding / chat protocol live separately in src/lib/qoder/ because they're
 * used by every signed request, not just OAuth.
 */

// Timeout for OAuth helper calls. The OAuth modal polls every 2s for up to
// 5 minutes; an individual request that stalls beyond this is treated as a
// failed poll attempt and the next poll iteration retries.
const FETCH_TIMEOUT_MS = 15_000;
export const QODER_OAUTH_MAX_RESPONSE_BYTES = 1024 * 1024;

class QoderOAuthBodyTooLargeError extends Error {
  constructor(actualBytes = null) {
    const suffix = Number.isFinite(actualBytes) ? ` (${actualBytes} bytes)` : "";
    super(`Qoder OAuth response exceeds ${QODER_OAUTH_MAX_RESPONSE_BYTES} bytes${suffix}`);
    this.name = "QoderOAuthBodyTooLargeError";
    this.code = "ERR_QODER_OAUTH_BODY_TOO_LARGE";
  }
}

function base64Url(buf) {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function timeoutError() {
  return new DOMException(`Qoder OAuth request timed out after ${FETCH_TIMEOUT_MS}ms`, "TimeoutError");
}

function signalError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Qoder OAuth request aborted", "AbortError");
}

function awaitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signalError(signal));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    // Observe late resolution/rejection even after the deadline wins.
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

function cancelBody(body, reason) {
  try {
    const cancellation = body?.cancel?.(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch { /* best-effort transport cleanup */ }
}

function releaseReader(reader) {
  try { reader?.releaseLock?.(); } catch { /* pending read or already released */ }
}

function declaredLength(response) {
  const raw = response?.headers?.get?.("content-length");
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}

async function readResponseBytes(response, signal) {
  const declared = declaredLength(response);
  if (declared !== null && declared > QODER_OAUTH_MAX_RESPONSE_BYTES) {
    const error = new QoderOAuthBodyTooLargeError(declared);
    cancelBody(response?.body, error);
    throw error;
  }
  if (signal?.aborted) {
    const error = signalError(signal);
    cancelBody(response?.body, error);
    throw error;
  }
  if (!response?.body) return new Uint8Array();

  if (typeof response.body.getReader !== "function") {
    // Compatibility for lightweight response doubles. Production fetch
    // responses always take the bounded byte-stream path below.
    if (typeof response.arrayBuffer === "function") {
      const arrayBuffer = await awaitWithSignal(
        Promise.resolve().then(() => response.arrayBuffer()),
        signal,
      );
      const bytes = new Uint8Array(arrayBuffer);
      if (bytes.byteLength > QODER_OAUTH_MAX_RESPONSE_BYTES) {
        throw new QoderOAuthBodyTooLargeError(bytes.byteLength);
      }
      return bytes;
    }
    if (typeof response.text === "function") {
      const text = await awaitWithSignal(
        Promise.resolve().then(() => response.text()),
        signal,
      );
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > QODER_OAUTH_MAX_RESPONSE_BYTES) {
        throw new QoderOAuthBodyTooLargeError(bytes.byteLength);
      }
      return bytes;
    }
    throw new TypeError("Qoder OAuth response body is not readable");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let completed = false;
  let terminalError = null;
  try {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new TypeError("Qoder OAuth response returned an invalid stream chunk");
      }
      totalBytes += value.byteLength;
      if (totalBytes > QODER_OAUTH_MAX_RESPONSE_BYTES) {
        throw new QoderOAuthBodyTooLargeError(totalBytes);
      }
      if (value.byteLength) chunks.push(value);
    }
  } catch (error) {
    terminalError = error;
    throw error;
  } finally {
    let cancellation = null;
    if (!completed) {
      try { cancellation = Promise.resolve(reader.cancel(terminalError)).catch(() => {}); }
      catch { /* preserve the primary body failure */ }
    }
    releaseReader(reader);
    cancellation?.finally(() => releaseReader(reader));
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readResponseText(response, signal, { fatalUtf8 = false } = {}) {
  const bytes = await readResponseBytes(response, signal);
  return new TextDecoder("utf-8", { fatal: fatalUtf8 }).decode(bytes);
}

/**
 * Keep one absolute deadline across response headers and body consumption.
 * Signal races remain authoritative even for injected/non-cooperative fetch
 * implementations; cancellation is observed but never awaited.
 */
async function fetchWithTimeout(url, init = {}, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError()), FETCH_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    const fetchPromise = Promise.resolve().then(() => fetch(url, {
      ...init,
      signal: controller.signal,
    }));
    fetchPromise.then(
      lateResponse => {
        if (controller.signal.aborted) cancelBody(lateResponse?.body, controller.signal.reason);
      },
      () => {},
    );
    response = await awaitWithSignal(fetchPromise, controller.signal);
    const consumption = Promise.resolve().then(() => consume(response, controller.signal));
    return await awaitWithSignal(consumption, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      cancelBody(response?.body, controller.signal.reason);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class QoderService {
  /**
   * Generate a PKCE verifier + S256 challenge pair.
   * Uses 32 random bytes (matches qodercli/Veria).
   */
  generatePkcePair() {
    const verifier = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
  }

  /**
   * Initiate the device flow. Returns the URL to open in a browser plus the
   * verifier/nonce/machineId we'll need to poll and to sign future requests.
   */
  initiateDeviceFlow() {
    const { verifier, challenge } = this.generatePkcePair();
    const nonce = uuidv4();
    const machineId = uuidv4();

    const params = new URLSearchParams({
      challenge,
      challenge_method: "S256",
      machine_id: machineId,
      nonce,
    });

    return {
      verificationUriComplete: `${QODER_LOGIN_URL}?${params.toString()}`,
      codeVerifier: verifier,
      nonce,
      machineId,
    };
  }

  /**
   * Single poll attempt. Returns one of:
   *   { status: "pending" }       — keep polling
   *   { status: "ok", token, ... } — user authorized, tokens captured
   *   throws Error                 — terminal failure
   *
   * Upstream returns 202/404 while waiting; 200 with a JSON body when done.
   */
  async pollDeviceToken({ nonce, codeVerifier }) {
    if (!nonce || !codeVerifier) {
      throw new Error("pollDeviceToken: missing nonce or code verifier");
    }
    const url = `${QODER_DEVICE_TOKEN_URL}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;

    return fetchWithTimeout(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Go-http-client/2.0",
      },
    }, async (response, signal) => {

      // Pending — server has registered the device code but the user hasn't
      // finished the browser flow yet. Both 202 and 404 mean "keep polling".
      if (response.status === 202 || response.status === 404) {
        cancelBody(response.body);
        return { status: "pending" };
      }

      const text = await readResponseText(response, signal, { fatalUtf8: response.ok });

      if (!response.ok) {
        let message = `Qoder device token poll failed: HTTP ${response.status}`;
        try {
          const body = JSON.parse(text);
          if (body.message) message = `Qoder device token poll failed: ${body.message}`;
        } catch {}
        throw new Error(message);
      }

      let body;
      try {
        body = JSON.parse(text);
      } catch (err) {
        throw new Error(`Qoder device token poll: invalid JSON response (${err.message})`);
      }

      // Defensive: 200 + empty token means the upstream changed shape.
      if (!body || typeof body !== "object" || Array.isArray(body)
          || typeof body.token !== "string" || !body.token.trim()) {
        throw new Error("Qoder device token poll returned 200 but no token");
      }

      const expireMs = QoderService.parseExpiry(body.expires_at, body.expires_in);

      return {
        status: "ok",
        accessToken: body.token,
        refreshToken: body.refresh_token || "",
        userId: body.user_id || "",
        expireTime: expireMs,
        rawResponse: body,
      };
    });
  }

  /**
   * Fetch profile info for the freshly-issued token. Best-effort — failures
   * shouldn't block login; returning empty strings is fine.
   */
  async fetchUserInfo(accessToken) {
    try {
      return await fetchWithTimeout(QODER_USERINFO_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": "Go-http-client/2.0",
        },
      }, async (response, signal) => {
        if (!response.ok) {
          cancelBody(response.body);
          return { name: "", email: "" };
        }
        const text = await readResponseText(response, signal, { fatalUtf8: true });
        const body = JSON.parse(text);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Qoder user info returned an invalid JSON envelope");
        }
        const clean = value => typeof value === "string" ? value.trim() : "";
        return {
          name: clean(body.name) || clean(body.username),
          email: clean(body.email),
          organizationId: clean(body.organization_id),
        };
      });
    } catch {
      return { name: "", email: "" };
    }
  }

  /**
   * Convert the upstream's expiry hint into a Unix-millisecond timestamp.
   * Accepts:
   *   - numeric (ms-epoch): returned as-is
   *   - numeric string of ms-epoch: e.g. "1781594470000"
   *   - RFC3339 string: e.g. "2026-06-16T07:15:04Z"
   *   - seconds-from-now via expiresInSeconds (>= 0)
   * Falls back to "now + 30 days" when both are missing.
   *
   * Order matters: try numeric (string or number) before Date.parse, since
   * Date.parse accepts short numeric strings like "2026" as years and would
   * otherwise return a misleading year-2026 timestamp instead of falling
   * through to the integer branch.
   *
   * Static so callers (and tests) can use it without instantiating.
   */
  static parseExpiry(expiresAt, expiresInSeconds) {
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
      return expiresAt;
    }
    const trimmed = typeof expiresAt === "string" ? expiresAt.trim() : "";
    if (trimmed) {
      // Pure numeric string → ms-epoch (don't let Date.parse swallow short
      // numerics as years).
      if (/^\d+$/.test(trimmed)) {
        const ms = Number.parseInt(trimmed, 10);
        if (Number.isFinite(ms) && ms > 0) return ms;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return parsed;
    }
    // expiresInSeconds === 0 means "already expired"; honor that by returning
    // the current time rather than fabricating a 30-day default.
    if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds >= 0) {
      return Date.now() + expiresInSeconds * 1000;
    }
    return Date.now() + 30 * 24 * 60 * 60 * 1000;
  }
}
