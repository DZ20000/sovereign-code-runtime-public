import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const TASK_PANEL_TEST_MANIFEST_SCHEMA =
  "scr.task-panel-focused-tests/v1";
export const TASK_PANEL_TEST_GATE_RESULT_SCHEMA =
  "scr.task-panel-test-gate-result/v1";
export const TASK_PANEL_TEST_GATE_NAME = "task-panel-focused-tests";
export const TASK_PANEL_TEST_MANIFEST_PATH =
  "config/task-panel-focused-tests.json";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function pathIdentity(value) {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeTrackedPath(value) {
  return value.replaceAll("\\", "/");
}

function normalizeTestPath(value) {
  if (typeof value !== "string") {
    throw new Error("Every task-panel test manifest entry must be a string.");
  }
  if (value.length === 0 || value !== value.trim()) {
    throw new Error(
      `Task-panel test path is empty or padded: ${JSON.stringify(value)}.`,
    );
  }
  if (value.includes("\\")) {
    throw new Error(`Task-panel test path must use forward slashes: ${value}.`);
  }
  if (
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("//")
  ) {
    throw new Error(
      `Task-panel test path must be repository-relative: ${value}.`,
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Task-panel test path is not canonical: ${value}.`);
  }
  if (!value.endsWith(".test.ts")) {
    throw new Error(
      `Task-panel test path is not a TypeScript test file: ${value}.`,
    );
  }
  return value;
}

function resolveContainedPath(root, repositoryPath, label) {
  const candidate = resolve(root, repositoryPath);
  const displacement = relative(root, candidate);
  if (
    displacement.length === 0 ||
    displacement === ".." ||
    displacement.startsWith(`..${sep}`) ||
    isAbsolute(displacement)
  ) {
    throw new Error(`${label} escapes the repository root: ${repositoryPath}.`);
  }
  return candidate;
}

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(
      `Git ${args[0]} failed to start: ${messageOf(result.error)}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `Git ${args[0]} failed with exit ${String(result.status)}${
        detail.length === 0 ? "" : `: ${detail}`
      }`,
    );
  }
  return result.stdout;
}

function readGitContext(root) {
  const topLevel = realpathSync(
    runGit(root, ["rev-parse", "--show-toplevel"]).trim(),
  );
  if (pathIdentity(topLevel) !== pathIdentity(root)) {
    throw new Error(
      `Task-panel test gate must run at the Git root: expected ${topLevel}, received ${root}.`,
    );
  }
  const commit = runGit(root, ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error(`Git returned an invalid HEAD identity: ${commit}.`);
  }
  const trackedFiles = new Set(
    runGit(root, ["ls-files", "-z", "--"])
      .split("\0")
      .filter((value) => value.length > 0)
      .map(normalizeTrackedPath),
  );
  return { commit, trackedFiles };
}

function gitCommonRoot(root) {
  const commonDirectory = runGit(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
  return dirname(realpathSync(commonDirectory));
}

function resolveVitestModule(root) {
  const candidates = [
    {
      ownerRoot: root,
      path: join(root, "node_modules", "vitest", "vitest.mjs"),
    },
  ];
  const commonRoot = gitCommonRoot(root);
  if (pathIdentity(commonRoot) !== pathIdentity(root)) {
    candidates.push({
      ownerRoot: commonRoot,
      path: join(commonRoot, "node_modules", "vitest", "vitest.mjs"),
    });
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    const resolved = resolveContainedPath(
      candidate.ownerRoot,
      realpathSync(candidate.path),
      "Resolved Vitest module",
    );
    if (lstatSync(resolved).isFile()) return resolved;
  }
  throw new Error(
    `Vitest is unavailable. Checked: ${candidates
      .map((candidate) => resolve(candidate.path))
      .join(", ")}.`,
  );
}

export function readTaskPanelTestManifest(
  root,
  manifestPath = TASK_PANEL_TEST_MANIFEST_PATH,
) {
  const manifestFile = resolveContainedPath(
    root,
    manifestPath,
    "Manifest path",
  );
  const document = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!isRecord(document)) {
    throw new Error("Task-panel test manifest must be a JSON object.");
  }
  const keys = Object.keys(document).sort();
  if (keys.length !== 2 || keys[0] !== "schemaVersion" || keys[1] !== "tests") {
    throw new Error(
      "Task-panel test manifest must contain only schemaVersion and tests.",
    );
  }
  if (document.schemaVersion !== TASK_PANEL_TEST_MANIFEST_SCHEMA) {
    throw new Error(
      `Unsupported task-panel test manifest schema: ${String(document.schemaVersion)}.`,
    );
  }
  if (!Array.isArray(document.tests)) {
    throw new Error("Task-panel test manifest tests must be an array.");
  }
  return document.tests.map(normalizeTestPath);
}

export function inspectExpectedTaskPanelTests(
  root,
  expectedFiles,
  trackedFiles,
) {
  const duplicateExpectedFiles = [];
  const seen = new Map();
  for (const file of expectedFiles) {
    const identity = file.toLowerCase();
    if (seen.has(identity)) {
      if (!duplicateExpectedFiles.includes(file)) {
        duplicateExpectedFiles.push(file);
      }
    } else {
      seen.set(identity, file);
    }
  }

  const tracked = new Set(
    [...trackedFiles].map((value) => normalizeTrackedPath(value)),
  );
  const missingFiles = [];
  const nonRegularFiles = [];
  const untrackedFiles = [];
  for (const file of new Set(expectedFiles)) {
    const absolute = resolveContainedPath(root, file, "Test path");
    if (!existsSync(absolute)) {
      missingFiles.push(file);
    } else {
      try {
        const metadata = lstatSync(absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          nonRegularFiles.push(file);
        } else {
          resolveContainedPath(
            root,
            realpathSync(absolute),
            "Resolved expected file",
          );
        }
      } catch {
        if (!nonRegularFiles.includes(file)) nonRegularFiles.push(file);
      }
    }
    if (!tracked.has(file)) {
      untrackedFiles.push(file);
    }
  }

  return {
    empty: expectedFiles.length === 0,
    duplicateExpectedFiles: duplicateExpectedFiles.sort(),
    missingFiles: missingFiles.sort(),
    nonRegularFiles: nonRegularFiles.sort(),
    untrackedFiles: untrackedFiles.sort(),
  };
}

function normalizeActualTestPath(root, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Vitest JSON contains a result without a file identity.");
  }
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const displacement = relative(root, absolute);
  if (
    displacement.length === 0 ||
    displacement === ".." ||
    displacement.startsWith(`..${sep}`) ||
    isAbsolute(displacement)
  ) {
    throw new Error(`Vitest reported a test outside the repository: ${value}.`);
  }
  return normalizeTestPath(displacement.split(sep).join("/"));
}

