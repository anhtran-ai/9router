import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
const encoder = new TextEncoder();

const sessionResponse = () => new Response(JSON.stringify({
  code: 0,
  data: { chat_session_id: "session-1", message_id: "message-1" },
}));

function closedEventResponse(text = "") {
  return new Response(new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

const opts = stream => ({
  model: "auto",
  body: { messages: [{ role: "user", content: "hello" }] },
  stream,
  credentials: { accessToken: "token", providerSpecificData: {} },
});

describe("Trae stream integrity", () => {
  beforeEach(() => fetchMock.mockReset());

  it("rejects streaming EOF without an explicit terminal event", async () => {
    fetchMock.mockResolvedValueOnce(sessionResponse()).mockResolvedValueOnce(closedEventResponse(
      'event: plan_item\ndata: {"id":"1","thought":"partial"}\n\n',
    ));

    const result = await new TraeExecutor().execute(opts(true));
    await expect(result.response.text()).rejects.toThrow("without a terminal event");
  });

  it("returns 502 for non-streaming EOF without an explicit terminal event", async () => {
    fetchMock.mockResolvedValueOnce(sessionResponse()).mockResolvedValueOnce(closedEventResponse());

    const result = await new TraeExecutor().execute(opts(false));
    expect(result.response.status).toBe(502);
    await expect(result.response.text()).resolves.toContain("without a terminal event");
  });

  it("rejects malformed event JSON", async () => {
    fetchMock.mockResolvedValueOnce(sessionResponse()).mockResolvedValueOnce(closedEventResponse(
      "event: plan_item\ndata: {broken}\n\n",
    ));

    const result = await new TraeExecutor().execute(opts(true));
    await expect(result.response.text()).rejects.toThrow("malformed JSON");
  });

  it("aborts the upstream GET promptly when the client cancels", async () => {
    let upstreamSignal;
    fetchMock.mockResolvedValueOnce(sessionResponse()).mockImplementationOnce((_url, init) => {
      upstreamSignal = init.signal;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } }));
    });

    const result = await new TraeExecutor().execute(opts(true));
    await result.response.body.cancel("client cancelled");
    expect(upstreamSignal.aborted).toBe(true);
  });

  it("does not start the event GET for an already-aborted stream", async () => {
    const abort = new AbortController();
    abort.abort("client cancelled");
    fetchMock.mockResolvedValueOnce(sessionResponse());

    const result = await new TraeExecutor().execute({ ...opts(true), signal: abort.signal });
    await expect(result.response.text()).resolves.toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
