"use server";

import { NextResponse } from "next/server";
import { assertPublicUrl, fetchPublic } from "@/shared/utils/ssrfGuard.js";
import { isLocalRequest } from "@/dashboardGuard";

const TIMEOUT_MS = 8000;
const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024;

function discardResponseBody(response) {
  if (!response?.body || response.bodyUsed === true) return;
  try {
    const cancellation = response.body.cancel();
    cancellation?.catch?.(() => {});
  } catch { /* best-effort connection release */ }
}

function cancelReader(reader) {
  let cancellation;
  try {
    cancellation = reader.cancel();
  } catch {
    releaseReader(reader);
    return;
  }
  Promise.resolve(cancellation).catch(() => {}).finally(() => releaseReader(reader));
}

function releaseReader(reader) {
  try { reader.releaseLock?.(); } catch { /* a pending read releases after cancellation settles */ }
}

function runWithSignal(operation, signal) {
  const getAbortReason = () => signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Request aborted", "AbortError");
  if (signal.aborted) return Promise.reject(getAbortReason());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, getAbortReason());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function readMcpMessage(response, expectedId, signal) {
  let parsed;
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const contentType = response.headers?.get?.("content-type") || "";
    const isEventStream = contentType.toLowerCase().includes("text/event-stream");
    let total = 0;
    let reachedEof = false;
    let pendingText = "";
    let eventDataLines = [];

    const parseCompleteJson = (text) => {
      if (!text.trim()) return { complete: false };
      try {
        return { complete: true, value: JSON.parse(text) };
      } catch {
        return { complete: false };
      }
    };

    const finishEvent = () => {
      if (eventDataLines.length === 0) return undefined;
      const data = eventDataLines.join("\n");
      eventDataLines = [];
      if (!data || data === "[DONE]") return undefined;
      try {
        const candidate = JSON.parse(data);
        return String(candidate?.id) === String(expectedId) ? candidate : undefined;
      } catch {
        return undefined;
      }
    };

    const consumeEventStream = (text, flush = false) => {
      pendingText += text;
      while (true) {
        const newlineIndex = pendingText.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = pendingText.slice(0, newlineIndex);
        pendingText = pendingText.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const candidate = finishEvent();
          if (candidate !== undefined) return candidate;
        } else if (line === "data") {
          eventDataLines.push("");
        } else if (line.startsWith("data:")) {
          let data = line.slice(5);
          if (data.startsWith(" ")) data = data.slice(1);
          eventDataLines.push(data);
        }
      }

      if (flush) {
        let line = pendingText;
        pendingText = "";
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          return finishEvent();
        }
        if (line === "data") {
          eventDataLines.push("");
        } else if (line.startsWith("data:")) {
          let data = line.slice(5);
          if (data.startsWith(" ")) data = data.slice(1);
          eventDataLines.push(data);
        }
        return finishEvent();
      }
      return undefined;
    };

    try {
      while (true) {
        const { done, value } = await runWithSignal(() => reader.read(), signal);
        if (done) {
          reachedEof = true;
          const finalText = decoder.decode();
          if (isEventStream) {
            return consumeEventStream(finalText, true) ?? null;
          }
          pendingText += finalText;
          const result = parseCompleteJson(pendingText);
          return result.complete ? result.value : null;
        }
        total += value.byteLength;
        if (total > MAX_MCP_RESPONSE_BYTES) {
          throw new Error("MCP response body is too large");
        }
        const text = decoder.decode(value, { stream: true });
        if (isEventStream) {
          const candidate = consumeEventStream(text);
          if (candidate !== undefined) return candidate;
        } else {
          pendingText += text;
          const result = parseCompleteJson(pendingText);
          if (result.complete) return result.value;
        }
      }
    } finally {
      if (!reachedEof) cancelReader(reader);
      releaseReader(reader);
    }
  } else if (typeof response?.text === "function") {
    const text = await runWithSignal(() => response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > MAX_MCP_RESPONSE_BYTES) {
      throw new Error("MCP response body is too large");
    }
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  } else if (typeof response?.json === "function") {
    parsed = await runWithSignal(() => response.json(), signal);
  }
  return parsed;
}

// Probe MCP server: initialize + tools/list. No auth header — works for authless servers.
// OAuth servers return 401, signal client to skip tool listing.
async function probeMcp(url, fetchImpl = fetch) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let activeResponse;
  try {
    // Step 1: initialize
    const initRes = activeResponse = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "9router", version: "1" } },
      }),
      signal: ac.signal,
    });
    if (initRes.status === 401 || initRes.status === 403) {
      discardResponseBody(initRes);
      activeResponse = null;
      return { requiresAuth: true, tools: [] };
    }
    if (!initRes.ok) {
      discardResponseBody(initRes);
      activeResponse = null;
      return { error: `init ${initRes.status}`, tools: [] };
    }
    const sessionId = initRes.headers.get("mcp-session-id") || "";
    const initMessage = await readMcpMessage(initRes, 1, ac.signal);
    activeResponse = null;
    if (String(initMessage?.id) !== "1" || !initMessage?.result) {
      return { error: "invalid initialize response", tools: [] };
    }

    const listHeaders = { ...headers };
    if (sessionId) listHeaders["mcp-session-id"] = sessionId;

    // Step 2: notifications/initialized (required by spec before tools/list)
    try {
      const notifyRes = activeResponse = await fetchImpl(url, {
        method: "POST",
        headers: listHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        signal: ac.signal,
      });
      discardResponseBody(notifyRes);
      activeResponse = null;
    } catch { /* notification failure is non-fatal */ }

    // Step 3: tools/list
    const listRes = activeResponse = await fetchImpl(url, {
      method: "POST",
      headers: listHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      signal: ac.signal,
    });
    if (listRes.status === 401 || listRes.status === 403) {
      discardResponseBody(listRes);
      activeResponse = null;
      return { requiresAuth: true, tools: [] };
    }
    const parsed = await readMcpMessage(listRes, 2, ac.signal);
    activeResponse = null;
    const tools = parsed?.result?.tools || [];
    return {
      tools: tools.map((t) => ({ name: t.name, description: t.description || "" })),
    };
  } catch (e) {
    discardResponseBody(activeResponse);
    return {
      error: ac.signal.aborted || e.name === "AbortError" ? "timeout" : e.message,
      tools: [],
      blocked: String(e?.message || "").startsWith("Blocked URL:"),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request) {
  try {
    const { url } = await request.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "url required" }, { status: 400 });
    }
    // SSRF guard for remote callers; local host keeps self-hosted MCP servers.
    const isRemote = !isLocalRequest(request);
    if (isRemote) {
      try {
        // Keep DNS resolution inside probeMcp's deadline. fetchPublic performs
        // the async validation and pins the validated address before connect.
        assertPublicUrl(url);
      } catch {
        return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
      }
    }
    const result = await probeMcp(url, isRemote ? fetchPublic : fetch);
    if (result.blocked) {
      return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
    }
    delete result.blocked;
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e.message, tools: [] }, { status: 500 });
  }
}
