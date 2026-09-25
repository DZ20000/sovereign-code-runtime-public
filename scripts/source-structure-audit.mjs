#!/usr/bin/env node

import { open, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const SOURCE_STRUCTURE_AUDIT_SCHEMA_VERSION =
  "scr.source-structure-audit/v1";
export const SOURCE_STRUCTURE_CONFIG_SCHEMA_VERSION =
  "scr.source-structure-audit-config/v1";
export const SOURCE_STRUCTURE_BASELINE_SCHEMA_VERSION =
  "scr.source-structure-baseline/v1";

const DEFAULT_CONFIG_PATH = "config/source-structure-audit.json";
const REPORT_ROOT = ".sovereign/reports";
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_BASELINE_BYTES = 2 * 1024 * 1024;
const MAX_BASELINE_ENTRIES = 10_000;
const MUTATION_FLAGS = new Set([
  "--write-baseline",
  "--update-baseline",
  "--ratchet",
]);
const VALUE_FLAGS = new Set(["--root", "--output", "--config"]);
const BOOLEAN_FLAGS = new Set(["--check"]);

function fail(message) {
  const bounded = String(message)
    .replace(/[\0\r\n]+/gu, " ")
    .slice(0, 1_000);
  throw new Error(bounded);
}

function runGit(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
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

function isContained(root, candidate) {
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

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a plain object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has an unsupported field set.`);
  }
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(
      `${label} must be a positive safe integer no greater than ${maximum}.`,
    );
  }
  return value;
}

function boundedString(value, label, maximumLength = 4_096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

async function exactGitRoot(candidate) {
  const lexical = resolve(candidate);
  if (isFilesystemRoot(lexical)) {
    fail("Source-structure audit refuses a filesystem or volume root.");
  }
  const metadata = await lstat(lexical).catch((error) => {
    fail(`Source-structure root is unavailable: ${error?.code ?? "FS_ERROR"}`);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("Source-structure root must be a direct Git worktree directory.");
  }
  const canonical = await realpath(lexical);
  if (isFilesystemRoot(canonical)) {
    fail("Source-structure audit refuses a filesystem or volume root.");
  }
  const gitRoot = resolve(
    runGit(lexical, ["rev-parse", "--show-toplevel"]).stdout.trim(),
  );
  const canonicalGitRoot = await realpath(gitRoot);
  if (
    lexical.toLowerCase() !== gitRoot.toLowerCase() ||
    canonical.toLowerCase() !== canonicalGitRoot.toLowerCase()
  ) {
    fail("Source-structure root must be the exact Git worktree root.");
  }
  return Object.freeze({ path: lexical, canonical });
}

async function readDirectFile(candidate, label, maximumBytes) {
  const absolute = resolve(candidate);
  const before = await lstat(absolute).catch((error) => {
    fail(`${label} is unavailable: ${error?.code ?? "FS_ERROR"}`);
  });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size > maximumBytes
  ) {
    fail(`${label} must be a bounded direct unshared regular file.`);
  }
  const canonical = await realpath(absolute);
  let handle;
  let bytes;
  try {
    handle = await open(absolute, "r");
    const openedBefore = await handle.stat();
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1 ||
      openedBefore.dev !== before.dev ||
      openedBefore.ino !== before.ino ||
      openedBefore.size !== before.size ||
      openedBefore.mtimeMs !== before.mtimeMs
    ) {
      fail(`${label} changed before its verified read began.`);
    }
    bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (
      openedAfter.dev !== openedBefore.dev ||
      openedAfter.ino !== openedBefore.ino ||
      openedAfter.nlink !== 1 ||
      openedAfter.size !== openedBefore.size ||
      openedAfter.mtimeMs !== openedBefore.mtimeMs ||
      openedAfter.ctimeMs !== openedBefore.ctimeMs ||
      bytes.byteLength !== openedBefore.size
    ) {
      fail(`${label} changed while reading.`);
    }
  } finally {
    await handle?.close();
  }
  const after = await lstat(absolute);
  const canonicalAfter = await realpath(absolute);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.nlink !== 1 ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    resolve(canonicalAfter).toLowerCase() !== resolve(canonical).toLowerCase()
  ) {
    fail(`${label} changed after reading.`);
  }
  return Object.freeze({ path: absolute, canonical, bytes });
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} must contain valid UTF-8 text.`);
  }
}

async function readJsonFile(candidate, label, maximumBytes) {
  const file = await readDirectFile(candidate, label, maximumBytes);
  const text = decodeUtf8(file.bytes, label);
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(`${label} is invalid JSON: ${error?.message ?? "PARSE_ERROR"}`);
  }
  return Object.freeze({ ...file, document });
}

