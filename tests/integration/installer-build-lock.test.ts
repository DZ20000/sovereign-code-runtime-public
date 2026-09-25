import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireInstallerBuildLock,
  releaseInstallerBuildLock,
} from "../../apps/desktop-tauri/scripts/installer-build-lock.mjs";

const cleanup: string[] = [];
const deadProcessId = 2_147_483_647;

function deadOwnerRecord(root: string) {
  return {
    schemaVersion: "scr.installer-build-lock/v1" as const,
    token: "stale-token",
    processId: deadProcessId,
    startedAt: new Date().toISOString(),
    cwd: root,
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installer build lock", () => {
  it("rejects a concurrent live build and releases only its own token", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-installer-lock-"));
    cleanup.push(root);
    const path = join(root, "installer.lock");
    const lock = await acquireInstallerBuildLock(path, { cwd: root });

    await expect(
      acquireInstallerBuildLock(path, { cwd: root }),
    ).rejects.toThrow("Another installer build is active");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      processId: process.pid,
      token: lock.token,
      cwd: root,
    });
    await releaseInstallerBuildLock(lock);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a candidate-local lock as soon as its owner exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-installer-lock-recover-"));
    cleanup.push(root);
    const path = join(root, "installer.lock");
    const original = deadOwnerRecord(root);
    await writeFile(path, JSON.stringify(original), "utf8");

    const lock = await acquireInstallerBuildLock(path, { cwd: root });
    expect(lock.recoveredLock).toEqual(original);
    expect(lock.token).not.toBe(original.token);
    expect(lock.record).toMatchObject({
      processId: process.pid,
      cwd: root,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(lock.record);
    await releaseInstallerBuildLock(lock);
  });

  it("preserves a dead-owner lock from another build root", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-installer-lock-foreign-"));
    cleanup.push(root);
    const path = join(root, "installer.lock");
    const original = deadOwnerRecord(join(root, "other"));
    await writeFile(path, JSON.stringify(original), "utf8");

    await expect(
      acquireInstallerBuildLock(path, { cwd: root }),
    ).rejects.toThrow("different build root");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
  });

  it("preserves an incomplete lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-installer-lock-partial-"));
    cleanup.push(root);
    const path = join(root, "installer.lock");
    await writeFile(path, "", "utf8");

    await expect(
      acquireInstallerBuildLock(path, { cwd: root }),
    ).rejects.toThrow("incomplete or invalid");
    await expect(readFile(path, "utf8")).resolves.toBe("");
  });

  it("refuses to remove a lock after ownership changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-installer-lock-owner-"));
    cleanup.push(root);
    const path = join(root, "installer.lock");
    const lock = await acquireInstallerBuildLock(path, { cwd: root });
    await writeFile(
      path,
      JSON.stringify({ ...lock.record, token: "other" }),
      "utf8",
    );

    await expect(releaseInstallerBuildLock(lock)).rejects.toThrow(
      "ownership changed",
    );
  });
});
