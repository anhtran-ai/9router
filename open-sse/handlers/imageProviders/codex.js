// Codex (ChatGPT Plus/Pro) image generation via Responses API + SSE
import { randomUUID } from "node:crypto";
import {
  cancelResponseBody,
  imageClientAbortError,
  nowSec,
} from "./_base.js";
import { awaitWithSignal, throwIfAborted } from "../../utils/abort.js";
import { PROVIDERS } from "../../config/providers.js";

const CODEX_RESPONSES_URL = PROVIDERS.codex.baseUrl;
const CODEX_USER_AGENT = "codex_cli_rs/0.136.0";
const CODEX_VERSION = "0.136.0";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_MODEL_SUFFIX = "-image";
const CODEX_REF_DETAIL = "high";

function decodeAccountId(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

function stripImageSuffix(model) {
  return model.endsWith(CODEX_MODEL_SUFFIX) ? model.slice(0, -CODEX_MODEL_SUFFIX.length) : model;
}

function toDataUrl(input) {
  if (!input || typeof input !== "string") return null;
  if (/^data:image\//i.test(input) || /^https?:\/\//i.test(input)) return input;
  return `data:image/png;base64,${input}`;
}

function buildContent(prompt, refs, detail = CODEX_REF_DETAIL) {
  const content = [];
  refs.forEach((url, index) => {
    content.push({ type: "input_text", text: `<image name=image${index + 1}>` });
    content.push({ type: "input_image", image_url: url, detail });
    content.push({ type: "input_text", text: "</image>" });
  });
  content.push({ type: "input_text", text: prompt });
  return content;
}

function extractCompletedImage(data) {
  const outputs = data?.response?.output || data?.output;
  if (!Array.isArray(outputs)) return null;
  for (const item of outputs) {
    if (item?.type === "image_generation_call" && item.result) return item.result;
  }
  return null;
}

function upstreamFailure(data, fallback) {
  return data?.error?.message || data?.response?.error?.message || data?.message || fallback;
}

function parseEventBlock(block, state, log, callbacks) {
  const lines = block.replace(/\r/g, "").split("\n");
  let eventName = null;
  const dataParts = [];
  for (const line of lines) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
  }
  if (!eventName) return null;

  state.events++;
  if (state.events > state.maxEvents) {
    throw new Error(`Codex image stream exceeds ${state.maxEvents} event limit`);
  }

  if (eventName !== state.lastEvent) {
    log?.info?.("IMAGE", `codex progress: ${eventName}`);
    state.lastEvent = eventName;
  }

  const now = Date.now();
  if (callbacks.onProgress && now - state.lastProgressLogMs > 200) {
    state.lastProgressLogMs = now;
    callbacks.onProgress({ stage: eventName, bytesReceived: state.bytesReceived });
  }

  const dataStr = dataParts.join("\n");
  let data = null;
  let invalidJson = false;
  if (dataStr) {
    try { data = JSON.parse(dataStr); } catch { invalidJson = true; }
  }

  const isTerminal = eventName === "response.output_item.done" ||
    eventName === "response.completed" ||
    eventName === "response.failed" ||
    eventName === "response.incomplete" ||
    eventName === "error";
  if (invalidJson && isTerminal) {
    throw new Error(`Codex returned malformed JSON for terminal event ${eventName}`);
  }

  if (eventName === "response.image_generation_call.partial_image" && data?.partial_image_b64) {
    callbacks.onPartialImage?.({
      b64_json: data.partial_image_b64,
      index: data.partial_image_index,
    });
  }

  if (eventName === "response.output_item.done") {
    const item = data?.item;
    if (item?.type === "image_generation_call" && item.result) {
      return { terminal: true, imageB64: item.result };
    }
  }

  if (eventName === "error" || eventName === "response.failed" || eventName === "response.incomplete") {
    throw new Error(upstreamFailure(data, `Codex image stream ended with ${eventName}`));
  }

  if (eventName === "response.completed") {
    return { terminal: true, imageB64: extractCompletedImage(data) };
  }
  return null;
}

function requireEventStream(response) {
  const contentType = String(response?.headers?.get?.("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "text/event-stream") {
    cancelResponseBody(response);
    const shown = contentType || "missing";
    throw new Error(`Codex returned unexpected Content-Type '${shown}'; expected text/event-stream`);
  }
}

// Incremental parser shared by collection and downstream streaming. next()
// reads only until one SSE block is available, so the streaming wrapper can
// obey downstream demand without filling its queue with partial images.
function createStreamParser(response, log, { signal, maxBytes, maxEvents }) {
  throwIfAborted(signal);
  if (!response?.body) throw new Error("Codex returned an empty image stream");

  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelResponseBody(response);
    throw new Error(`Codex image stream exceeds ${maxBytes} byte limit`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let reachedEnd = false;
  let cancelStarted = false;
  let released = false;
  const state = {
    bytesReceived: 0,
    events: 0,
    maxEvents,
    lastEvent: null,
    lastProgressLogMs: 0,
  };

  const release = () => {
    if (released) return;
    try {
      reader.releaseLock();
      released = true;
    } catch { /* a pending read is released after cancel settles */ }
  };

  const cancel = (reason = signal?.reason || "Codex image parser finished") => {
    buffer = "";
    if (!reachedEnd && !cancelStarted) {
      cancelStarted = true;
      try {
        const cancellation = Promise.resolve(reader.cancel(reason)).catch(() => {});
        cancellation.finally(release);
      } catch { /* best effort */ }
    }
    release();
  };

  const next = async (callbacks = {}) => {
    try {
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (match) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          return { done: false, terminal: parseEventBlock(block, state, log, callbacks) };
        }

        if (reachedEnd) {
          if (buffer.trim()) {
            const block = buffer;
            buffer = "";
            return { done: false, terminal: parseEventBlock(block, state, log, callbacks) };
          }
          return { done: true, terminal: null };
        }

        const { done, value } = await awaitWithSignal(reader.read(), signal);
        if (done) {
          reachedEnd = true;
          buffer += decoder.decode();
          release();
          continue;
        }
        state.bytesReceived += value?.byteLength || 0;
        if (state.bytesReceived > maxBytes) {
          throw new Error(`Codex image stream exceeds ${maxBytes} byte limit`);
        }
        buffer += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      cancel(error);
      throw error;
    }
  };

  return { next, cancel };
}

// Parse Codex SSE stream → final base64 image. Stops and cancels upstream as
// soon as a terminal event arrives; it never waits for a socket EOF afterward.
async function parseStream(response, log, callbacks = {}) {
  const parser = createStreamParser(response, log, callbacks);
  try {
    while (true) {
      const item = await parser.next(callbacks);
      if (item.done) return null;
      if (item.terminal) return item.terminal.imageB64 || null;
    }
  } finally {
    parser.cancel(callbacks.signal?.reason || "terminal event received");
  }
}

function encodeSse(event, data) {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Pull-driven SSE bridge. highWaterMark=0 means no upstream read happens until
// the client asks for data, and each pull enqueues at most one output event.
function buildSseResponse(providerResponse, log, onSuccess, lifecycle) {
  const parser = createStreamParser(providerResponse, log, {
    signal: lifecycle.signal,
    maxBytes: lifecycle.maxResponseBytes,
    maxEvents: lifecycle.maxSseEvents,
  });
  const pending = [];
  let cancelled = false;
  let finished = false;
  let terminal = false;
  let pulling = false;
  let controllerRef = null;

  const cleanup = () => {
    lifecycle.signal?.removeEventListener("abort", onAbort);
  };
  const finish = (controller) => {
    if (finished) return;
    finished = true;
    cleanup();
    parser.cancel("Codex downstream stream finished");
    lifecycle.finishOperation();
    if (!cancelled) {
      try { controller.close(); } catch { /* client already cancelled */ }
    }
  };
  const onAbort = () => {
    pending.length = 0;
    terminal = true;
    parser.cancel(lifecycle.signal?.reason);
    lifecycle.finishOperation();
    if (!pulling && !finished && !cancelled && controllerRef) {
      finished = true;
      cleanup();
      try { controllerRef.error(lifecycle.signal.reason); } catch { /* already closed */ }
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      if (lifecycle.signal?.aborted) onAbort();
      else lifecycle.signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (finished || cancelled) return;
      pulling = true;
      try {
        while (pending.length === 0 && !terminal) {
          const item = await parser.next({
            onProgress: (info) => pending.push(["progress", info]),
            onPartialImage: (info) => pending.push(["partial_image", info]),
          });
          if (item.done) {
            terminal = true;
            pending.push(["error", {
              message: "Codex did not return an image. Account may not be entitled (Plus/Pro required).",
            }]);
          } else if (item.terminal) {
            terminal = true;
            parser.cancel("terminal event received");
            const b64 = item.terminal.imageB64;
            if (!b64) {
              pending.push(["error", {
                message: "Codex did not return an image. Account may not be entitled (Plus/Pro required).",
              }]);
            } else {
              if (onSuccess) {
                try {
                  Promise.resolve(onSuccess()).catch(error => {
                    log?.warn?.("IMAGE", `Success cleanup failed: ${error?.message || error}`);
                  });
                } catch (error) {
                  log?.warn?.("IMAGE", `Success cleanup failed: ${error?.message || error}`);
                }
              }
              throwIfAborted(lifecycle.signal);
              pending.push(["done", { created: nowSec(), data: [{ b64_json: b64 }] }]);
            }
          }
        }

        if (pending.length > 0 && !cancelled) {
          const [event, data] = pending.shift();
          controller.enqueue(encodeSse(event, data));
        }
        if (terminal && pending.length === 0) finish(controller);
      } catch (error) {
        parser.cancel(error);
        if (!cancelled) {
          try { controller.enqueue(encodeSse("error", { message: error?.message || "Stream failed" })); } catch { /* cancelled */ }
        }
        terminal = true;
        pending.length = 0;
        finish(controller);
      } finally {
        pulling = false;
      }
    },
    cancel() {
      cancelled = true;
      finished = true;
      pending.length = 0;
      terminal = true;
      lifecycle.abortOperation(imageClientAbortError());
      parser.cancel(lifecycle.signal?.reason);
      cleanup();
      lifecycle.finishOperation();
    },
  }, { highWaterMark: 0 });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  stream: true,
  buildUrl: () => CODEX_RESPONSES_URL,
  buildHeaders: (creds) => {
    const accountId = creds?.providerSpecificData?.chatgptAccountId || decodeAccountId(creds?.idToken);
    return {
      accept: "text/event-stream, application/json",
      authorization: `Bearer ${creds?.accessToken || ""}`,
      "chatgpt-account-id": accountId || "",
      "content-type": "application/json",
      originator: CODEX_ORIGINATOR,
      session_id: randomUUID(),
      "user-agent": CODEX_USER_AGENT,
      version: CODEX_VERSION,
      "x-client-request-id": randomUUID(),
    };
  },
  buildBody: (model, body) => {
    const refs = [];
    if (Array.isArray(body.images)) body.images.forEach((i) => { const u = toDataUrl(i); if (u) refs.push(u); });
    const single = toDataUrl(body.image);
    if (single) refs.push(single);
    const detail = body.image_detail || CODEX_REF_DETAIL;
    const imgTool = { type: "image_generation", output_format: (body.output_format || "png").toLowerCase() };
    if (body.size && body.size !== "") imgTool.size = body.size;
    if (body.quality && body.quality !== "") imgTool.quality = body.quality;
    if (body.background && body.background !== "") imgTool.background = body.background;
    return {
      model: stripImageSuffix(model),
      instructions: "",
      input: [{ type: "message", role: "user", content: buildContent(body.prompt, refs, detail) }],
      tools: [imgTool],
      tool_choice: "auto",
      parallel_tool_calls: false,
      prompt_cache_key: randomUUID(),
      stream: true,
      store: false,
      reasoning: null,
    };
  },
  async parseResponse(response, context) {
    requireEventStream(response);
    if (context.streamToClient) {
      return {
        sseResponse: buildSseResponse(response, context.log, context.onRequestSuccess, context),
      };
    }
    const b64 = await parseStream(response, context.log, {
      signal: context.signal,
      maxBytes: context.maxResponseBytes,
      maxEvents: context.maxSseEvents,
    });
    if (!b64) {
      throw new Error("Codex did not return an image. Account may not be entitled (Plus/Pro required).");
    }
    return { created: nowSec(), data: [{ b64_json: b64 }] };
  },
  normalize: (responseBody) => responseBody,
};
