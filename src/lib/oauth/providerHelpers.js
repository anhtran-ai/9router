import {
  awaitModelCatalogResponse,
  cancelModelCatalogBody,
  readModelCatalogJson,
} from "../../../open-sse/services/modelCatalogResponse.js";

const BASE64_BLOCK_SIZE = 4;
const KIRO_PROFILE_FETCH_TIMEOUT_MS = 10_000;
const KIRO_PROFILE_RESPONSE_LIMIT_BYTES = 256 * 1024;

function validateXaiOAuthEndpoint(rawUrl, field) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error(`xai discovery ${field} is empty`);
  let parsed;
  try { parsed = new URL(value); } catch (err) {
    throw new Error(`xai discovery ${field} is invalid: ${err.message}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`xai discovery ${field} must use https: ${value}`);
  const host = parsed.hostname.toLowerCase().trim();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xai discovery ${field} host ${host} is not on x.ai`);
  }
  return value;
}

function decodeXaiIdTokenEmail(idToken) {
  if (!idToken || typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const json = Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload.email || payload.preferred_username || payload.sub || undefined;
  } catch {
    return undefined;
  }
}

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractEmailFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  return payload.email || payload.preferred_username || payload.sub || undefined;
}

export async function fetchKiroProfileArn(
  accessToken,
  { signal = null, timeoutMs = KIRO_PROFILE_FETCH_TIMEOUT_MS } = {},
) {
  if (!accessToken) return null;
  const controller = new AbortController();
  const effectiveTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : KIRO_PROFILE_FETCH_TIMEOUT_MS;
  const timer = setTimeout(
    () => controller.abort(new DOMException("Kiro profile lookup timed out", "TimeoutError")),
    effectiveTimeoutMs,
  );
  timer.unref?.();
  let abortListener = null;
  if (signal) {
    abortListener = () => controller.abort(signal.reason);
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    if (controller.signal.aborted) return null;
    const response = await awaitModelCatalogResponse(fetch("https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ maxResults: 10 }),
      signal: controller.signal,
    }), controller.signal);
    if (!response.ok) {
      cancelModelCatalogBody(response, "Kiro profile lookup rejected");
      return null;
    }
    const data = await readModelCatalogJson(response, {
      signal: controller.signal,
      maxBytes: KIRO_PROFILE_RESPONSE_LIMIT_BYTES,
    });
    return data.profiles?.find((p) => p.arn?.trim())?.arn?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export function extractCodexAccountInfo(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};
  const chatgpt = payload["https://api.openai.com/auth"] || {};
  return {
    email: payload.email,
    chatgptAccountId: chatgpt.chatgpt_account_id || payload.account_id,
    chatgptPlanType: chatgpt.chatgpt_plan_type || payload.plan_type,
  };
}

export {
  BASE64_BLOCK_SIZE,
  validateXaiOAuthEndpoint,
  decodeXaiIdTokenEmail,
  decodeJwtPayload,
  extractEmailFromAccessToken,
};
