/**
 * Regression test for #1062:
 * GitHub Copilot's /responses endpoint only serves OpenAI (gpt/codex) models.
 * Gemini/Claude models must never be routed/escalated there, otherwise they
 * fail with a misleading 400 "does not support Responses API".
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import "../translator/registerAll.js";
import { GithubExecutor } from "../../open-sse/executors/github.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ToolCompatibilityError } from "../../open-sse/translator/concerns/hostedToolPolicy.js";

const mocked = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocked.fetch,
  default: mocked.fetch,
}));

afterEach(() => {
  vi.restoreAllMocks();
  mocked.fetch.mockReset();
});

describe("GithubExecutor.supportsResponsesEndpoint", () => {
  const exec = new GithubExecutor();

  it("excludes Gemini models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-preview")).toBe(false);
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-low")).toBe(false);
  });

  it("excludes Claude models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("claude-sonnet-4.6")).toBe(false);
    expect(exec.supportsResponsesEndpoint("claude-opus-4.7")).toBe(false);
  });

  it("allows OpenAI/codex models on the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gpt-5.5-codex")).toBe(true);
    expect(exec.supportsResponsesEndpoint("o4-mini")).toBe(true);
    expect(exec.supportsResponsesEndpoint("gpt-4.1")).toBe(true);
  });

  it("is null-safe", () => {
    expect(exec.supportsResponsesEndpoint(undefined)).toBe(true);
    expect(exec.supportsResponsesEndpoint("")).toBe(true);
  });
});

describe("GithubExecutor.execute cached-route guard (#1062)", () => {
  it("does NOT use /responses for a Gemini model even if it was wrongly cached as codex", async () => {
    const exec = new GithubExecutor();
    // Simulate a prior misclassification that cached the Gemini model.
    exec.knownCodexModels.add("gemini-3.1-pro-preview");

    const respSpy = vi
      .spyOn(exec, "executeWithResponsesEndpoint")
      .mockResolvedValue({ via: "responses" });
    // Short-circuit the /chat/completions path (BaseExecutor.execute).
    const baseSpy = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(exec)), "execute")
      .mockResolvedValue({ response: { status: 200 }, via: "chat" });

    const result = await exec.execute({ model: "gemini-3.1-pro-preview", body: { messages: [] }, log: null });

    expect(respSpy).not.toHaveBeenCalled();
    expect(baseSpy).toHaveBeenCalled();
    expect(result.via).toBe("chat");
  });

  it("rejects native Chat custom tools before a cached Responses route dispatches (#35 / SR-07)", async () => {
    const model = "gpt-5.5-codex";
    const body = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, model, {
      messages: [{ role: "user", content: "offline custom tool probe" }],
      tools: [{ type: "custom", custom: { name: "exec", format: { type: "text" } } }],
      tool_choice: { type: "custom", custom: { name: "exec" } },
    }, true, null, "github");
    const exec = new GithubExecutor();
    exec.knownCodexModels.add(model);
    mocked.fetch.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(exec.execute({
      model, body, stream: true, credentials: {}, signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ToolCompatibilityError);
    expect(mocked.fetch).not.toHaveBeenCalled();
  });

  it("consumes a 400 diagnostic once and preserves it when no endpoint switch applies", async () => {
    const exec = new GithubExecutor();
    mocked.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "ordinary bad request" }), {
      status: 400,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "x-upstream": "yes",
      },
    }));

    const result = await exec.execute({
      model: "gpt-4.1",
      body: { messages: [{ role: "user", content: "fixture" }] },
      stream: false,
      credentials: { copilotToken: "fixture" },
    });

    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-encoding")).toBeNull();
    expect(result.response.headers.get("x-upstream")).toBe("yes");
    expect(await result.response.json()).toEqual({ error: "ordinary bad request" });
    expect(mocked.fetch).toHaveBeenCalledTimes(1);
  });

  it("switches to /responses from a bounded chat diagnostic without cloning it", async () => {
    const exec = new GithubExecutor();
    const switchResult = { via: "responses" };
    vi.spyOn(exec, "executeWithResponsesEndpoint").mockResolvedValueOnce(switchResult);
    mocked.fetch.mockResolvedValueOnce(new Response(
      "The requested model is not supported by the chat endpoint",
      { status: 400 },
    ));

    const result = await exec.execute({
      model: "gpt-5.5-codex",
      body: { messages: [{ role: "user", content: "fixture" }] },
      stream: false,
      credentials: { copilotToken: "fixture" },
    });

    expect(result).toBe(switchResult);
    expect(exec.knownCodexModels.has("gpt-5.5-codex")).toBe(true);
    expect(exec.executeWithResponsesEndpoint).toHaveBeenCalledTimes(1);
  });

  it("cancels a stalled endpoint diagnostic when the caller disconnects", async () => {
    const exec = new GithubExecutor();
    const client = new AbortController();
    const cancel = vi.fn();
    mocked.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 400 }));

    const pending = exec.execute({
      model: "gpt-4.1",
      body: { messages: [{ role: "user", content: "fixture" }] },
      stream: false,
      credentials: { copilotToken: "fixture" },
      signal: client.signal,
    });
    await vi.waitFor(() => expect(mocked.fetch).toHaveBeenCalledTimes(1));
    client.abort(new DOMException("client left", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
