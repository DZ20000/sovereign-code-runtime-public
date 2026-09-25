import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_PORTABLE_COMPONENTS = [
  "renderer-trusted-keys.json",
];

async function runGit(workspaceRoot, args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return result.stdout.trim();
}

export async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function describeFile(path, relativePath) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Release component is not a direct regular file: ${path}`);
  }
  return {
    path: relativePath.replaceAll("\\", "/"),
    bytes: info.size,
    sha256: await sha256File(path),
  };
}

export function parseGitStatus(source) {
  const records = source
    .split(/\r?\n/gu)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return {
    dirty: records.length > 0,
    changeCount: records.length,
  };
}

export async function readGitSource(workspaceRoot) {
  const required = "Source provenance requires a Git clone or registered worktree at the repository root with a checked-out commit. Source archives without .git are not supported for Runtime Host bundles or release packages; see docs/development.md.";
  const sourceRoot = await realpath(workspaceRoot);
  const gitEntry = await lstat(resolve(sourceRoot, ".git")).catch(() => null);
  if (gitEntry === null || gitEntry.isSymbolicLink() || (!gitEntry.isFile() && !gitEntry.isDirectory())) {
    throw new Error(required);
  }
  let commit;
  try {
    const topLevel = await realpath(await runGit(sourceRoot, ["rev-parse", "--show-toplevel"]));
    if (topLevel !== sourceRoot) throw new Error("Git belongs to another source directory.");
    if (gitEntry.isFile()) {
      // A linked worktree has a reciprocal gitdir file. Reject an arbitrary
      // pointer to another checkout's .git, even when Git treats this as its root.
      const gitDirectory = await realpath(await runGit(sourceRoot, ["rev-parse", "--absolute-git-dir"]));
      const backReference = await readFile(resolve(gitDirectory, "gitdir"), "utf8");
      if (await realpath(backReference.trim()) !== await realpath(resolve(sourceRoot, ".git"))) {
        throw new Error("Git worktree registration does not match this source directory.");
      }
    }
    commit = await runGit(sourceRoot, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(required);
  }
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`Git returned an invalid source commit: ${commit}`);
  }
  const shortCommit = await runGit(workspaceRoot, ["rev-parse", "--short=12", "HEAD"]);
  const committedAt = await runGit(workspaceRoot, ["show", "-s", "--format=%cI", "HEAD"]);
  const branch = await runGit(
    workspaceRoot,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
  ).catch(() => "");
  const status = parseGitStatus(await runGit(
    workspaceRoot,
    ["status", "--porcelain=v1", "--untracked-files=normal"],
  ));
  return {
    commit,
    shortCommit,
    branch: branch.length === 0 ? null : branch,
    committedAt,
    dirty: status.dirty,
    changeCount: status.changeCount,
  };
}

export async function readProductMetadata(workspaceRoot, projectRoot) {
  const [workspacePackage, shellPackage, tauriConfig] = await Promise.all([
    readFile(resolve(workspaceRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(projectRoot, "src-tauri", "tauri.conf.json"), "utf8").then(JSON.parse),
  ]);
  const versions = new Set([
    workspacePackage.version,
    shellPackage.version,
    tauriConfig.version,
  ]);
  if (versions.size !== 1 || [...versions].some((value) => typeof value !== "string")) {
    throw new Error(
      `Release versions do not match: workspace=${String(workspacePackage.version)}, shell=${String(shellPackage.version)}, tauri=${String(tauriConfig.version)}`,
    );
  }
  if (
    typeof tauriConfig.productName !== "string" ||
    tauriConfig.productName.trim().length === 0 ||
    typeof tauriConfig.identifier !== "string" ||
    tauriConfig.identifier.trim().length === 0
  ) {
    throw new Error("Tauri product metadata is incomplete.");
  }
  return {
    name: tauriConfig.productName,
    version: tauriConfig.version,
    identifier: tauriConfig.identifier,
    platform: process.platform,
    architecture: process.arch,
  };
}

export function assertPortableRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new Error("Portable component path is invalid.");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    isAbsolute(value) ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Portable component path escapes the package: ${value}`);
  }
  return normalized;
}

