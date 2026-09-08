import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import http2 from "node:http2";
import {
  __test__,
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

const originalFetch = global.fetch;

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCalls(mock, count) {
  for (let i = 0; i < 50 && mock.mock.calls.length < count; i++) await Promise.resolve();
  expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearCursorModelCache();
    vi.restoreAllMocks();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    const requestFn = vi.fn().mockResolvedValue({
      status: 200,
      body: Buffer.from(payload),
    });
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials, { requestFn })).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials, { requestFn })).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(requestFn).toHaveBeenCalledWith(
      "https://agent.api5.cursor.sh/agent.v1.AgentService/GetUsableModels",
      expect.objectContaining({
        "content-type": "application/proto",
        accept: "application/proto",
      }),
      expect.any(Uint8Array),
      expect.any(AbortSignal),
      10_000,
    );
  });

  it("coalesces concurrent misses while one caller can abort independently", async () => {
    const pendingResponse = deferred();
    let transportSignal;
    const requestFn = vi.fn((_url, _headers, _body, signal) => {
      transportSignal = signal;
      return pendingResponse.promise;
    });
    const credentials = {
      accessToken: "cursor-shared-token",
      providerSpecificData: { machineId: "cursor-shared-machine" },
    };
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();

    const first = resolveCursorModels(credentials, { requestFn, signal: firstCaller.signal });
    const second = resolveCursorModels(credentials, { requestFn, signal: secondCaller.signal });
    await waitForCalls(requestFn, 1);
    firstCaller.abort(new DOMException("first caller left", "AbortError"));

    await expect(first).resolves.toBeNull();
    expect(transportSignal.aborted).toBe(false);
    pendingResponse.resolve({
      status: 200,
      body: Buffer.from(concat(model("cursor-shared", "Cursor Shared"))),
    });
    await expect(second).resolves.toEqual({
      models: [{ id: "cursor-shared", name: "Cursor Shared" }],
    });
    expect(requestFn).toHaveBeenCalledOnce();
  });

  it("does not let an older force refresh overwrite a newer catalog", async () => {
    const older = deferred();
    const newer = deferred();
    const requestFn = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const credentials = {
      accessToken: "cursor-order-token",
      providerSpecificData: { machineId: "cursor-order-machine" },
    };

    const olderPending = resolveCursorModels(credentials, { forceRefresh: true, requestFn });
    await waitForCalls(requestFn, 1);
    const newerPending = resolveCursorModels(credentials, { forceRefresh: true, requestFn });
    await waitForCalls(requestFn, 2);

    newer.resolve({ status: 200, body: Buffer.from(concat(model("cursor-newer", "Newer"))) });
    await expect(newerPending).resolves.toMatchObject({ models: [{ id: "cursor-newer" }] });
    older.resolve({ status: 200, body: Buffer.from(concat(model("cursor-older", "Older"))) });
    await expect(olderPending).resolves.toMatchObject({ models: [{ id: "cursor-older" }] });

    await expect(resolveCursorModels(credentials, { requestFn })).resolves.toMatchObject({
      models: [{ id: "cursor-newer" }],
    });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate a cleared cache from an in-flight request", async () => {
    const older = deferred();
    const requestFn = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({
        status: 200,
        body: Buffer.from(concat(model("cursor-after-clear", "After Clear"))),
      });
    const credentials = {
      accessToken: "cursor-clear-token",
      providerSpecificData: { machineId: "cursor-clear-machine" },
    };

    const beforeClear = resolveCursorModels(credentials, { forceRefresh: true, requestFn });
    await waitForCalls(requestFn, 1);
    clearCursorModelCache();
    older.resolve({ status: 200, body: Buffer.from(concat(model("cursor-before-clear", "Before Clear"))) });
    await expect(beforeClear).resolves.toMatchObject({ models: [{ id: "cursor-before-clear" }] });

    await expect(resolveCursorModels(credentials, { requestFn })).resolves.toMatchObject({
      models: [{ id: "cursor-after-clear" }],
    });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("fails open when the Cursor catalog request fails", async () => {
    const requestFn = vi.fn().mockResolvedValue({ status: 403, body: Buffer.from("no") });

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    }, { requestFn })).resolves.toBeNull();
  });

  it("does not log Cursor transport errors verbatim", async () => {
    const reflected = "cursor-secret-reflected-by-transport";
    const requestFn = vi.fn().mockRejectedValue(new Error(reflected));
    const log = { warn: vi.fn() };

    await expect(resolveCursorModels({
      accessToken: "cursor-secret-token",
      providerSpecificData: { machineId: "cursor-secret-machine" },
    }, { forceRefresh: true, requestFn, log })).resolves.toBeNull();

    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(reflected);
  });

  it("destroys the HTTP/2 request when the catalog exceeds 2 MiB", async () => {
    const req = new EventEmitter();
    req.end = vi.fn();
    req.close = vi.fn();
    req.destroy = vi.fn();
    const client = new EventEmitter();
    client.request = vi.fn(() => req);
    client.close = vi.fn();
    client.destroy = vi.fn();
    vi.spyOn(http2, "connect").mockReturnValue(client);

    const pending = __test__.http2PostProto(
      "https://agent.api5.cursor.sh/models",
      {},
      new Uint8Array(),
      null,
      10_000,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "ModelCatalogBodyTooLargeError",
      code: "ERR_MODEL_CATALOG_BODY_TOO_LARGE",
    });
    req.emit("response", { ":status": 200 });
    req.emit("data", Buffer.alloc(2 * 1024 * 1024 + 1));

    await rejected;
    expect(req.close).toHaveBeenCalledWith(http2.constants.NGHTTP2_CANCEL);
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("destroys HTTP/2 resources and removes the listener on caller abort", async () => {
    const req = new EventEmitter();
    req.end = vi.fn();
    req.close = vi.fn();
    req.destroy = vi.fn();
    const client = new EventEmitter();
    client.request = vi.fn(() => req);
    client.close = vi.fn();
    client.destroy = vi.fn();
    vi.spyOn(http2, "connect").mockReturnValue(client);
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");

    const pending = __test__.http2PostProto(
      "https://agent.api5.cursor.sh/models",
      {},
      new Uint8Array(),
      caller.signal,
      10_000,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    caller.abort(new DOMException("client left", "AbortError"));

    await rejected;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
