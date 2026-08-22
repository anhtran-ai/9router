import { describe, expect, it } from "vitest";

import { hasSpecializedExecutor } from "open-sse/executors/index.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import claudeRegistry from "open-sse/providers/registry/claude.js";
import { __test__ } from "@/dashboardGuard";

function providerIds() {
  return REGISTRY.map((entry) => entry.id);
}

describe("v0.5.55 upgrade keeps Azox-scoped providers wired", () => {
  it("keeps the qwen registry entry reachable", () => {
    expect(providerIds()).toContain("qwen");
  });

  it("keeps qwen and opencode-go specialized executors registered", () => {
    expect(hasSpecializedExecutor("qwen")).toBe(true);
    expect(hasSpecializedExecutor("opencode-go")).toBe(true);
  });

  it("keeps the qwen OAuth refresh grant config-driven", () => {
    const qwen = REGISTRY.find((entry) => entry.id === "qwen");
    expect(qwen.oauth.refresh).toEqual({ encoding: "form" });
    expect(qwen.oauth.tokenUrl).toBeTruthy();
    expect(qwen.oauth.clientId).toBeTruthy();
  });

  it("keeps the claudeOverlay header hook on the claude transport", () => {
    expect(claudeRegistry.transport.auth.hooks).toContain("claudeOverlay");
  });
});

describe("v0.5.55 upgrade keeps both public API allowlists", () => {
  it("keeps the contributor entry point public", () => {
    expect(__test__.isPublicApi("/api/contribute/session")).toBe(true);
  });

  it("adopts the upstream SAML entry point", () => {
    expect(__test__.isPublicApi("/api/auth/saml/acs")).toBe(true);
  });

  it("still denies contributor-admin and combo transfer by default", () => {
    expect(__test__.isPublicApi("/api/contributor-admin/invites")).toBe(false);
    expect(__test__.isPublicApi("/api/import-export/combos")).toBe(false);
  });
});
