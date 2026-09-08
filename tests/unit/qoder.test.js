/**
 * Unit tests for Qoder encoding + COSY signing primitives.
 *
 * These cover the parts that would silently produce wrong-but-plausible
 * output if logic regressed:
 *   - body encoder boundary cases (empty input, lengths not divisible by 3)
 *   - COSY header production (signature deterministic given fixed inputs,
 *     all required headers present, sigPath correctly stripped)
 *   - device flow URL construction
 */

import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";

import { qoderEncodeBody } from "../../src/lib/qoder/encoding.js";
import { buildCosyHeaders } from "../../src/lib/qoder/cosy.js";
import {
  QoderService,
  QODER_OAUTH_MAX_RESPONSE_BYTES,
} from "../../src/lib/oauth/services/qoder.js";
import {
  QODER_CHAT_URL_ENCODED,
  QODER_MODEL_LIST_URL,
  QODER_MODEL_MAP,
} from "../../src/lib/qoder/constants.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { __test__ as qoderExecutorInternals } from "../../open-sse/executors/qoder.js";

// Convenience aliases — tests were originally written against module-level
// helpers; the QoderService class wraps them so each test creates its own
// instance to avoid hidden state.
const generatePkcePair = () => new QoderService().generatePkcePair();
const initiateDeviceFlow = () => new QoderService().initiateDeviceFlow();
const parseExpiry = QoderService.parseExpiry;
const QODER_FETCH_TIMEOUT_MS = 15_000;

function stalledBodyResponse(init, method) {
  const cancel = vi.fn(async () => {});
  return {
    ok: true,
    status: 200,
    body: { cancel },
    [method]: () => new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException("body stalled", "AbortError"));
      if (init.signal.aborted) onAbort();
      else init.signal.addEventListener("abort", onAbort, { once: true });
    }),
  };
}

