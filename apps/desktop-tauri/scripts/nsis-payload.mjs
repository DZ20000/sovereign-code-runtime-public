import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SAFE_ARCHIVE_PATH = /^[^\0\r\n]{1,512}$/u;

function sameFileIdentity(left, right) {
  if (left.dev === 0 || left.ino === 0 || right.dev === 0 || right.ino === 0) {
    return true;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function assertContainedArchivePath(value) {
  if (
    typeof value !== "string" ||
    !SAFE_ARCHIVE_PATH.test(value) ||
    isAbsolute(value)
  ) {
    throw new Error("NSIS payload path must be one bounded relative archive path.");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("NSIS payload path must stay inside the installer archive.");
  }
  return normalized;
}

async function stableDescriptor(path, logicalPath) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) {
    throw new Error(`Extracted NSIS payload must be one unshared direct regular file: ${path}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    !sameFileIdentity(before, after) ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.length !== before.size
  ) {
    throw new Error(`Extracted NSIS payload changed while it was being verified: ${path}`);
  }
  return {
    path: logicalPath,
    bytes: before.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function regularExecutable(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() ? resolve(path) : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function commandCandidates(environment) {
  const candidates = [];
  if (typeof environment.SCR_7Z_PATH === "string" && environment.SCR_7Z_PATH.trim().length > 0) {
    candidates.push(environment.SCR_7Z_PATH.trim());
  }
  if (typeof environment.ProgramFiles === "string") {
    candidates.push(resolve(environment.ProgramFiles, "7-Zip", "7z.exe"));
  }
  if (typeof environment["ProgramFiles(x86)"] === "string") {
    candidates.push(resolve(environment["ProgramFiles(x86)"], "7-Zip", "7z.exe"));
  }
  if (typeof environment.USERPROFILE === "string") {
    candidates.push(resolve(environment.USERPROFILE, "scoop", "shims", "7z.exe"));
    candidates.push(resolve(environment.USERPROFILE, "scoop", "shims", "7zz.exe"));
  }
  return candidates;
}

export async function resolveSevenZipExecutable(environment = process.env) {
  for (const candidate of commandCandidates(environment)) {
    const executable = await regularExecutable(candidate);
    if (executable !== null) return executable;
  }
  const where = resolve(environment.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
  for (const name of ["7z.exe", "7zz.exe", "7za.exe"]) {
    const result = spawnSync(where, [name], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    if (result.error !== undefined || result.status !== 0) continue;
    for (const line of String(result.stdout ?? "").split(/\r?\n/u)) {
      const value = line.trim();
      if (value.length === 0) continue;
      const executable = await regularExecutable(value);
      if (executable !== null) return executable;
    }
  }
  throw new Error(
    "7-Zip is required to verify the executable embedded in the NSIS installer. Set SCR_7Z_PATH or install 7-Zip.",
  );
}

export async function extractNsisPayloadDescriptor({
  installerPath,
  payloadPath,
  extractorExecutable,
  extractorArgumentsPrefix = [],
  extractorEnvironment = process.env,
}) {
  const installer = resolve(installerPath);
  const logicalPath = assertContainedArchivePath(payloadPath);
  const extractor = extractorExecutable === undefined
    ? await resolveSevenZipExecutable(extractorEnvironment)
    : resolve(extractorExecutable);
  const installerBefore = await stableDescriptor(installer, "installer.exe");
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "scr-nsis-payload-"));
  const extractionRoot = resolve(temporaryRoot, "payload");
  await mkdir(extractionRoot);
  try {
    const result = spawnSync(
      extractor,
      [
        ...extractorArgumentsPrefix,
        "x",
        "-y",
        `-o${extractionRoot}`,
        "--",
        installer,
        logicalPath,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...extractorEnvironment },
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        `7-Zip exited with code ${String(result.status)}.`,
      );
    }
    const installerAfter = await stableDescriptor(installer, "installer.exe");
    if (
      installerAfter.bytes !== installerBefore.bytes ||
      installerAfter.sha256 !== installerBefore.sha256
    ) {
      throw new Error("NSIS installer changed while its payload was being extracted.");
    }
    const extractedPath = resolve(extractionRoot, ...logicalPath.split("/"));
    const realRoot = await realpath(extractionRoot);
    const realFile = await realpath(extractedPath).catch((error) => {
      throw new Error(`NSIS payload was not extracted: ${logicalPath}`, { cause: error });
    });
    const relation = relative(realRoot, realFile);
    if (
      relation === "" ||
      relation === ".." ||
      relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)
    ) {
      throw new Error("Extracted NSIS payload resolves outside the temporary extraction root.");
    }
    return await stableDescriptor(realFile, logicalPath);
  } finally {
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    }).catch(() => undefined);
  }
}