export function extractVitestTaskPanelTestFiles(root, report) {
  if (!isRecord(report) || !Array.isArray(report.testResults)) {
    throw new Error("Vitest JSON report is missing testResults.");
  }
  return report.testResults.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Vitest JSON contains a malformed test result.");
    }
    return normalizeActualTestPath(root, entry.name);
  });
}

export function compareTaskPanelTestFileSets(expectedFiles, actualFiles) {
  const expectedByIdentity = new Map(
    expectedFiles.map((file) => [file.toLowerCase(), file]),
  );
  const actualByIdentity = new Map();
  const duplicateActualFiles = [];
  for (const file of actualFiles) {
    const identity = file.toLowerCase();
    if (actualByIdentity.has(identity)) {
      if (!duplicateActualFiles.includes(file)) duplicateActualFiles.push(file);
    } else {
      actualByIdentity.set(identity, file);
    }
  }
  const missingActualFiles = [...expectedByIdentity]
    .filter(([identity]) => !actualByIdentity.has(identity))
    .map(([, file]) => file)
    .sort();
  const unexpectedActualFiles = [...actualByIdentity]
    .filter(([identity]) => !expectedByIdentity.has(identity))
    .map(([, file]) => file)
    .sort();
  return {
    duplicateActualFiles: duplicateActualFiles.sort(),
    missingActualFiles,
    unexpectedActualFiles,
  };
}

function boundedTail(value) {
  const text = typeof value === "string" ? value : "";
  return text.length <= 4_000 ? text : text.slice(-4_000);
}

