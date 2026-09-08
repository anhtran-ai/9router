import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { transformToOllama } from "open-sse/utils/ollamaTransform.js";
import { readRequestBodyBytes, RequestBodyError } from "open-sse/utils/requestBody.js";

let initialized = false;
const MAX_OLLAMA_REQUEST_BYTES = 64 * 1024 * 1024;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {
  await ensureInitialized();

  let rawBody;
  try {
    rawBody = await readRequestBodyBytes(request, {
      maxBytes: MAX_OLLAMA_REQUEST_BYTES,
      label: "Ollama request body",
      requireBody: true,
    });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return Response.json({ error: error?.message || "Invalid request body" }, { status });
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "JSON body must be an object" }, { status: 400 });
  }
  const modelName = typeof body.model === "string" && body.model
    ? body.model
    : "llama3.2";

  const headers = new Headers(request.headers);
  for (const name of ["content-length", "content-encoding", "transfer-encoding", "digest", "content-md5"]) {
    headers.delete(name);
  }
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: rawBody,
    signal: request.signal,
  });
  const response = await handleChat(forwarded);
  return await transformToOllama(response, modelName, request.signal);
}