describe("Qoder OAuth response deadlines", () => {
  it("keeps the poll deadline active while reading the token body", async () => {
    const originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    let upstream;
    try {
      globalThis.fetch = vi.fn(async (_url, init) => {
        upstream = stalledBodyResponse(init, "text");
        return upstream;
      });
      const pending = new QoderService().pollDeviceToken({
        nonce: "nonce-fixture",
        codeVerifier: "verifier-fixture",
      });
      const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(QODER_FETCH_TIMEOUT_MS);

      await rejected;
      expect(upstream.body.cancel).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("returns promptly when the optional user-info body stalls", async () => {
    const originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    let upstream;
    try {
      globalThis.fetch = vi.fn(async (_url, init) => {
        upstream = stalledBodyResponse(init, "text");
        return upstream;
      });
      const pending = new QoderService().fetchUserInfo("access-token-fixture");
      await vi.advanceTimersByTimeAsync(QODER_FETCH_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({ name: "", email: "" });
      expect(upstream.body.cancel).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("enforces the header deadline when fetch ignores AbortSignal", async () => {
    const originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(() => new Promise(() => {}));
      const pending = new QoderService().pollDeviceToken({
        nonce: "nonce-fixture",
        codeVerifier: "verifier-fixture",
      });
      const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(QODER_FETCH_TIMEOUT_MS);

      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("does not wait for a non-cooperative body read or cancellation", async () => {
    const originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise(() => {}));
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn(() => new Promise(() => {})),
      cancel,
      releaseLock,
    };
    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: {
          getReader: () => reader,
          cancel: () => { throw new TypeError("body is locked"); },
        },
      }));
      const pending = new QoderService().pollDeviceToken({
        nonce: "nonce-fixture",
        codeVerifier: "verifier-fixture",
      });
      const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });

      await vi.advanceTimersByTimeAsync(QODER_FETCH_TIMEOUT_MS);

      await rejected;
      expect(reader.read).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("does not await cancellation for a pending device authorization", async () => {
    const originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise(() => {}));
    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 202,
        headers: new Headers(),
        body: { cancel },
      }));

      await expect(new QoderService().pollDeviceToken({
        nonce: "nonce-fixture",
        codeVerifier: "verifier-fixture",
      })).resolves.toEqual({ status: "pending" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("rejects an oversized declared OAuth body without waiting for cancellation", async () => {
    const originalFetch = globalThis.fetch;
    const cancel = vi.fn(() => new Promise(() => {}));
    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          "content-length": String(QODER_OAUTH_MAX_RESPONSE_BYTES + 1),
        }),
        body: { cancel },
      }));

      await expect(new QoderService().pollDeviceToken({
        nonce: "nonce-fixture",
        codeVerifier: "verifier-fixture",
      })).rejects.toMatchObject({ code: "ERR_QODER_OAUTH_BODY_TOO_LARGE" });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects invalid UTF-8 in an otherwise valid HTTP 200 token envelope", async () => {
    const originalFetch = globalThis.fetch;
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('{"token":"dt-'),
      0xff,
      ...new TextEncoder().encode('","user_id":"fixture"}'),
    ]);
    try {
      globalThis.fetch = vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

      await expect(new QoderService().pollDeviceToken({
        nonce: "nonce-fixture",
        codeVerifier: "verifier-fixture",
      })).rejects.toBeInstanceOf(TypeError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps accepting a bounded valid token envelope", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => Response.json({
        token: "dt-valid-fixture",
        refresh_token: "refresh-fixture",
        user_id: "user-fixture",
        expires_in: 60,
      }));

      await expect(new QoderService().pollDeviceToken({
        nonce: "nonce-fixture",
        codeVerifier: "verifier-fixture",
      })).resolves.toMatchObject({
        status: "ok",
        accessToken: "dt-valid-fixture",
        userId: "user-fixture",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("QODER_MODEL_MAP", () => {
  it("allows Qoder's latest model key", () => {
    expect(QODER_MODEL_MAP.qmodel_latest).toBe("qmodel_latest");
  });

  it("exposes Qoder's latest model in the static provider catalog", () => {
    expect(PROVIDER_MODELS.qd.some((model) => model.id === "qmodel_latest")).toBe(true);
  });
});

describe("qoderEncodeBody", () => {
  it("preserves base64 length (input length divisible by 3)", () => {
    const input = Buffer.from("abcdef", "utf8"); // 6 bytes → 8 base64 chars
    const encoded = qoderEncodeBody(input);
    expect(encoded.length).toBe(8);
  });

  it("preserves base64 length (input length not divisible by 3)", () => {
    const input = Buffer.from("hello", "utf8"); // 5 bytes → 8 base64 chars (with padding)
    const encoded = qoderEncodeBody(input);
    expect(encoded.length).toBe(8);
  });

  it("handles empty input without throwing", () => {
    const encoded = qoderEncodeBody(Buffer.alloc(0));
    expect(encoded).toBe("");
  });

  it("accepts string and Buffer inputs equivalently", () => {
    const a = qoderEncodeBody("hello");
    const b = qoderEncodeBody(Buffer.from("hello", "utf8"));
    expect(a).toBe(b);
  });

  it("only emits characters from the custom alphabet", () => {
    // The custom alphabet is "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"
    // plus "$" for the padding char. If the substitution step regresses,
    // characters outside that set would leak into the output.
    const allowed = new Set(
      "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$",
    );
    const encoded = qoderEncodeBody(
      "hello world this is a longer string for testing 0123456789",
    );
    for (const ch of encoded) {
      expect(allowed.has(ch), `unexpected char in output: ${JSON.stringify(ch)}`).toBe(true);
    }
  });

  it("is deterministic for identical input", () => {
    const a = qoderEncodeBody("abc");
    const b = qoderEncodeBody("abc");
    expect(a).toBe(b);
  });

  it("produces different output for different input", () => {
    const a = qoderEncodeBody("abc");
    const b = qoderEncodeBody("xyz");
    expect(a).not.toBe(b);
  });
});

describe("generatePkcePair", () => {
  it("produces base64url-safe verifier and challenge of the right length", () => {
    const { verifier, challenge } = generatePkcePair();
    // 32 bytes → 43 base64url chars (no padding)
    expect(verifier.length).toBe(43);
    expect(challenge.length).toBe(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("verifier and challenge are different (challenge is sha256 of verifier)", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).not.toBe(challenge);
    // S256: challenge should be base64url(sha256(verifier))
    const expected = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(challenge).toBe(expected);
  });

  it("returns codeVerifier (not verifier) on the higher-level helper", () => {
    // Regression: the providers.js qoder entry once read flow.verifier (undefined)
    // because initiateDeviceFlow returns the field as `codeVerifier`.
    const flow = initiateDeviceFlow();
    expect(typeof flow.codeVerifier).toBe("string");
    expect(flow.codeVerifier.length).toBe(43);
    expect(flow.verifier).toBeUndefined();
  });
});

describe("initiateDeviceFlow", () => {
  it("produces a verification URL pointing at qoder.com/device/selectAccounts", () => {
    const flow = initiateDeviceFlow();
    expect(flow.verificationUriComplete).toMatch(
      /^https:\/\/qoder\.com\/device\/selectAccounts\?/,
    );
    expect(flow.verificationUriComplete).toContain("challenge_method=S256");
    expect(flow.verificationUriComplete).toContain(`nonce=${flow.nonce}`);
    expect(flow.verificationUriComplete).toContain(`machine_id=${flow.machineId}`);
  });

  it("returns nonce and machineId as UUIDs", () => {
    const flow = initiateDeviceFlow();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(flow.nonce).toMatch(uuidRe);
    expect(flow.machineId).toMatch(uuidRe);
  });
});

describe("buildCosyHeaders", () => {
  const creds = {
    userId: "test-user-id",
    authToken: "dt-test-token",
    name: "Test",
    email: "test@example.com",
    machineId: "fixed-machine-id",
  };

  it("produces all required Cosy-* headers", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    const required = [
      "Authorization",
      "Cosy-Key",
      "Cosy-User",
      "Cosy-Date",
      "Cosy-Version",
      "Cosy-Machineid",
      "Cosy-Machinetoken",
      "Cosy-Machinetype",
      "Cosy-Machineos",
      "Cosy-Clienttype",
      "Cosy-Clientip",
      "Cosy-Bodyhash",
      "Cosy-Bodylength",
      "Cosy-Sigpath",
      "Cosy-Data-Policy",
      "Login-Version",
      "X-Request-Id",
    ];
    for (const key of required) {
      expect(headers[key], `missing header ${key}`).toBeDefined();
    }
  });

  it("Authorization is a Bearer COSY token with payload+sig", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers.Authorization).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[a-f0-9]{32}$/);
  });

  it("Cosy-Sigpath strips the leading /algo prefix", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers["Cosy-Sigpath"]).toBe("/api/v2/model/list");
  });

  it("Cosy-Sigpath also handles the encoded chat URL", () => {
    const headers = buildCosyHeaders(Buffer.from("body", "utf8"), QODER_CHAT_URL_ENCODED, creds);
    expect(headers["Cosy-Sigpath"]).toBe(
      "/api/v2/service/pro/sse/agent_chat_generation",
    );
  });

  it("Cosy-Bodyhash is the MD5 of the request body, Cosy-Bodylength is the length", () => {
    const body = Buffer.from("hello qoder", "utf8");
    const headers = buildCosyHeaders(body, QODER_MODEL_LIST_URL, creds);
    const expectedHash = crypto.createHash("md5").update(body).digest("hex");
    expect(headers["Cosy-Bodyhash"]).toBe(expectedHash);
    expect(headers["Cosy-Bodylength"]).toBe(String(body.length));
  });

  it("empty body produces the canonical empty-MD5 hash", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers["Cosy-Bodyhash"]).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(headers["Cosy-Bodylength"]).toBe("0");
  });

  it("Cosy-Machineid + Cosy-Machinetoken match the supplied machineId", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers["Cosy-Machineid"]).toBe("fixed-machine-id");
    expect(headers["Cosy-Machinetoken"]).toBe("fixed-machine-id");
  });

  it("auto-generates a machineId when none is supplied", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, {
      ...creds,
      machineId: "",
    });
    expect(headers["Cosy-Machineid"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("throws when userId is missing", () => {
    expect(() =>
      buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, { ...creds, userId: "" }),
    ).toThrow(/user id is empty/);
  });

  it("throws when authToken is missing", () => {
    expect(() =>
      buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, { ...creds, authToken: "" }),
    ).toThrow(/auth token is empty/);
  });

  it("Cosy-User reflects the supplied userId verbatim", () => {
    const headers = buildCosyHeaders(Buffer.alloc(0), QODER_MODEL_LIST_URL, creds);
    expect(headers["Cosy-User"]).toBe("test-user-id");
  });

  it("two calls with identical inputs differ only in fields that include fresh randomness", () => {
    // The signature fingerprints a fresh AES key + UUID per call, so the
    // signature, Cosy-Key, X-Request-Id, and Cosy-Date (1s resolution)
    // can differ — but Cosy-User, Cosy-Bodyhash, Cosy-Bodylength,
    // Cosy-Sigpath, and the machineId-derived headers must be stable.
    const a = buildCosyHeaders(Buffer.from("payload", "utf8"), QODER_CHAT_URL_ENCODED, creds);
    const b = buildCosyHeaders(Buffer.from("payload", "utf8"), QODER_CHAT_URL_ENCODED, creds);
    expect(a["Cosy-User"]).toBe(b["Cosy-User"]);
    expect(a["Cosy-Bodyhash"]).toBe(b["Cosy-Bodyhash"]);
    expect(a["Cosy-Bodylength"]).toBe(b["Cosy-Bodylength"]);
    expect(a["Cosy-Sigpath"]).toBe(b["Cosy-Sigpath"]);
    expect(a["Cosy-Machineid"]).toBe(b["Cosy-Machineid"]);
    expect(a["X-Request-Id"]).not.toBe(b["X-Request-Id"]);
  });
});

