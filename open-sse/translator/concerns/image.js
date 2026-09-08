// Build a base64 data URI from mime + base64 payload
export function encodeDataUri(mimeType, base64) {
  return `data:${mimeType};base64,${base64}`;
}

// Parse a base64 data URI → { mimeType, base64 }, or null if not a data URI.
// [\s\S] tolerates newlines inside the base64 payload.
const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;
export function parseDataUri(url) {
  if (typeof url !== "string") return null;
  const m = url.match(DATA_URI_RE);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

import { lookup } from "node:dns/promises";
import { Agent } from "undici";
import { MAX_IMAGE_BYTES, FETCH_TIMEOUT_MS, IMAGE_SIGNATURES, BLOCKED_HOSTS } from "../../config/mediaConfig.js";
import { isPublicIpAddress } from "../../../src/shared/utils/ssrfGuard.js";
import { awaitWithSignal } from "../../utils/abort.js";

// Resolve host once and return only public IPs (SSRF guard).
// Rejects if any resolved record is private/reserved (defeats multi-A tricks).
async function resolvePinnedIps(hostname, signal) {
  if (!hostname || BLOCKED_HOSTS.has(hostname.toLowerCase())) return null;
  try {
    if (signal?.aborted) return null;
    const lookupPromise = lookup(hostname, { all: true });
    // Stop this request's wait while still observing a late DNS rejection.
    const records = await awaitWithSignal(lookupPromise, signal);
    if (!records.length || records.some((r) => !isPublicIpAddress(r.address, r.family))) return null;
    return records;
  } catch {
    return null;
  }
}

// Verify buffer magic bytes match a known image signature; return its mime or null.
function detectImageMime(buf) {
  for (const { sig, offset, mime, verifyWebp } of IMAGE_SIGNATURES) {
    if (buf.length < offset + sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[offset + i] !== sig[i]) { match = false; break; }
    }
    if (!match) continue;
    // WEBP: RIFF....WEBP — bytes 8..11 must be "WEBP".
    if (verifyWebp && !(buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)) continue;
    return mime;
  }
  return null;
}

/**
 * Fetch a remote image URL and return it as a base64 data URI.
 * Hardened against SSRF (private/metadata IPs), memory DoS (size cap),
 * and disguised non-image payloads (magic-byte verification).
 * Returns null on any failure or rejection.
 *
 * @param {string} imageUrl - HTTP(S) URL of the image
 * @param {object} options - { signal, timeoutMs, maxBytes }
 * @returns {Promise<{url: string, mimeType: string}|null>}
 */
export async function fetchImageAsBase64(imageUrl, options = {}) {
  const { signal, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES } = options;
  if (!imageUrl || (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))) {
    return null;
  }

  let url;
  try { url = new URL(imageUrl); } catch { return null; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  const pinnedIps = await resolvePinnedIps(url.hostname, fetchSignal);
  if (!pinnedIps || fetchSignal.aborted) {
    clearTimeout(timeout);
    return null;
  }

  // Pin connect to the validated IP so no second DNS resolution can rebind (TOCTOU fix).
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, lookupOptions, callback) => {
        const requestedFamily = Number(lookupOptions?.family) || 0;
        const eligible = requestedFamily
          ? pinnedIps.filter(({ family }) => family === requestedFamily)
          : pinnedIps;
        const records = eligible.length > 0 ? eligible : pinnedIps;
        if (lookupOptions?.all) {
          callback(null, records.map(({ address, family }) => ({ address, family })));
        } else {
          callback(null, records[0].address, records[0].family);
        }
      },
    },
  });

  let response;
  let reader;
  let cancellation = null;
  const cancelBestEffort = (body, reason) => {
    try {
      cancellation = Promise.resolve(body?.cancel?.(reason)).catch(() => {});
    } catch {
      cancellation = null;
    }
  };
  try {
    // redirect:"manual" prevents a public URL redirecting to a private one (SSRF bypass).
    const fetchPromise = Promise.resolve(fetch(imageUrl, {
      signal: fetchSignal,
      redirect: "manual",
      dispatcher,
    }));
    // An injected fetch implementation may ignore AbortSignal. If it resolves
    // after the deadline, discard its unread body instead of leaking it.
    fetchPromise.then(
      (lateResponse) => {
        if (fetchSignal.aborted) cancelBestEffort(lateResponse?.body, fetchSignal.reason);
      },
      () => {},
    );
    response = await awaitWithSignal(fetchPromise, fetchSignal);
    if (!response.ok || !response.body) {
      cancelBestEffort(response.body);
      return null;
    }

    // Stream-read with a hard byte cap to avoid loading huge payloads into memory.
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), fetchSignal);
      if (done) break;
      total += value.length;
      if (total > maxBytes) { cancelBestEffort(reader); return null; }
      chunks.push(value);
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const mimeType = detectImageMime(buf);
    if (!mimeType) return null; // not a recognized image — reject disguised payloads

    return { url: `data:${mimeType};base64,${buf.toString("base64")}`, mimeType };
  } catch {
    cancelBestEffort(reader || response?.body);
    return null;
  } finally {
    const release = () => {
      try { reader?.releaseLock(); } catch { /* pending read or already released */ }
    };
    release();
    cancellation?.finally(release);
    clearTimeout(timeout);
    // Never let a non-cooperative dispatcher cleanup extend the request
    // deadline. The close still runs and its eventual rejection is observed.
    try { Promise.resolve(dispatcher.close()).catch(() => {}); } catch { /* best effort */ }
  }
}
