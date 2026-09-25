import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("real NSIS install coverage", () => {
  it("exposes an explicit two-pass install/reinstall smoke rather than treating dry-run as coverage", () => {
    const packageJson = JSON.parse(
      source("apps", "desktop-tauri", "package.json"),
    ) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(packageJson.scripts["smoke:installer-install:dry-run"]).toBe(
      "node scripts/smoke-installer-install.mjs --dry-run --passes 2",
    );
    expect(packageJson.scripts["smoke:installer-install"]).toBe(
      "node scripts/smoke-installer-install.mjs --apply --passes 2",
    );
    expect(packageJson.scripts["verify:installed"]).toBe(
      "node scripts/verify-installed-nsis.mjs --require-running",
    );

    const smoke = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "smoke-installer-install.mjs",
    );
    const cutover = smoke.indexOf('"--worker"');
    const userData = smoke.indexOf("cutover.userDataPreserved !== true");
    const verifier = smoke.indexOf("verifierScript,", userData);
    expect(cutover).toBeGreaterThan(0);
    expect(userData).toBeGreaterThan(cutover);
    expect(verifier).toBeGreaterThan(userData);
    expect(smoke).toContain("cutover.preservationBackupCleaned !== true");
    expect(smoke).toContain('"--require-running"');
    expect(smoke).toContain("Choose exactly one of --apply or --dry-run.");
  });

  it("verifies the installed payload, resources, shell integration and optional permission migration", () => {
    const verifier = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "verify-installed-nsis.mjs",
    );
    expect(verifier).toContain("verifyInstalledExecutable");
    expect(verifier).toContain("runtimeComponentChecks");
    expect(verifier).toContain("NSIS uninstaller");
    expect(verifier).toContain("Desktop shortcut");
    expect(verifier).toContain("Start Menu shortcut");
    expect(verifier).toContain(
      "Current-user uninstall registry entry is missing.",
    );
    expect(verifier).toContain(
      "Windows login startup does not target the verified installed executable.",
    );
    expect(verifier).toContain(
      "The verified installed executable is not running.",
    );
    expect(verifier).toContain("--permission-model-version");
    expect(verifier).toContain("--expect-profile");
    expect(verifier).toContain("--expect-fallback");
    expect(verifier).toContain("--expect-workspace-restore");
  });

  it("exposes a read-only installed UI audit with opt-in screenshot evidence", () => {
    const packageJson = JSON.parse(
      source("apps", "desktop-tauri", "package.json"),
    ) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const audit = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "installed-ui-audit.mjs",
    );
    const powershell = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "installed-ui-audit-powershell.mjs",
    );
    const renderer = source(
      "apps",
      "desktop-tauri",
      "scripts",
      "installed-renderer-state-audit.mjs",
    );

    expect(packageJson.scripts["audit:installed-ui"]).toBe(
      "node scripts/installed-ui-audit.mjs",
    );
    expect(audit).toContain("--capture-screenshot");
    expect(audit).toContain("--expect-pid");
    expect(audit).toContain("--expect-release");
    expect(audit).toContain("--expect-version");
    expect(audit).toContain("input: source");
    expect(audit).toContain("mkdtemp");
    expect(audit).toContain("sameScreenshotFileIdentity");
    expect(audit).toContain("info.nlink !== 1n");
    expect(audit).toContain("MAX_INSTALLED_UI_SCREENSHOT_BYTES");
    expect(audit).toContain("does not match the allocated destination");
    expect(audit).not.toContain("lstat(observation.screenshot.path)");
    expect(audit).not.toContain("-EncodedCommand");
    expect(powershell).toContain("Get-CimInstance Win32_Process");
    expect(powershell).toContain("IsHungAppWindow");
    expect(powershell).toContain("DwmGetWindowAttribute");
    expect(powershell).toContain("TopLevelWindowsForProcess");
    expect(powershell).toContain("Tauri Window");
    expect(powershell).toContain("UIAutomationClient");
    expect(powershell).toContain("msedgewebview2.exe");
    expect(powershell).toContain("PrintWindow");
    expect(powershell).toContain("sampledColors.Count -ge 4");
    expect(powershell).not.toContain("Start-Process");
    expect(powershell).not.toContain("SetForegroundWindow");
    expect(powershell).not.toContain("InvokePattern");
    expect(renderer).toContain("entrypointMatched");
    expect(renderer).toContain("one bounded direct regular file");
    expect(renderer).toContain("resolves outside its expected parent");
  });
});
