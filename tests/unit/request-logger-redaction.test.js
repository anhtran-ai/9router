import { describe, expect, it } from "vitest";
import { maskSensitiveHeaders, sanitizeUrl } from "../../open-sse/utils/requestLogger.js";

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
});
