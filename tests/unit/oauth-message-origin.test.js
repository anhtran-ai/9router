import { describe, expect, it } from "vitest";
import {
  isLoopbackOAuthHostname,
  isTrustedOAuthMessageEvent,
  isTrustedOAuthMessageOrigin,
} from "../../src/shared/utils/oauthOrigin.js";

describe("OAuth postMessage origin policy", () => {
  it.each([
    "http://localhost:1455",
    "https://localhost:56121",
    "http://127.0.0.1:1455",
    "http://[::1]:1455",
  ])("accepts only the exact configured HTTP(S) loopback callback origin: %s", (origin) => {
    expect(isTrustedOAuthMessageOrigin(origin, "https://router.example", origin)).toBe(true);
  });

  it("rejects an arbitrary loopback origin that was not configured for the flow", () => {
    expect(isTrustedOAuthMessageOrigin(
      "http://127.42.7.9:9999",
      "https://router.example",
      "http://localhost:1455",
    )).toBe(false);
  });

  it.each([
    "https://localhost.attacker.test",
    "https://127.0.0.1.attacker.test",
    "https://attacker.test/path/localhost",
    "ftp://localhost/callback",
    "null",
    "not a URL",
  ])("rejects a deceptive or unsupported origin: %s", (origin) => {
    expect(isTrustedOAuthMessageOrigin(origin, "https://router.example")).toBe(false);
  });

  it("accepts the exact application origin", () => {
    expect(isTrustedOAuthMessageOrigin("https://router.example", "https://router.example")).toBe(true);
  });

  it("classifies loopback hostnames without substring matching", () => {
    expect(isLoopbackOAuthHostname("localhost")).toBe(true);
    expect(isLoopbackOAuthHostname("127.255.255.254")).toBe(true);
    expect(isLoopbackOAuthHostname("::1")).toBe(true);
    expect(isLoopbackOAuthHostname("localhost.attacker.test")).toBe(false);
    expect(isLoopbackOAuthHostname("128.0.0.1")).toBe(false);
  });

  it("requires the exact popup, origin and OAuth state together", () => {
    const popup = {};
    const base = {
      origin: "http://localhost:1455",
      source: popup,
      data: { type: "oauth_callback", data: { code: "code", state: "state-1" } },
    };
    const options = {
      applicationOrigin: "https://router.example",
      expectedCallbackOrigin: "http://localhost:1455/callback",
      expectedPopup: popup,
      expectedState: "state-1",
    };
    expect(isTrustedOAuthMessageEvent(base, options)).toBe(true);
    expect(isTrustedOAuthMessageEvent({ ...base, source: {} }, options)).toBe(false);
    expect(isTrustedOAuthMessageEvent({ ...base, origin: "http://localhost:9999" }, options)).toBe(false);
    expect(isTrustedOAuthMessageEvent({
      ...base,
      data: { type: "oauth_callback", data: { code: "code", state: "wrong" } },
    }, options)).toBe(false);
  });
});
