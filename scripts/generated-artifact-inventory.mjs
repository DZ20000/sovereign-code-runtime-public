#!/usr/bin/env node

import { lstat, mkdir, opendir, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  basename,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const GENERATED_ARTIFACT_INVENTORY_SCHEMA_VERSION =
  "scr.generated-artifact-inventory/v1";

const DEFAULT_MAXIMUM_ENTRIES = 100_000;
const MAXIMUM_ENTRY_LIMIT = 1_000_000;
const REPORT_ROOT = ".sovereign/reports";
const DELETION_FLAGS = new Set(["--delete", "--remove", "--clean", "--prune"]);
const OPTION_FLAGS = new Set(["--root", "--output", "--max-entries"]);
const BUILD_OUTPUT_NAMES = new Set([
  "dist",
  "build",
  "out",
  "target",
  "artifacts",
  "coverage",
]);
const VISUAL_OUTPUT_NAMES = new Set([
  "visual-artifacts",
  ".visual-final",
  ".visual-artifacts",
  "visual-output",
]);
const BUILD_CACHE_NAMES = new Set([
  ".cache",
  ".turbo",
  ".vite",
  ".parcel-cache",
  ".eslintcache",
  "cargo-target",
]);
const DEPENDENCY_CACHE_NAMES = new Set([
  "node_modules",
  ".pnpm-store",
  ".gradle",
  ".dart_tool",
]);
const REVIEW_ONLY_NAMES = new Map([
  ["runtime-resources", ["prepared-runtime-resource", "build-input-review"]],
  [".local-research", ["local-research", "operator-review-required"]],
  [".so-automation", ["local-automation", "operator-review-required"]],
]);
const TEMPORARY_FILE_PATTERN = /(?:\.tmp|\.temp|\.bak|\.backup|\.old)$/iu;
const LOG_FILE_PATTERN = /\.log$/iu;

function fail(message) {
  const bounded = String(message)
    .replace(/[\0\r\n]+/gu, " ")
    .slice(0, 1_000);
  throw new Error(bounded);
}

function runGit(root, args, { input = undefined, allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input,
    shell: false,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    fail(
      result.stderr || result.stdout || `Git command failed: ${args.join(" ")}`,
    );
  }
  return result;
}

function isFilesystemRoot(candidate) {
  const normalized = resolve(candidate);
  return (
    normalized.toLowerCase() === resolve(parse(normalized).root).toLowerCase()
  );
}

function contained(root, candidate) {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function portablePath(value, label, { extension = null } = {}) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    /[\0\r\n]/u.test(value) ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    fail(`${label} contains an unsafe path segment.`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255,
    )
  ) {
    fail(`${label} contains an unsafe path segment.`);
  }
  if (extension !== null && !value.toLowerCase().endsWith(extension)) {
    fail(`${label} must use the ${extension} extension.`);
  }
  return value;
}

function positiveInteger(value, label, maximum = MAXIMUM_ENTRY_LIMIT) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail(
      `${label} must be a positive safe integer no greater than ${maximum}.`,
    );
  }
  return parsed;
}

function toPortable(root, candidate) {
  return relative(root, candidate).split(sep).join("/");
}

async function traversalDirectory(root, candidate) {
  const metadata = await lstat(candidate).catch(() => null);
  if (
    metadata === null ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory()
  ) {
    return null;
  }
  const canonical = await realpath(candidate).catch(() => null);
  if (
    canonical === null ||
    !contained(root.canonical, canonical) ||
    resolve(candidate).toLowerCase() !== resolve(canonical).toLowerCase()
  ) {
    return null;
  }
  return canonical;
}

