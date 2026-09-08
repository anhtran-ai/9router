/**
 * Unit tests for image generation handler
 *
 * Covers:
 *  - OpenAI-compatible format (openai, minimax, openrouter)
 *  - Gemini format (generateContent API)
 *  - Provider-specific formats (nanobanana, sdwebui)
 *  - Response normalization to OpenAI format
 *  - Error handling (missing prompt, invalid model)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("node:dns/promises", () => ({ lookup: dnsMocks.lookup }));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";

const originalFetch = global.fetch;

describe("handleImageGenerationCore", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    dnsMocks.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("validates required prompt field", async () => {
    const result = await handleImageGenerationCore({
      body: { model: "openai/dall-e-3" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Missing required field: prompt");
  });

  it("rejects unsupported provider", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "unknown-provider", model: "test" },
      credentials: null,
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support image generation");
  });

  it("generates image with OpenAI format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/image.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A cute cat", n: 1, size: "1024x1024" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        }),
        body: expect.stringContaining('"prompt":"A cute cat"'),
      })
    );

    const responseBody = await result.response.json();
    expect(responseBody.data).toHaveLength(1);
    expect(responseBody.data[0].url).toBe("https://example.com/image.png");
  });

  it("generates image with Gemini format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "Generated image" },
                  { inlineData: { data: "base64imagedata" } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A sunset" },
      modelInfo: { provider: "gemini", model: "gemini-image-preview" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"responseModalities":["TEXT","IMAGE"]'),
      })
    );

    const responseBody = await result.response.json();
    expect(responseBody.data).toHaveLength(1);
    expect(responseBody.data[0].b64_json).toBe("base64imagedata");
  });

  it("generates image with Minimax format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/minimax.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A mountain", size: "1024x1024" },
      modelInfo: { provider: "minimax", model: "minimax-image-01" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.minimaxi.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      })
    );
  });

  it("generates image with NanoBanana format", async () => {
    vi.useFakeTimers();
    global.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 200, data: { taskId: "task-123" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              successFlag: 1,
              response: { resultImageUrl: "https://example.com/nanobanana.png" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const pending = handleImageGenerationCore({
      body: { prompt: "A robot", n: 2, size: "1024x1792" },
      modelInfo: { provider: "nanobanana", model: "nanobanana-flash" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;

    expect(result.success).toBe(true);
    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.type).toBe("TEXTTOIAMGE");
    expect(requestBody.numImages).toBe(2);
    expect(requestBody.image_size).toBe("9:16");
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.nanobananaapi.ai/api/v1/nanobanana/record-info?taskId=task-123",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
        signal: expect.any(AbortSignal),
      })
    );

    const responseBody = await result.response.json();
    expect(responseBody.data[0].url).toBe("https://example.com/nanobanana.png");
  });

  it("polls Black Forest Labs with the bounded operation signal", async () => {
    vi.useFakeTimers();
    global.fetch
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ polling_url: "https://api.bfl.ai/v1/get_result?id=task-1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ status: "Ready", result: { sample: "https://example.com/bfl.png" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));

    const pending = handleImageGenerationCore({
      body: { prompt: "BFL" },
      modelInfo: { provider: "black-forest-labs", model: "flux-pro-1.1" },
      credentials: { apiKey: "bfl-key" },
    });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;

    expect(result.success).toBe(true);
    expect((await result.response.json()).data[0].url).toBe("https://example.com/bfl.png");
    expect(global.fetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("does not send BFL credentials to an untrusted polling URL", async () => {
    global.fetch.mockResolvedValueOnce(new Response(
      JSON.stringify({ polling_url: "http://127.0.0.1/internal" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const result = await handleImageGenerationCore({
      body: { prompt: "untrusted poll" },
      modelInfo: { provider: "black-forest-labs", model: "flux-pro-1.1" },
      credentials: { apiKey: "bfl-key" },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("Untrusted BFL polling URL");
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("polls Fal and bounds the final result body", async () => {
    vi.useFakeTimers();
    global.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status_url: "https://queue.fal.run/status/task-1",
        response_url: "https://queue.fal.run/result/task-1",
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ status: "COMPLETED" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ images: [{ url: "https://example.com/fal.png" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));

    const pending = handleImageGenerationCore({
      body: { prompt: "Fal" },
      modelInfo: { provider: "fal-ai", model: "fal-ai/flux/dev" },
      credentials: { apiKey: "fal-key" },
    });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;

    expect(result.success).toBe(true);
    expect((await result.response.json()).data[0].url).toBe("https://example.com/fal.png");
    expect(global.fetch.mock.calls[2][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("polls Runway with the bounded operation signal", async () => {
    vi.useFakeTimers();
    global.fetch
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ id: "runway-task" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ status: "SUCCEEDED", output: ["https://example.com/runway.png"] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));

    const pending = handleImageGenerationCore({
      body: { prompt: "Runway" },
      modelInfo: { provider: "runwayml", model: "gen4_image" },
      credentials: { apiKey: "runway-key" },
    });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;

    expect(result.success).toBe(true);
    expect((await result.response.json()).data[0].url).toBe("https://example.com/runway.png");
    expect(global.fetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("generates image with SD WebUI format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ images: ["base64sdwebui1", "base64sdwebui2"] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A forest", size: "768x768", n: 2 },
      modelInfo: { provider: "sdwebui", model: "sdxl-base-1.0" },
      credentials: null,
      log: null,
    });

    expect(result.success).toBe(true);
    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.width).toBe(768);
    expect(requestBody.height).toBe(768);
    expect(requestBody.batch_size).toBe(2);

    const responseBody = await result.response.json();
    expect(responseBody.data).toHaveLength(2);
  });

  it("handles OpenRouter with HTTP-Referer header", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/or.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A city" },
      modelInfo: { provider: "openrouter", model: "openai/dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/images/generations",
      expect.objectContaining({
        headers: expect.objectContaining({
          "HTTP-Referer": "https://endpoint-proxy.local",
          "X-Title": "Endpoint Proxy",
        }),
      })
    );
  });

  it("handles Vercel AI Gateway image generation as OpenAI-compatible", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/vercel-image.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A watercolor castle", n: 1, size: "1024x1024" },
      modelInfo: { provider: "vercel-ai-gateway", model: "openai/gpt-image-1" },
      credentials: { apiKey: "vag-test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer vag-test-key",
        }),
        body: expect.stringContaining('"model":"openai/gpt-image-1"'),
      })
    );
  });

  it("handles HuggingFace binary response", async () => {
    const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    global.fetch.mockResolvedValueOnce(
      new Response(imageBuffer, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A tree" },
      modelInfo: { provider: "huggingface", model: "black-forest-labs/FLUX.1-schnell" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBeTruthy();
  });

  it.each(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])("generates image with Codex %s-image using current Codex version header", async (model) => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        [
          "event: response.output_item.done",
          'data: {"item":{"type":"image_generation_call","result":"base64codeximage"}}',
          "",
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "A green square",
        size: "1024x1024",
        output_format: "png",
      },
      modelInfo: { provider: "codex", model: `${model}-image` },
      credentials: {
        accessToken: "codex-token",
        providerSpecificData: { chatgptAccountId: "account-123" },
      },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer codex-token",
          "chatgpt-account-id": "account-123",
          version: "0.136.0",
        }),
      })
    );

    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.model).toBe(model);
    expect(requestBody.tools).toEqual([
      { type: "image_generation", output_format: "png", size: "1024x1024" },
    ]);

    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBe("base64codeximage");
  });

  it("generates image with Cloudflare Workers AI JSON response", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { image: "base64cloudflare" },
          success: true,
          errors: [],
          messages: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A lighthouse", size: "1024x1536" },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/leonardo/lucid-origin" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/cf-account/ai/run/@cf/leonardo/lucid-origin",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer cf-token",
        }),
      })
    );

    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.prompt).toBe("A lighthouse");
    expect(requestBody.width).toBe(1024);
    expect(requestBody.height).toBe(1536);

    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBe("base64cloudflare");
  });

  it("uses multipart form data for Cloudflare FLUX.2 models", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { image: "base64flux2" },
          success: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A mountain lake", size: "1792x1024", steps: 4 },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/black-forest-labs/flux-2-klein-9b" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(true);

    const fetchCall = global.fetch.mock.calls[0];
    expect(fetchCall[1].headers).not.toHaveProperty("Content-Type");
    expect(fetchCall[1].body).toBeInstanceOf(FormData);
    expect(fetchCall[1].body.get("prompt")).toBe("A mountain lake");
    expect(fetchCall[1].body.get("width")).toBe("1792");
    expect(fetchCall[1].body.get("height")).toBe("1024");
    expect(fetchCall[1].body.get("steps")).toBe("4");
  });

  it("resolves Cloudflare img2img and inpainting URL inputs before sending", async () => {
    const sourcePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const maskPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
    global.fetch
      .mockResolvedValueOnce(new Response(sourcePng, { status: 200, headers: { "Content-Type": "image/png" } }))
      .mockResolvedValueOnce(new Response(maskPng, { status: 200, headers: { "Content-Type": "image/png" } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { image: "aW5wYWludA==" }, success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "Change to a lion",
        image: "https://example.com/source.png",
        mask_image: "https://example.com/mask.png",
        size: "512x512",
      },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/runwayml/stable-diffusion-v1-5-inpainting" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://example.com/source.png",
      expect.objectContaining({ redirect: "manual", dispatcher: expect.anything() }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://example.com/mask.png",
      expect.objectContaining({ redirect: "manual", dispatcher: expect.anything() }),
    );

    const providerCall = global.fetch.mock.calls[2];
    expect(providerCall[0]).toBe("https://api.cloudflare.com/client/v4/accounts/cf-account/ai/run/@cf/runwayml/stable-diffusion-v1-5-inpainting");
    const requestBody = JSON.parse(providerCall[1].body);
    expect(requestBody.image).toEqual([...sourcePng]);
    expect(requestBody.image_b64).toBe(Buffer.from(sourcePng).toString("base64"));
    expect(requestBody.mask).toEqual([...maskPng]);
    expect(requestBody.mask_image).toEqual([...maskPng]);
    expect(requestBody.mask_b64).toBe(Buffer.from(maskPng).toString("base64"));
  });

  it("rejects a Cloudflare image URL that resolves to loopback before fetching it", async () => {
    dnsMocks.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);

    const result = await handleImageGenerationCore({
      body: {
        prompt: "Do not fetch internal services",
        image: "https://attacker.example/internal.png",
      },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/runwayml/stable-diffusion-v1-5-img2img" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("handles provider error responses", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded" } }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.error).toContain("Rate limit exceeded");
  });

  it("handles network errors", async () => {
    global.fetch.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("Network timeout");
  });

  it("calls onRequestSuccess callback on success", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/success.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const onRequestSuccess = vi.fn();

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
      onRequestSuccess,
    });

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("keeps a validated image success when account cleanup rejects", async () => {
    global.fetch.mockResolvedValueOnce(Response.json({
      created: 123,
      data: [{ url: "https://example.com/success.png" }],
    }));
    const onRequestSuccess = vi.fn(() => Promise.reject(new Error("cleanup failed")));

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      onRequestSuccess,
    });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(onRequestSuccess).toHaveBeenCalledOnce();
  });

  it("rejects an empty OpenAI image result before recording account success", async () => {
    global.fetch.mockResolvedValueOnce(Response.json({ created: 123, data: [] }));
    const onRequestSuccess = vi.fn();

    const result = await handleImageGenerationCore({
      body: { prompt: "empty result" },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "test-key" },
      onRequestSuccess,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("returned no generated image");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("rejects an async provider terminal state without an image", async () => {
    vi.useFakeTimers();
    global.fetch
      .mockResolvedValueOnce(Response.json({
        polling_url: "https://api.bfl.ai/v1/get_result?id=empty-task",
      }))
      .mockResolvedValueOnce(Response.json({ status: "Ready", result: {} }));
    const onRequestSuccess = vi.fn();

    const pending = handleImageGenerationCore({
      body: { prompt: "empty async result" },
      modelInfo: { provider: "black-forest-labs", model: "flux-pro-1.1" },
      credentials: { apiKey: "bfl-key" },
      onRequestSuccess,
    });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("returned no generated image");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("does not record success when binary image URL resolution is rejected", async () => {
    global.fetch.mockResolvedValueOnce(Response.json({
      created: 123,
      data: [{ url: "http://127.0.0.1/private-image" }],
    }));
    const onRequestSuccess = vi.fn();

    const result = await handleImageGenerationCore({
      body: { prompt: "binary output" },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "test-key" },
      binaryOutput: true,
      onRequestSuccess,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("bounds a provider that never returns response headers", async () => {
    vi.useFakeTimers();
    let upstreamSignal;
    let resolveHeaders;
    const lateCancel = vi.fn();
    const lateResponse = new Response(new ReadableStream({ cancel: lateCancel }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    global.fetch.mockImplementationOnce((_url, options) => {
      upstreamSignal = options.signal;
      return new Promise((resolve) => { resolveHeaders = resolve; });
    });

    const pending = handleImageGenerationCore({
      body: { prompt: "stalled headers" },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "test-key" },
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;
    expect(result).toMatchObject({ success: false, status: 504 });
    expect(upstreamSignal.aborted).toBe(true);

    // A non-compliant fetch implementation may resolve after abort. Its late
    // body is still observed and cancelled instead of leaking a connection.
    resolveHeaders(lateResponse);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateCancel).toHaveBeenCalledOnce();
  });

  it("maps client cancellation during stalled headers to 499", async () => {
    const client = new AbortController();
    let upstreamSignal;
    global.fetch.mockImplementationOnce((_url, options) => {
      upstreamSignal = options.signal;
      return new Promise(() => {});
    });

    const pending = handleImageGenerationCore({
      body: { prompt: "cancel me" },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "test-key" },
      signal: client.signal,
    });
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    client.abort();

    const result = await pending;
    expect(result).toMatchObject({ success: false, status: 499 });
    expect(upstreamSignal.aborted).toBe(true);
  });

  it("times out a stalled provider body and releases its reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream({ cancel }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    global.fetch.mockResolvedValueOnce(upstream);

    const pending = handleImageGenerationCore({
      body: { prompt: "stalled body" },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "test-key" },
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;
    expect(result).toMatchObject({ success: false, status: 504 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("rejects oversized provider JSON and cancels the body", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(JSON.stringify({ data: "x".repeat(256) }));
    const upstream = new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes); },
      cancel,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    global.fetch.mockResolvedValueOnce(upstream);

    const result = await handleImageGenerationCore({
      body: { prompt: "too large" },
      modelInfo: { provider: "openai", model: "gpt-image-1" },
      credentials: { apiKey: "test-key" },
      maxResponseBytes: 64,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("exceeds 64 byte limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("caps Codex SSE events and releases the upstream reader", async () => {
    const cancel = vi.fn();
    const payload = [
      "event: response.image_generation_call.partial_image",
      'data: {"partial_image_b64":"cGFydA==","partial_image_index":0}',
      "",
      "event: response.output_item.done",
      'data: {"item":{"type":"image_generation_call","result":"ZmluYWw="}}',
      "",
      "",
    ].join("\n");
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
      cancel,
    }), { headers: { "Content-Type": "text/event-stream" } });
    global.fetch.mockResolvedValueOnce(upstream);

    const result = await handleImageGenerationCore({
      body: { prompt: "event flood" },
      modelInfo: { provider: "codex", model: "gpt-5.6-sol-image" },
      credentials: { accessToken: "codex-token" },
      maxSseEvents: 1,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("exceeds 1 event limit");
    expect(upstream.body.locked).toBe(false);
  });

  it("rejects an oversized Codex SSE byte stream and cancels upstream", async () => {
    const cancel = vi.fn();
    const oversized = new TextEncoder().encode(`event: progress\ndata: ${"x".repeat(256)}\n\n`);
    const upstream = new Response(new ReadableStream({
      start(controller) { controller.enqueue(oversized); },
      cancel,
    }), { headers: { "Content-Type": "text/event-stream" } });
    global.fetch.mockResolvedValueOnce(upstream);

    const result = await handleImageGenerationCore({
      body: { prompt: "byte flood" },
      modelInfo: { provider: "codex", model: "gpt-5.6-sol-image" },
      credentials: { accessToken: "codex-token" },
      maxResponseBytes: 64,
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(result.error).toContain("exceeds 64 byte limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("stops Codex collection at the terminal event without waiting for EOF", async () => {
    const cancel = vi.fn();
    const terminal = [
      "event: response.output_item.done",
      'data: {"item":{"type":"image_generation_call","result":"ZmluYWw="}}',
      "",
      "",
    ].join("\n");
    const upstream = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(terminal)); },
      cancel,
    }), { headers: { "Content-Type": "text/event-stream" } });
    global.fetch.mockResolvedValueOnce(upstream);

    const result = await handleImageGenerationCore({
      body: { prompt: "terminal" },
      modelInfo: { provider: "codex", model: "gpt-5.6-sol-image" },
      credentials: { accessToken: "codex-token" },
      timeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    expect((await result.response.json()).data[0].b64_json).toBe("ZmluYWw=");
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body.locked).toBe(false);
  });

  it("keeps a terminal Codex stream success when account cleanup rejects", async () => {
    const terminal = [
      "event: response.output_item.done",
      'data: {"item":{"type":"image_generation_call","result":"ZmluYWw="}}',
      "",
      "",
    ].join("\n");
    global.fetch.mockResolvedValueOnce(new Response(terminal, {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const onRequestSuccess = vi.fn(() => Promise.reject(new Error("cleanup failed")));

    const result = await handleImageGenerationCore({
      body: { prompt: "terminal" },
      modelInfo: { provider: "codex", model: "gpt-5.6-sol-image" },
      credentials: { accessToken: "codex-token" },
      streamToClient: true,
      onRequestSuccess,
    });
    const body = await result.response.text();

    expect(result.success).toBe(true);
    expect(body).toContain("event: done");
    expect(body).not.toContain("event: error");
    expect(onRequestSuccess).toHaveBeenCalledOnce();
  });

  it("does not read Codex SSE without downstream demand and buffers at most one parsed event", async () => {
    const encoder = new TextEncoder();
    const partial = encoder.encode([
      "event: response.image_generation_call.partial_image",
      'data: {"partial_image_b64":"cGFydGlhbA==","partial_image_index":0}',
      "",
      "",
    ].join("\n"));
    const terminal = encoder.encode([
      "event: response.output_item.done",
      'data: {"item":{"type":"image_generation_call","result":"ZmluYWw="}}',
      "",
      "",
    ].join("\n"));
    const upstreamReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: partial })
        .mockResolvedValueOnce({ done: false, value: terminal })
        .mockImplementation(() => new Promise(() => {})),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream; charset=utf-8" }),
      body: { getReader: () => upstreamReader },
    });

    const result = await handleImageGenerationCore({
      body: { prompt: "slow reader" },
      modelInfo: { provider: "codex", model: "gpt-5.6-sol-image" },
      credentials: { accessToken: "codex-token" },
      streamToClient: true,
    });
    expect(result.success).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(upstreamReader.read).not.toHaveBeenCalled();

    const downstream = result.response.body.getReader();
    const first = await downstream.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: progress");
    expect(upstreamReader.read).toHaveBeenCalledTimes(1);

    // No second upstream read occurs while the client pauses. The partial
    // notification from the same block is the only pending transformed event.
    await Promise.resolve();
    await Promise.resolve();
    expect(upstreamReader.read).toHaveBeenCalledTimes(1);
    const second = await downstream.read();
    expect(new TextDecoder().decode(second.value)).toContain("event: partial_image");
    expect(upstreamReader.read).toHaveBeenCalledTimes(1);

    const output = [];
    while (!output.some((text) => text.includes("event: done"))) {
      const item = await downstream.read();
      if (item.done) break;
      output.push(new TextDecoder().decode(item.value));
    }
    expect(output.join("\n")).toContain("event: done");
    expect(upstreamReader.read).toHaveBeenCalledTimes(2);
    expect(upstreamReader.cancel).toHaveBeenCalledOnce();
    expect(upstreamReader.releaseLock).toHaveBeenCalled();
  });

  it("times out and releases a Codex upstream when downstream never reads", async () => {
    vi.useFakeTimers();
    const upstreamReader = {
      read: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    let upstreamSignal;
    global.fetch.mockImplementationOnce((_url, options) => {
      upstreamSignal = options.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        body: { getReader: () => upstreamReader },
      });
    });

    const result = await handleImageGenerationCore({
      body: { prompt: "never consumed" },
      modelInfo: { provider: "codex", model: "gpt-5.6-sol-image" },
      credentials: { accessToken: "codex-token" },
      streamToClient: true,
      timeoutMs: 25,
    });
    expect(result.success).toBe(true);
    expect(upstreamReader.read).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(upstreamSignal.aborted).toBe(true);
    expect(upstreamReader.read).not.toHaveBeenCalled();
    expect(upstreamReader.cancel).toHaveBeenCalledOnce();
    expect(upstreamReader.releaseLock).toHaveBeenCalled();
    await expect(result.response.text()).rejects.toThrow("Image generation timed out");
  });

  it.each(["application/json", "text/html"])(
    "rejects Codex HTTP 200 with unexpected Content-Type %s",
    async (contentType) => {
      global.fetch.mockResolvedValueOnce(new Response(
        contentType === "application/json" ? JSON.stringify({ error: "not SSE" }) : "<html>not SSE</html>",
        { status: 200, headers: { "Content-Type": contentType } },
      ));

      const result = await handleImageGenerationCore({
        body: { prompt: "wrong media type" },
        modelInfo: { provider: "codex", model: "gpt-5.6-sol-image" },
        credentials: { accessToken: "codex-token" },
        streamToClient: true,
      });

      expect(result).toMatchObject({ success: false, status: 502 });
      expect(result.error).toContain(`unexpected Content-Type '${contentType}'`);
      const errorBody = await result.response.json();
      expect(errorBody.error).toMatchObject({
        type: "server_error",
        code: "bad_gateway",
      });
    },
  );

  it("aborts Codex upstream when the downstream SSE body is cancelled", async () => {
    const upstreamCancel = vi.fn();
    const upstream = new Response(new ReadableStream({ cancel: upstreamCancel }), {
      headers: { "Content-Type": "text/event-stream" },
    });
    let upstreamSignal;
    global.fetch.mockImplementationOnce((_url, options) => {
      upstreamSignal = options.signal;
      return Promise.resolve(upstream);
    });
    const onRequestSuccess = vi.fn();

    const result = await handleImageGenerationCore({
      body: { prompt: "stream then cancel" },
      modelInfo: { provider: "codex", model: "gpt-5.6-sol-image" },
      credentials: { accessToken: "codex-token" },
      streamToClient: true,
      onRequestSuccess,
    });
    expect(result.success).toBe(true);

    const downstream = result.response.body.getReader();
    const pendingRead = downstream.read();
    await vi.waitFor(() => expect(upstream.body.locked).toBe(true));
    await downstream.cancel("client disconnected");
    await expect(pendingRead).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => expect(upstreamCancel).toHaveBeenCalledOnce());
    expect(upstreamSignal.aborted).toBe(true);
    expect(upstream.body.locked).toBe(false);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("aborts async provider polling sleep before issuing another request", async () => {
    const client = new AbortController();
    global.fetch.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: 200, data: { taskId: "task-cancel" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const pending = handleImageGenerationCore({
      body: { prompt: "cancel polling" },
      modelInfo: { provider: "nanobanana", model: "nanobanana-flash" },
      credentials: { apiKey: "test-key" },
      signal: client.signal,
    });
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    client.abort();

    const result = await pending;
    expect(result).toMatchObject({ success: false, status: 499 });
    expect(global.fetch).toHaveBeenCalledOnce();
  });
});