describe("parseExpiry", () => {
  // Regression for review finding #2: numeric expires_at was silently
  // dropped because the function only inspected strings.
  it("accepts ms-epoch as a JSON number", () => {
    const future = Date.now() + 60_000;
    expect(parseExpiry(future, undefined)).toBe(future);
  });

  it("accepts ms-epoch as a numeric string", () => {
    const future = Date.now() + 60_000;
    expect(parseExpiry(String(future), undefined)).toBe(future);
  });

  it("accepts RFC3339 strings", () => {
    const iso = "2030-01-02T03:04:05Z";
    expect(parseExpiry(iso, undefined)).toBe(Date.parse(iso));
  });

  // Regression for review finding #5: Date.parse("2026") returns Jan 1 2026,
  // so a short numeric string like "2026" used to be interpreted as a year
  // instead of falling through to the integer-ms branch. We now try the
  // pure-numeric path first so this can't happen again.
  it("does not interpret short numeric strings as a year", () => {
    // "1700000000" (Unix seconds) should NOT come out as Date.parse("1700000000")
    const result = parseExpiry("1700000000", undefined);
    // 1.7e9 ms = 1970-01-20 — the function's contract is ms, so we expect
    // exactly that value, not a year interpretation.
    expect(result).toBe(1_700_000_000);
  });

  it("falls back to expiresInSeconds when expiresAt is missing", () => {
    const before = Date.now();
    const result = parseExpiry(undefined, 60);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before + 60_000);
    expect(result).toBeLessThanOrEqual(after + 60_000);
  });

  // Regression for review finding #7: expiresInSeconds=0 used to be treated
  // as missing and silently fabricated 30-day default. We now honor 0 as
  // "already expired".
  it("treats expires_in: 0 as already expired (now), not 30-day fallback", () => {
    const before = Date.now();
    const result = parseExpiry(undefined, 0);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it("falls back to ~30 days when both inputs are missing", () => {
    const before = Date.now();
    const result = parseExpiry(undefined, undefined);
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    // Allow a small skew to absorb test runtime.
    expect(result).toBeGreaterThanOrEqual(expected - 5_000);
    expect(result).toBeLessThanOrEqual(expected + 5_000);
  });

  it("falls back to ~30 days when both inputs are unparseable", () => {
    const before = Date.now();
    const result = parseExpiry("not-a-date", -5);
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    expect(result).toBeGreaterThanOrEqual(expected - 5_000);
    expect(result).toBeLessThanOrEqual(expected + 5_000);
  });
});

describe("normalizeMessages", () => {
  const { normalizeMessages } = qoderExecutorInternals;

  it("hoists role:system out of messages into systemText", () => {
    const result = normalizeMessages([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(result.systemText).toBe("you are helpful");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("flattens multipart text content into a string", () => {
    const result = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "part1" },
          { type: "text", text: "part2" },
        ],
      },
    ]);
    expect(result.messages[0].content).toBe("part1\npart2");
  });

  it("joins multiple system messages with a blank line", () => {
    const result = normalizeMessages([
      { role: "system", content: "rule 1" },
      { role: "system", content: "rule 2" },
      { role: "user", content: "hi" },
    ]);
    expect(result.systemText).toBe("rule 1\n\nrule 2");
  });

  it("returns empty results for empty input", () => {
    const result = normalizeMessages([]);
    expect(result.messages).toEqual([]);
    expect(result.systemText).toBe("");
  });

  it("preserves image_url blocks (http URL) instead of dropping them", () => {
    const result = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ]);
    const content = result.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toContainEqual({ type: "text", text: "describe" });
    expect(content).toContainEqual({ type: "image_url", image_url: { url: "https://example.com/a.png" } });
  });

  it("preserves base64 data: URI images (no OSS upload needed)", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    const result = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri } },
          { type: "text", text: "what color?" },
        ],
      },
    ]);
    const content = result.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "image_url", image_url: { url: dataUri } });
    expect(content.some((b) => b.type === "text" && b.text === "what color?")).toBe(true);
  });

  it("converts claude-style base64 image blocks to image_url data URIs", () => {
    const result = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
        ],
      },
    ]);
    const content = result.messages[0].content;
    expect(content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,AAAA" },
    });
  });

  it("drops image blocks with no usable url but keeps the text", () => {
    const result = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: {} },
          { type: "image", source: { type: "base64" } },
        ],
      },
    ]);
    expect(result.messages[0].content).toBe("hi");
  });
});

