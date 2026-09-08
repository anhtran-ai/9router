const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { DATA_DIR } = require("./paths");
const { LOG_BLACKLIST_URL_PARTS } = require("./config");

function time() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

const log = (msg) => console.log(`[${time()}] [MITM] ${msg}`);
const err = (msg) => console.error(`[${time()}] ❌ [MITM] ${msg}`);

const DUMP_DIR = path.join(DATA_DIR, "logs", "mitm");
if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });

// Clear all files inside DUMP_DIR (called on MITM server start to avoid unbounded growth)
function clearDumpDir() {
  try {
    if (!fs.existsSync(DUMP_DIR)) return;
    for (const f of fs.readdirSync(DUMP_DIR)) {
      try { fs.rmSync(path.join(DUMP_DIR, f), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

const EMPTY_BODY_RE = /^\s*(\{\s*\}|\[\s*\]|null)?\s*$/;
const MAX_DUMP_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SANITIZE_DEPTH = 20;
const MAX_SANITIZE_NODES = 20_000;
const REDACTED = "[redacted]";

function slugify(s, max = 80) {
  return String(s).replace(/[^a-zA-Z0-9]/g, "_").substring(0, max);
}

function isBlacklisted(url) {
  if (!url) return false;
  return LOG_BLACKLIST_URL_PARTS.some(part => url.includes(part));
}

function isSensitiveName(name) {
  const normalized = String(name || "")
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const parts = normalized.split(/[^a-z\d]+/).filter(Boolean);
  return parts.some((part) => [
    "auth", "authorization", "cookie", "credential", "jwt", "key",
    "passwd", "password", "secret", "session", "signature", "token",
  ].includes(part)) || ["apikey", "credential", "password", "secret", "token"]
    .some((marker) => normalized.includes(marker));
}

function sanitizeUrl(rawUrl) {
  try {
    const raw = String(rawUrl || "");
    const absolute = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw);
    const parsed = new URL(raw, "https://mitm-log.invalid");
    if (parsed.username) parsed.username = REDACTED;
    if (parsed.password) parsed.password = REDACTED;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveName(key) || key.toLowerCase() === "code") parsed.searchParams.set(key, REDACTED);
    }
    return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "[invalid-url-redacted]";
  }
}

function sanitizeText(value) {
  return String(value || "")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/(["']?(?:access[_-]?token|api[_-]?key|client[_-]?secret|authorization|cookie|password|refresh[_-]?token)["']?\s*[=:]\s*["']?)[^\s,;}"']+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => sanitizeUrl(candidate));
}

function sanitizeHeaders(headers) {
  const out = {};
  try {
    for (const [name, value] of Object.entries(headers || {})) {
      out[name] = isSensitiveName(name) ? REDACTED : sanitizeText(value);
    }
  } catch {
    return { "[headers]": "[unserializable]" };
  }
  return out;
}

function sanitizeValue(value) {
  let nodes = 0;
  const visit = (current, key, depth) => {
    nodes += 1;
    if (nodes > MAX_SANITIZE_NODES || depth > MAX_SANITIZE_DEPTH) return "[truncated]";
    if (key && isSensitiveName(key)) return REDACTED;
    if (current === null || current === undefined || typeof current === "number" || typeof current === "boolean") return current;
    if (typeof current === "string") return sanitizeText(current);
    if (Array.isArray(current)) return current.map((item) => visit(item, "", depth + 1));
    if (typeof current !== "object") return sanitizeText(current);
    const out = {};
    for (const [childKey, childValue] of Object.entries(current)) out[childKey] = visit(childValue, childKey, depth + 1);
    return out;
  };
  return visit(value, "", 0);
}

function sanitizeBodyText(text) {
  try {
    return JSON.stringify(sanitizeValue(JSON.parse(text)), null, 2);
  } catch {
    return sanitizeText(text);
  }
}

function isLikelyBinary(buffer) {
  if (!buffer?.length) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  let suspicious = 0;
  for (const byte of sample) {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte > 0x7e) suspicious += 1;
  }
  return suspicious / sample.length > 0.3;
}

// Decode body buffer based on content-encoding header
function decodeBody(buf, encoding, maxOutputLength = MAX_DUMP_BODY_BYTES) {
  if (!buf || buf.length === 0) return buf;
  const enc = (encoding || "").toLowerCase();
  try {
    const options = { maxOutputLength };
    if (enc.includes("gzip")) return zlib.gunzipSync(buf, options);
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf, options);
    if (enc.includes("deflate")) return zlib.inflateSync(buf, options);
  } catch {
    // Compressed bytes can still contain credentials and cannot be inspected
    // safely when decoding fails or exceeds maxOutputLength.
    return null;
  }
  return buf;
}

