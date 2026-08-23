import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  loadCustomizationManifest,
  parseNameStatus,
  validateCustomizationDiff,
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
      ["diff", "--name-status", "--find-renames=100%", `${manifest.upstream_ref}...HEAD`],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(validateCustomizationDiff(manifest, parseNameStatus(diff))).toEqual([]);
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
