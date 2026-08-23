import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const oauthModalSource = fs.readFileSync(
  path.join(repoRoot, "src/shared/components/OAuthModal.js"),
  "utf-8"
);
const contributorPageSource = fs.readFileSync(
  path.join(repoRoot, "src/app/contribute/page.js"),
  "utf-8"
);
const oauthServicesIndexSource = fs.readFileSync(
  path.join(repoRoot, "src/lib/oauth/services/index.js"),
  "utf-8"
);

describe("OAuthModal apiBase seam", () => {
  it("keeps the dashboard OAuth API prefix as the default", () => {
    expect(oauthModalSource).toMatch(/apiBase\s*=\s*["']\/api\/oauth["']/);
    expect(oauthModalSource).toMatch(/apiBase:\s*PropTypes\.string/);
  });

  it("routes every OAuth endpoint through apiBase", () => {
    expect(oauthModalSource).not.toContain("/api/oauth/");
    const endpointCalls = oauthModalSource.match(/(?:fetch|new URL)\(\s*[`"'][^`"']*\/(?:authorize|exchange|poll|poll-status|device-code|manual-code|start-proxy|stop-proxy|register-session|ide-status)/g) || [];
    expect(endpointCalls.length).toBeGreaterThan(0);
    for (const call of endpointCalls) {
      expect(call).toContain("${apiBase}");
    }
  });

  it("uses the contributor-scoped OAuth API prefix", () => {
    expect(contributorPageSource).toMatch(
      /<OAuthModal[\s\S]*?apiBase=["']\/api\/contribute\/oauth["'][\s\S]*?\/>/
    );
  });

  it("keeps the OAuth service barrel identical to upstream formatting", () => {
    expect(oauthServicesIndexSource).toMatch(/export \{ CursorService \} from "\.\/cursor\.js";\n\n$/);
  });
});
