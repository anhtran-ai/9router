/**
 * `9router xai video` — generate a Grok Imagine video through the local
 * 9router gateway and save the result as an MP4 file.
 *
 * Flow: POST /v1/videos/generations → poll GET /v1/videos/{request_id}
 * until done/failed/timeout → download video.url → atomic rename.
 *
 * No OAuth tokens or Authorization headers are ever printed.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MODEL = "xai/grok-imagine-video";
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_GATEWAY_JSON_BYTES = 1024 * 1024;
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const VIDEO_DOWNLOAD_STALL_TIMEOUT_MS = 30 * 1000;

const TERMINAL_STATUSES = new Set(["done", "failed", "completed", "error", "expired", "cancelled"]);
const FAILED_STATUSES = new Set(["failed", "error", "expired", "cancelled"]);

const HELP = `
Usage: 9router xai video --prompt "..." [options]

Generate a Grok Imagine video via your local 9router gateway
(requires a connected xAI account — Grok Build OAuth or API key).

Options:
  --prompt <text>         Video description (required)
  --output <file>         Output MP4 path (default: video.mp4)
  --model <id>            Model (default: ${DEFAULT_MODEL})
  --duration <seconds>    Video duration
  --aspect-ratio <ratio>  e.g. 16:9, 9:16, 1:1
  --resolution <res>      480p | 720p | 1080p
  --image <path-or-url>   Image input for image-to-video
  --timeout <seconds>     Max total request/poll/download time (default: ${DEFAULT_TIMEOUT_SEC})
  --port <port>           Gateway port (default: ${DEFAULT_PORT})
  --host <host>           Gateway host (default: ${DEFAULT_HOST})
  --api-key <key>         9router API key (or env NINE_ROUTER_API_KEY)
  -h, --help              Show this help
`;

function sanitizeText(text) {
  return String(text ?? "").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}

function isValidRequestId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function getCreationRequestId(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const hasPrimary = body.request_id !== undefined;
  const hasAlternate = body.id !== undefined;
  if (!hasPrimary && !hasAlternate) return null;
  if (hasPrimary && !isValidRequestId(body.request_id)) return null;
  if (hasAlternate && !isValidRequestId(body.id)) return null;
  if (hasPrimary && hasAlternate && body.request_id !== body.id) return null;
  return hasPrimary ? body.request_id : body.id;
}

function parseArgs(argv) {
  const opts = {
    model: DEFAULT_MODEL,
    output: "video.mp4",
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    apiKey: process.env.NINE_ROUTER_API_KEY || null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--prompt") opts.prompt = next();
    else if (a === "--output" || a === "-o") opts.output = next();
    else if (a === "--model") opts.model = next();
    else if (a === "--duration") opts.duration = parseInt(next(), 10);
    else if (a === "--aspect-ratio") opts.aspectRatio = next();
    else if (a === "--resolution") opts.resolution = next();
    else if (a === "--image") opts.image = next();
    else if (a === "--timeout") opts.timeoutSec = parseInt(next(), 10) || DEFAULT_TIMEOUT_SEC;
    else if (a === "--port" || a === "-p") opts.port = parseInt(next(), 10) || DEFAULT_PORT;
    else if (a === "--host" || a === "-H") opts.host = next() || DEFAULT_HOST;
    else if (a === "--api-key") opts.apiKey = next();
    else if (a === "--poll-interval-ms") opts.pollIntervalMs = parseInt(next(), 10) || DEFAULT_POLL_INTERVAL_MS;
    else if (a === "-h" || a === "--help") opts.help = true;
    else {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  return opts;
}

/** Local file path → base64 data URL; URLs pass through untouched. */
function imageInputToUrl(input) {
  if (/^(https?:|data:)/i.test(input)) return input;
  const stat = fs.statSync(input);
  if (!stat.isFile()) throw new Error(`Image input is not a file: ${input}`);
  if (stat.size > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`Image input exceeds the ${MAX_IMAGE_INPUT_BYTES}-byte limit`);
  }
  const buf = fs.readFileSync(input);
  // Recheck after the read so a concurrently replaced/growing file cannot be
  // forwarded beyond the documented limit.
  if (buf.byteLength > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`Image input exceeds the ${MAX_IMAGE_INPUT_BYTES}-byte limit`);
  }
  const ext = path.extname(input).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Minimal JSON request against the local gateway. Returns { status, headers, body }. */