function parseConfig(raw) {
  const value = plainObject(raw, "Source-structure audit config");
  exactKeys(
    value,
    [
      "schemaVersion",
      "recommendedMaxLines",
      "hardMaxLines",
      "maximumSourceBytes",
      "sourceExtensions",
      "excludedDirectoryNames",
      "baselinePath",
    ],
    "Source-structure audit config",
  );
  if (value.schemaVersion !== SOURCE_STRUCTURE_CONFIG_SCHEMA_VERSION) {
    fail("Source-structure audit config schema is unsupported.");
  }
  const recommendedMaxLines = positiveInteger(
    value.recommendedMaxLines,
    "Recommended line limit",
    1_000_000,
  );
  const hardMaxLines = positiveInteger(
    value.hardMaxLines,
    "Hard line limit",
    1_000_000,
  );
  if (hardMaxLines <= recommendedMaxLines) {
    fail("Hard line limit must exceed the recommended line limit.");
  }
  const maximumSourceBytes = positiveInteger(
    value.maximumSourceBytes,
    "Maximum source bytes",
    64 * 1024 * 1024,
  );
  if (
    !Array.isArray(value.sourceExtensions) ||
    value.sourceExtensions.length < 1 ||
    value.sourceExtensions.length > 128
  ) {
    fail("Source extensions have an invalid inventory.");
  }
  const sourceExtensions = value.sourceExtensions.map((entry, index) => {
    const extension = boundedString(entry, `Source extension ${index}`, 24);
    if (
      !/^\.[a-z0-9]+$/u.test(extension) ||
      extension !== extension.toLowerCase()
    ) {
      fail(`Source extension ${index} must be lowercase and start with a dot.`);
    }
    return extension;
  });
  if (new Set(sourceExtensions).size !== sourceExtensions.length) {
    fail("Source extensions contain a duplicate.");
  }
  if (
    !Array.isArray(value.excludedDirectoryNames) ||
    value.excludedDirectoryNames.length > 256
  ) {
    fail("Excluded directory names have an invalid inventory.");
  }
  const excludedDirectoryNames = value.excludedDirectoryNames.map(
    (entry, index) => {
      const name = boundedString(entry, `Excluded directory ${index}`, 255);
      if (
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\")
      ) {
        fail(`Excluded directory ${index} must be one path segment.`);
      }
      return name;
    },
  );
  if (new Set(excludedDirectoryNames).size !== excludedDirectoryNames.length) {
    fail("Excluded directory names contain a duplicate.");
  }
  return Object.freeze({
    schemaVersion: SOURCE_STRUCTURE_CONFIG_SCHEMA_VERSION,
    recommendedMaxLines,
    hardMaxLines,
    maximumSourceBytes,
    sourceExtensions: Object.freeze(sourceExtensions),
    excludedDirectoryNames: Object.freeze(excludedDirectoryNames),
    baselinePath: portablePath(value.baselinePath, "Baseline path", {
      extension: ".json",
    }),
  });
}

function parseBaseline(raw, config) {
  const value = plainObject(raw, "Source-structure baseline");
  exactKeys(
    value,
    ["schemaVersion", "generatedFromHead", "policy", "entries"],
    "Source-structure baseline",
  );
  if (value.schemaVersion !== SOURCE_STRUCTURE_BASELINE_SCHEMA_VERSION) {
    fail("Source-structure baseline schema is unsupported.");
  }
  const generatedFromHead = boundedString(
    value.generatedFromHead,
    "Baseline source commit",
    64,
  );
  if (!/^[a-f0-9]{40,64}$/u.test(generatedFromHead)) {
    fail("Baseline source commit must be a lowercase Git object ID.");
  }
  const policy = boundedString(value.policy, "Baseline policy", 4_096);
  if (
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_BASELINE_ENTRIES
  ) {
    fail("Source-structure baseline has an invalid entry inventory.");
  }
  const entries = new Map();
  for (const [index, rawEntry] of value.entries.entries()) {
    const label = `Source-structure baseline entry ${index}`;
    const entry = plainObject(rawEntry, label);
    exactKeys(
      entry,
      ["path", "observedLines", "maximumLines", "reason"],
      label,
    );
    const path = portablePath(entry.path, `${label} path`);
    if (entries.has(path))
      fail("Source-structure baseline contains a duplicate path.");
    const observedLines = positiveInteger(
      entry.observedLines,
      `${label} observed lines`,
      10_000_000,
    );
    const maximumLines = positiveInteger(
      entry.maximumLines,
      `${label} maximum lines`,
      10_000_000,
    );
    if (maximumLines < observedLines || maximumLines <= config.hardMaxLines) {
      fail(`${label} must cap existing debt above the hard limit.`);
    }
    entries.set(
      path,
      Object.freeze({
        path,
        observedLines,
        maximumLines,
        reason: boundedString(entry.reason, `${label} reason`, 2_000),
      }),
    );
  }
  return Object.freeze({
    schemaVersion: SOURCE_STRUCTURE_BASELINE_SCHEMA_VERSION,
    generatedFromHead,
    policy,
    entries,
  });
}

