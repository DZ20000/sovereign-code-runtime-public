import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  INSTALLER_PACKAGE_SCHEMA_VERSION,
  assertSafeInstallerRelativePath,
  buildRecoveryExecutableOrder,
  parseInstallerPackage,
  sha256InstallerFile,
  verifyInstalledExecutable,
  verifyInstallerPackage,
} from "../../apps/desktop-tauri/scripts/installer-package.mjs";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-installer-package-"));
  cleanup.push(root);
  const installerPath = join(root, "Sovereign Code Runtime_0.1.0_x64-setup.exe");
  const installedPayloadPath = join(root, "installed-payload.exe");
  await writeFile(installerPath, Buffer.from("immutable installer payload"));
  await writeFile(installedPayloadPath, Buffer.from("immutable installed application payload"));
  const manifest = {
    schemaVersion: INSTALLER_PACKAGE_SCHEMA_VERSION,
    createdAt: "2026-08-20T00:00:00.000Z",
    product: {
      name: "Sovereign Code Runtime",
      version: "0.1.0",
      identifier: "com.sovereign.runtime",
      platform: "win32",
      architecture: "x64",
    },
    source: {
      commit: "a".repeat(40),
      shortCommit: "a".repeat(12),
      branch: "feature/update-cutover",
      committedAt: "2026-08-20T00:00:00.000Z",
      dirty: false,
      changeCount: 0,
    },
    installer: {
      path: "Sovereign Code Runtime_0.1.0_x64-setup.exe",
      bytes: (await readFile(installerPath)).byteLength,
      sha256: await sha256InstallerFile(installerPath),
    },
    installedExecutable: {
      path: "sovereign-desktop-tauri.exe",
      bytes: (await readFile(installedPayloadPath)).byteLength,
      sha256: await sha256InstallerFile(installedPayloadPath),
    },
  };
  const manifestPath = join(root, "installer-package.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { root, installerPath, installedPayloadPath, manifestPath, manifest };
}

