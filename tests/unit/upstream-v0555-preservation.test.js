import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { hasSpecializedExecutor } from "open-sse/executors/index.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import claudeRegistry from "open-sse/providers/registry/claude.js";
import { PROVIDERS as OAUTH_PROVIDERS } from "@/lib/oauth/providers/index.js";
import { __test__ } from "@/dashboardGuard";

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function matchingLines(relativePath, pattern) {
  return source(relativePath).split("\n").filter((line) => pattern.test(line));
}

function providerIds() {
  return REGISTRY.map((entry) => entry.id);
}

describe("Plan 2 cleanup returns out-of-scope runtime code upstream", () => {
  it("removes the fork-only qwen Code provider and specialized executor", () => {
    expect(providerIds()).not.toContain("qwen");
    expect(hasSpecializedExecutor("qwen")).toBe(false);
    expect(OAUTH_PROVIDERS).not.toHaveProperty("qwen");
  });

  it("uses the upstream transport path instead of the old opencode-go executor", () => {
    expect(providerIds()).toContain("opencode-go");
    expect(hasSpecializedExecutor("opencode-go")).toBe(false);
  });

  it("removes qwen Code files and wiring while preserving generic model support", () => {
    const removedFiles = [
      "../../open-sse/providers/registry/qwen.js",
      "../../open-sse/executors/qwen.js",
      "../../src/lib/oauth/providers/qwen.js",
      "../../src/lib/oauth/services/qwen.js",
    ];

    for (const relativePath of removedFiles) {
      expect(existsSync(new URL(relativePath, import.meta.url))).toBe(false);
    }

    expect(source("../../open-sse/executors/index.js")).not.toMatch(/QwenExecutor|\.\/qwen\.js/);
    expect(source("../../open-sse/executors/default.js")).not.toMatch(/^\s*qwen:\s/m);
    expect(source("../../open-sse/providers/registry/index.js")).not.toMatch(/\.\/qwen\.js/);
    expect(source("../../src/lib/oauth/providers/index.js")).not.toMatch(/\.\/qwen\.js|^\s*qwen,?\s*$/m);
    expect(source("../../src/lib/oauth/services/index.js")).not.toMatch(/QwenService|\.\/qwen\.js/);

    expect(matchingLines("../../open-sse/providers/pricing.js", /qwen/i)).toHaveLength(20);
    expect(matchingLines("../../open-sse/providers/capabilities.js", /qwen/i)).toHaveLength(16);
    expect(matchingLines("../../open-sse/providers/models/schema.js", /qwen/i)).toHaveLength(2);
  });

  it("removes the dead claudeOverlay header hook", () => {
    expect(claudeRegistry.transport.auth.hooks || []).not.toContain("claudeOverlay");
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