async function exactGitRoot(candidate) {
  const lexical = resolve(candidate);
  if (isFilesystemRoot(lexical)) {
    fail("Generated-artifact inventory refuses a filesystem or volume root.");
  }
  const metadata = await lstat(lexical).catch((error) => {
    fail(`Inventory root is unavailable: ${error?.code ?? "FS_ERROR"}`);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("Inventory root must be a direct Git worktree directory.");
  }
  const canonical = await realpath(lexical);
  if (isFilesystemRoot(canonical)) {
    fail("Generated-artifact inventory refuses a filesystem or volume root.");
  }
  const gitRootResult = runGit(lexical, ["rev-parse", "--show-toplevel"]);
  const gitRoot = resolve(gitRootResult.stdout.trim());
  const canonicalGitRoot = await realpath(gitRoot);
  if (
    lexical.toLowerCase() !== gitRoot.toLowerCase() ||
    canonical.toLowerCase() !== canonicalGitRoot.toLowerCase()
  ) {
    fail("Inventory root must be the exact Git worktree root.");
  }
  return Object.freeze({ path: lexical, canonical });
}

function classifyCandidateName(name, kind) {
  const lower = name.toLowerCase();
  if (lower === ".worktrees") {
    return Object.freeze({
      category: "worktree-container",
      fixedRisk: "active-worktree-container",
    });
  }
  if (DEPENDENCY_CACHE_NAMES.has(lower)) {
    return Object.freeze({
      category: "dependency-cache",
      fixedRisk: "reinstallable-review",
    });
  }
  const review = REVIEW_ONLY_NAMES.get(lower);
  if (review !== undefined) {
    return Object.freeze({ category: review[0], fixedRisk: review[1] });
  }
  if (VISUAL_OUTPUT_NAMES.has(lower) || lower.includes("visual-artifact")) {
    return Object.freeze({ category: "visual-test-output", fixedRisk: null });
  }
  if (BUILD_OUTPUT_NAMES.has(lower)) {
    return Object.freeze({ category: "build-output", fixedRisk: null });
  }
  if (BUILD_CACHE_NAMES.has(lower)) {
    return Object.freeze({ category: "build-cache", fixedRisk: null });
  }
  if (kind !== "directory" && LOG_FILE_PATTERN.test(lower)) {
    return Object.freeze({ category: "diagnostic-log", fixedRisk: null });
  }
  if (kind !== "directory" && TEMPORARY_FILE_PATTERN.test(lower)) {
    return Object.freeze({ category: "temporary-file", fixedRisk: null });
  }
  return null;
}

async function discoverCandidates(root, budget) {
  const candidates = new Map();
  const stack = [root.path];
  while (stack.length > 0) {
    const directoryPath = stack.pop();
    const canonicalDirectory = await traversalDirectory(root, directoryPath);
    if (canonicalDirectory === null) {
      if (directoryPath === root.path) {
        fail("Inventory root could not be traversed directly.");
      }
      continue;
    }
    void canonicalDirectory;
    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch (error) {
      if (directoryPath === root.path) {
        fail(`Inventory root could not be read: ${error?.code ?? "FS_ERROR"}`);
      }
      continue;
    }
    for await (const entry of directory) {
      if (budget.remaining <= 0) {
        budget.discoveryTruncated = true;
        return candidates;
      }
      budget.remaining -= 1;
      if (entry.name === ".git") continue;
      const absolute = join(directoryPath, entry.name);
      const relativePath = toPortable(root.path, absolute);
      const kind = entry.isSymbolicLink()
        ? "link"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other";
      const classification = classifyCandidateName(entry.name, kind);
      if (classification !== null) {
        candidates.set(relativePath, {
          absolute,
          relativePath,
          kind,
          ...classification,
        });
        continue;
      }
      if (kind === "directory") stack.push(absolute);
    }
  }
  return candidates;
}

function trackedPaths(root) {
  const result = runGit(root.path, ["ls-files", "-z"]);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((value) => value.split("\\").join("/"));
}

function trackedCount(candidate, tracked) {
  if (candidate.kind === "file" || candidate.kind === "link") {
    return tracked.includes(candidate.relativePath) ? 1 : 0;
  }
  const prefix = `${candidate.relativePath}/`;
  return tracked.filter(
    (value) => value === candidate.relativePath || value.startsWith(prefix),
  ).length;
}

function gitIgnored(root, relativePath) {
  const result = runGit(
    root.path,
    ["check-ignore", "--quiet", "--no-index", "--", relativePath],
    { allowFailure: true },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail(`Git ignore classification failed for ${relativePath}.`);
}

async function scanFile(candidate, budget) {
  if (budget.remaining <= 0) {
    return Object.freeze({
      fileCount: 0,
      directoryCount: 0,
      linkCount: 0,
      byteCount: 0,
      complete: false,
      truncated: true,
      inaccessible: false,
    });
  }
  budget.remaining -= 1;
  try {
    const metadata = await lstat(candidate.absolute);
    if (metadata.isSymbolicLink()) {
      return Object.freeze({
        fileCount: 0,
        directoryCount: 0,
        linkCount: 1,
        byteCount: 0,
        complete: false,
        truncated: false,
        inaccessible: false,
      });
    }
    if (!metadata.isFile()) {
      return Object.freeze({
        fileCount: 0,
        directoryCount: 0,
        linkCount: 0,
        byteCount: 0,
        complete: false,
        truncated: false,
        inaccessible: true,
      });
    }
    if (metadata.nlink !== 1) {
      return Object.freeze({
        fileCount: 0,
        directoryCount: 0,
        linkCount: 1,
        byteCount: 0,
        complete: false,
        truncated: false,
        inaccessible: false,
      });
    }
    return Object.freeze({
      fileCount: 1,
      directoryCount: 0,
      linkCount: 0,
      byteCount: metadata.size,
      complete: true,
      truncated: false,
      inaccessible: false,
    });
  } catch {
    return Object.freeze({
      fileCount: 0,
      directoryCount: 0,
      linkCount: 0,
      byteCount: 0,
      complete: false,
      truncated: false,
      inaccessible: true,
    });
  }
}

async function scanDirectory(root, candidate, budget) {
  if (candidate.relativePath === ".worktrees") {
    return Object.freeze({
      fileCount: 0,
      directoryCount: 0,
      linkCount: 0,
      byteCount: 0,
      complete: false,
      truncated: false,
      inaccessible: false,
    });
  }
  const totals = {
    fileCount: 0,
    directoryCount: 0,
    linkCount: 0,
    byteCount: 0,
    complete: true,
    truncated: false,
    inaccessible: false,
  };
  const stack = [candidate.absolute];
  while (stack.length > 0) {
    if (budget.remaining <= 0) {
      totals.complete = false;
      totals.truncated = true;
      break;
    }
    const directoryPath = stack.pop();
    const canonicalDirectory = await traversalDirectory(root, directoryPath);
    if (canonicalDirectory === null) {
      totals.linkCount += 1;
      totals.complete = false;
      continue;
    }
    void canonicalDirectory;
    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch {
      totals.complete = false;
      totals.inaccessible = true;
      continue;
    }
    for await (const entry of directory) {
      if (budget.remaining <= 0) {
        totals.complete = false;
        totals.truncated = true;
        break;
      }
      budget.remaining -= 1;
      const absolute = join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        totals.linkCount += 1;
        totals.complete = false;
        continue;
      }
      if (entry.isDirectory()) {
        totals.directoryCount += 1;
        stack.push(absolute);
        continue;
      }
      if (entry.isFile()) {
        totals.fileCount += 1;
        try {
          const metadata = await lstat(absolute);
          if (metadata.isSymbolicLink() || !metadata.isFile()) {
            totals.linkCount += metadata.isSymbolicLink() ? 1 : 0;
            totals.complete = false;
          } else {
            totals.byteCount += metadata.size;
          }
        } catch {
          totals.complete = false;
          totals.inaccessible = true;
        }
        continue;
      }
      totals.complete = false;
    }
    if (totals.truncated) break;
  }
  return Object.freeze(totals);
}

function dispositionFor(candidate, scan, trackedFileCount, ignored) {
  if (candidate.category === "worktree-container") {
    return Object.freeze({
      disposition: "blocked",
      risk: "active-worktree-container",
    });
  }
  if (trackedFileCount > 0) {
    return Object.freeze({
      disposition: "blocked",
      risk: "contains-git-tracked-content",
    });
  }
  if (candidate.kind === "link" || scan.linkCount > 0) {
    return Object.freeze({
      disposition: "review",
      risk: "contains-link-or-junction",
    });
  }
  if (scan.inaccessible) {
    return Object.freeze({ disposition: "review", risk: "inaccessible-entry" });
  }
  if (!scan.complete || scan.truncated) {
    return Object.freeze({
      disposition: "review",
      risk: "scan-budget-exhausted",
    });
  }
  if (candidate.fixedRisk !== null) {
    return Object.freeze({ disposition: "review", risk: candidate.fixedRisk });
  }
  if (!ignored) {
    return Object.freeze({ disposition: "review", risk: "not-git-ignored" });
  }
  return Object.freeze({
    disposition: "eligible-after-process-check",
    risk: "regenerable-output",
  });
}

export async function collectGeneratedArtifacts({
  root,
  maximumEntries = DEFAULT_MAXIMUM_ENTRIES,
}) {
  const safeRoot = await exactGitRoot(root);
  const limit = positiveInteger(
    maximumEntries,
    "Maximum inventory entry count",
  );
  const budget = { remaining: limit, discoveryTruncated: false };
  const candidates = await discoverCandidates(safeRoot, budget);
  const tracked = trackedPaths(safeRoot);
  const entries = [];
  for (const candidate of [...candidates.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    const scan =
      candidate.kind === "directory"
        ? await scanDirectory(safeRoot, candidate, budget)
        : await scanFile(candidate, budget);
    const trackedFileCount = trackedCount(candidate, tracked);
    const ignored = gitIgnored(safeRoot, candidate.relativePath);
    const disposition = dispositionFor(
      candidate,
      scan,
      trackedFileCount,
      ignored,
    );
    entries.push(
      Object.freeze({
        relativePath: candidate.relativePath,
        kind: candidate.kind,
        category: candidate.category,
        gitIgnored: ignored,
        trackedFileCount,
        fileCount: scan.fileCount,
        directoryCount: scan.directoryCount,
        linkCount: scan.linkCount,
        byteCount: scan.byteCount,
        complete: scan.complete,
        truncated: scan.truncated,
        disposition: disposition.disposition,
        risk: disposition.risk,
        automatedDeletionAllowed: false,
      }),
    );
  }
  const summary = Object.freeze({
    candidateCount: entries.length,
    eligibleCount: entries.filter(
      (entry) => entry.disposition === "eligible-after-process-check",
    ).length,
    reviewCount: entries.filter((entry) => entry.disposition === "review")
      .length,
    blockedCount: entries.filter((entry) => entry.disposition === "blocked")
      .length,
    observedBytes: entries.reduce((total, entry) => total + entry.byteCount, 0),
    complete:
      !budget.discoveryTruncated && entries.every((entry) => entry.complete),
    discoveryTruncated: budget.discoveryTruncated,
    scannedEntryCount: limit - budget.remaining,
    maximumEntries: limit,
  });
  return Object.freeze({
    schemaVersion: GENERATED_ARTIFACT_INVENTORY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: safeRoot.path,
    gitHead: runGit(safeRoot.path, ["rev-parse", "HEAD"]).stdout.trim(),
    readOnly: true,
    automatedDeletionAllowed: false,
    summary,
    entries: Object.freeze(entries),
  });
}

export function parseGeneratedArtifactCliArguments(argv) {
  for (const argument of argv) {
    if (DELETION_FLAGS.has(argument)) {
      fail(
        "Deletion is intentionally unsupported by generated-artifact inventory.",
      );
    }
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!OPTION_FLAGS.has(flag))
      fail(`Unknown generated-artifact argument: ${flag}`);
    if (values.has(flag))
      fail(`Duplicate generated-artifact argument: ${flag}`);
    const value = argv[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      fail(`Generated-artifact argument has no value: ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }
  return Object.freeze({
    root: values.get("--root") ?? ".",
    output: values.has("--output")
      ? portablePath(values.get("--output"), "Report path", {
          extension: ".json",
        })
      : null,
    maximumEntries: values.has("--max-entries")
      ? positiveInteger(
          values.get("--max-entries"),
          "Maximum inventory entry count",
        )
      : DEFAULT_MAXIMUM_ENTRIES,
  });
}

async function ensureReportDirectory(root, output) {
  const reportPrefix = `${REPORT_ROOT}/`;
  if (!output.startsWith(reportPrefix)) {
    fail(`Report path must be below ${REPORT_ROOT}.`);
  }
  const segments = output.split("/");
  const directorySegments = segments.slice(0, -1);
  let current = root.path;
  for (const segment of directorySegments) {
    current = join(current, segment);
    if (!contained(root.path, current) || current === root.path) {
      fail("Report path contains an unsafe path segment.");
    }
    try {
      await mkdir(current);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail(
          `Report directory could not be created: ${error?.code ?? "FS_ERROR"}`,
        );
      }
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail("Report directory may not be a link or non-directory entry.");
    }
    const canonical = await realpath(current);
    if (!contained(root.canonical, canonical)) {
      fail("Report directory escaped the Git worktree.");
    }
  }
  const finalPath = join(root.path, ...segments);
  if (!contained(root.path, finalPath) || finalPath === root.path) {
    fail("Report path contains an unsafe path segment.");
  }
  return finalPath;
}

async function writeReport(root, output, manifest) {
  if (!gitIgnored(root, output)) {
    fail("Report path must be Git-ignored.");
  }
  const finalPath = await ensureReportDirectory(root, output);
  await writeFile(finalPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return finalPath;
}

export async function runGeneratedArtifactInventoryCli(argv) {
  const options = parseGeneratedArtifactCliArguments(argv);
  const root = await exactGitRoot(options.root);
  const manifest = await collectGeneratedArtifacts({
    root: root.path,
    maximumEntries: options.maximumEntries,
  });
  if (options.output !== null)
    await writeReport(root, options.output, manifest);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  runGeneratedArtifactInventoryCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Generated-artifact inventory failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
