import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { sha256InstallerFile } from "./installer-package.mjs";

const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"];

function sameFileIdentity(left, right) {
  if (left.dev === 0 || left.ino === 0 || right.dev === 0 || right.ino === 0) {
    return true;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isUnsharedDirectRegularFile(info) {
  return info.isFile() && !info.isSymbolicLink() && info.nlink <= 1;
}

async function directRegularFile(path) {
  const info = await lstatIfExists(path);
  if (info === null) return null;
  if (!isUnsharedDirectRegularFile(info)) {
    throw new Error(`Preserved user-data path must be one unshared direct regular file: ${path}`);
  }
  return info;
}

async function stableDirectFileDigest(path) {
  const before = await directRegularFile(path);
  if (before === null) return null;
  const sha256 = await sha256InstallerFile(path);
  const after = await directRegularFile(path);
  if (
    after === null ||
    !sameFileIdentity(before, after) ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new Error(`Preserved user-data file changed while it was being verified: ${path}`);
  }
  return { info: after, sha256 };
}

export function buildPreservedRuntimeDataPaths(userDataRoot) {
  const root = resolve(userDataRoot);
  const databases = [
    resolve(root, "tasks.sqlite"),
    resolve(root, "audit", "audit.sqlite"),
    resolve(root, "audit", "runs.sqlite"),
  ];
  return [
    resolve(root, "settings.json"),
    ...databases.flatMap((database) => SQLITE_SIDECARS.map((suffix) => `${database}${suffix}`)),
  ];
}

export async function capturePreservedFiles(paths, backupRoot) {
  const root = resolve(backupRoot);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Preserved user-data backup root must be one direct directory: ${root}`);
  }
  const realRoot = await realpath(root);
  const snapshots = [];
  const seen = new Set();
  for (let index = 0; index < paths.length; index += 1) {
    const path = resolve(paths[index]);
    const comparable = process.platform === "win32"
      ? path.toLocaleLowerCase("en-US")
      : path;
    if (seen.has(comparable)) {
      throw new Error(`Preserved user-data path is duplicated: ${path}`);
    }
    seen.add(comparable);
    const before = await directRegularFile(path);
    const backupPath = resolve(
      realRoot,
      `${String(index).padStart(2, "0")}-${basename(path) || "preserved-file"}`,
    );
    if (before === null) {
      snapshots.push({ path, backupPath, existed: false, bytes: null, sha256: null });
      continue;
    }
    await copyFile(path, backupPath);
    const [source, backup] = await Promise.all([
      stableDirectFileDigest(path),
      stableDirectFileDigest(backupPath),
    ]);
    if (
      source === null ||
      backup === null ||
      !sameFileIdentity(before, source.info) ||
      source.info.size !== before.size ||
      source.info.mtimeMs !== before.mtimeMs ||
      source.info.ctimeMs !== before.ctimeMs ||
      backup.info.size !== before.size ||
      backup.sha256 !== source.sha256
    ) {
      throw new Error(`Could not capture one stable preserved user-data file: ${path}`);
    }
    snapshots.push({
      path,
      backupPath,
      existed: true,
      bytes: before.size,
      sha256: source.sha256,
    });
  }
  return snapshots;
}

export async function verifyPreservedFiles(snapshots) {
  const checks = [];
  for (const snapshot of snapshots) {
    const initial = await lstatIfExists(snapshot.path);
    if (initial !== null && !isUnsharedDirectRegularFile(initial)) {
      checks.push({
        ...snapshot,
        actualExists: true,
        actualBytes: null,
        actualSha256: null,
        matched: false,
      });
      continue;
    }
    const actual = initial === null ? null : await stableDirectFileDigest(snapshot.path);
    if (!snapshot.existed) {
      checks.push({
        ...snapshot,
        actualExists: actual !== null,
        actualBytes: actual?.info.size ?? null,
        actualSha256: actual?.sha256 ?? null,
        matched: actual === null,
      });
      continue;
    }
    checks.push({
      ...snapshot,
      actualExists: actual !== null,
      actualBytes: actual?.info.size ?? null,
      actualSha256: actual?.sha256 ?? null,
      matched: actual !== null &&
        actual.info.size === snapshot.bytes &&
        actual.sha256 === snapshot.sha256,
    });
  }
  return checks;
}

export function preservedFilesMatched(checks) {
  return checks.every((check) => check.matched === true);
}

export async function readVerifiedPreservedFile(snapshot) {
  if (!snapshot.existed) return null;
  const before = await directRegularFile(snapshot.backupPath);
  if (before === null) {
    throw new Error(`Preserved user-data backup is missing: ${snapshot.backupPath}`);
  }
  const bytes = await readFile(snapshot.backupPath);
  const after = await directRegularFile(snapshot.backupPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    after === null ||
    !sameFileIdentity(before, after) ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    bytes.length !== snapshot.bytes ||
    sha256 !== snapshot.sha256
  ) {
    throw new Error(`Preserved user-data backup is missing or corrupt: ${snapshot.backupPath}`);
  }
  return bytes;
}

async function verifyBackupsForRestore(snapshots) {
  for (const snapshot of snapshots) {
    if (!snapshot.existed) continue;
    const backup = await stableDirectFileDigest(snapshot.backupPath);
    if (
      backup === null ||
      backup.info.size !== snapshot.bytes ||
      backup.sha256 !== snapshot.sha256
    ) {
      throw new Error(`Preserved user-data backup is missing or corrupt: ${snapshot.backupPath}`);
    }
  }
}

async function assertCurrentPathsSafeToReplace(snapshots) {
  for (const snapshot of snapshots) {
    const info = await lstatIfExists(snapshot.path);
    if (info === null) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
      throw new Error(`Refusing to replace a non-regular preserved user-data path: ${snapshot.path}`);
    }
  }
}

export async function restorePreservedFiles(snapshots) {
  await verifyBackupsForRestore(snapshots);
  await assertCurrentPathsSafeToReplace(snapshots);
  const staged = new Map();
  try {
    for (const snapshot of snapshots) {
      if (!snapshot.existed) continue;
      await mkdir(dirname(snapshot.path), { recursive: true });
      const temporary = `${snapshot.path}.restore-${process.pid}-${randomUUID()}.tmp`;
      await copyFile(snapshot.backupPath, temporary);
      const temporaryCheck = await stableDirectFileDigest(temporary);
      if (
        temporaryCheck === null ||
        temporaryCheck.info.size !== snapshot.bytes ||
        temporaryCheck.sha256 !== snapshot.sha256
      ) {
        throw new Error(`Restored temporary user-data file is invalid: ${temporary}`);
      }
      staged.set(snapshot.path, temporary);
    }

    for (const snapshot of snapshots) {
      if (!snapshot.existed) {
        await rm(snapshot.path, { force: true });
        continue;
      }
      const temporary = staged.get(snapshot.path);
      if (temporary === undefined) {
        throw new Error(`Restored temporary user-data file is missing: ${snapshot.path}`);
      }
      await rm(snapshot.path, { force: true });
      await rename(temporary, snapshot.path);
      staged.delete(snapshot.path);
    }
  } finally {
    await Promise.all(
      [...staged.values()].map((temporary) =>
        rm(temporary, { force: true }).catch(() => undefined)
      ),
    );
  }
  const restoredChecks = await verifyPreservedFiles(snapshots);
  if (!preservedFilesMatched(restoredChecks)) {
    throw new Error("Restored user-data files do not match their verified backup.");
  }
  return restoredChecks;
}
