import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function processIsAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId < 1) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validLock(value) {
  return value !== null &&
    typeof value === "object" &&
    value.schemaVersion === "scr.installer-build-lock/v1" &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    Number.isSafeInteger(value.processId) &&
    value.processId > 0 &&
    typeof value.startedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    typeof value.cwd === "string" &&
    value.cwd.length > 0;
}

async function readLock(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return validLock(value) ? value : null;
  } catch {
    return null;
  }
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameLock(left, right) {
  return left !== null &&
    left.token === right.token &&
    left.processId === right.processId &&
    left.startedAt === right.startedAt &&
    samePath(left.cwd, right.cwd);
}

export async function acquireInstallerBuildLock(
  lockPath,
  { processId = process.pid, now = Date.now(), cwd = process.cwd() } = {},
) {
  const path = resolve(lockPath);
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  const record = {
    schemaVersion: "scr.installer-build-lock/v1",
    token,
    processId,
    startedAt: new Date(now).toISOString(),
    cwd: resolve(cwd),
  };
  let recoveredLock = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { path, token, record, recoveredLock };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readLock(path);
      if (existing === null) {
        throw new Error("Installer build lock is incomplete or invalid; refusing automatic removal.");
      }
      if (!samePath(existing.cwd, record.cwd)) {
        throw new Error("Installer build lock belongs to a different build root; refusing automatic removal.");
      }
      if (!sameLock(await readLock(path), existing)) {
        throw new Error("Installer build lock changed during recovery verification.");
      }
      if (processIsAlive(existing.processId)) {
        throw new Error(`Another installer build is active as PID ${String(existing.processId)}.`);
      }
      await rm(path);
      recoveredLock = existing;
    }
  }
  throw new Error(`Could not acquire installer build lock: ${path}`);
}

export async function releaseInstallerBuildLock(lock) {
  if (lock === null || lock === undefined) return;
  const current = await readLock(lock.path);
  if (current?.token !== lock.token) {
    throw new Error("Installer build lock ownership changed before release.");
  }
  await rm(lock.path, { force: true });
}
