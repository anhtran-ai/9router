// SSRF guard: block internal/private/metadata targets for server-side fetch.
//
// Three layers, each closing a distinct bypass class documented in #3714:
//   1. assertPublicUrl        - synchronous literal-IP/hostname checks (cheap, for
//                                immediate rejection of obviously-bad input at request-build time).
//   2. assertPublicUrlResolved - adds DNS resolution so a hostname that merely
//                                *resolves* to a private/loopback address (e.g. a
//                                nip.io/sslip.io wildcard-DNS domain, or an attacker's
//                                own domain pointed at 127.0.0.1) is also rejected.
//   3. fetchPublic             - wraps fetch() with manual redirect handling so a
//                                validated public URL can't 30x its way to an
//                                internal target without the redirect target being
//                                re-validated through layer 2 first.
//
// Layer 1 alone previously had matching bugs, not just missing coverage: hostname
// checks ran on the raw string without normalizing a trailing dot ("localhost."),
// and the IPv6 check only recognized one textual representation of an IPv4-mapped
// address (dotted "::ffff:a.b.c.d") while Node/WHATWG URL parsing can normalize the
// same address to hex form ("::ffff:7f00:1") — a mismatch, not an oversight.

import dns from "node:dns";
import { Agent } from "undici";

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const DNS_LOOKUP_TIMEOUT_MS = 5_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
  "x-key",
  "xi-api-key",
  "x-subscription-token",
]);

// Parse dotted IPv4 to 32-bit integer, or null if not a valid IPv4 literal.
function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// IPv4 ranges that are not globally reachable, expressed as [startInt, maskBits].
// Keep this broader than RFC1918: benchmark, documentation, protocol-assignment,
// multicast, reserved and broadcast space can all be routed inside a host/VPC and
// therefore are SSRF targets too.
const BLOCKED_V4_RANGES = [
  [ipv4ToInt("0.0.0.0"), 8],
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("100.64.0.0"), 10], // CGNAT — also used by some cloud metadata proxies
  [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("169.254.0.0"), 16], // includes 169.254.169.254 cloud metadata
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.0.0.0"), 24], // IETF protocol assignments
  [ipv4ToInt("192.0.2.0"), 24], // TEST-NET-1
  [ipv4ToInt("192.31.196.0"), 24], // special-purpose AS112 service
  [ipv4ToInt("192.52.193.0"), 24], // AMT special-purpose relay anycast
  [ipv4ToInt("192.88.99.0"), 24], // deprecated 6to4 relay anycast
  [ipv4ToInt("192.168.0.0"), 16],
  [ipv4ToInt("192.175.48.0"), 24], // special-purpose AS112 service
  [ipv4ToInt("198.18.0.0"), 15], // network benchmark range
  [ipv4ToInt("198.51.100.0"), 24], // TEST-NET-2
  [ipv4ToInt("203.0.113.0"), 24], // TEST-NET-3
  [ipv4ToInt("224.0.0.0"), 4], // multicast
  [ipv4ToInt("240.0.0.0"), 4], // reserved + limited broadcast
];

function isBlockedIpv4Int(ip) {
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

function isBlockedIpv4(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return isBlockedIpv4Int(ip);
}

function parseHextets(s) {
  if (s === "") return [];
  const segs = s.split(":");
  const out = [];
  for (const seg of segs) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
    out.push(parseInt(seg, 16));
  }
  return out;
}

// Parse any textual IPv6 representation (including an embedded dotted-IPv4 tail,
// "::" compression in any position, and full/partial forms) into 8 16-bit groups.
// Returns null if the string isn't a valid IPv6 literal. Parsing into groups once
// and reasoning about the numeric value — rather than pattern-matching the source
// string — is what makes this immune to "which textual form did the URL parser
// pick" bugs: "::ffff:127.0.0.1" and "::ffff:7f00:1" produce identical groups.
function parseIPv6ToGroups(rawHost) {
  let host = rawHost.toLowerCase();

  const v4TailMatch = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let v4Groups = null;
  if (v4TailMatch) {
    const v4Int = ipv4ToInt(v4TailMatch[1]);
    if (v4Int === null) return null;
    v4Groups = [(v4Int >>> 16) & 0xffff, v4Int & 0xffff];
    host = host.slice(0, host.length - v4TailMatch[1].length);
    if (host.endsWith("::")) {
      // "::" compression marker itself — leave both colons, the removed IPv4
      // fills the gap it represents.
    } else if (host.endsWith(":")) {
      host = host.slice(0, -1); // was just the "prevgroup:ipv4" separator
    }
  }

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups;
  if (doubleColonParts.length === 2) {
    const head = parseHextets(doubleColonParts[0]);
    const tail = parseHextets(doubleColonParts[1]);
    if (head === null || tail === null) return null;
    const v4Len = v4Groups ? v4Groups.length : 0;
    const missing = 8 - head.length - tail.length - v4Len;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail, ...(v4Groups || [])];
  } else {
    const all = parseHextets(host);
    if (all === null) return null;
    groups = [...all, ...(v4Groups || [])];
  }
  return groups.length === 8 ? groups : null;
}