function executeVitest(root, expectedFiles) {
  const vitestModule = resolveVitestModule(root);
  const outputDirectory = resolveContainedPath(
    root,
    "node_modules/.cache/sovereign-task-panel-test-gate",
    "Vitest report directory",
  );
  mkdirSync(outputDirectory, { recursive: true });
  const trustedOutputDirectory = resolveContainedPath(
    root,
    realpathSync(outputDirectory),
    "Resolved Vitest report directory",
  );
  const outputFile = resolveContainedPath(
    trustedOutputDirectory,
    `report-${process.pid}-${randomUUID()}.json`,
    "Vitest report path",
  );
  let report = null;
  let runnerError = null;
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        vitestModule,
        "run",
        ...expectedFiles,
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 300_000,
        windowsHide: true,
      },
    );
    if (result.error !== undefined) {
      runnerError = messageOf(result.error);
    }
    if (existsSync(outputFile)) {
      try {
        const metadata = lstatSync(outputFile);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.nlink !== 1
        ) {
          runnerError = "Vitest JSON report is not a direct regular file.";
        } else {
          report = JSON.parse(readFileSync(outputFile, "utf8"));
        }
      } catch (error) {
        runnerError = `Vitest JSON report is unreadable: ${messageOf(error)}`;
      }
    } else if (runnerError === null) {
      runnerError = "Vitest did not produce the required JSON report.";
    }
  } finally {
    if (existsSync(outputFile)) unlinkSync(outputFile);
  }
  return {
    exitCode: result?.status ?? null,
    signal: result?.signal ?? null,
    report,
    runnerError,
    stdout: boundedTail(result?.stdout),
    stderr: boundedTail(result?.stderr),
  };
}

function baseReport({
  commit,
  manifestPath,
  expectedFiles,
  actualFiles = [],
  phase,
  message,
}) {
  return {
    schemaVersion: TASK_PANEL_TEST_GATE_RESULT_SCHEMA,
    gate: TASK_PANEL_TEST_GATE_NAME,
    status: "failed",
    phase,
    message,
    commit,
    manifestPath,
    expectedFileCount: expectedFiles.length,
    actualFileCount: actualFiles.length,
    expectedFiles: [...expectedFiles],
    actualFiles: [...actualFiles].sort(),
    missingFiles: [],
    untrackedFiles: [],
    nonRegularFiles: [],
    duplicateExpectedFiles: [],
    missingActualFiles: [],
    unexpectedActualFiles: [],
    duplicateActualFiles: [],
    testsStarted: false,
    testExitCode: null,
    testSignal: null,
    vitestSuccess: null,
    runnerError: null,
  };
}

export class TaskPanelTestGateError extends Error {
  constructor(message, report, runnerOutput = {}) {
    super(message);
    this.name = "TaskPanelTestGateError";
    this.report = report;
    this.runnerStdout = runnerOutput.stdout ?? "";
    this.runnerStderr = runnerOutput.stderr ?? "";
  }
}

function fail(message, report, runnerOutput) {
  throw new TaskPanelTestGateError(message, report, runnerOutput);
}

