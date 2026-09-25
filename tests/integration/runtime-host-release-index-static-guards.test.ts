import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");

function source(...segments: string[]): string {
  return readFileSync(resolve(root, ...segments), "utf8");
}

describe("Runtime Host release-index managed import guards", () => {
  it("keeps release-index and Runtime candidate trust separate from the untrusted source", () => {
    const format = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "runtime-host-release-index-format.mjs",
    );
    const stage = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "stage-runtime-host-release-index.mjs",
    );

    expect(format).toContain("RELEASE_INDEX_TRUST_SCHEMA_VERSION");
    expect(format).toContain("RUNTIME_TRUST_SCHEMA_VERSION");
    expect(format).toContain("forbiddenRoot");
    expect(format).toContain(
      "may not be supplied by the untrusted release source",
    );
    expect(stage).toContain("indexTrustedKeysPath");
    expect(stage).toContain("runtimeTrustedKeysPath");
    expect(stage).toContain(
      "Release source and managed update root must be separate directory trees.",
    );
  });

  it("verifies signatures, canonical JSON and exact package hashes before publishing", () => {
    const format = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "runtime-host-release-index-format.mjs",
    );
    const stage = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "stage-runtime-host-release-index.mjs",
    );

    expect(format).toContain("must use canonical JSON");
    expect(format).toContain("metadata.nlink !== 1");
    expect(format).toContain("openedBefore.dev !== before.dev");
    expect(format).toContain("openedAfter.ctimeMs !== openedBefore.ctimeMs");
    expect(format).toContain("verifyEd25519Signature(");
    expect(format).toContain(
      "Runtime candidate package does not match its release-index entry.",
    );
    expect(format).toContain(
      "Runtime candidate component size or SHA-256 does not match.",
    );
    expect(stage).toContain("await verifyRuntimeCandidatePackage({");
    expect(stage).toContain("await rename(stagingPath, item.finalPath);");
  });

  it("ratchets index and release sequences through immutable hash-chained receipts", () => {
    const stage = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "stage-runtime-host-release-index.mjs",
    );

    expect(stage).toContain("previousReceiptSha256");
    expect(stage).toContain("receipt chain is broken");
    expect(stage).toContain("receipt sequence did not increase strictly");
    expect(stage).toContain("release-index sequence is a replay");
    expect(stage).toContain("release sequence does not advance monotonically");
    expect(stage).toContain("sequence conflicts with an existing receipt");
  });

  it("keeps the importer local-only and does not add a network or process-execution channel", () => {
    const stage = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "stage-runtime-host-release-index.mjs",
    );
    const format = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "runtime-host-release-index-format.mjs",
    );

    for (const text of [stage, format]) {
      expect(text).not.toMatch(
        /from ["']node:(?:http|https|net|tls|child_process)["']/u,
      );
      expect(text).not.toMatch(
        /\b(?:fetch|spawn|execFile|exec|powershell|pwsh)\s*\(/u,
      );
    }
    expect(stage).not.toContain("installRuntimeCandidateUpdate");
    expect(stage).not.toContain("activateRuntimeCandidateUpdate");
  });

  it("only cleans importer-owned temporary staging and never recursively removes arbitrary paths", () => {
    const stage = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "stage-runtime-host-release-index.mjs",
    );

    expect(stage).toContain("/^\\.import-[a-f0-9]{24}\\.tmp$/u");
    expect(stage).toContain(
      "Refusing to clean a staging directory outside the managed inbox.",
    );
    expect(stage).toContain(
      "Owned Runtime Host import staging contains an unexpected entry; it was not removed.",
    );
    expect(stage).not.toMatch(/\b(?:rm|rmSync|rmdirSync)\s*\(/u);
  });

  it("adds a read-only managed consistency audit without adding install or activation authority", () => {
    const stage = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "stage-runtime-host-release-index.mjs",
    );
    const audit = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "audit-runtime-host-release-index.mjs",
    );

    expect(stage).toContain("auditManagedRuntimeHostReleaseIndex");
    expect(stage).toContain(
      "managed audit is unavailable while an import lock exists",
    );
    expect(stage).toContain("inbox contains an unreceipted release");
    expect(stage).toContain("receipt references a missing inbox package");
    expect(audit).not.toMatch(
      /\b(?:install|activate|download|fetch|spawn|execFile|exec)\s*\(/u,
    );
  });

  it("exposes explicit local staging and audit CLIs from the desktop-tauri package", () => {
    const packageJson = JSON.parse(
      source("apps", "desktop-tauri", "package.json"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["runtime:index:stage"]).toBe(
      "node scripts/stage-runtime-host-release-index.mjs",
    );
    expect(packageJson.scripts?.["runtime:index:audit"]).toBe(
      "node scripts/audit-runtime-host-release-index.mjs",
    );
    expect(packageJson.scripts?.["runtime:index:download"]).toBeUndefined();
    expect(packageJson.scripts?.["runtime:index:activate"]).toBeUndefined();
  });
});
