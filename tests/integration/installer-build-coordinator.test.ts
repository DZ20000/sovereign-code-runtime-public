import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("installer build coordinator", () => {
  it("routes every installer package script through one serialized build transaction", async () => {
    const packageJson = JSON.parse(await readFile(
      resolve(process.cwd(), "apps", "desktop-tauri", "package.json"),
      "utf8",
    ));
    expect(packageJson.scripts.make).toBe("node scripts/build-installer.mjs");
    expect(packageJson.scripts["package:installer"]).toBe("node scripts/build-installer.mjs");
    expect(packageJson.scripts["package:installer:dry-run"])
      .toBe("node scripts/build-installer.mjs --dry-run");

    const scriptsRoot = resolve(process.cwd(), "apps", "desktop-tauri", "scripts");
    const script = await readFile(resolve(scriptsRoot, "build-installer.mjs"), "utf8");
    const source = script.indexOf("const source = await readGitSource");
    const lock = script.indexOf("lock = await acquireInstallerBuildLock");
    const clean = script.indexOf("await rm(installerRoot");
    const build = script.indexOf('[tauriCli, "build"]');
    const packageStep = script.indexOf("[packageScript]");
    const sourceCheck = script.indexOf('assertSourceUnchanged(source, await readGitSource(workspaceRoot), "installer packaging")');
    const release = script.lastIndexOf("releaseInstallerBuildLock");
    expect(source).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(source);
    expect(clean).toBeGreaterThan(lock);
    expect(build).toBeGreaterThan(clean);
    expect(packageStep).toBeGreaterThan(build);
    expect(sourceCheck).toBeGreaterThan(packageStep);
    expect(release).toBeGreaterThan(sourceCheck);
    expect(script).toContain("cwd: projectRoot");
    expect(script).toContain("lock.recoveredLock");
    expect(script).toContain("Recovered candidate-local installer build lock");
    expect(script).toContain("Installer source changed during");
    expect(script).not.toContain("--recover-stale-lock");

    const lockScript = await readFile(resolve(scriptsRoot, "installer-build-lock.mjs"), "utf8");
    expect(lockScript).toContain("samePath(existing.cwd, record.cwd)");
    expect(lockScript).toContain("processIsAlive(existing.processId)");
    expect(lockScript).toContain("recoveredLock = existing");
    expect(lockScript).not.toContain("Get-CimInstance");
    expect(lockScript).not.toContain("recoverInstallerBuildLock");
    expect(lockScript).not.toContain("staleAfterMs");
  });

  it("describes the exact build commands without mutating a dirty worktree", () => {
    const projectRoot = resolve(process.cwd(), "apps", "desktop-tauri");
    const script = resolve(projectRoot, "scripts", "build-installer.mjs");
    const result = spawnSync(process.execPath, [script, "--dry-run"], {
      cwd: projectRoot,
      encoding: "utf8",
      shell: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({
      dryRun: true,
      buildCommand: [process.execPath, expect.stringContaining("@tauri-apps"), "build"],
      packageCommand: [process.execPath, expect.stringContaining("package-installer.mjs")],
    });
    expect(plan).not.toHaveProperty("staleLockRecoveryCommand");
  });
});
