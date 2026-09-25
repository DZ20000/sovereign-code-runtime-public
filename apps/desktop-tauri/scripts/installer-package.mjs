import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const INSTALLER_PACKAGE_SCHEMA_VERSION = "scr.installer-package/v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_RELATIVE_PATH_PATTERN = /^[^\0\r\n]{1,512}$/u;

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    throw new Error(`${label} fields do not match the installer package schema.`);
  }
}

function requiredString(value, label, maximum = 4_096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requiredSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256 digest.`);
  }
  return value;
}

function requiredBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function assertSafeInstallerRelativePath(value, label = "Installer component path") {
  const path = requiredString(value, label, 512).replaceAll("\\", "/");
  if (
    !SAFE_RELATIVE_PATH_PATTERN.test(path) ||
    isAbsolute(path) ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be one contained relative path.`);
  }
  return path;
}

function parseFileDescriptor(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertExactKeys(value, ["path", "bytes", "sha256"], label);
  return {
    path: assertSafeInstallerRelativePath(value.path, `${label} path`),
    bytes: requiredBytes(value.bytes, `${label} byte length`),
    sha256: requiredSha256(value.sha256, `${label} SHA-256`),
  };
}

export function parseInstallerPackage(value) {
  if (!isRecord(value)) {
    throw new Error("Installer package manifest must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "createdAt",
      "product",
      "source",
      "installer",
      "installedExecutable",
    ],
    "Installer package manifest",
  );
  if (value.schemaVersion !== INSTALLER_PACKAGE_SCHEMA_VERSION) {
    throw new Error("Unsupported installer package schema.");
  }
  const createdAt = requiredString(value.createdAt, "Installer package creation time", 64);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("Installer package creation time is invalid.");
  }
  if (!isRecord(value.product)) {
    throw new Error("Installer product metadata must be an object.");
  }
  assertExactKeys(
    value.product,
    ["name", "version", "identifier", "platform", "architecture"],
    "Installer product metadata",
  );
  if (!isRecord(value.source)) {
    throw new Error("Installer source metadata must be an object.");
  }
  assertExactKeys(
    value.source,
    ["commit", "shortCommit", "branch", "committedAt", "dirty", "changeCount"],
    "Installer source metadata",
  );
  const commit = requiredString(value.source.commit, "Installer source commit", 40);
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("Installer source commit is invalid.");
  }
  const branch = value.source.branch === null
    ? null
    : requiredString(value.source.branch, "Installer source branch", 512);
  if (
    typeof value.source.dirty !== "boolean" ||
    !Number.isSafeInteger(value.source.changeCount) ||
    value.source.changeCount < 0
  ) {
    throw new Error("Installer source dirty state is invalid.");
  }
  const committedAt = requiredString(value.source.committedAt, "Installer source commit time", 64);
  if (!Number.isFinite(Date.parse(committedAt))) {
    throw new Error("Installer source commit time is invalid.");
  }
  return {
    schemaVersion: INSTALLER_PACKAGE_SCHEMA_VERSION,
    createdAt,
    product: {
      name: requiredString(value.product.name, "Installer product name", 256),
      version: requiredString(value.product.version, "Installer product version", 64),
      identifier: requiredString(value.product.identifier, "Installer product identifier", 256),
      platform: requiredString(value.product.platform, "Installer product platform", 32),
      architecture: requiredString(value.product.architecture, "Installer product architecture", 32),
    },
    source: {
      commit,
      shortCommit: requiredString(value.source.shortCommit, "Installer short commit", 40),
      branch,
      committedAt,
      dirty: value.source.dirty,
      changeCount: value.source.changeCount,
    },
    installer: parseFileDescriptor(value.installer, "Installer executable"),
    installedExecutable: parseFileDescriptor(
      value.installedExecutable,
      "Installed application executable",
    ),
  };
}