function assertContainedFile(portableRoot, relativePath) {
  const normalized = assertPortableRelativePath(relativePath);
  const root = resolve(portableRoot);
  const absolute = resolve(root, ...normalized.split("/"));
  const relativePathFromRoot = relative(root, absolute);
  if (
    relativePathFromRoot === "" ||
    relativePathFromRoot === ".." ||
    relativePathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativePathFromRoot)
  ) {
    throw new Error(`Portable component path is outside the package: ${relativePath}`);
  }
  return { normalized, absolute };
}

export async function verifyPortablePackage(portableRoot, manifestValue = undefined) {
  const manifestPath = resolve(portableRoot, "portable-package.json");
  const manifest = manifestValue ?? JSON.parse(await readFile(manifestPath, "utf8"));
  const problems = [];
  if (manifest?.schemaVersion !== "scr.portable-package/v2") {
    problems.push("portable package schema is not scr.portable-package/v2");
  }
  if (!COMMIT_PATTERN.test(manifest?.source?.commit ?? "")) {
    problems.push("source commit is invalid");
  }
  if (typeof manifest?.source?.dirty !== "boolean") {
    problems.push("source dirty state is missing");
  }
  if (
    typeof manifest?.product?.version !== "string" ||
    manifest.product.version.length === 0
  ) {
    problems.push("product version is missing");
  }
  if (!Array.isArray(manifest?.components) || manifest.components.length === 0) {
    problems.push("portable components are missing");
  }

  const componentChecks = [];
  const seen = new Set();
  const realRoot = await realpath(portableRoot);
  let totalBytes = 0;
  for (const component of Array.isArray(manifest?.components) ? manifest.components : []) {
    try {
      const { normalized, absolute } = assertContainedFile(portableRoot, component?.path);
      if (seen.has(normalized)) {
        throw new Error(`Duplicate portable component: ${normalized}`);
      }
      seen.add(normalized);
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Portable component is not a direct regular file: ${normalized}`);
      }
      const realAbsolute = await realpath(absolute);
      const realRelative = relative(realRoot, realAbsolute);
      if (
        realRelative === "" ||
        realRelative === ".." ||
        realRelative.startsWith(`..${sep}`) ||
        isAbsolute(realRelative)
      ) {
        throw new Error(`Portable component resolves outside the package: ${normalized}`);
      }
      const actualSha256 = await sha256File(realAbsolute);
      const expectedBytes = component?.bytes;
      const expectedSha256 = component?.sha256;
      const matched =
        Number.isSafeInteger(expectedBytes) &&
        expectedBytes >= 0 &&
        expectedBytes === info.size &&
        SHA256_PATTERN.test(expectedSha256 ?? "") &&
        expectedSha256 === actualSha256;
      componentChecks.push({
        path: normalized,
        expectedBytes,
        actualBytes: info.size,
        expectedSha256,
        actualSha256,
        matched,
      });
      if (!matched) {
        problems.push(`portable component does not match its manifest: ${normalized}`);
      }
      totalBytes += info.size;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      componentChecks.push({
        path: typeof component?.path === "string" ? component.path : "<invalid>",
        matched: false,
        error: message,
      });
      problems.push(message);
    }
  }

  for (const requiredPath of REQUIRED_PORTABLE_COMPONENTS) {
    if (!seen.has(requiredPath)) {
      problems.push(`required portable component is missing: ${requiredPath}`);
    }
  }

  if (manifest?.totalBytes !== totalBytes) {
    problems.push(`portable totalBytes mismatch: expected ${String(manifest?.totalBytes)}, actual ${totalBytes}`);
  }
  const executablePath = manifest?.executable?.path;
  const executableComponent = componentChecks.find((component) => component.path === executablePath);
  if (
    executableComponent === undefined ||
    executableComponent.matched !== true ||
    manifest?.executable?.bytes !== executableComponent.actualBytes ||
    manifest?.executable?.sha256 !== executableComponent.actualSha256
  ) {
    problems.push("portable executable metadata does not match its component");
  }

  return {
    passed: problems.length === 0,
    portableRoot: resolve(portableRoot),
    manifestPath,
    manifestSha256: await stat(manifestPath).then(() => sha256File(manifestPath)).catch(() => null),
    sourceCommit: manifest?.source?.commit ?? null,
    sourceDirty: manifest?.source?.dirty ?? null,
    productVersion: manifest?.product?.version ?? null,
    totalBytes,
    componentChecks,
    problems,
  };
}

export async function writeJsonAtomic(path, value) {
  const parent = dirname(path);
  const temporary = resolve(parent, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