// Save raw request: method + url + headers + body
function dumpRequest(req, bodyBuffer, tag = "raw") {
  if (isBlacklisted(req.url)) return null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeUrl = sanitizeUrl(req.url);
    const slug = slugify((req.headers.host || "") + safeUrl);
    const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.req.json`);
    let parsed = null;
    const omitBody = bodyBuffer.length > MAX_DUMP_BODY_BYTES || isLikelyBinary(bodyBuffer);
    if (!omitBody) {
      try { parsed = JSON.parse(bodyBuffer.toString()); } catch { /* not JSON */ }
    }
    fs.writeFileSync(file, JSON.stringify({
      method: req.method,
      url: safeUrl,
      host: req.headers.host,
      headers: sanitizeHeaders(req.headers),
      body: omitBody
        ? "[request body omitted: binary or exceeded log limit]"
        : parsed
          ? sanitizeValue(parsed)
          : sanitizeText(bodyBuffer.toString("utf8"))
    }, null, 2));
    return file;
  } catch { return null; }
}

// Buffer-based response dumper, capped before decode and after decompression.
function createResponseDumper(req, tag = "raw", options = {}) {
  if (isBlacklisted(req.url)) return null;
  const maxBodyBytes = Number.isSafeInteger(options.maxBodyBytes) && options.maxBodyBytes > 0
    ? options.maxBodyBytes
    : MAX_DUMP_BODY_BYTES;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeUrl = sanitizeUrl(req.url);
  const slug = slugify((req.headers.host || "") + safeUrl);
  const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.res.txt`);
  let status = 0;
  let headers = {};
  const chunks = [];
  let total = 0;
  let truncated = false;
  let ended = false;
  return {
    writeHeader: (s, h) => { status = s; headers = h || {}; },
    writeChunk: (chunk) => {
      if (ended || chunk == null) return;
      const remaining = maxBodyBytes - total;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const kept = buffer.subarray(0, remaining);
      if (kept.length) chunks.push(kept);
      total += kept.length;
      if (kept.length < buffer.length) truncated = true;
    },
    end: () => {
      if (ended) return;
      ended = true;
      try {
        const raw = Buffer.concat(chunks, total);
        const enc = headers["content-encoding"] || headers["Content-Encoding"];
        const decoded = decodeBody(raw, enc, maxBodyBytes);
        const text = truncated
          ? "[response body omitted: exceeded log limit]"
          : decoded === null
            ? "[response body omitted: decode failed or exceeded log limit]"
            : sanitizeBodyText(decoded.toString("utf8"));
        // Skip empty / trivially-empty bodies
        if (EMPTY_BODY_RE.test(text)) return;
        // Strip content-encoding since body is now decoded
        const cleanHeaders = sanitizeHeaders(headers);
        delete cleanHeaders["content-encoding"];
        delete cleanHeaders["Content-Encoding"];
        const suffix = truncated ? `\n[response body truncated at ${maxBodyBytes} bytes]` : "";
        const out = `STATUS: ${status}\nHEADERS: ${JSON.stringify(cleanHeaders, null, 2)}\n---BODY---\n${text}${suffix}`;
        fs.writeFileSync(file, out);
      } catch { /* ignore */ }
      finally { chunks.length = 0; }
    },
    file
  };
}

module.exports = {
  log,
  err,
  dumpRequest,
  createResponseDumper,
  clearDumpDir,
  __test__: { MAX_DUMP_BODY_BYTES, sanitizeHeaders, sanitizeUrl, sanitizeValue },
};