describe("installer package and cutover recovery", () => {
  it("parses one exact immutable installer package manifest", async () => {
    const { manifest } = await fixture();
    expect(parseInstallerPackage(manifest)).toEqual(manifest);
    expect(() => parseInstallerPackage({ ...manifest, unexpected: true })).toThrow(
      "fields do not match",
    );
  });

  it("rejects absolute and traversal component paths", () => {
    expect(() => assertSafeInstallerRelativePath("../setup.exe")).toThrow("contained relative path");
    expect(() => assertSafeInstallerRelativePath("C:\\setup.exe")).toThrow("contained relative path");
    expect(() => assertSafeInstallerRelativePath("folder//setup.exe")).toThrow("contained relative path");
  });

  it("verifies the installer against its co-produced immutable manifest", async () => {
    const { manifestPath, manifest } = await fixture();
    const verification = await verifyInstallerPackage(manifestPath);
    expect(verification).toMatchObject({
      passed: true,
      manifest,
      installerCheck: { matched: true },
      problems: [],
    });
  });

  it("detects installer replacement without consulting a later mutable release build", async () => {
    const { manifestPath, installerPath } = await fixture();
    await writeFile(installerPath, Buffer.from("later unrelated installer build"));
    const verification = await verifyInstallerPackage(manifestPath);
    expect(verification.passed).toBe(false);
    expect(verification.installerCheck.matched).toBe(false);
    expect(verification.problems).toContain(
      "installer executable does not match its immutable manifest",
    );
  });

  it("rejects hard-linked installer and installed-executable paths", async () => {
    const { root, installerPath, installedPayloadPath, manifestPath, manifest } = await fixture();
    await link(installerPath, join(root, "installer-hard-link.exe"));
    await expect(verifyInstallerPackage(manifestPath)).rejects.toThrow("unshared direct regular file");

    const directPath = join(root, "sovereign-desktop-tauri.exe");
    await writeFile(directPath, await readFile(installedPayloadPath));
    await link(directPath, join(root, "installed-hard-link.exe"));
    await expect(
      verifyInstalledExecutable(directPath, manifest.installedExecutable),
    ).rejects.toThrow("unshared direct regular file");
  });

  it("verifies installed bytes against the hash captured when the installer was built", async () => {
    const { root, installedPayloadPath, manifest } = await fixture();
    const directPath = join(root, "sovereign-desktop-tauri.exe");
    await writeFile(directPath, await readFile(installedPayloadPath));
    await expect(
      verifyInstalledExecutable(directPath, manifest.installedExecutable),
    ).resolves.toMatchObject({ exists: true, matched: true });

    await writeFile(directPath, Buffer.from("subsequent non-installer build"));
    await expect(
      verifyInstalledExecutable(directPath, manifest.installedExecutable),
    ).resolves.toMatchObject({ exists: true, matched: false });
  });

  it("always prefers the newly installed path and deduplicates previous shell paths", () => {
    const installed = resolve("C:/Users/Test/AppData/Local/Programs/Sovereign/sovereign.exe");
    const oldPortable = resolve("D:/Sovereign/SovereignCodeRuntime.exe");
    expect(buildRecoveryExecutableOrder(installed, [oldPortable, installed, oldPortable])).toEqual([
      installed,
      oldPortable,
    ]);
  });

  it("does not use mutable target/release output during install-time verification", async () => {
    const script = await readFile(
      resolve(
        process.cwd(),
        "apps",
        "desktop-tauri",
        "scripts",
        "install-nsis-and-restart.mjs",
      ),
      "utf8",
    );
    expect(script).not.toContain("target/release/sovereign-desktop-tauri.exe");
    expect(script).toContain("manifest.installedExecutable");
    expect(script).toContain("stageVerifiedInstaller");
    expect(script).toContain("runInstaller(stagedInstaller.path)");
    expect(script).toContain('spawnSync(installerPath, ["/S", "/UPDATE"]');
    expect(script).toContain(
      "if (shutdownStarted && !launched && preservationRecoveryError === null)",
    );
    expect(script).toContain("captureRecoveryExecutable");
    expect(script).toContain("installedRecoveryCheck.matched");
    expect(script).toContain("firstVerifiedPreviousRecoveryExecutable");
    expect(script).not.toContain("firstExistingExecutable");
    expect(script).toContain("recovery launch");
  });

  it("binds installed-executable verification to the executable extracted from NSIS", async () => {
    const script = await readFile(
      resolve(
        process.cwd(),
        "apps",
        "desktop-tauri",
        "scripts",
        "package-installer.mjs",
      ),
      "utf8",
    );
    expect(script).toContain("extractNsisPayloadDescriptor");
    expect(script).toContain('payloadPath: "sovereign-desktop-tauri.exe"');
    expect(script).toContain("installedExecutable,");
    expect(script).toContain("releaseExecutableMatchesPayload");
    expect(script).not.toContain('installedExecutable: await describeFile(releaseExecutable');
  });


  it("delegates guarded shutdown to the identity-bound installed process tree", async () => {
    const script = await readFile(
      resolve(
        process.cwd(),
        "apps",
        "desktop-tauri",
        "scripts",
        "install-nsis-and-restart.mjs",
      ),
      "utf8",
    );
    const processes = await readFile(resolve(process.cwd(), "apps/desktop-tauri/scripts/installer-processes.mjs"), "utf8");
    expect(script).toContain('from "./installer-processes.mjs"');
    expect(script).toContain("await stopInstalledApplication(installedExecutable, initialProcesses)");
    expect(processes).toContain("assertRestartTargetUnchanged(current.snapshot, expected.target)");
    expect(processes).toContain("trackRestartTree(current.snapshot, expected.processes)");
    expect(processes).toContain("stopRestartTree(remaining.processes)");
    expect(processes).toContain("await waitForTreeExit(remaining.processes, 10_000)");
    expect(processes).toContain("The selected installed process tree is still running; installation did not start.");
    expect(script + processes).not.toContain("@((Get-Guardians) + (Get-RuntimeHosts))");
  });

});
