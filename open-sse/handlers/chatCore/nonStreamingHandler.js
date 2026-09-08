import { FORMATS } from "../../translator/formats.js";
import { addBufferToUsage, filterUsageForFormat } from "../../utils/usageTracking.js";
import { createErrorResult, readUpstreamBodyText } from "../../utils/error.js";
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { convertChatStreamToOpenAIResponse } from "./sseToJsonHandler.js";
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { InvalidResponseError, normalizeNonStreamingResponse } from "../../translator/concerns/responseContract.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";

const MAX_NON_STREAMING_RESPONSE_BYTES = 64 * 1024 * 1024;

async function readJsonResponse(providerResponse, signal) {
  const text = await readUpstreamBodyText(providerResponse, {
    signal,
    maxBytes: MAX_NON_STREAMING_RESPONSE_BYTES,
    stallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
    fatalUtf8: true,
  });
  if (!text.trim()) throw new InvalidResponseError("empty upstream JSON response");
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidResponseError("invalid upstream JSON response");
  }
}

// Retain the exported entry point used by existing callers and tests.
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames = null, options = {}) {
  return normalizeNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames, options);
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, trackDone, appendLog, pxpipe, reqTag, log, signal = null }) {
  trackDone();
  const contentType = (providerResponse.headers.get("content-type") || "").toLowerCase();
  let responseBody;

  try {
    if (contentType.includes("text/event-stream")) {
      responseBody = targetFormat === FORMATS.OPENAI_RESPONSES
        ? await convertResponsesStreamToJson(providerResponse.body, { signal })
        : await convertChatStreamToOpenAIResponse(providerResponse.body, model, { signal });
    } else {
      responseBody = await readJsonResponse(providerResponse, signal);
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      error instanceof InvalidResponseError ? error.message : "Invalid upstream response body",
      undefined,
      "invalid_upstream_response",
    );
  }

  reqLogger.logProviderResponse(providerResponse.status, providerResponse.statusText, providerResponse.headers, responseBody);
  // Validate and translate before success callbacks or usage recording.
  responseBody = decloakToolNames(responseBody, toolNameMap);
  let translatedResponse;
  try {
    translatedResponse = translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames, {
      allowBackground: body?.background === true && body?.stream !== true,
    });
  } catch (error) {
    if (!(error instanceof InvalidResponseError)) throw error;
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
    return createErrorResult(error.status, error.message, undefined, error.code);
  }
  if (onRequestSuccess) {
    // Publish the in-memory success watermark before returning while keeping
    // any asynchronous account-state persistence best-effort.
    try {
      Promise.resolve(onRequestSuccess()).catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
    } catch (err) {
      console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
    }
  }

  const usage = extractUsageFromResponse(responseBody);
  appendLog({ tokens: usage, status: "200 OK" });
  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, silent: true });
  if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));

  const isChatCompletionResponse = Array.isArray(translatedResponse?.choices);
  // Responses-format translation produces a `object:"response"` body with no
  // `choices`; skip the Chat-Completions-specific post-processing below for it.
  const isResponsesResponse = sourceFormat === FORMATS.OPENAI_RESPONSES && translatedResponse?.object === "response";

  // Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other")
  if (translatedResponse?.choices?.[0]) {
    const choice = translatedResponse.choices[0];
    const msg = choice.message;
    const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    if (hasToolCalls && !["tool_calls", "length", "content_filter"].includes(choice.finish_reason)) {
      choice.finish_reason = "tool_calls";
    }
  }

  // Ensure OpenAI-required fields
  if (isChatCompletionResponse) {
    if (!translatedResponse.object) translatedResponse.object = "chat.completion";
    if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);
  }

  // Strip Azure-specific fields
  if (isChatCompletionResponse) {
    delete translatedResponse.prompt_filter_results;
    if (translatedResponse?.choices) {
      for (const choice of translatedResponse.choices) delete choice.content_filter_results;
    }
  }

  if (translatedResponse?.usage) {
    const bufferedUsage = addBufferToUsage(translatedResponse.usage);
    translatedResponse.usage = filterUsageForFormat(bufferedUsage, sourceFormat);
    if (isResponsesResponse && bufferedUsage.total_tokens !== undefined) {
      translatedResponse.usage.total_tokens = bufferedUsage.total_tokens;
    }
  }

  reqLogger.logConvertedResponse(translatedResponse);

  const totalLatency = Date.now() - requestStartTime;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: totalLatency, total: totalLatency },
    tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: responseBody || null,
    response: {
      content: translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
      thinking: translatedResponse?.choices?.[0]?.message?.reasoning_content || translatedResponse?.reasoning_content || null,
      finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown"
    },
    pxpipe,
    status: "success"
  }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });

  return {
    success: true,
    response: new Response(JSON.stringify(translatedResponse), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    })
  };
}
