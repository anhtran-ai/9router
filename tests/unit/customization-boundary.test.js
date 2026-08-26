import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  loadCustomizationManifest,
  parseNameStatus,
  renderForkDiffInventory,
  validateCustomizationDiff,
  validateInventory,
} from "../../scripts/check-customization-boundary.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = fileURLToPath(new URL("../../docs/CUSTOMIZATIONS.yaml", import.meta.url));

describe("customization boundary guard", () => {
  it("parses the customization manifest", () => {
    const manifest = loadCustomizationManifest(manifestPath);

    expect(manifest.schema_version).toBe(1);
    expect(manifest.upstream_ref).toBe("v0.5.55");
    expect(manifest.boundaries.additive.length).toBeGreaterThan(0);
    expect(manifest.boundaries.modified.length).toBeGreaterThan(0);
  });

  it("accepts the current fork diff from upstream v0.5.55", () => {
    const manifest = loadCustomizationManifest(manifestPath);
    const diff = execFileSync(
      "git",
      ["diff", "--name-status", "--find-renames=100%", `${manifest.upstream_sha}...HEAD`],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(validateCustomizationDiff(manifest, parseNameStatus(diff))).toEqual([]);
  });

  it("keeps the human inventory synchronized with the manifest", () => {
    const manifest = loadCustomizationManifest(manifestPath);
    const inventory = readFileSync(
      new URL("../../docs/FORK_DIFF_INVENTORY.md", import.meta.url),
      "utf8",
    );

    expect(validateInventory(manifest, inventory)).toEqual([]);
  });

  it.each(["\n", "\r\n"])("accepts checkout line endings %j but still rejects stale content", (eol) => {
    const manifest = loadCustomizationManifest(manifestPath);
    const inventory = renderForkDiffInventory(manifest).replaceAll("\n", eol);
    expect(validateInventory(manifest, inventory)).toEqual([]);
    expect(validateInventory(manifest, `${inventory}stale`)).toHaveLength(1);
  });

  it("maps combo failures and hosted tool policy to their regression gates", () => {
    const inventory = renderForkDiffInventory(loadCustomizationManifest(manifestPath));
    const rows = inventory.split("\n").filter(row => row.startsWith("| M |") || row.startsWith("| A |"));
    expect(rows.find(row => row.includes("`open-sse/services/combo.js`"))).toContain("unsupported-tool-fallback.test.js");
    expect(rows.find(row => row.includes("`open-sse/translator/concerns/hostedToolPolicy.js`"))).toContain("hosted-tool-policy.test.js");
  });

  it("renders baseline counts from manifest snapshot fields", () => {
    const manifest = structuredClone(loadCustomizationManifest(manifestPath));
    manifest.fork_snapshot.additive_total = 91;
    manifest.fork_snapshot.modified_total = 82;
    manifest.fork_snapshot.modified_runtime = 73;

    expect(renderForkDiffInventory(manifest)).toContain(
      "`91` additive, `82` modified, `73` modified runtime seams.",
    );
  });

  it("rejects a fixture that modifies a file outside an approved seam", () => {
    const manifest = loadCustomizationManifest(manifestPath);
    const fixture = readFileSync(
      new URL("../fixtures/customization-boundary-outside-seam.diff", import.meta.url),
      "utf8",
    );

    expect(validateCustomizationDiff(manifest, parseNameStatus(fixture))).toEqual([
      "M src/shared/components/ContributorSecretPanel.js is outside approved modified seams",
    ]);
  });
});
