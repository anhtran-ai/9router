import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { InvalidResponseError, normalizeNonStreamingResponse } from "../../translator/concerns/responseContract.js";
import { saveRequestDetail } from "@/lib/usageDb.js";

const isResponsesProvider = provider => PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;

/** Collect Chat SSE without inventing success for unrelated JSON or truncated data. */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const chunks = [];
  let streamError = null;
  let hasChoice = false;
  let terminalSeen = false;

  // SSE data belongs to a complete frame, not to an individual data: line.
  // The response is already buffered; normalize all allowed line separators
  // before joining a frame's data values exactly as a streaming reader does.
  const frames = String(rawSSE || "").replace(/\r\n|\r/g, "\n").split("\n\n");
  for (const frame of frames) {
    const payload = frame.split("\n")
      .filter(line => line === "data" || line.startsWith("data:"))
      .map(line => line === "data" ? "" : line.slice(5).replace(/^ /, ""))
      .join("\n").trim();
    if (payload === "[DONE]") { terminalSeen = true; continue; }
    if (!payload) continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk?.error) streamError = chunk.error;
      else if (Array.isArray(chunk?.choices)) {
        chunks.push(chunk);
        hasChoice ||= chunk.choices.some(choice => choice && (choice.delta || choice.message));
        terminalSeen ||= chunk.choices.some(choice => choice?.finish_reason != null);
      }
    } catch {
      streamError ||= { message: "Invalid upstream SSE data", code: "invalid_upstream_response" };
    }
  }

  if (streamError) return { error: streamError };
  if (!hasChoice) return null;
  if (!terminalSeen) return { error: { message: "Upstream SSE stream ended without a terminal event", code: "invalid_upstream_response" } };

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || choice?.message || {};
    if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoningParts.push(delta.reasoning_content);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  const message = { role: "assistant", content: contentParts.join("") || (toolCallMap.size > 0 ? null : "") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
  if (usage) result.usage = usage;
  return result;
}

/** Provider forces streaming while the client requests one JSON response. */
export async function handleForcedSSEToJson({ providerResponse, sourceFormat, targetFormat, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, customToolNames, trackDone, appendLog, reqTag, log }) {
  const contentType = (providerResponse.headers.get("content-type") || "").toLowerCase();
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider));
  const isJson = contentType.includes("application/json") || contentType.includes("+json");
  if (!isSSE && !isJson) return null;
  trackDone();

  try {
    let responseBody;
    let responseFormat = targetFormat;
    if (isJson) {
      // A provider may honor stream:false despite its registry forceStream flag.
      responseBody = await providerResponse.json();
    } else if (isResponsesProvider(provider) || targetFormat === FORMATS.OPENAI_RESPONSES) {
      responseBody = await convertResponsesStreamToJson(providerResponse.body);
      responseFormat = FORMATS.OPENAI_RESPONSES;
    } else {
      responseBody = parseSSEToOpenAIResponse(await providerResponse.text(), model);
      responseFormat = FORMATS.OPENAI;
      if (responseBody?.error) {
        throw new InvalidResponseError("upstream SSE reported an error");
      }
    }
    const clientBody = normalizeNonStreamingResponse(responseBody, responseFormat, sourceFormat, customToolNames, {
      allowBackground: isJson && body?.background === true && body?.stream !== true,
    });

    // No account-success callback or usage record until collection, terminal
    // validation and the client-format conversion have all succeeded.
    if (onRequestSuccess) await onRequestSuccess();
    const usage = extractUsageFromResponse(responseBody) || {};
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));
    const totalLatency = Date.now() - requestStartTime;
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, latency: { ttft: totalLatency, total: totalLatency }, tokens: usage,
      request: extractRequestConfig(body, stream), providerRequest: finalBody || translatedBody || null,
      response: { content: clientBody.choices?.[0]?.message?.content || clientBody.content || clientBody.output || null,
        thinking: clientBody.choices?.[0]?.message?.reasoning_content || null,
        finish_reason: clientBody.choices?.[0]?.finish_reason || clientBody.stop_reason || clientBody.status || "unknown" },
      status: "success",
    }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});
    return { success: true, response: new Response(JSON.stringify(clientBody), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }) };
  } catch (error) {
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY,
      error instanceof InvalidResponseError ? error.message : "Invalid upstream streaming response",
      undefined, "invalid_upstream_response");
  }
}
