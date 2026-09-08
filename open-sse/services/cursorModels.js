/**
 * Cursor live model catalog fetcher.
 *
 * Cursor exposes the account-specific model picker through the AgentService
 * `GetUsableModels` Connect RPC. Unlike the static provider registry, this
 * includes models newly enabled for the account and omits unavailable ones.
 */

import crypto from "crypto";
import http2 from "http2";
import { PROVIDER_OAUTH } from "../providers/index.js";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { decodeMessage } from "../utils/cursorProtobuf.js";
import {
  MODEL_CATALOG_BODY_LIMIT_BYTES,
  ModelCatalogBodyTooLargeError,
} from "./modelCatalogResponse.js";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// agent.v1.ModelDetails protobuf field numbers.
const MODEL_ID_FIELD = 1;
const DISPLAY_MODEL_ID_FIELD = 3;
const DISPLAY_NAME_FIELD = 4;
const DISPLAY_NAME_SHORT_FIELD = 5;
const RESPONSE_MODELS_FIELD = 1;

/** @type {Map<string, { expiresAt: number, models: { id: string, name: string }[] }>} */
const catalogCache = new Map();
/** @type {Map<string, { controller: AbortController, promise: Promise<object | null>, waiters: number, settled: boolean }>} */
const catalogInflight = new Map();
let catalogCacheEpoch = 0;

function callerAbortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Cursor catalog request aborted", "AbortError");
}

function awaitWithCallerSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(callerAbortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, callerAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function waitForCatalog(entry, signal) {
  entry.waiters += 1;
  try {
    return await awaitWithCallerSignal(entry.promise, signal);
  } finally {
    entry.waiters -= 1;
    if (entry.waiters === 0 && !entry.settled && !entry.controller.signal.aborted) {
      entry.controller.abort(new DOMException("Cursor catalog has no active callers", "AbortError"));
    }
  }
}

function getCursorModelsUrl() {
  const config = PROVIDER_OAUTH.cursor;
  if (!config?.agentEndpoint || !config?.modelsEndpoint) return null;
  return `${config.agentEndpoint.replace(/\/$/, "")}${config.modelsEndpoint}`;
}

function cacheKey(credentials) {
  const seed = [
    credentials?.providerSpecificData?.machineId,
    credentials?.accessToken,
  ].filter(Boolean).join(":");
  if (!seed) return "cursor-anonymous";
  return crypto.createHash("sha256").update(`cursor:${seed}`).digest("hex");
}

function firstString(fields, fieldNumber) {
  const value = fields.get(fieldNumber)?.[0]?.value;
  if (!value || typeof value === "number") return "";
  return Buffer.from(value).toString("utf8");
}

/**
 * Decode Cursor's `agent.v1.GetUsableModelsResponse` protobuf payload.
 * The response contains repeated `agent.v1.ModelDetails` messages in field 1.
 */
export function parseCursorUsableModels(payload) {
  const response = decodeMessage(payload);
  const seen = new Set();
  const models = [];

  for (const entry of response.get(RESPONSE_MODELS_FIELD) || []) {
    if (!entry?.value || typeof entry.value === "number") continue;
    const detail = decodeMessage(entry.value);
    const id = firstString(detail, MODEL_ID_FIELD).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = (
      firstString(detail, DISPLAY_NAME_FIELD)
      || firstString(detail, DISPLAY_NAME_SHORT_FIELD)
      || firstString(detail, DISPLAY_MODEL_ID_FIELD)
      || id
    ).trim();
    models.push({ id, name });
  }

  return models;
}

/**
 * agent.api5.cursor.sh is HTTP/2-only; Node fetch/undici cannot speak h2.
 * Unary GetUsableModels uses an unframed protobuf body (application/proto).
 */
function http2PostProto(url, headers, body, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = http2.connect(`https://${urlObj.host}`);
    const chunks = [];
    let totalBytes = 0;
    let responseHeaders = {};
    let settled = false;
    let req = null;
    let onAbort = null;
    let timeoutId = null;

    const finish = (fn, value, destroyTransport = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (destroyTransport) {
        try { req?.close?.(http2.constants.NGHTTP2_CANCEL); } catch {}
        try { req?.destroy?.(); } catch {}
        try { client.destroy(); } catch {}
      } else {
        try { client.close(); } catch {}
      }
      fn(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new DOMException("Cursor GetUsableModels timed out", "TimeoutError"),
        true,
      );
    }, timeoutMs);

    client.on("error", (error) => finish(reject, error, true));

    try {
      req = client.request({
        ":method": "POST",
        ":path": urlObj.pathname,
        ":authority": urlObj.host,
        ":scheme": "https",
        ...headers,
      });
    } catch (error) {
      finish(reject, error, true);
      return;
    }

    req.on("response", (hdrs) => { responseHeaders = hdrs; });
    req.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > MODEL_CATALOG_BODY_LIMIT_BYTES) {
        finish(
          reject,
          new ModelCatalogBodyTooLargeError(MODEL_CATALOG_BODY_LIMIT_BYTES, totalBytes),
          true,
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      finish(resolve, {
        status: Number(responseHeaders[":status"] || 0),
        body: Buffer.concat(chunks),
      });
    });
    req.on("error", (error) => finish(reject, error, true));

    if (signal) {
      onAbort = () => finish(
        reject,
        signal.reason ?? new DOMException("Request aborted", "AbortError"),
        true,
      );
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (!settled) {
      try {
        req.end(body && body.length ? Buffer.from(body) : undefined);
      } catch (error) {
        finish(reject, error, true);
      }
    }
  });
}