function gatewayRequest({
  host,
  port,
  apiKey,
  method,
  reqPath,
  body,
  signal,
  deadlineMs = null,
  extraHeaders = null,
  maxResponseBytes = MAX_GATEWAY_JSON_BYTES,
}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Accept: "application/json", ...(extraHeaders || {}) };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let req = null;
    let res = null;
    let timer = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { res?.destroy?.(); } catch { /* best-effort socket cleanup */ }
      try { req?.destroy?.(); } catch { /* best-effort socket cleanup */ }
      reject(error);
    };
    const onAbort = () => fail(
      signal?.reason instanceof Error ? signal.reason : new Error("aborted"),
    );

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    if (deadlineMs !== null) {
      const remainingMs = deadlineMs - Date.now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        fail(new Error(`Timed out waiting for ${method} ${reqPath}`));
        return;
      }
      timer = setTimeout(
        () => fail(new Error(`Timed out waiting for ${method} ${reqPath}`)),
        remainingMs,
      );
    }

    try {
      req = http.request({ hostname: host, port, path: reqPath, method, headers }, (response) => {
        res = response;
        const rawLength = Array.isArray(res.headers["content-length"])
          ? res.headers["content-length"][0]
          : res.headers["content-length"];
        if (rawLength && /^\d+$/.test(rawLength) && Number(rawLength) > maxResponseBytes) {
          fail(new Error(`Gateway JSON response exceeds the ${maxResponseBytes}-byte limit`));
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        res.on("data", (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.byteLength;
          if (totalBytes > maxResponseBytes) {
            fail(new Error(`Gateway JSON response exceeds the ${maxResponseBytes}-byte limit`));
            return;
          }
          chunks.push(bytes);
        });
        res.on("aborted", () => fail(new Error("Gateway response was interrupted")));
        res.on("error", fail);
        res.on("end", () => {
          if (settled) return;
          let data;
          try {
            const bytes = Buffer.concat(chunks, totalBytes);
            const requireValidUtf8 = Number(res.statusCode) >= 200 && Number(res.statusCode) < 300;
            data = new TextDecoder("utf-8", { fatal: requireValidUtf8 }).decode(bytes);
          } catch {
            fail(new Error("Gateway returned invalid UTF-8 in a successful JSON response"));
            return;
          }
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { /* keep raw */ }
          succeed({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
        });
      });
      req.on("error", fail);
      if (payload) req.write(payload);
      req.end();
    } catch (error) {
      fail(error);
    }
  });
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(
      reject,
      signal?.reason instanceof Error ? signal.reason : new Error("aborted"),
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(resolve), ms);
  });

/**
 * Poll GET /v1/videos/{id} until a terminal status or deadline.
 * @returns {Promise<object>} final poll body (status done) — throws on failed/timeout.
 */