export async function sha256InstallerFile(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

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

async function readStableDirectRegularFile(path, label, allowMissing = false) {
  const before = await lstatIfExists(path);
  if (before === null) {
    if (allowMissing) return null;
    throw new Error(`${label} is missing: ${path}`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) {
    throw new Error(`${label} must be one unshared direct regular file.`);
  }
  const bytes = await readFile(path);
  const after = await lstatIfExists(path);
  if (
    after === null ||
    !sameFileIdentity(before, after) ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    bytes.length !== before.size
  ) {
    throw new Error(`${label} changed while it was being verified.`);
  }
  return {
    info: after,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function verifyContainedRegularFile(root, descriptor, label) {
  const absolutePath = resolve(root, ...descriptor.path.split("/"));
  const relation = relative(root, absolutePath);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error(`${label} escapes the installer package directory.`);
  }
  const file = await readStableDirectRegularFile(absolutePath, label);
  const realRoot = await realpath(root);
  const realFile = await realpath(absolutePath);
  const realRelation = relative(realRoot, realFile);
  if (
    realRelation === "" ||
    realRelation === ".." ||
    realRelation.startsWith(`..${sep}`) ||
    isAbsolute(realRelation)
  ) {
    throw new Error(`${label} resolves outside the installer package directory.`);
  }
  const matched = file.info.size === descriptor.bytes && file.sha256 === descriptor.sha256;
  return {
    path: absolutePath,
    expectedBytes: descriptor.bytes,
    actualBytes: file.info.size,
    expectedSha256: descriptor.sha256,
    actualSha256: file.sha256,
    matched,
  };
}

export async function verifyInstallerPackage(manifestPath) {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestFile = await readStableDirectRegularFile(
    absoluteManifestPath,
    "Installer package manifest",
  );
  if (manifestFile.info.size < 1 || manifestFile.info.size > 512 * 1024) {
    throw new Error("Installer package manifest must be one bounded direct regular file.");
  }
  const manifest = parseInstallerPackage(JSON.parse(manifestFile.bytes.toString("utf8")));
  const packageRoot = dirname(absoluteManifestPath);
  const installerCheck = await verifyContainedRegularFile(
    packageRoot,
    manifest.installer,
    "Installer executable",
  );
  const problems = [];
  if (!installerCheck.matched) {
    problems.push("installer executable does not match its immutable manifest");
  }
  if (manifest.product.platform !== "win32") {
    problems.push("installer package is not a Windows build");
  }
  const manifestAfter = await readStableDirectRegularFile(
    absoluteManifestPath,
    "Installer package manifest",
  );
  if (manifestAfter.sha256 !== manifestFile.sha256) {
    throw new Error("Installer package manifest changed during verification.");
  }
  const installerAfter = await verifyContainedRegularFile(
    packageRoot,
    manifest.installer,
    "Installer executable",
  );
  if (
    installerAfter.actualSha256 !== installerCheck.actualSha256 ||
    installerAfter.actualBytes !== installerCheck.actualBytes
  ) {
    throw new Error("Installer executable changed during package verification.");
  }
  const manifestSha256 = manifestFile.sha256;
  return {
    passed: problems.length === 0,
    manifest,
    manifestPath: absoluteManifestPath,
    manifestSha256,
    packageRoot,
    installerPath: installerCheck.path,
    installerCheck,
    problems,
  };
}

export function buildRecoveryExecutableOrder(installedExecutable, previousShellExecutables = []) {
  const values = [installedExecutable, ...previousShellExecutables]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => resolve(value));
  const seen = new Set();
  return values.filter((value) => {
    const key = process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function verifyInstalledExecutable(installedExecutable, descriptor) {
  const path = resolve(installedExecutable);
  const file = await readStableDirectRegularFile(
    path,
    "Installed application executable",
    true,
  );
  if (file === null) {
    return {
      path,
      exists: false,
      matched: false,
      expectedBytes: descriptor.bytes,
      actualBytes: null,
      expectedSha256: descriptor.sha256,
      actualSha256: null,
    };
  }
  return {
    path,
    exists: true,
    matched: file.info.size === descriptor.bytes && file.sha256 === descriptor.sha256,
    expectedBytes: descriptor.bytes,
    actualBytes: file.info.size,
    expectedSha256: descriptor.sha256,
    actualSha256: file.sha256,
  };
}
