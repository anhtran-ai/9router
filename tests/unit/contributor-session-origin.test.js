import { describe, expect, it } from "vitest";

import { isSameOrigin } from "../../src/lib/contributor/session.js";

describe("contributor same-origin policy", () => {
  it("rejects a cross-site navigation even when the browser omits Origin", () => {
    const request = new Request("https://router.example/api/contribute/oauth/claude/start-proxy", {
      headers: {
        host: "router.example",
        "sec-fetch-site": "cross-site",
      },
    });

    expect(isSameOrigin(request)).toBe(false);
  });

  it("keeps direct navigation compatible when Origin is absent", () => {
    const request = new Request("https://router.example/api/contribute/oauth/claude/authorize", {
      headers: {
        host: "router.example",
        "sec-fetch-site": "none",
      },
    });

    expect(isSameOrigin(request)).toBe(true);
  });
});