function isBlockedIpv6Groups(g) {
  if (!Array.isArray(g) || g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) {
    return true;
  }
  const isZero = (n) => g[n] === 0;
  // loopback ::1
  if ([0, 1, 2, 3, 4, 5, 6].every(isZero) && g[7] === 1) return true;
  // unspecified ::
  if (g.every((x) => x === 0)) return true;
  // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // unique local fc00::/7
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // IPv4-mapped/compatible and NAT64 literals are special-purpose IPv6 space.
  // Reject the whole prefixes instead of relying on the host's translation
  // configuration, even when the embedded IPv4 value looks public.
  if ([0, 1, 2, 3, 4].every(isZero) && g[5] === 0xffff) return true;
  if ([0, 1, 2, 3, 4, 5].every(isZero)) return true;
  if (g[0] === 0x0064 && g[1] === 0xff9b) return true;

  // Current globally routable unicast allocations are within 2000::/3. Fail
  // closed for unallocated/special space, then exclude special ranges inside
  // that aggregate (IETF assignments, documentation, 6to4 and doc-prefix v2).
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && (g[1] & 0xfe00) === 0) return true; // 2001::/23
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return true; // deprecated 6to4
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true; // documentation
  return false;
}

// Canonical address classifier for callers that already performed DNS lookup
// and need to pin their own connection. Unknown families and malformed records
// fail closed.
export function isPublicIpAddress(address, family) {
  const normalized = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  const numericFamily = Number(family) || 0;
  if (numericFamily === 4) {
    return ipv4ToInt(normalized) !== null && !isBlockedIpv4(normalized);
  }
  if (numericFamily === 6) {
    const groups = parseIPv6ToGroups(normalized);
    return groups !== null && !isBlockedIpv6Groups(groups);
  }
  return false;
}

function normalizeHost(hostname) {
  // A trailing dot marks an FQDN and is semantically insignificant
  // ("localhost." and "localhost" are the same host) but was being compared
  // as a literal character, letting it slip past every string-based check.
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function isBlockedHost(host) {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (isBlockedIpv4(host)) return true;
  if (host.includes(":")) {
    const groups = parseIPv6ToGroups(host.replace(/^\[|\]$/g, ""));
    if (groups && isBlockedIpv6Groups(groups)) return true;
  }
  return false;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

async function lookupWithDeadline(host, { signal, dnsTimeoutMs = DNS_LOOKUP_TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw abortReason(signal);

  const requestedTimeout = Number(dnsTimeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, DNS_LOOKUP_TIMEOUT_MS)
    : DNS_LOOKUP_TIMEOUT_MS;
  let timer;
  let onAbort;
  const racers = [dns.promises.lookup(host, { all: true, verbatim: true })];

  racers.push(new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Blocked URL: DNS resolution timed out");
      error.code = "DNS_LOOKUP_TIMEOUT";
      reject(error);
    }, timeoutMs);
  }));

  if (signal?.addEventListener) {
    racers.push(new Promise((_, reject) => {
      onAbort = () => reject(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }));
  }

  try {
    return await Promise.race(racers);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// Throw if URL targets a non-public host by literal hostname/IP alone (no DNS
// resolution — see assertPublicUrlResolved for that). Caller should map to 400.
export function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Blocked URL: only http(s) is allowed");
  }
  const host = normalizeHost(parsed.hostname);
  if (isBlockedHost(host)) throw new Error("Blocked URL: internal host");
}

async function resolvePublicUrl(rawUrl, options = {}) {
  const { signal } = options;
  if (signal?.aborted) throw abortReason(signal);
  const parsed = new URL(rawUrl);
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Blocked URL: only http(s) is allowed");
  }

  const host = normalizeHost(parsed.hostname);
  if (isBlockedHost(host)) throw new Error("Blocked URL: internal host");

  // Already a literal IPv4/IPv6 address. Return it so fetchPublic can pin the
  // connection without asking the system resolver again.
  const bracketless = host.replace(/^\[|\]$/g, "");
  if (ipv4ToInt(bracketless) !== null) {
    return { parsed, host, addresses: [{ address: bracketless, family: 4 }] };
  }
  if (bracketless.includes(":")) {
    return { parsed, host, addresses: [{ address: bracketless, family: 6 }] };
  }

  let addresses;
  try {
    addresses = await lookupWithDeadline(host, options);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (error?.code === "DNS_LOOKUP_TIMEOUT") throw error;
    // Fail closed. Letting fetch resolve the hostname again after our lookup
    // failed would bypass both address validation and DNS pinning.
    throw new Error("Blocked URL: DNS resolution failed", { cause: error });
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error("Blocked URL: DNS returned no addresses");
  }

  for (const { address, family } of addresses) {
    if (!isPublicIpAddress(address, family)) {
      throw new Error("Blocked URL: hostname resolves to an internal host");
    }
  }
  return { parsed, host, addresses };
}