function trackedSourcePaths(root, config) {
  const output = runGit(root.path, ["ls-files", "-z"]).stdout;
  const excluded = new Set(config.excludedDirectoryNames);
  const extensions = new Set(config.sourceExtensions);
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => path.split("\\").join("/"))
    .filter((path) => {
      const segments = path.split("/");
      return (
        extensions.has(extname(path).toLowerCase()) &&
        !segments.slice(0, -1).some((segment) => excluded.has(segment))
      );
    })
    .sort((left, right) => left.localeCompare(right));
}

function countLines(bytes) {
  if (bytes.byteLength === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  if (bytes.at(-1) !== 0x0a) lines += 1;
  return lines;
}

function finding(severity, code, path, lines, limit) {
  return Object.freeze({ severity, code, path, lines, limit });
}

function sourceFinding(path, lines, baseline, config) {
  if (baseline !== undefined) {
    if (lines > baseline.maximumLines) {
      return finding(
        "error",
        "SOURCE_FILE_BASELINE_EXCEEDED",
        path,
        lines,
        baseline.maximumLines,
      );
    }
    if (lines <= config.hardMaxLines) {
      return finding(
        "warning",
        "SOURCE_BASELINE_CAN_BE_REMOVED",
        path,
        lines,
        config.hardMaxLines,
      );
    }
    if (lines > config.recommendedMaxLines) {
      return finding(
        "warning",
        "SOURCE_FILE_RECOMMENDED_LIMIT",
        path,
        lines,
        baseline.maximumLines,
      );
    }
    return null;
  }
  if (lines > config.hardMaxLines) {
    return finding(
      "error",
      "SOURCE_FILE_HARD_LIMIT",
      path,
      lines,
      config.hardMaxLines,
    );
  }
  if (lines > config.recommendedMaxLines) {
    return finding(
      "warning",
      "SOURCE_FILE_RECOMMENDED_LIMIT",
      path,
      lines,
      config.recommendedMaxLines,
    );
  }
  return null;
}

function candidatePath(root, portable) {
  const segments = portable.split("/");
  const absolute = resolve(root.path, ...segments);
  if (!isContained(root.path, absolute) || absolute === root.path) {
    fail(`Tracked source path escaped the Git worktree: ${portable}`);
  }
  return absolute;
}

function gitIgnored(root, portable) {
  const result = runGit(
    root.path,
    ["check-ignore", "--quiet", "--no-index", "--", portable],
    { allowFailure: true },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail(`Git ignore classification failed for ${portable}.`);
}

export async function auditSourceStructure({
  root,
  configPath = DEFAULT_CONFIG_PATH,
}) {
  const safeRoot = await exactGitRoot(root);
  const portableConfigPath = portablePath(configPath, "Config path", {
    extension: ".json",
  });
  const configFile = await readJsonFile(
    candidatePath(safeRoot, portableConfigPath),
    "Source-structure audit config",
    MAX_CONFIG_BYTES,
  );
  if (!isContained(safeRoot.canonical, configFile.canonical)) {
    fail("Source-structure audit config escaped the Git worktree.");
  }
  const config = parseConfig(configFile.document);
  const baselineFile = await readJsonFile(
    candidatePath(safeRoot, config.baselinePath),
    "Source-structure baseline",
    MAX_BASELINE_BYTES,
  );
  if (!isContained(safeRoot.canonical, baselineFile.canonical)) {
    fail("Source-structure baseline escaped the Git worktree.");
  }
  const baseline = parseBaseline(baselineFile.document, config);
  const paths = trackedSourcePaths(safeRoot, config);
  const findings = [];
  const files = [];
  const observed = new Set();
  for (const path of paths) {
    observed.add(path);
    const absolute = candidatePath(safeRoot, path);
    let file;
    try {
      file = await readDirectFile(
        absolute,
        `Tracked source ${path}`,
        config.maximumSourceBytes,
      );
    } catch {
      findings.push(
        finding("error", "SOURCE_PATH_NOT_DIRECT_FILE", path, null, null),
      );
      continue;
    }
    if (!isContained(safeRoot.canonical, file.canonical)) {
      findings.push(
        finding("error", "SOURCE_PATH_NOT_DIRECT_FILE", path, null, null),
      );
      continue;
    }
    try {
      decodeUtf8(file.bytes, `Tracked source ${path}`);
    } catch {
      findings.push(
        finding("error", "SOURCE_FILE_INVALID_UTF8", path, null, null),
      );
      continue;
    }
    const lines = countLines(file.bytes);
    const baselineEntry = baseline.entries.get(path);
    const result = sourceFinding(path, lines, baselineEntry, config);
    if (result !== null) findings.push(result);
    files.push(
      Object.freeze({
        path,
        lines,
        bytes: file.bytes.byteLength,
        baseline: baselineEntry !== undefined,
        limit: baselineEntry?.maximumLines ?? config.hardMaxLines,
      }),
    );
  }
  for (const entry of baseline.entries.values()) {
    if (!observed.has(entry.path)) {
      findings.push(
        finding(
          "error",
          "SOURCE_BASELINE_PATH_MISSING",
          entry.path,
          null,
          entry.maximumLines,
        ),
      );
    }
  }
  findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code),
  );
  const largestFiles = [...files]
    .sort(
      (left, right) =>
        right.lines - left.lines || left.path.localeCompare(right.path),
    )
    .slice(0, 50);
  const errorCount = findings.filter(
    (item) => item.severity === "error",
  ).length;
  const warningCount = findings.filter(
    (item) => item.severity === "warning",
  ).length;
  return Object.freeze({
    schemaVersion: SOURCE_STRUCTURE_AUDIT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: safeRoot.path,
    gitHead: runGit(safeRoot.path, ["rev-parse", "HEAD"]).stdout.trim(),
    config: Object.freeze({
      path: portableConfigPath,
      baselinePath: config.baselinePath,
      recommendedMaxLines: config.recommendedMaxLines,
      hardMaxLines: config.hardMaxLines,
      maximumSourceBytes: config.maximumSourceBytes,
    }),
    baseline: Object.freeze({
      generatedFromHead: baseline.generatedFromHead,
      entryCount: baseline.entries.size,
      policy: baseline.policy,
    }),
    summary: Object.freeze({
      fileCount: files.length,
      totalLines: files.reduce((total, file) => total + file.lines, 0),
      errorCount,
      warningCount,
      passed: errorCount === 0,
    }),
    findings: Object.freeze(findings),
    largestFiles: Object.freeze(largestFiles),
  });
}

