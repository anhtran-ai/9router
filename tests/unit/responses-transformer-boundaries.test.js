import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  createResponsesApiTransformStream,
  createResponsesLogger,
} from "../../open-sse/transformer/responsesTransformer.js";

async function runTransform(chunks) {
  const transform = createResponsesApiTransformStream();
  const reader = transform.readable.getReader();
  const writer = transform.writable.getWriter();
  const output = [];
  const consume = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output.push(value);
    }
  })();
  const produce = (async () => {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  })();

  const [produced, consumed] = await Promise.allSettled([produce, consume]);
  if (produced.status === "rejected") throw produced.reason;
  if (consumed.status === "rejected") throw consumed.reason;
  return new TextDecoder().decode(Buffer.concat(output.map((chunk) => Buffer.from(chunk))));
}

describe("dormant Responses transformer boundary safety", () => {
  it("preserves split UTF-8 and parses CRLF/CR/LF SSE frame separators", async () => {
    const encoder = new TextEncoder();
    const first = encoder.encode(`data: ${JSON.stringify({
      id: "chat-1",
      choices: [{ index: 0, delta: { content: "🙂" }, finish_reason: null }],
    })}\r\n\r\n`);
    const emojiStart = first.indexOf(0xf0);

    const output = await runTransform([
      first.slice(0, emojiStart + 2),
      first.slice(emojiStart + 2, first.length - 3), // ends at the first CR
      first.slice(first.length - 3),                 // starts with LF (split CRLF)
      encoder.encode(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "B" }, finish_reason: null }],
      })}\r\r`),
      encoder.encode(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`),
    ]);

    const events = output.split(/\r?\n/)
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const text = events
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("🙂B");
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
  });

  it("accepts [DONE] as a terminal marker only after semantic output", async () => {
    const output = await runTransform([
      new TextEncoder().encode(`data: ${JSON.stringify({
        id: "chat-2",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      })}\n\ndata: [DONE]\n\n`),
    ]);

    expect(output).toContain('"type":"response.completed"');
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("accepts an OpenAI usage-only chunk between finish_reason and [DONE]", async () => {
    const encoder = new TextEncoder();
    const output = await runTransform([encoder.encode([
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"))]);

    expect(output.match(/"type":"response.completed"/g)).toHaveLength(1);
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it.each([
    ["an empty stream", []],
    ["a bare DONE marker", [new TextEncoder().encode("data: [DONE]\n\n")]],
    ["malformed JSON", [new TextEncoder().encode("data: {bad}\n\n")]],
    ["an upstream error envelope", [new TextEncoder().encode('data: {"error":{"message":"bad gateway payload"}}\n\n')]],
    ["a missing terminal marker", [new TextEncoder().encode(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    })}\n\n`)]],
  ])("rejects %s instead of synthesizing a successful response", async (_label, chunks) => {
    await expect(runTransform(chunks)).rejects.toThrow("Invalid upstream Chat Completions stream");
  });

  it("rejects invalid UTF-8 in a successful SSE protocol", async () => {
    const prefix = new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"');
    const suffix = new TextEncoder().encode('"},"finish_reason":"stop"}]}\n\n');
    const invalid = new Uint8Array(prefix.length + 2 + suffix.length);
    invalid.set(prefix);
    invalid.set([0xc3, 0x28], prefix.length);
    invalid.set(suffix, prefix.length + 2);

    await expect(runTransform([invalid])).rejects.toThrow();
  });

  it("rejects semantic response data after completion", async () => {
    const encoder = new TextEncoder();
    const terminal = JSON.stringify({
      choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
    });
    const late = JSON.stringify({
      choices: [{ index: 0, delta: { content: "late" }, finish_reason: null }],
    });

    await expect(runTransform([
      encoder.encode(`data: ${terminal}\n\ndata: ${late}\n\n`),
    ])).rejects.toThrow("after the terminal event");
  });

  it("keeps an untrusted model id inside one sanitized log-directory segment", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-responses-"));
    try {
      const logger = createResponsesLogger("../../escape\\bad:model\0?", baseDir);
      expect(logger).not.toBeNull();
      logger.logInput("input");
      logger.logOutput("output");
      logger.flush();

      const logsDir = path.join(baseDir, "logs");
      const entries = fs.readdirSync(logsDir, { withFileTypes: true });
      expect(entries).toHaveLength(1);
      expect(entries[0].isDirectory()).toBe(true);
      expect(entries[0].name).not.toMatch(/[\\/:]/);
      expect(fs.readFileSync(path.join(logsDir, entries[0].name, "1_input_stream.txt"), "utf8")).toBe("input");
      expect(fs.existsSync(path.join(baseDir, "escape"))).toBe(false);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