// Async: assertPublicUrl plus DNS resolution of non-literal hostnames, so a
// domain that merely *resolves* to a private/loopback/metadata address (wildcard-DNS
// services like nip.io/sslip.io, or an attacker-controlled domain with an A record
// pointed at 127.0.0.1) is rejected too, not just IPs typed directly into the URL.
export async function assertPublicUrlResolved(rawUrl, options = {}) {
  await resolvePublicUrl(rawUrl, options);
}

function createPinnedDispatcher(host, addresses) {
  return new Agent({
    connect: {
      lookup(requestedHost, options, callback) {
        if (normalizeHost(requestedHost) !== host) {
          callback(new Error("Blocked URL: unexpected DNS lookup"));
          return;
        }

        const requestedFamily = Number(options?.family) || 0;
        const eligible = requestedFamily
          ? addresses.filter(({ family }) => family === requestedFamily)
          : addresses;
        const records = eligible.length > 0 ? eligible : addresses;
        if (options?.all) {
          callback(null, records.map(({ address, family }) => ({ address, family })));
          return;
        }
        callback(null, records[0].address, records[0].family);
      },
    },
  });
}

function stripSensitiveRedirectHeaders(headers) {
  const sanitized = new Headers(headers || {});
  // Snapshot keys before deleting: mutating a live Headers iterator can skip
  // the entry immediately after a deletion.
  for (const name of Array.from(sanitized.keys())) {
    const normalized = name.toLowerCase();
    const isSensitive = SENSITIVE_REDIRECT_HEADERS.has(normalized)
      || normalized.includes("token")
      || normalized.includes("secret")
      || normalized.includes("password")
      || normalized.includes("credential")
      || normalized.includes("api-key")
      || normalized.includes("apikey")
      || normalized.includes("session")
      || normalized.includes("jwt")
      || normalized === "key"
      || normalized.endsWith("-key")
      || /(^|[-_])auth(?:entication|orization)?([-_]|$)/.test(normalized);
    if (isSensitive) sanitized.delete(name);
  }
  return sanitized;
}

function switchRedirectToGet(status, method) {
  const normalizedMethod = (method || "GET").toUpperCase();
  return status === 303 && normalizedMethod !== "HEAD"
    || (status === 301 || status === 302) && normalizedMethod === "POST";
}

// fetch() with SSRF-safe manual redirect handling: each hop's target is
// re-validated through assertPublicUrlResolved before being followed, so a
// validated public URL can't 30x its way to an internal target. Bounded to
// maxRedirects hops (fetch's own default following behavior has no bound
// relevant here since we never let it auto-follow).
export async function fetchPublic(url, init = {}, { maxRedirects = 5, dnsTimeoutMs } = {}) {
  let currentUrl = new URL(url).toString();
  let currentInit = { ...init, headers: new Headers(init.headers || {}) };
  for (let hop = 0; ; hop++) {
    const { parsed, host, addresses } = await resolvePublicUrl(currentUrl, {
      signal: currentInit.signal,
      dnsTimeoutMs,
    });
    const dispatcher = createPinnedDispatcher(host, addresses);
    let res;
    try {
      res = await fetch(currentUrl, { ...currentInit, redirect: "manual", dispatcher });
    } catch (error) {
      // A broken dispatcher must not make the caller wait forever after the
      // request has already failed.
      dispatcher.close().catch(() => {});
      throw error;
    }
    const isRedirect = REDIRECT_STATUSES.has(res.status);
    const location = isRedirect ? res.headers.get("location") : null;
    if (!location) {
      // close() drains once the response body is consumed; do not await it here,
      // because the caller owns the body returned below.
      dispatcher.close().catch(() => {});
      return res;
    }

    // Redirect bodies are never consumed. Fire cleanup without awaiting
    // third-party cancel/close hooks, which are allowed to remain pending.
    try { Promise.resolve(res.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
    dispatcher.close().catch(() => {});
    if (hop >= maxRedirects) throw new Error("Blocked URL: too many redirects");

    const nextUrl = new URL(location, currentUrl).toString();
    const nextParsed = new URL(nextUrl);
    let nextHeaders = currentInit.headers;
    if (nextParsed.origin !== parsed.origin) {
      nextHeaders = stripSensitiveRedirectHeaders(nextHeaders);
    }

    if (switchRedirectToGet(res.status, currentInit.method)) {
      nextHeaders = new Headers(nextHeaders);
      nextHeaders.delete("content-length");
      nextHeaders.delete("content-type");
      nextHeaders.delete("transfer-encoding");
      currentInit = { ...currentInit, method: "GET", body: undefined, headers: nextHeaders };
    } else {
      currentInit = { ...currentInit, headers: nextHeaders };
    }
    currentUrl = nextUrl;
  }
}
