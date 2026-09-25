import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

const rendererUpdate = source(
  "apps/desktop-tauri/src-tauri/src/renderer_update.rs",
);
const runtimeGuard = source(
  "apps/desktop-tauri/src-tauri/src/renderer_update/release_guard.rs",
);
const releaseGuard = source("scripts/renderer-release-guard.mjs");

describe("Renderer release runtime gate static guards", () => {
  it("keeps the Shell validator on the canonical activation lease protocol", () => {
    for (const schema of [
      "scr.renderer-activation-lease/v1",
      "scr.renderer-release-provenance/v1",
    ]) {
      expect(releaseGuard).toContain(schema);
      expect(runtimeGuard).toContain(schema);
    }
    for (const obsoleteSchema of [
      "scr.renderer-release-lease/v1",
      "scr.renderer-release-manifest-binding/v1",
      "scr.renderer-release-settlement/v1",
    ]) {
      expect(runtimeGuard).not.toContain(obsoleteSchema);
      expect(rendererUpdate).not.toContain(obsoleteSchema);
    }
    expect(
      existsSync(
        new URL(
          "../../apps/desktop-tauri/scripts/renderer-release-coordination.mjs",
          import.meta.url,
        ),
      ),
    ).toBe(false);
  });

  it("rechecks the held guard before development install, preflight and activation", () => {
    expect(rendererUpdate).toContain(
      "self.require_release_guard(&candidate_ref)?;",
    );
    expect(rendererUpdate).toContain(
      "self.require_release_guard(&installed.release)?;",
    );
    expect(rendererUpdate).toContain(
      "self.verify_release_guard_against(&installed.release, &state.persisted.revision)?;",
    );
    expect(rendererUpdate).toContain(
      'release.channel != "development"',
    );
  });

  it("enables the gate only for the real Shell manager", () => {
    expect(rendererUpdate).toContain(
      "Self::from_parts(root, built_in_url, Vec::new(), false)",
    );
    expect(rendererUpdate).toContain(
      "Self::from_parts(root, built_in_url, trusted_keys, true)",
    );
    expect(rendererUpdate).toContain("release_guard_required: bool");
  });

  it("keeps the new gate and split tests within reviewable source bounds", () => {
    const testModule = source(
      "apps/desktop-tauri/src-tauri/src/renderer_update/tests.rs",
    );
    expect(runtimeGuard.split(/\r?\n/u).length).toBeLessThan(700);
    expect(rendererUpdate.split(/\r?\n/u).length).toBeLessThan(3_500);
    expect(testModule.split(/\r?\n/u).length).toBeLessThan(1_200);
  });
});