async function pollUntilDone({ host, port, apiKey, requestId, connectionId, timeoutSec, pollIntervalMs, signal, onProgress, deadlineMs = null }) {
  const deadline = deadlineMs ?? (Date.now() + timeoutSec * 1000);
  while (true) {
    if (signal?.aborted) throw new Error("aborted");
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutSec}s waiting for video job ${requestId}`);
    }

    const res = await gatewayRequestWithConnection({ host, port, apiKey, requestId, connectionId, signal, deadlineMs: deadline });
    if (res.status === 200 && res.body) {
      const status = String(res.body.status || "").toLowerCase();
      onProgress?.(status || "pending", res.body.progress);
      if (FAILED_STATUSES.has(status)) {
        const msg = res.body.error?.message || res.body.error || "video generation failed";
        throw new Error(`Job ${requestId} failed: ${sanitizeText(typeof msg === "string" ? msg : JSON.stringify(msg))}`);
      }
      if (TERMINAL_STATUSES.has(status)) return res.body;
    } else if (res.status >= 400 && res.status !== 429 && res.status !== 503) {
      throw new Error(`Polling failed (HTTP ${res.status}): ${sanitizeText(res.raw?.slice(0, 300))}`);
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
  }
}

function gatewayRequestWithConnection({ host, port, apiKey, requestId, connectionId, signal, deadlineMs }) {
  return gatewayRequest({
    host,
    port,
    apiKey,
    method: "GET",
    reqPath: `/v1/videos/${encodeURIComponent(requestId)}`,
    signal,
    deadlineMs,
    extraHeaders: connectionId ? { "x-connection-id": connectionId } : null,
  });
}

/**
 * Download a URL to `outputPath` via a `.part` temp file with atomic rename.
 * The temp file is removed on any failure.
 */
async function downloadToFile(
  url,
  outputPath,
  {
    signal,
    deadlineMs = Date.now() + DEFAULT_TIMEOUT_SEC * 1000,
    maxBytes = MAX_VIDEO_DOWNLOAD_BYTES,
    stallTimeoutMs = VIDEO_DOWNLOAD_STALL_TIMEOUT_MS,
  } = {},
) {
  const partPath = `${outputPath}.part`;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) {
    throw new TypeError("stallTimeoutMs must be a positive number");
  }

  await new Promise((resolve, reject) => {
    let activeRequest = null;
    let activeResponse = null;
    let outputFd = null;
    let declaredLength = null;
    let totalBytes = 0;
    let timer = null;
    let settled = false;

    const removePartialFile = () => {
      if (outputFd !== null) {
        try { fs.closeSync(outputFd); } catch { /* already closed */ }
        outputFd = null;
      }
      try { fs.unlinkSync(partPath); } catch { /* absent */ }
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error) => {
      if (settled) return;
      // Claim settlement before destroying streams: destroy() can emit
      // `aborted`/`error` synchronously and must not replace the root cause.
      settled = true;
      cleanup();
      try { activeResponse?.destroy?.(); } catch { /* best effort */ }
      try { activeRequest?.destroy?.(); } catch { /* best effort */ }
      removePartialFile();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => fail(
      signal?.reason instanceof Error ? signal.reason : new Error("aborted"),
    );
    const armDeadline = () => {
      clearTimeout(timer);
      const remainingMs = deadlineMs - Date.now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        fail(new Error("Timed out downloading video"));
        return false;
      }
      timer = setTimeout(
        () => fail(new Error("Timed out downloading video")),
        Math.min(stallTimeoutMs, remainingMs),
      );
      timer.unref?.();
      return true;
    };
    const validateContentType = (value) => {
      const type = String(value || "").split(";", 1)[0].trim().toLowerCase();
      if (!type || type === "application/octet-stream" || type === "binary/octet-stream" ||
          type === "application/mp4" || type === "video/mp4" || type.startsWith("video/")) return;
      throw new Error(`Download returned a non-video content type: ${type}`);
    };
    const validateMp4File = () => {
      const fd = fs.openSync(partPath, "r");
      try {
        // ISO BMFF `ftyp` requires the 8-byte atom header plus a 4-byte major
        // brand and 4-byte minor version. A bare magic token is not a file.
        const header = Buffer.alloc(16);
        const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
        const firstBoxSize = bytesRead >= 4 ? header.readUInt32BE(0) : 0;
        if (bytesRead < 16 || header.toString("ascii", 4, 8) !== "ftyp" ||
            firstBoxSize < 16 || firstBoxSize > totalBytes) {
          throw new Error("Download did not contain a valid MP4 file header");
        }
      } finally {
        fs.closeSync(fd);
      }
    };
    const get = (target, redirectsLeft, priorProtocol = null) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        fail(new Error("Download URL is invalid"));
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        fail(new Error(`Download redirect uses unsupported protocol: ${parsed.protocol}`));
        return;
      }
      if (priorProtocol === "https:" && parsed.protocol !== "https:") {
        fail(new Error("Download redirect attempted to downgrade HTTPS"));
        return;
      }
      if (!armDeadline()) return;

      const mod = parsed.protocol === "https:" ? https : http;
      let req;
      try {
        req = mod.get(parsed, (res) => {
          if (settled || req !== activeRequest) {
            res.destroy();
            return;
          }
          activeResponse = res;
          if (!armDeadline()) return;

          if (res.statusCode >= 300 && res.statusCode < 400) {
            if (!res.headers.location) {
              fail(new Error(`Download redirect (HTTP ${res.statusCode}) has no Location header`));
              return;
            }
            if (redirectsLeft <= 0) {
              fail(new Error("Download exceeded the redirect limit"));
              return;
            }
            let next;
            try {
              next = new URL(res.headers.location, parsed).toString();
            } catch {
              fail(new Error("Download redirect URL is invalid"));
              return;
            }
            // A redirect body is irrelevant. Destroy it synchronously rather
            // than waiting for a peer-controlled cancel/drain operation.
            activeResponse = null;
            activeRequest = null;
            res.destroy();
            req.destroy();
            get(next, redirectsLeft - 1, parsed.protocol);
            return;
          }
          if (res.statusCode !== 200) {
            fail(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          try {
            validateContentType(res.headers["content-type"]);
          } catch (error) {
            fail(error);
            return;
          }
          const rawLength = Array.isArray(res.headers["content-length"])
            ? res.headers["content-length"][0]
            : res.headers["content-length"];
          if (rawLength && /^\d+$/.test(rawLength)) {
            declaredLength = Number(rawLength);
            if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
              fail(new Error(`Video download exceeds the ${maxBytes}-byte limit`));
              return;
            }
          }

          try {
            outputFd = fs.openSync(partPath, "w");
          } catch (error) {
            fail(error);
            return;
          }

          res.on("data", (chunk) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += bytes.byteLength;
            if (totalBytes > maxBytes) {
              fail(new Error(`Video download exceeds the ${maxBytes}-byte limit`));
              return;
            }
            try {
              fs.writeSync(outputFd, bytes);
            } catch (error) {
              fail(error);
              return;
            }
            armDeadline();
          });
          res.on("aborted", () => fail(new Error("Video download was interrupted")));
          res.on("error", fail);
          res.on("end", () => {
            if (settled) return;
            if (declaredLength !== null && totalBytes !== declaredLength) {
              fail(new Error(`Video download was truncated (expected ${declaredLength}, received ${totalBytes})`));
              return;
            }
            try {
              if (outputFd !== null) {
                fs.closeSync(outputFd);
                outputFd = null;
              }
              validateMp4File();
            } catch (error) {
              fail(error);
              return;
            }
            activeResponse = null;
            activeRequest = null;
            finish(resolve);
          });
        });
      } catch (error) {
        fail(error);
        return;
      }
      activeRequest = req;
      req.on("error", (error) => {
        if (req === activeRequest) fail(error);
      });
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    get(url, 5);
  });
  try {
    fs.renameSync(partPath, outputPath);
  } catch (error) {
    try { fs.unlinkSync(partPath); } catch { /* absent */ }
    throw error;
  }
}

async function run(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.log(HELP);
    return 1;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (!opts.prompt) {
    console.error("❌ --prompt is required");
    console.log(HELP);
    return 1;
  }

  const controller = new AbortController();
  const partPath = `${opts.output}.part`;
  const onSigint = () => {
    controller.abort();
    try { fs.unlinkSync(partPath); } catch { /* absent */ }
    console.error("\n✋ Cancelled");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    const deadlineMs = Date.now() + opts.timeoutSec * 1000;
    const body = { model: opts.model, prompt: opts.prompt };
    if (opts.duration) body.duration = opts.duration;
    if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
    if (opts.resolution) body.resolution = opts.resolution;
    if (opts.image) body.image = { url: imageInputToUrl(opts.image) };

    console.log(`🎬 Requesting video (${opts.model})…`);
    const create = await gatewayRequest({
      host: opts.host, port: opts.port, apiKey: opts.apiKey,
      method: "POST", reqPath: "/v1/videos/generations", body, signal: controller.signal, deadlineMs,
    });

    const requestId = getCreationRequestId(create.body);
    if (create.status !== 200 || !requestId) {
      const detail = create.body?.error?.message || create.body?.error || create.raw || `HTTP ${create.status}`;
      console.error(`❌ Create failed: ${sanitizeText(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)}`);
      if (create.status === 400 && /No credentials/i.test(String(detail))) {
        console.error("   Connect an xAI account first: dashboard → Providers → xAI (Grok).");
      }
      return 1;
    }

    const connectionId = create.headers["x-9router-connection-id"] || null;
    console.log(`📋 Job accepted: ${requestId}`);

    let lastLine = "";
    const result = await pollUntilDone({
      host: opts.host, port: opts.port, apiKey: opts.apiKey,
      requestId, connectionId,
      timeoutSec: opts.timeoutSec, pollIntervalMs: opts.pollIntervalMs,
      signal: controller.signal,
      deadlineMs,
      onProgress: (status, progress) => {
        const line = `⏳ ${status}${Number.isFinite(progress) ? ` ${progress}%` : ""}`;
        if (line !== lastLine) {
          lastLine = line;
          if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${line}`);
          else console.log(line);
        }
      },
    });
    if (process.stdout.isTTY) process.stdout.write("\n");

    const videoUrl = result.video?.url || result.video?.file_output?.public_url;
    if (!videoUrl) {
      console.error("❌ Job finished but no video URL was returned");
      return 1;
    }

    console.log("⬇️  Downloading…");
    await downloadToFile(videoUrl, opts.output, { signal: controller.signal, deadlineMs });
    console.log(`✅ Saved ${opts.output}`);
    return 0;
  } catch (err) {
    if (process.stdout.isTTY) process.stdout.write("\n");
    console.error(`❌ ${sanitizeText(err?.message || String(err))}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

module.exports = {
  run,
  parseArgs,
  pollUntilDone,
  downloadToFile,
  imageInputToUrl,
  sanitizeText,
  MAX_GATEWAY_JSON_BYTES,
  MAX_IMAGE_INPUT_BYTES,
  MAX_VIDEO_DOWNLOAD_BYTES,
  VIDEO_DOWNLOAD_STALL_TIMEOUT_MS,
};
