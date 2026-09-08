// Check if running in Node.js environment (has fs module)
const isNode = typeof process !== "undefined" && process.versions?.node && typeof window === "undefined";

// Check if logging is enabled via environment variable (default: false)
const LOGGING_ENABLED = typeof process !== "undefined" && process.env?.ENABLE_REQUEST_LOGS === 'true';

let fs = null;
let path = null;
let LOGS_DIR = null;

// Lazy load Node.js modules (avoid top-level await)
async function ensureNodeModules() {
  if (!isNode || !LOGGING_ENABLED || fs) return;
  try {
    fs = await import("fs");
    path = await import("path");
    LOGS_DIR = path.join(typeof process !== "undefined" && process.cwd ? process.cwd() : ".", "logs");
  } catch {
    // Running in non-Node environment (Worker, Browser, etc.)
  }
}

// Format timestamp for folder name: 20251228_143045_123
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}_${h}${min}${s}_${ms}`;
}

const LOG_SEGMENT_MAX_LENGTH = 64;
const LOG_SESSION_COLLISION_LIMIT = 1_000;

// Keep every user-influenced component a single cross-platform basename.
// Forward slashes were already replaced, but backslashes remain separators on
// Windows and allowed a model such as `..\\..\\..\\outside` to escape logs/.
export function sanitizeLogPathSegment(value, fallback = "unknown") {
  const sanitized = String(value || fallback)
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, LOG_SEGMENT_MAX_LENGTH);
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : fallback;
}

// Create log session folder: {sourceFormat}_{targetFormat}_{model}_{timestamp}
async function createLogSession(sourceFormat, targetFormat, model) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) return null;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const timestamp = formatTimestamp();
    const safeSource = sanitizeLogPathSegment(sourceFormat);
    const safeTarget = sanitizeLogPathSegment(targetFormat);
    const safeModel = sanitizeLogPathSegment(model);
    const folderName = `${safeSource}_${safeTarget}_${safeModel}_${timestamp}`;
    const logsRoot = path.resolve(LOGS_DIR);
    let sessionPath = null;
    for (let attempt = 0; attempt < LOG_SESSION_COLLISION_LIMIT; attempt++) {
      const suffix = attempt === 0 ? "" : `_${attempt}`;
      const candidate = path.resolve(logsRoot, `${folderName}${suffix}`);
      const relative = path.relative(logsRoot, candidate);
      if (
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      ) {
        throw new Error("Unsafe request-log session path");
      }
      try {
        // Exclusive creation prevents concurrent requests in the same
        // millisecond from sharing and overwriting a session directory.
        fs.mkdirSync(candidate, { recursive: false });
        sessionPath = candidate;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (!sessionPath) throw new Error("Request-log session collision limit exceeded");
    
    return sessionPath;
  } catch (err) {
    console.log("[LOG] Failed to create log session:", err.message);
    return null;
  }
}

// Write JSON file
function writeJsonFile(sessionPath, filename, data) {
  if (!fs || !sessionPath) return;
  
  try {
    const filePath = path.join(sessionPath, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log(`[LOG] Failed to write ${filename}:`, err.message);
  }
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "set-cookie",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
  "x-key",
  "xi-api-key",
  "x-subscription-token",
]);

function sensitiveNameParts(name) {
  const normalized = String(name)
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return {
    normalized,
    parts: normalized.split(/[^a-z\d]+/).filter(Boolean),
  };
}

function isSensitiveName(name) {
  const { normalized, parts } = sensitiveNameParts(name);
  if (SENSITIVE_HEADER_NAMES.has(normalized)) return true;
  const sensitiveParts = new Set([
    "auth",
    "authentication",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "jwt",
    "key",
    "passwd",
    "password",
    "secret",
    "session",
    "sig",
    "signature",
    "token",
  ]);
  return parts.some((part) => sensitiveParts.has(part))
    || ["token", "secret", "password", "credential", "apikey", "jwt"]
      .some((marker) => normalized.includes(marker))
    || /(?:^|[^a-z])auth(?:$|[^a-z])/.test(normalized)
    || normalized.endsWith("auth");
}

function isSensitiveHeaderName(name) {
  return isSensitiveName(name);
}

// Always remove full credential values before persisting request/response logs.
export function maskSensitiveHeaders(headers) {
  if (!headers) return {};
  try {
    let entries;
    if (typeof headers.entries === "function") entries = Array.from(headers.entries());
    else if (Array.isArray(headers)) entries = headers;
    else entries = Object.entries(headers);

    return Object.fromEntries(entries.map(([name, value]) => [
      name,
      isSensitiveHeaderName(name) ? "[redacted]" : value,
    ]));
  } catch {
    // Logging is observational and must never break a request because an
    // adapter supplied a proxy/getter-backed headers object.
    return { "[headers]": "[unserializable]" };
  }
}

function isSensitiveQueryName(name) {
  return isSensitiveName(name) || String(name).toLowerCase() === "code";
}

// Provider URLs can contain credentials (for example Vertex's ?key=...).
// Preserve routing information while removing userinfo and sensitive query values.
export function sanitizeUrl(url) {
  if (url === null || url === undefined) return url;
  try {
    const raw = String(url);
    const isAbsolute = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw);
    const parsed = new URL(raw, "http://request-log.invalid");
    if (parsed.username) parsed.username = "[redacted]";
    if (parsed.password) parsed.password = "[redacted]";
    const sensitiveKeys = new Set();
    for (const key of parsed.searchParams.keys()) {
      if (isSensitiveQueryName(key)) sensitiveKeys.add(key);
    }
    for (const key of sensitiveKeys) parsed.searchParams.set(key, "[redacted]");
    return isAbsolute
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // Never fail open: a malformed provider URL may itself contain userinfo or
    // query credentials, and retaining the raw value would persist the secret.
    return "[invalid-url-redacted]";
  }
}

const REDACTED_VALUE = "[redacted]";
const BINARY_VALUE = "[binary payload omitted]";
const TRUNCATED_VALUE = "[log value truncated]";
const MAX_LOG_VALUE_DEPTH = 20;
const MAX_LOG_VALUE_NODES = 20_000;

function isUrlFieldName(name) {
  const { normalized, parts } = sensitiveNameParts(name);
  return normalized === "url" || normalized === "uri" || normalized === "endpoint"
    || normalized.endsWith("-url") || normalized.endsWith("-uri")
    || parts.at(-1) === "url" || parts.at(-1) === "uri";
}

function binaryLength(value) {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.byteLength;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return value.byteLength;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return null;
}

// Recursively redact structured credentials before anything reaches
// JSON.stringify. This covers hosted MCP authorization/headers, OAuth-shaped
// response bodies, query credentials in nested URLs, cycles/deep inputs, and
// binary transports such as Windsurf protobuf where an API key is embedded in
// the payload bytes and cannot be safely inspected field-by-field.
export function sanitizeLogValue(value) {
  const seen = new WeakSet();
  let nodes = 0;

  const visit = (current, key = "", depth = 0) => {
    try {
      nodes += 1;
      if (nodes > MAX_LOG_VALUE_NODES || depth > MAX_LOG_VALUE_DEPTH) return TRUNCATED_VALUE;
      if (key && isSensitiveName(key)) return REDACTED_VALUE;
      if (current === null || current === undefined) return current;

      if (typeof current === "string") {
        if (key && isUrlFieldName(key)) return sanitizeUrl(current);
        const trimmed = current.trim();
        if ((trimmed.startsWith("{") && trimmed.endsWith("}"))
          || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
          try {
            return JSON.stringify(visit(JSON.parse(current), "", depth + 1));
          } catch { /* sanitize as opaque text below */ }
        }
        return sanitizeLogText(current);
      }
      if (typeof current === "number" || typeof current === "boolean") return current;
      if (typeof current === "bigint") return current.toString();
      if (typeof current !== "object") return String(current);

      const bytes = binaryLength(current);
      if (bytes !== null) return `${BINARY_VALUE} (${bytes} bytes)`;
      if (current instanceof URL) return sanitizeUrl(current.toString());
      if (current instanceof Date) return current.toISOString();
      if (typeof Headers !== "undefined" && current instanceof Headers) {
        return maskSensitiveHeaders(current);
      }
      if (typeof URLSearchParams !== "undefined" && current instanceof URLSearchParams) {
        const params = Object.create(null);
        for (const [name, item] of current.entries()) {
          const sanitized = visit(item, name, depth + 1);
          if (params[name] === undefined) params[name] = sanitized;
          else if (Array.isArray(params[name])) params[name].push(sanitized);
          else params[name] = [params[name], sanitized];
        }
        return params;
      }
      if (seen.has(current)) return "[circular]";
      seen.add(current);

      if (Array.isArray(current)) {
        return current.map((item) => visit(item, "", depth + 1));
      }

      if (current instanceof Map) {
        const sanitizedMap = Object.create(null);
        for (const [mapKey, item] of current.entries()) {
          const name = String(mapKey);
          sanitizedMap[name] = visit(item, name, depth + 1);
        }
        return sanitizedMap;
      }

      const descriptors = Object.getOwnPropertyDescriptors(current);
      const sanitized = Object.create(null);
      for (const [name, descriptor] of Object.entries(descriptors)) {
        sanitized[name] = "value" in descriptor
          ? visit(descriptor.value, name, depth + 1)
          : (isSensitiveName(name) ? REDACTED_VALUE : "[accessor omitted]");
      }
      return sanitized;
    } catch {
      return "[unserializable]";
    }
  };

  return visit(value);
}

export function sanitizeLogText(value) {
  if (value === null || value === undefined) return value;
  try {
    const bytes = binaryLength(value);
    if (bytes !== null) return `${BINARY_VALUE} (${bytes} bytes)`;
    return String(value)
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
      .replace(
        /((?:[a-z\d_-]*(?:token|secret|passwd|password|credential|cookie|session|api[_-]?key|authorization|signature|jwt)[a-z\d_-]*)["']?\s*[:=]\s*["']?)([^"'\s&,};]+)/gi,
        "$1[redacted]",
      )
      .replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => sanitizeUrl(candidate));
  } catch {
    return "[unserializable]";
  }
}

// No-op logger when logging is disabled
function createNoOpLogger() {
  return {
    sessionPath: null,
    logClientRawRequest() {},
    logRawRequest() {},
    logOpenAIRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    appendProviderChunk() {},
    appendOpenAIChunk() {},
    logConvertedResponse() {},
    appendConvertedChunk() {},
    logError() {}
  };
}

/**
 * Create a new log session and return logger functions
 * @param {string} sourceFormat - Source format from client (claude, openai, etc.)
 * @param {string} targetFormat - Target format to provider (antigravity, gemini-cli, etc.)
 * @param {string} model - Model name
 * @returns {Promise<object>} Promise that resolves to logger object with methods to log each stage
 */
export async function createRequestLogger(sourceFormat, targetFormat, model) {
  // Return no-op logger if logging is disabled
  if (!LOGGING_ENABLED) {
    return createNoOpLogger();
  }
  
  // Wait for session to be created before returning logger
  const sessionPath = await createLogSession(sourceFormat, targetFormat, model);
  const omittedStreamLogs = new Set();

  // A secret may be split across arbitrary transport chunks (for example
  // `access_` then `token=...`), so no per-chunk regex can redact reliably.
  // Persist only one marker per stream and keep the raw frames out of logs.
  const appendOmittedStream = (filename) => {
    if (!fs || !sessionPath || omittedStreamLogs.has(filename)) return;
    try {
      const filePath = path.join(sessionPath, filename);
      fs.appendFileSync(filePath, "[stream content omitted to prevent credential disclosure]\n");
      omittedStreamLogs.add(filename);
    } catch {
      // Ignore append errors
    }
  };
  
  return {
    get sessionPath() { return sessionPath; },
    
    // 1. Log client raw request (before any conversion)
    logClientRawRequest(endpoint, body, headers = {}) {
      writeJsonFile(sessionPath, "1_req_client.json", {
        timestamp: new Date().toISOString(),
        endpoint: sanitizeUrl(endpoint),
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      });
    },
    
    // 2. Log raw request from client (after initial conversion like responsesApi)
    logRawRequest(body, headers = {}) {
      writeJsonFile(sessionPath, "2_req_source.json", {
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      });
    },
    
    // 3. Log OpenAI intermediate format (source → openai)
    logOpenAIRequest(body) {
      writeJsonFile(sessionPath, "3_req_openai.json", {
        timestamp: new Date().toISOString(),
        body: sanitizeLogValue(body)
      });
    },
    
    // 4. Log target format request (openai → target)
    logTargetRequest(url, headers, body) {
      writeJsonFile(sessionPath, "4_req_target.json", {
        timestamp: new Date().toISOString(),
        url: sanitizeUrl(url),
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      });
    },
    
    // 5. Log provider response (for non-streaming or error)
    logProviderResponse(status, statusText, headers, body) {
      const filename = "5_res_provider.json";
      writeJsonFile(sessionPath, filename, {
        timestamp: new Date().toISOString(),
        status,
        statusText: sanitizeLogText(statusText),
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      });
    },
    
    // 5. Append streaming chunk to provider response
    appendProviderChunk(_chunk) {
      appendOmittedStream("5_res_provider.txt");
    },
    
    // 6. Append OpenAI intermediate chunks (target → openai)
    appendOpenAIChunk(_chunk) {
      appendOmittedStream("6_res_openai.txt");
    },
    
    // 7. Log converted response to client (for non-streaming)
    logConvertedResponse(body) {
      writeJsonFile(sessionPath, "7_res_client.json", {
        timestamp: new Date().toISOString(),
        body: sanitizeLogValue(body)
      });
    },
    
    // 7. Append streaming chunk to converted response
    appendConvertedChunk(_chunk) {
      appendOmittedStream("7_res_client.txt");
    },
    
    // 6. Log error
    logError(error, requestBody = null) {
      writeJsonFile(sessionPath, "6_error.json", {
        timestamp: new Date().toISOString(),
        error: sanitizeLogText(error?.message || String(error)),
        stack: sanitizeLogText(error?.stack),
        requestBody: sanitizeLogValue(requestBody)
      });
    }
  };
}

// Legacy functions for backward compatibility
export function logRequest() {}
export function logResponse() {}
export function logError(provider, { error, url, model, requestBody }) {
  if (!fs || !LOGS_DIR) return;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const date = new Date().toISOString().split("T")[0];
    const logsRoot = path.resolve(LOGS_DIR);
    const safeProvider = sanitizeLogPathSegment(provider);
    const logPath = path.resolve(logsRoot, `${safeProvider}-${date}.log`);
    const relative = path.relative(logsRoot, logPath);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("Unsafe request-log path");
    }
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "error",
      provider: sanitizeLogText(provider),
      model: sanitizeLogText(model),
      url: sanitizeUrl(url),
      error: sanitizeLogText(error?.message || String(error)),
      stack: sanitizeLogText(error?.stack),
      requestBody: sanitizeLogValue(requestBody)
    };
    
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
  } catch (err) {
    console.log("[LOG] Failed to write error log:", err.message);
  }
}