export const __test__ = { http2PostProto };

async function fetchCursorCatalog(credentials, signal, requestFn = http2PostProto) {
  const accessToken = credentials?.accessToken;
  const machineId = credentials?.providerSpecificData?.machineId;
  const url = getCursorModelsUrl();
  if (!accessToken || !machineId || !url) return null;

  const headers = {
    ...buildCursorHeaders(accessToken, machineId, credentials?.providerSpecificData?.ghostMode !== false),
    // Connect unary calls use an unframed protobuf body, unlike Cursor chat's
    // streaming `application/connect+proto` endpoint.
    accept: "application/proto",
    "content-type": "application/proto",
  };
  delete headers["connect-accept-encoding"];
  delete headers["connect-protocol-version"];

  const response = await requestFn(url, headers, new Uint8Array(), signal, FETCH_TIMEOUT_MS);
  if (response.status !== 200) {
    const error = new Error(`Cursor GetUsableModels returned ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return parseCursorUsableModels(new Uint8Array(response.body));
}

/**
 * Resolve the live Cursor catalog for the authenticated account.
 * Returns null on any failure so callers can fall back to static models.
 */
export async function resolveCursorModels(credentials, options = {}) {
  if (!credentials?.accessToken || !credentials?.providerSpecificData?.machineId) {
    options.log?.debug?.("CURSOR_MODELS", "No Cursor access token or machine ID; skipping live fetch");
    return null;
  }

  const key = cacheKey(credentials);
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached?.expiresAt > Date.now()) return { models: cached.models };
  }

  const existing = catalogInflight.get(key);
  if (existing && !existing.controller.signal.aborted && !options.forceRefresh) {
    try {
      return await waitForCatalog(existing, options.signal);
    } catch (error) {
      if (!options.signal?.aborted) {
        options.log?.warn?.("CURSOR_MODELS", "Live model fetch failed");
      }
      return null;
    }
  }

  const controller = new AbortController();
  const requestEpoch = catalogCacheEpoch;
  const entry = {
    controller,
    promise: null,
    waiters: 0,
    settled: false,
  };
  entry.promise = Promise.resolve().then(async () => {
    try {
      const models = await fetchCursorCatalog(credentials, controller.signal, options.requestFn);
      if (!models?.length) return null;
      const result = { models };
      if (
        requestEpoch === catalogCacheEpoch
        && catalogInflight.get(key) === entry
        && !controller.signal.aborted
      ) {
        catalogCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, models });
      }
      return result;
    } catch (error) {
      options.log?.warn?.("CURSOR_MODELS", "Live model fetch failed");
      return null;
    }
  });
  catalogInflight.set(key, entry);
  entry.promise.then(
    () => {
      entry.settled = true;
      if (catalogInflight.get(key) === entry) catalogInflight.delete(key);
    },
    () => {
      entry.settled = true;
      if (catalogInflight.get(key) === entry) catalogInflight.delete(key);
    },
  );

  try {
    return await waitForCatalog(entry, options.signal);
  } catch (error) {
    if (!options.signal?.aborted) {
      options.log?.warn?.("CURSOR_MODELS", "Live model fetch failed");
    }
    return null;
  }
}

export function clearCursorModelCache() {
  catalogCacheEpoch += 1;
  if (!Number.isSafeInteger(catalogCacheEpoch)) catalogCacheEpoch = 1;
  catalogCache.clear();
  catalogInflight.clear();
}