describe("wrapQoderSSE", () => {
  const { wrapQoderSSE } = qoderExecutorInternals;

  // Helper: build a fake Response carrying the given lines as the body.
  function makeResponse(lines, { status = 200 } = {}) {
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    return new Response(body, { status });
  }

  // Helper: drain a wrapped response into an array of decoded SSE events.
  async function drain(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    buf += decoder.decode();
    return buf;
  }

  it("reports a missing terminal instead of synthesizing success at EOF", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "hi" } }] });
    const upstream = `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`;
    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/auto");
    const out = await drain(wrapped);
    expect(out).toContain(`data: ${inner}\n\n`);
    expect(out).toContain("qoder_missing_terminal");
    expect(out).toContain("data: [DONE]\n\n");
  });

  // Regression for review finding #4: a final data: line without a trailing
  // newline used to be silently dropped from `buffer` in flush().
  it("drains a trailing partial line without a newline in flush()", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "tail" }, finish_reason: "stop" }] });
    // Note: NO trailing \n on the final line.
    const upstream = `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}`;
    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/auto");
    const out = await drain(wrapped);
    expect(out).toContain(`data: ${inner}\n\n`);
  });

  // Regression for review finding #3: chunks could leak past [DONE] when
  // the success branch had no doneEmitted guard. We synthesize an error
  // envelope (which sets doneEmitted=true) followed by a valid envelope
  // and assert the second envelope is NOT forwarded.
  it("does not forward chunks after [DONE] has been emitted", async () => {
    const errorEnv = JSON.stringify({ statusCodeValue: 500, body: "boom" });
    const validInner = JSON.stringify({ choices: [{ delta: { content: "leak" } }] });
    const validEnv = JSON.stringify({ statusCodeValue: 200, body: validInner });
    const wrapped = await wrapQoderSSE(
      makeResponse([`data: ${errorEnv}\n\ndata: ${validEnv}\n\n`]),
      "qoder/auto",
    );
    const out = await drain(wrapped);
    expect(out).not.toContain("leak");
    // Should still have a single [DONE].
    const doneCount = (out.match(/data: \[DONE\]/g) || []).length;
    expect(doneCount).toBe(1);
  });

  // Regression for review finding #6: literal newlines inside the inner
  // OpenAI body would split the SSE frame across multiple data: lines.
  // We now strip them so the frame stays a single event.
  it("strips embedded newlines from inner body before forwarding", async () => {
    const innerWithNewlines = '{"choices":[{"delta":{"content":"a\nb"}}]}';
    const env = JSON.stringify({ statusCodeValue: 200, body: innerWithNewlines });
    const wrapped = await wrapQoderSSE(makeResponse([`data: ${env}\n\n`]), "qoder/auto");
    const out = await drain(wrapped);
    // The forwarded data: line should be a single event terminated by \n\n
    // and contain no internal \n other than the trailing pair.
    const dataLine = out.split("\n\n").find((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    expect(dataLine).toBeDefined();
    // Body sans "data: " prefix should be valid JSON.
    expect(() => JSON.parse(dataLine.slice("data: ".length))).not.toThrow();
  });

  it("upstream error envelope produces a protocol error + [DONE]", async () => {
    const env = JSON.stringify({ statusCodeValue: 503, body: "service unavailable" });
    const wrapped = await wrapQoderSSE(makeResponse([`data: ${env}\n\n`]), "qoder/lite");
    const out = await drain(wrapped);
    expect(out).toContain("qoder_upstream_error");
    expect(out).not.toContain("finish_reason\":\"stop");
    expect(out).toContain("data: [DONE]\n\n");
  });

  it("closes on a terminal frame even when upstream cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const inner = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
    const envelope = JSON.stringify({ statusCodeValue: 200, body: inner });
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${envelope}\ndata: ${JSON.stringify({ statusCodeValue: 200, body: "[DONE]" })}\n\n`,
        ));
      },
      cancel,
    });

    const wrapped = await wrapQoderSSE(new Response(source), "qoder/auto");
    await expect(drain(wrapped)).resolves.toContain("data: [DONE]\n\n");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("non-ok responses are returned unchanged (no transform)", async () => {
    const r = new Response("not ok", { status: 500 });
    const wrapped = await wrapQoderSSE(r, "qoder/auto");
    expect(wrapped).toBe(r);
  });
});
