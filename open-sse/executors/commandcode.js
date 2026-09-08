import { randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { commandCodeToOpenAIResponse } from "../translator/response/commandcode-to-openai.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import {
  cancelReaderBestEffort,
  MAX_STREAM_FRAME_CHARS,
  readReaderWithDeadline,
  ReaderDeadlineError,
} from "../utils/reader.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";

/**
 * CommandCodeExecutor — talks to https://api.commandcode.ai/alpha/generate
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 * Adds the per-request `x-session-id` header expected by CommandCode upstream.
 *
 * Upstream returns AI SDK v5 NDJSON (one JSON event per line, no `data:` prefix).
 * We translate each event to an OpenAI chat.completion.chunk and emit it as SSE so
 * both the streaming and non-streaming (forced SSE → JSON) downstream handlers in
 * 9router can consume it without further format translation.
 */
export class CommandCodeExecutor extends BaseExecutor {
  constructor() {
    super("commandcode", PROVIDERS.commandcode);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    return body;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      "x-session-id": randomUUID(),
    };

    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async execute(opts) {
    const result = await super.execute(opts);
    if (!result?.response?.ok || !result.response.body) return result;
    result.response = await inspectAndWrapCommandCodeResponse(result.response, opts.model, {
      signal: opts.signal,
      firstFrameTimeoutMs: this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS,
    });
    return result;
  }

  parseError(response, bodyText) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText || "{}");
    } catch {
      parsed = null;
    }
    const errObj = parsed?.error || parsed;
    const msg = errObj?.message || parsed?.message || bodyText || response.statusText;
    const status = Number(errObj?.code || errObj?.statusCode || response.status) || response.status;
    return {
      status,
      message: msg || `CommandCode upstream error: ${response.status}`,
    };
  }
}

export function parseCommandCodeError(event) {
  if (!event || typeof event !== "object") {
    return {
      statusCode: 503,
      message: "CommandCode upstream error",
      type: "server_error",
    };
  }

  const errVal = event.error ?? event.message ?? "unknown";
  let message = "";
  let statusCode = null;
  let type = "server_error";

  if (typeof errVal === "object" && errVal !== null) {
    message = errVal.message || errVal.error || JSON.stringify(errVal);
    if (errVal.statusCode && Number.isInteger(Number(errVal.statusCode))) {
      statusCode = Number(errVal.statusCode);
    } else if (errVal.status && Number.isInteger(Number(errVal.status))) {
      statusCode = Number(errVal.status);
    }
    if (errVal.type) type = errVal.type;
  } else if (typeof errVal === "string") {
    message = errVal;
  } else {
    message = JSON.stringify(errVal);
  }

  if (event.statusCode && Number.isInteger(Number(event.statusCode))) {
    statusCode = Number(event.statusCode);
  }

  if (!statusCode || statusCode < 400 || statusCode > 599) {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      statusCode = 429;
      type = "rate_limit_error";
    } else if (lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
      statusCode = 401;
      type = "authentication_error";
    } else if (lower.includes("payment required") || lower.includes("billing")) {
      statusCode = 402;
      type = "billing_error";
    } else if (lower.includes("quota") || lower.includes("forbidden") || lower.includes("permission")) {
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("not found")) {
      statusCode = 404;
      type = "invalid_request_error";
    } else if (lower.includes("unavailable") || lower.includes("overloaded") || lower.includes("server error")) {
      statusCode = 503;
      type = "server_error";
    } else {
      statusCode = 503;
    }
  }

  return { statusCode, message, type };
}

function publicCommandCodeError(statusCode) {
  if (statusCode === 401) return { message: "CommandCode authentication failed", type: "authentication_error" };
  if (statusCode === 402) return { message: "CommandCode billing limit reached", type: "billing_error" };
  if (statusCode === 403) return { message: "CommandCode request is not permitted", type: "permission_error" };
  if (statusCode === 404) return { message: "CommandCode model or endpoint was not found", type: "invalid_request_error" };
  if (statusCode === 429) return { message: "CommandCode rate limit reached", type: "rate_limit_error" };
  if (statusCode === 503) return { message: "CommandCode is temporarily unavailable", type: "server_error" };
  return { message: "CommandCode upstream request failed", type: "upstream_error" };
}

