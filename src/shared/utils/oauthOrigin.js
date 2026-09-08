const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

function normalizeHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

export function isLoopbackOAuthHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;

  // Every address in 127.0.0.0/8 is loopback. URL canonicalization also turns
  // abbreviated forms such as 127.1 into a dotted-quad before this check.
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function canonicalOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isTrustedOAuthMessageOrigin(messageOrigin, applicationOrigin, expectedCallbackOrigin = null) {
  if (!messageOrigin || messageOrigin === "null") return false;
  const received = canonicalOrigin(messageOrigin);
  if (!received) return false;
  const app = canonicalOrigin(applicationOrigin);
  if (app && received === app) return true;
  const expected = canonicalOrigin(expectedCallbackOrigin);
  if (!expected || received !== expected) return false;
  const parsed = new URL(expected);
  return HTTP_PROTOCOLS.has(parsed.protocol) && isLoopbackOAuthHostname(parsed.hostname);
}

export function isTrustedOAuthMessageEvent(event, {
  applicationOrigin,
  expectedCallbackOrigin,
  expectedPopup,
  expectedState,
} = {}) {
  if (!event || !expectedPopup || event.source !== expectedPopup) return false;
  if (!isTrustedOAuthMessageOrigin(event.origin, applicationOrigin, expectedCallbackOrigin)) return false;
  const callbackState = event.data?.data?.state;
  return typeof expectedState === "string" && expectedState.length > 0 && callbackState === expectedState;
}