export function parseSourceStructureCliArguments(argv) {
  for (const argument of argv) {
    if (MUTATION_FLAGS.has(argument)) {
      fail("Baseline mutation is intentionally unsupported by this audit.");
    }
  }
  const values = new Map();
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) {
      if (check) fail(`Duplicate source-structure argument: ${flag}`);
      check = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag))
      fail(`Unknown source-structure argument: ${flag}`);
    if (values.has(flag)) fail(`Duplicate source-structure argument: ${flag}`);
    const value = argv[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      fail(`Source-structure argument has no value: ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }
  return Object.freeze({
    root: values.get("--root") ?? ".",
    configPath: values.has("--config")
      ? portablePath(values.get("--config"), "Config path", {
          extension: ".json",
        })
      : DEFAULT_CONFIG_PATH,
    output: values.has("--output")
      ? portablePath(values.get("--output"), "Report path", {
          extension: ".json",
        })
      : null,
    check,
  });
}

async function ensureReportPath(root, output) {
  if (!output.startsWith(`${REPORT_ROOT}/`)) {
    fail(`Report path must be below ${REPORT_ROOT}.`);
  }
  const segments = output.split("/");
  let current = root.path;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (!isContained(root.path, current) || current === root.path) {
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
    if (!isContained(root.canonical, canonical)) {
      fail("Report directory escaped the Git worktree.");
    }
  }
  const finalPath = join(root.path, ...segments);
  if (!isContained(root.path, finalPath) || finalPath === root.path) {
    fail("Report path contains an unsafe path segment.");
  }
  return finalPath;
}

async function writeReport(root, output, report) {
  if (!gitIgnored(root, output)) fail("Report path must be Git-ignored.");
  const finalPath = await ensureReportPath(root, output);
  await writeFile(finalPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function runSourceStructureAuditCli(argv) {
  const options = parseSourceStructureCliArguments(argv);
  const root = await exactGitRoot(options.root);
  const report = await auditSourceStructure({
    root: root.path,
    configPath: options.configPath,
  });
  if (options.output !== null) await writeReport(root, options.output, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  const argv = process.argv.slice(2);
  runSourceStructureAuditCli(argv)
    .then((report) => {
      const options = parseSourceStructureCliArguments(argv);
      if (options.check && !report.summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`Source-structure audit failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