export async function inspectAndWrapCommandCodeResponse(
  originalResponse,
  model,
  { signal, firstFrameTimeoutMs = FETCH_CONNECT_TIMEOUT_MS } = {},
) {
  const reader = originalResponse.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const bufferedLines = [];
  let bufferedChars = 0;
  let detectedError = null;
  const deadlineAt = Date.now() + firstFrameTimeoutMs;
  const bufferLine = line => {
    const nextSize = bufferedChars + line.length + (bufferedLines.length ? 1 : 0);
    if (line.length > MAX_STREAM_FRAME_CHARS || nextSize > MAX_STREAM_FRAME_CHARS) {
      const error = new Error("CommandCode stream prelude exceeds size limit");
      error.code = "upstream_stream_frame_too_large";
      throw error;
    }
    bufferedChars = nextSize;
    bufferedLines.push(line);
  };

  try {
    while (true) {
      const { value, done } = await readReaderWithDeadline(reader, {
        signal,
        deadlineAt,
        label: "CommandCode first stream event",
      });
      if (done) {
        buffer += decoder.decode();
        const trimmed = buffer.trim();
        if (trimmed) {
          if (trimmed.length > MAX_STREAM_FRAME_CHARS) {
            const error = new Error("CommandCode stream prelude exceeds size limit");
            error.code = "upstream_stream_frame_too_large";
            throw error;
          }
          try {
            const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
            const parsed = JSON.parse(jsonStr);
            if (parsed?.type === "error") {
              detectedError = parsed;
            } else {
              bufferLine(trimmed);
            }
          } catch {
            bufferLine(trimmed);
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      if (buffer.length > MAX_STREAM_FRAME_CHARS) {
        const error = new Error("CommandCode stream prelude exceeds size limit");
        error.code = "upstream_stream_frame_too_large";
        throw error;
      }

      let stopLoop = false;
      let lineIndex = 0;
      for (; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.length > MAX_STREAM_FRAME_CHARS) {
          const error = new Error("CommandCode stream prelude exceeds size limit");
          error.code = "upstream_stream_frame_too_large";
          throw error;
        }
        const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!jsonStr || jsonStr === "[DONE]") {
          bufferLine(trimmed);
          stopLoop = true;
          break;
        }

        let event;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          bufferLine(trimmed);
          continue;
        }

        if (event?.type === "error") {
          detectedError = event;
          stopLoop = true;
          break;
        }

        bufferLine(trimmed);

        if (
          event?.type === "text-delta" ||
          event?.type === "reasoning-delta" ||
          event?.type === "tool-input-start" ||
          event?.type === "tool-call" ||
          event?.type === "finish" ||
          event?.type === "finish-step"
        ) {
          stopLoop = true;
          break;
        }
      }

      if (stopLoop) {
        const completeUnreadLines = lines.slice(lineIndex + 1);
        if (completeUnreadLines.length > 0) {
          const unreadPrefix = `${completeUnreadLines.join("\n")}\n`;
          buffer = `${unreadPrefix}${buffer}`;
        }
        break;
      }
    }
  } catch (error) {
    cancelReaderBestEffort(reader, "CommandCode stream prelude rejected");
    if (signal?.aborted) throw error;
    const timedOut = error instanceof ReaderDeadlineError;
    return new Response(
      JSON.stringify({ error: {
        message: timedOut ? "CommandCode first stream event timed out" : "Invalid CommandCode stream prelude",
        type: "upstream_error",
        code: timedOut ? "upstream_stream_timeout" : "invalid_upstream_response",
      } }),
      {
        status: timedOut ? 504 : 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  }

  if (detectedError) {
    cancelReaderBestEffort(reader, "CommandCode error event");
    const { statusCode } = parseCommandCodeError(detectedError);
    const { message, type } = publicCommandCodeError(statusCode);
    return new Response(
      JSON.stringify({
        error: {
          message,
          type,
          code: statusCode,
        },
      }),
      {
        status: statusCode,
        statusText: statusCode === 503 ? "Service Unavailable" : (statusCode === 429 ? "Too Many Requests" : "Bad Gateway"),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const combinedStream = createReplayedStream(bufferedLines, buffer, reader);
  return wrapNdjsonAsOpenAISse(combinedStream, model, originalResponse);
}

function createReplayedStream(bufferedLines, remainingBuffer, reader) {
  const encoder = new TextEncoder();
  let replayed = false;

  return new ReadableStream({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        let prefix = bufferedLines.join("\n");
        if (prefix && remainingBuffer) {
          prefix += "\n" + remainingBuffer;
        } else if (remainingBuffer) {
          prefix = remainingBuffer;
        } else if (prefix) {
          prefix += "\n";
        }
        if (prefix) {
          controller.enqueue(encoder.encode(prefix));
        }
      }

      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      cancelReaderBestEffort(reader, reason);
    },
  });
}

function wrapNdjsonAsOpenAISse(streamBody, model, originalResponse = null) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };
  let terminalSeen = false;
  let failed = false;
  let doneEmitted = false;

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const emitFailure = (controller, code, reason) => {
    if (failed) return;
    failed = true;
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
      error: {
        message: `Invalid upstream response: ${reason}`,
        type: "upstream_error",
        code,
      },
    })}\n\n`));
  };

  const emitDone = controller => {
    if (doneEmitted) return;
    doneEmitted = true;
    controller.enqueue(encoder.encode(SSE_DONE));
  };

  const processLine = (line, controller) => {
    if (failed) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    const jsonText = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (!jsonText) return;
    if (jsonText === "[DONE]") {
      terminalSeen = true;
      return;
    }

    let event;
    try { event = JSON.parse(jsonText); } catch {
      emitFailure(controller, "commandcode_malformed_stream", "malformed CommandCode event");
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      emitFailure(controller, "commandcode_malformed_stream", "invalid CommandCode event");
      return;
    }
    if (event.type === "error") {
      emitFailure(controller, "commandcode_upstream_error", "CommandCode returned an error event");
      return;
    }
    if (event.type === "finish") terminalSeen = true;
    emitChunks(commandCodeToOpenAIResponse(event, state), controller);
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
      } catch {
        emitFailure(controller, "commandcode_malformed_stream", "invalid CommandCode stream encoding");
        controller.terminate();
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.length > MAX_STREAM_FRAME_CHARS) {
          emitFailure(controller, "commandcode_frame_too_large", "CommandCode stream event exceeds size limit");
          controller.terminate();
          return;
        }
        processLine(line, controller);
        if (failed) {
          controller.terminate();
          return;
        }
        if (terminalSeen) {
          emitDone(controller);
          controller.terminate();
          return;
        }
      }
      if (buffer.length > MAX_STREAM_FRAME_CHARS) {
        emitFailure(controller, "commandcode_frame_too_large", "CommandCode stream event exceeds size limit");
        controller.terminate();
      }
    },
    flush(controller) {
      try { buffer += decoder.decode(); } catch {
        emitFailure(controller, "commandcode_malformed_stream", "invalid CommandCode stream encoding");
      }
      const trimmed = buffer.trim();
      if (!failed && trimmed.length > MAX_STREAM_FRAME_CHARS) {
        emitFailure(controller, "commandcode_frame_too_large", "CommandCode stream event exceeds size limit");
      } else if (!failed && trimmed) processLine(trimmed, controller);
      if (!failed && !terminalSeen) {
        emitFailure(controller, "commandcode_missing_terminal", "CommandCode stream ended without a finish event");
      }
      emitDone(controller);
    },
  });

  const newBody = streamBody.pipeThrough(transform);
  const headers = new Headers(originalResponse?.headers);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  return new Response(newBody, {
    status: originalResponse?.status || 200,
    statusText: originalResponse?.statusText || "OK",
    headers,
  });
}

export default CommandCodeExecutor;