export function runTaskPanelTestGate(options = {}) {
  const root = realpathSync(options.root ?? process.cwd());
  const manifestPath = options.manifestPath ?? TASK_PANEL_TEST_MANIFEST_PATH;
  const gitContext = options.gitContext ?? readGitContext(root);
  const manifestInspection = inspectExpectedTaskPanelTests(
    root,
    [manifestPath],
    gitContext.trackedFiles,
  );
  if (
    manifestInspection.missingFiles.length > 0 ||
    manifestInspection.nonRegularFiles.length > 0 ||
    manifestInspection.untrackedFiles.length > 0
  ) {
    const message =
      "Task-panel test manifest must be a tracked direct regular file.";
    fail(message, {
      ...baseReport({
        commit: gitContext.commit,
        manifestPath,
        expectedFiles: [],
        phase: "manifest",
        message,
      }),
      missingFiles: manifestInspection.missingFiles,
      untrackedFiles: manifestInspection.untrackedFiles,
      nonRegularFiles: manifestInspection.nonRegularFiles,
    });
  }

  let expectedFiles;
  try {
    expectedFiles = readTaskPanelTestManifest(root, manifestPath);
  } catch (error) {
    const message = messageOf(error);
    fail(
      message,
      baseReport({
        commit: gitContext.commit,
        manifestPath,
        expectedFiles: [],
        phase: "manifest",
        message,
      }),
    );
  }

  const inspection = inspectExpectedTaskPanelTests(
    root,
    expectedFiles,
    gitContext.trackedFiles,
  );
  if (
    inspection.empty ||
    inspection.duplicateExpectedFiles.length > 0 ||
    inspection.missingFiles.length > 0 ||
    inspection.nonRegularFiles.length > 0 ||
    inspection.untrackedFiles.length > 0
  ) {
    const message = "Task-panel expected test set failed preflight validation.";
    fail(message, {
      ...baseReport({
        commit: gitContext.commit,
        manifestPath,
        expectedFiles,
        phase: "preflight",
        message,
      }),
      missingFiles: inspection.missingFiles,
      untrackedFiles: inspection.untrackedFiles,
      nonRegularFiles: inspection.nonRegularFiles,
      duplicateExpectedFiles: inspection.duplicateExpectedFiles,
    });
  }

  const runner = options.executeVitest ?? executeVitest;
  let execution;
  try {
    execution = runner(root, expectedFiles);
  } catch (error) {
    const message = `Vitest execution failed before a report was available: ${messageOf(error)}`;
    fail(message, {
      ...baseReport({
        commit: gitContext.commit,
        manifestPath,
        expectedFiles,
        phase: "execution",
        message,
      }),
      testsStarted: true,
      runnerError: messageOf(error),
    });
  }

  let actualFiles;
  try {
    actualFiles = extractVitestTaskPanelTestFiles(root, execution.report);
  } catch (error) {
    const message = messageOf(error);
    fail(
      message,
      {
        ...baseReport({
          commit: gitContext.commit,
          manifestPath,
          expectedFiles,
          phase: "postflight",
          message,
        }),
        missingActualFiles: [...expectedFiles],
        testsStarted: true,
        testExitCode: execution.exitCode,
        testSignal: execution.signal,
        vitestSuccess:
          isRecord(execution.report) &&
          typeof execution.report.success === "boolean"
            ? execution.report.success
            : null,
        runnerError: execution.runnerError ?? null,
      },
      execution,
    );
  }

  const comparison = compareTaskPanelTestFileSets(expectedFiles, actualFiles);
  const reportedSuccess =
    isRecord(execution.report) && execution.report.success === true;
  const report = {
    ...baseReport({
      commit: gitContext.commit,
      manifestPath,
      expectedFiles,
      actualFiles,
      phase: "complete",
      message: "Task-panel focused test gate passed.",
    }),
    status: "passed",
    missingActualFiles: comparison.missingActualFiles,
    unexpectedActualFiles: comparison.unexpectedActualFiles,
    duplicateActualFiles: comparison.duplicateActualFiles,
    testsStarted: true,
    testExitCode: execution.exitCode,
    testSignal: execution.signal,
    vitestSuccess: reportedSuccess,
    runnerError: execution.runnerError ?? null,
  };

  if (
    comparison.missingActualFiles.length > 0 ||
    comparison.unexpectedActualFiles.length > 0 ||
    comparison.duplicateActualFiles.length > 0
  ) {
    const message = "Vitest executed a different task-panel test file set.";
    fail(
      message,
      { ...report, status: "failed", phase: "postflight", message },
      execution,
    );
  }
  if (
    execution.exitCode !== 0 ||
    execution.signal !== null ||
    execution.runnerError !== null ||
    !reportedSuccess
  ) {
    const message = "Task-panel focused tests did not complete successfully.";
    fail(
      message,
      { ...report, status: "failed", phase: "execution", message },
      execution,
    );
  }
  return report;
}

function emitReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  try {
    emitReport(runTaskPanelTestGate());
  } catch (error) {
    if (error instanceof TaskPanelTestGateError) {
      emitReport(error.report);
      if (error.runnerStdout.length > 0) {
        process.stderr.write(`Vitest stdout:\n${error.runnerStdout}\n`);
      }
      if (error.runnerStderr.length > 0) {
        process.stderr.write(`Vitest stderr:\n${error.runnerStderr}\n`);
      }
      process.stderr.write(`Task-panel test gate failed: ${error.message}\n`);
    } else {
      process.stderr.write(
        `Task-panel test gate failed unexpectedly: ${messageOf(error)}\n`,
      );
    }
    process.exitCode = 1;
  }
}
