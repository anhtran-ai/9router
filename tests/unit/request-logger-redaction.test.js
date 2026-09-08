import { describe, expect, it } from "vitest";
import {
  maskSensitiveHeaders,
  sanitizeLogText,
  sanitizeLogValue,
  sanitizeUrl,
} from "../../open-sse/utils/requestLogger.js";

describe("request logger credential redaction", () => {
  it("redacts credential headers without retaining a recognizable token fragment", () => {
    const result = maskSensitiveHeaders({
      Authorization: "Bearer sk-super-secret-value",
      Cookie: "session=top-secret",
      "X-API-Key": "provider-api-key",
      "Ocp-Apim-Subscription-Key": "azure-subscription-secret",
      "X-Auth": "custom-auth-secret",
      "CF-Access-Jwt-Assertion": "signed-jwt",
      Accept: "application/json",
    });

    expect(result).toEqual({
      Authorization: "[redacted]",
      Cookie: "[redacted]",
      "X-API-Key": "[redacted]",
      "Ocp-Apim-Subscription-Key": "[redacted]",
      "X-Auth": "[redacted]",
      "CF-Access-Jwt-Assertion": "[redacted]",
      Accept: "application/json",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("provider-api-key");
  });

  it("supports Headers instances and redacts response cookies", () => {
    const result = maskSensitiveHeaders(new Headers({
      "set-cookie": "auth_token=secret",
      "content-type": "application/json",
    }));

    expect(result["set-cookie"]).toBe("[redacted]");
    expect(result["content-type"]).toBe("application/json");
  });

  it("redacts URL userinfo and sensitive query parameters", () => {
    const result = sanitizeUrl(
      "https://user:password@provider.example/v1/models?key=vertex-secret&access_token=oauth-secret&subscription-key=azure-secret&access_key=aws-secret&auth_key=custom-secret&APIKey=compact-secret&model=safe"
    );
    const parsed = new URL(result);

    expect(decodeURIComponent(parsed.username)).toBe("[redacted]");
    expect(decodeURIComponent(parsed.password)).toBe("[redacted]");
    expect(parsed.searchParams.get("key")).toBe("[redacted]");
    expect(parsed.searchParams.get("access_token")).toBe("[redacted]");
    expect(parsed.searchParams.get("subscription-key")).toBe("[redacted]");
    expect(parsed.searchParams.get("access_key")).toBe("[redacted]");
    expect(parsed.searchParams.get("auth_key")).toBe("[redacted]");
    expect(parsed.searchParams.get("APIKey")).toBe("[redacted]");
    expect(parsed.searchParams.get("model")).toBe("safe");
    expect(result).not.toContain("vertex-secret");
    expect(result).not.toContain("oauth-secret");
  });

  it("fails closed instead of retaining a malformed URL containing a credential", () => {
    const result = sanitizeUrl("http://[::1?api_key=must-not-survive");
    expect(result).toBe("[invalid-url-redacted]");
    expect(result).not.toContain("must-not-survive");
  });

  it("sanitizes relative client endpoints without converting them to a fake host", () => {
    const result = sanitizeUrl("/v1/messages?api_key=secret&stream=true");
    expect(result).toBe("/v1/messages?api_key=%5Bredacted%5D&stream=true");
  });

  it("redacts nested MCP credentials and credentials inside nested URLs", () => {
    const result = sanitizeLogValue({
      tools: [{
        type: "mcp",
        authorization: "Bearer nested-secret",
        headers: {
          "x-api-key": "nested-key",
          Accept: "application/json",
        },
        server_url: "https://mcp.example/tools?access_token=url-secret&mode=safe",
      }],
    });

    expect(result.tools[0]).toMatchObject({
      authorization: "[redacted]",
      headers: { "x-api-key": "[redacted]", Accept: "application/json" },
    });
    expect(new URL(result.tools[0].server_url).searchParams.get("access_token")).toBe("[redacted]");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("nested-secret");
    expect(serialized).not.toContain("nested-key");
    expect(serialized).not.toContain("url-secret");
  });

  it("omits credential-bearing binary payloads and terminates on cycles/deep values", () => {
    const cyclic = { payload: new Uint8Array([115, 101, 99, 114, 101, 116]) };
    cyclic.self = cyclic;
    const cyclicResult = sanitizeLogValue(cyclic);

    expect(cyclicResult.payload).toContain("binary payload omitted");
    expect(cyclicResult.self).toBe("[circular]");
    expect(JSON.stringify(cyclicResult)).not.toContain('"0":115');
    expect(JSON.stringify(cyclicResult)).not.toContain("secret");

    let deep = {};
    for (let i = 0; i < 30; i++) {
      deep = { child: deep };
    }

    const result = sanitizeLogValue(deep);
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("log value truncated");
  });

  it("redacts credentials embedded in logged error text", () => {
    const result = sanitizeLogText(
      "request failed Authorization: Bearer top-secret at https://provider.example/path?api_key=url-secret",
    );

    expect(result).not.toContain("top-secret");
    expect(result).not.toContain("url-secret");
    expect(result).toContain("[redacted]");
  });

  it("redacts credentials in raw JSON and URL strings", () => {
    const rawJson = JSON.stringify({
      authorization: "Bearer raw-secret",
      headers: { "x-api-key": "raw-api-key" },
      server_url: "https://mcp.example/run?access_token=raw-url-token&mode=safe",
    });

    const sanitizedJson = sanitizeLogValue(rawJson);
    const sanitizedUrl = sanitizeLogValue("https://provider.example/v1?api_key=raw-query-key&mode=safe");

    expect(typeof sanitizedJson).toBe("string");
    expect(sanitizedJson).not.toContain("raw-secret");
    expect(sanitizedJson).not.toContain("raw-api-key");
    expect(sanitizedJson).not.toContain("raw-url-token");
    expect(sanitizedJson).toContain("[redacted]");
    expect(sanitizedUrl).not.toContain("raw-query-key");
    expect(sanitizedUrl).toContain("%5Bredacted%5D");
  });

  it("sanitizes Maps and never throws for accessor/proxy-backed values", () => {
    const mapped = sanitizeLogValue(new Map([
      ["authorization", "Bearer map-secret"],
      ["safe", "visible"],
    ]));
    const accessor = {};
    Object.defineProperty(accessor, "safe", {
      enumerable: true,
      get() { throw new Error("getter must not run"); },
    });
    const brokenProxy = new Proxy({}, {
      ownKeys() { throw new Error("proxy trap"); },
    });

    expect(mapped).toMatchObject({ authorization: "[redacted]", safe: "visible" });
    expect(sanitizeLogValue(accessor)).toMatchObject({ safe: "[accessor omitted]" });
    expect(sanitizeLogValue(brokenProxy)).toBe("[unserializable]");
    expect(maskSensitiveHeaders(brokenProxy)).toEqual({ "[headers]": "[unserializable]" });
  });

  it("omits binary values passed to the text sanitizer", () => {
    const result = sanitizeLogText(new Uint8Array([115, 101, 99, 114, 101, 116]));

    expect(result).toContain("binary payload omitted");
    expect(result).not.toContain("115,101,99");
  });
});
