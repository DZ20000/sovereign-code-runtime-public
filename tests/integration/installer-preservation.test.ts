import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPreservedRuntimeDataPaths,
  capturePreservedFiles,
  preservedFilesMatched,
  readVerifiedPreservedFile,
  restorePreservedFiles,
  verifyPreservedFiles,
} from "../../apps/desktop-tauri/scripts/installer-preservation.mjs";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-installer-preservation-"));
  cleanup.push(root);
  const userData = join(root, "user-data");
  const backup = join(root, "backup");
  const database = join(userData, "tasks.sqlite");
  const wal = join(userData, "tasks.sqlite-wal");
  const shm = join(userData, "tasks.sqlite-shm");
  await mkdir(userData, { recursive: true });
  await writeFile(database, Buffer.from("database-before-install"));
  await writeFile(wal, Buffer.from("wal-before-install"));
  return { root, userData, backup, database, wal, shm };
}

describe("installer user-data preservation", () => {
  it("enumerates settings plus task, audit and run SQLite files with every sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-installer-preservation-paths-"));
    cleanup.push(root);
    const paths = buildPreservedRuntimeDataPaths(root);
    expect(paths).toEqual([
      resolve(root, "settings.json"),
      resolve(root, "tasks.sqlite"),
      resolve(root, "tasks.sqlite-wal"),
      resolve(root, "tasks.sqlite-shm"),
      resolve(root, "tasks.sqlite-journal"),
      resolve(root, "audit", "audit.sqlite"),
      resolve(root, "audit", "audit.sqlite-wal"),
      resolve(root, "audit", "audit.sqlite-shm"),
      resolve(root, "audit", "audit.sqlite-journal"),
      resolve(root, "audit", "runs.sqlite"),
      resolve(root, "audit", "runs.sqlite-wal"),
      resolve(root, "audit", "runs.sqlite-shm"),
      resolve(root, "audit", "runs.sqlite-journal"),
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("detects mutations, restores existing files and removes newly created sidecars", async () => {
    const { backup, database, wal, shm } = await fixture();
    const snapshots = await capturePreservedFiles([database, wal, shm], backup);
    expect(snapshots.map((entry) => entry.existed)).toEqual([true, true, false]);
    expect(preservedFilesMatched(await verifyPreservedFiles(snapshots))).toBe(true);

    await writeFile(database, Buffer.from("installer-mutated-database"));
    await rm(wal, { force: true });
    await writeFile(shm, Buffer.from("installer-created-sidecar"));
    expect(preservedFilesMatched(await verifyPreservedFiles(snapshots))).toBe(false);

    const restored = await restorePreservedFiles(snapshots);
    expect(preservedFilesMatched(restored)).toBe(true);
    await expect(readFile(database, "utf8")).resolves.toBe("database-before-install");
    await expect(readFile(wal, "utf8")).resolves.toBe("wal-before-install");
    await expect(readFile(shm)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads preserved settings only after re-verifying the backup bytes", async () => {
    const { backup, database } = await fixture();
    const [snapshot] = await capturePreservedFiles([database], backup);
    if (snapshot === undefined) throw new Error("Database snapshot missing.");
    await expect(readVerifiedPreservedFile(snapshot)).resolves.toEqual(
      Buffer.from("database-before-install"),
    );
    await writeFile(snapshot.backupPath, Buffer.from("tampered-backup"));
    await expect(readVerifiedPreservedFile(snapshot)).rejects.toThrow("missing or corrupt");
  });

  it("verifies every backup before deleting a current user-data file", async () => {
    const { backup, database, wal, shm } = await fixture();
    const snapshots = await capturePreservedFiles([database, wal, shm], backup);
    const databaseSnapshot = snapshots[0];
    if (databaseSnapshot === undefined) throw new Error("Database snapshot missing.");
    await writeFile(databaseSnapshot.backupPath, Buffer.from("corrupt-backup"));
    await writeFile(database, Buffer.from("current-file-must-survive"));

    await expect(restorePreservedFiles(snapshots)).rejects.toThrow("missing or corrupt");
    await expect(readFile(database, "utf8")).resolves.toBe("current-file-must-survive");
  });

  it("stages every verified restore file before replacing current data", async () => {
    const { backup, database, wal, shm } = await fixture();
    const snapshots = await capturePreservedFiles([database, wal, shm], backup);
    const walSnapshot = snapshots[1];
    if (walSnapshot === undefined) throw new Error("WAL snapshot missing.");
    await writeFile(walSnapshot.backupPath, Buffer.from("corrupt-wal-backup"));
    await writeFile(database, Buffer.from("current-database-must-survive"));

    await expect(restorePreservedFiles(snapshots)).rejects.toThrow("missing or corrupt");
    await expect(readFile(database, "utf8")).resolves.toBe("current-database-must-survive");
  });

  it("refuses to replace a directory or other non-regular current path", async () => {
    const { backup, database } = await fixture();
    const snapshots = await capturePreservedFiles([database], backup);
    await rm(database, { force: true });
    await mkdir(database);

    await expect(restorePreservedFiles(snapshots)).rejects.toThrow("Refusing to replace");
    await expect(readFile(database)).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("rejects duplicate and hard-linked source paths", async () => {
    const { userData, backup, database } = await fixture();
    await expect(capturePreservedFiles([database, database], backup)).rejects.toThrow("duplicated");

    const hardLink = join(userData, "tasks-linked.sqlite");
    await link(database, hardLink);
    await expect(capturePreservedFiles([database], join(backup, "hard-link"))).rejects.toThrow(
      "unshared direct regular file",
    );
  });

  it("treats an all-absent database set as an immutable empty set", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-installer-preservation-empty-"));
    cleanup.push(root);
    const paths = [
      join(root, "tasks.sqlite"),
      join(root, "tasks.sqlite-wal"),
      join(root, "tasks.sqlite-shm"),
      join(root, "tasks.sqlite-journal"),
    ];
    const snapshots = await capturePreservedFiles(paths, join(root, "backup"));
    expect(snapshots.every((entry) => !entry.existed)).toBe(true);
    expect(preservedFilesMatched(await verifyPreservedFiles(snapshots))).toBe(true);
    await writeFile(paths[0]!, Buffer.from("unexpected"));
    expect(preservedFilesMatched(await verifyPreservedFiles(snapshots))).toBe(false);
    await restorePreservedFiles(snapshots);
    await expect(readFile(paths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures settled persistent data after shutdown and verifies it before relaunch", async () => {
    const script = await readFile(
      join(
        process.cwd(),
        "apps",
        "desktop-tauri",
        "scripts",
        "install-nsis-and-restart.mjs",
      ),
      "utf8",
    );
    const installerStage = script.indexOf("stagedInstaller = await stageVerifiedInstaller");
    const shutdownComplete = script.indexOf("await stopInstalledApplication(installedExecutable, initialProcesses)");
    const preservationCapture = script.indexOf("preservedSnapshots = await capturePreservedFiles");
    const settingsBackupRead = script.indexOf("readVerifiedPreservedFile(settingsSnapshot)");
    const stagedInstallerVerification = script.indexOf("const stagedInstallerCheck");
    const replaceabilityGate = script.indexOf(
      "assertInstalledExecutableReplaceable(installedExecutable)",
    );
    const installerMutationBoundary = script.indexOf("installerMutationStarted = true;");
    const installerRun = script.indexOf("runInstaller(stagedInstaller.path)");
    const preservationVerification = script.indexOf(
      "const postInstallChecks = await verifyPreservedFiles",
    );
    const applicationLaunch = script.indexOf("const processId = launchDetached(installedExecutable)");
    expect(installerStage).toBeGreaterThan(0);
    expect(shutdownComplete).toBeGreaterThan(installerStage);
    expect(preservationCapture).toBeGreaterThan(shutdownComplete);
    expect(settingsBackupRead).toBeGreaterThan(preservationCapture);
    expect(stagedInstallerVerification).toBeGreaterThan(settingsBackupRead);
    expect(replaceabilityGate).toBeGreaterThan(stagedInstallerVerification);
    expect(installerMutationBoundary).toBeGreaterThan(replaceabilityGate);
    expect(installerRun).toBeGreaterThan(installerMutationBoundary);
    expect(preservationVerification).toBeGreaterThan(installerRun);
    expect(applicationLaunch).toBeGreaterThan(preservationVerification);
    expect(script).toContain("buildPreservedRuntimeDataPaths(userDataRoot)");
    expect(script).toContain("restorePreservedFiles(preservedSnapshots)");
    expect(script).toContain("removed verified preservation backup after successful relaunch");
    expect(script).toContain("preservationBackupCleaned");
    expect(script).toContain("allowInstalledExecutablePath: !installerMutationStarted");
    expect(script).toContain("before NSIS mutation a hash-verified previous shell may recover from the installed path");
    expect(script).toContain("Refusing to install a package produced from a dirty Git worktree.");
  });
});
