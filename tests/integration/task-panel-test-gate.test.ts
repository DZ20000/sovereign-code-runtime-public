import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TASK_PANEL_TEST_MANIFEST_SCHEMA,
  TaskPanelTestGateError,
  inspectExpectedTaskPanelTests,
  runTaskPanelTestGate,
  type TaskPanelTestGateReport,
} from "../../scripts/task-panel-test-gate.mjs";

interface Fixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly files: readonly string[];
}

const FIXTURE_PARENT = resolve(
  process.cwd(),
  "node_modules",
  ".cache",
  "sovereign-task-panel-test-gate-tests",
);

const COORDINATION_PANEL_TESTS = [
  "apps/desktop-tauri/test/task-coordination-bridge.test.ts",
  "apps/desktop/test/task-coordination-controller.test.ts",
  "apps/desktop/test/task-coordination-inbox.test.ts",
  "apps/desktop/test/task-coordination-ipc.test.ts",
  "tests/integration/task-coordination-operator-inbox.test.ts",
  "tests/integration/task-coordination-replay.test.ts",
  "tests/integration/task-hub-static-guards.test.ts",
] as const;

function strictChild(parent: string, candidate: string, label: string): string {
  const normalizedParent = resolve(parent);
  const normalizedCandidate = resolve(candidate);
  const displacement = relative(normalizedParent, normalizedCandidate);
  if (
    displacement.length === 0 ||
    displacement === ".." ||
    displacement.startsWith(`..${sep}`) ||
    isAbsolute(displacement)
  ) {
    throw new Error(`${label} is not a strict child of ${normalizedParent}.`);
  }
  return normalizedCandidate;
}

function fixtureFile(root: string, file: string): string {
  return strictChild(root, join(root, file), "Fixture file");
}

function fixture(files: readonly string[]): Fixture {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "fixture-"));
  strictChild(FIXTURE_PARENT, root, "Fixture root");
  const manifestPath = "manifest.json";
  for (const file of files) {
    const path = fixtureFile(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export {};\n", "utf8");
  }
  writeFileSync(
    fixtureFile(root, manifestPath),
    `${JSON.stringify(
      {
        schemaVersion: TASK_PANEL_TEST_MANIFEST_SCHEMA,
        tests: files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { root, manifestPath, files };
}

function cleanup(value: Fixture, extraFiles: readonly string[] = []): void {
  const directories = new Set<string>();
  for (const file of new Set([
    ...value.files,
    ...extraFiles,
    value.manifestPath,
  ])) {
    const path = fixtureFile(value.root, file);
    if (existsSync(path)) {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(
          `Refusing to remove non-regular fixture file: ${path}.`,
        );
      }
      unlinkSync(path);
    }
    let directory = dirname(path);
    while (directory !== value.root) {
      strictChild(value.root, directory, "Fixture directory");
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort(
    (left, right) => right.length - left.length,
  )) {
    if (existsSync(directory)) rmdirSync(directory);
  }
  const root = strictChild(FIXTURE_PARENT, value.root, "Fixture root");
  rmdirSync(root);
}

function reportFor(root: string, files: readonly string[], success = true) {
  return {
    success,
    testResults: files.map((file) => ({ name: resolve(root, file) })),
  };
}

function captureGateError(action: () => unknown): TaskPanelTestGateError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskPanelTestGateError);
    return error as TaskPanelTestGateError;
  }
  throw new Error("Expected task-panel test gate to fail.");
}

const gitContext = (
  files: readonly string[],
  manifestPath = "manifest.json",
) => ({
  commit: "a".repeat(40),
  trackedFiles: new Set([...files, manifestPath]),
});

describe("task-panel focused test gate", () => {
  it("fails before Vitest when a protected file moves and passes only after restoration", () => {
    const value = fixture(["protected.test.ts"]);
    const movedPath = "protected.test.ts.moved";
    let executions = 0;
    const executeVitest = (root: string, expectedFiles: readonly string[]) => {
      executions += 1;
      return {
        exitCode: 0,
        signal: null,
        report: reportFor(root, expectedFiles),
        runnerError: null,
      };
    };

    try {
      renameSync(
        fixtureFile(value.root, "protected.test.ts"),
        fixtureFile(value.root, movedPath),
      );
      const failure = captureGateError(() =>
        runTaskPanelTestGate({
          root: value.root,
          manifestPath: value.manifestPath,
          gitContext: gitContext(value.files),
          executeVitest,
        }),
      );
      expect(failure.report).toMatchObject({
        phase: "preflight",
        expectedFileCount: 1,
        actualFileCount: 0,
        missingFiles: ["protected.test.ts"],
        testsStarted: false,
      } satisfies Partial<TaskPanelTestGateReport>);
      expect(executions).toBe(0);

      renameSync(
        fixtureFile(value.root, movedPath),
        fixtureFile(value.root, "protected.test.ts"),
      );
      const success = runTaskPanelTestGate({
        root: value.root,
        manifestPath: value.manifestPath,
        gitContext: gitContext(value.files),
        executeVitest,
      });
      expect(success).toMatchObject({
        status: "passed",
        expectedFileCount: 1,
        actualFileCount: 1,
        missingFiles: [],
        missingActualFiles: [],
        testsStarted: true,
      } satisfies Partial<TaskPanelTestGateReport>);
      expect(executions).toBe(1);
    } finally {
      if (existsSync(fixtureFile(value.root, movedPath))) {
        renameSync(
          fixtureFile(value.root, movedPath),
          fixtureFile(value.root, "protected.test.ts"),
        );
      }
      cleanup(value);
    }
  });

  it("fails before Vitest when a coordination panel test is renamed and passes only after restoration", () => {
    const protectedPath = COORDINATION_PANEL_TESTS[2];
    const value = fixture([protectedPath]);
    const renamedPath = `${protectedPath}.renamed`;
    let executions = 0;
    const executeVitest = (root: string, expectedFiles: readonly string[]) => {
      executions += 1;
      return {
        exitCode: 0,
        signal: null,
        report: reportFor(root, expectedFiles),
        runnerError: null,
      };
    };

    try {
      renameSync(
        fixtureFile(value.root, protectedPath),
        fixtureFile(value.root, renamedPath),
      );
      const failure = captureGateError(() =>
        runTaskPanelTestGate({
          root: value.root,
          manifestPath: value.manifestPath,
          gitContext: gitContext(value.files),
          executeVitest,
        }),
      );
      expect(failure.report).toMatchObject({
        phase: "preflight",
        expectedFileCount: 1,
        actualFileCount: 0,
        missingFiles: [protectedPath],
        testsStarted: false,
      } satisfies Partial<TaskPanelTestGateReport>);
      expect(executions).toBe(0);

      renameSync(
        fixtureFile(value.root, renamedPath),
        fixtureFile(value.root, protectedPath),
      );
      const success = runTaskPanelTestGate({
        root: value.root,
        manifestPath: value.manifestPath,
        gitContext: gitContext(value.files),
        executeVitest,
      });
      expect(success).toMatchObject({
        status: "passed",
        expectedFileCount: 1,
        actualFileCount: 1,
        missingFiles: [],
        untrackedFiles: [],
        nonRegularFiles: [],
        duplicateExpectedFiles: [],
        missingActualFiles: [],
        unexpectedActualFiles: [],
        duplicateActualFiles: [],
        testsStarted: true,
      } satisfies Partial<TaskPanelTestGateReport>);
      expect(executions).toBe(1);
    } finally {
      if (existsSync(fixtureFile(value.root, renamedPath))) {
        renameSync(
          fixtureFile(value.root, renamedPath),
          fixtureFile(value.root, protectedPath),
        );
      }
      cleanup(value, [renamedPath]);
    }
  });

  it("rejects empty, duplicate and untracked expected sets", () => {
    const value = fixture(["protected.test.ts"]);
    try {
      expect(
        inspectExpectedTaskPanelTests(value.root, [], new Set()),
      ).toMatchObject({ empty: true });
      expect(
        inspectExpectedTaskPanelTests(
          value.root,
          ["protected.test.ts", "protected.test.ts"],
          new Set(["protected.test.ts"]),
        ),
      ).toMatchObject({
        duplicateExpectedFiles: ["protected.test.ts"],
      });
      expect(
        inspectExpectedTaskPanelTests(
          value.root,
          ["protected.test.ts"],
          new Set(),
        ),
      ).toMatchObject({ untrackedFiles: ["protected.test.ts"] });

      let executions = 0;
      const failure = captureGateError(() =>
        runTaskPanelTestGate({
          root: value.root,
          manifestPath: value.manifestPath,
          gitContext: gitContext([]),
          executeVitest() {
            executions += 1;
            throw new Error("Vitest must not start for an untracked test.");
          },
        }),
      );
      expect(failure.report).toMatchObject({
        phase: "preflight",
        expectedFileCount: 1,
        actualFileCount: 0,
        untrackedFiles: ["protected.test.ts"],
        testsStarted: false,
      } satisfies Partial<TaskPanelTestGateReport>);
      expect(executions).toBe(0);
    } finally {
      cleanup(value);
    }
  });

  it("fails before Vitest when a coordination panel test is untracked", () => {
    const protectedPath = COORDINATION_PANEL_TESTS[4];
    const value = fixture([protectedPath]);
    let executions = 0;
    try {
      const failure = captureGateError(() =>
        runTaskPanelTestGate({
          root: value.root,
          manifestPath: value.manifestPath,
          gitContext: gitContext([]),
          executeVitest() {
            executions += 1;
            throw new Error("Vitest must not start for an untracked test.");
          },
        }),
      );
      expect(failure.report).toMatchObject({
        phase: "preflight",
        expectedFileCount: 1,
        actualFileCount: 0,
        missingFiles: [],
        untrackedFiles: [protectedPath],
        testsStarted: false,
      } satisfies Partial<TaskPanelTestGateReport>);
      expect(executions).toBe(0);
    } finally {
      cleanup(value);
    }
  });

  it("requires the manifest itself to be tracked before starting Vitest", () => {
    const value = fixture(["protected.test.ts"]);
    let executions = 0;
    try {
      const failure = captureGateError(() =>
        runTaskPanelTestGate({
          root: value.root,
          manifestPath: value.manifestPath,
          gitContext: {
            commit: "a".repeat(40),
            trackedFiles: new Set(value.files),
          },
          executeVitest() {
            executions += 1;
            throw new Error("Vitest must not start for an untracked manifest.");
          },
        }),
      );
      expect(failure.report).toMatchObject({
        phase: "manifest",
        expectedFileCount: 0,
        actualFileCount: 0,
        untrackedFiles: ["manifest.json"],
        testsStarted: false,
      } satisfies Partial<TaskPanelTestGateReport>);
      expect(executions).toBe(0);
    } finally {
      cleanup(value);
    }
  });

  it("fails when Vitest reports a smaller file set despite an exit code of zero", () => {
    const value = fixture(["first.test.ts", "second.test.ts"]);
    try {
      const failure = captureGateError(() =>
        runTaskPanelTestGate({
          root: value.root,
          manifestPath: value.manifestPath,
          gitContext: gitContext(value.files),
          executeVitest(root) {
            return {
              exitCode: 0,
              signal: null,
              report: reportFor(root, ["first.test.ts"]),
              runnerError: null,
            };
          },
        }),
      );
      expect(failure.report).toMatchObject({
        phase: "postflight",
        expectedFileCount: 2,
        actualFileCount: 1,
        missingActualFiles: ["second.test.ts"],
        testsStarted: true,
        testExitCode: 0,
        vitestSuccess: true,
      } satisfies Partial<TaskPanelTestGateReport>);
    } finally {
      cleanup(value);
    }
  });

  it("fails when Vitest reports duplicate or unexpected coordination files", () => {
    const expectedPath = COORDINATION_PANEL_TESTS[0];
    const unexpectedPath = "unexpected-coordination.test.ts";
    const value = fixture([expectedPath]);
    try {
      const failure = captureGateError(() =>
        runTaskPanelTestGate({
          root: value.root,
          manifestPath: value.manifestPath,
          gitContext: gitContext(value.files),
          executeVitest(root) {
            return {
              exitCode: 0,
              signal: null,
              report: reportFor(root, [
                expectedPath,
                expectedPath,
                unexpectedPath,
              ]),
              runnerError: null,
            };
          },
        }),
      );
      expect(failure.report).toMatchObject({
        phase: "postflight",
        expectedFileCount: 1,
        actualFileCount: 3,
        missingActualFiles: [],
        unexpectedActualFiles: [unexpectedPath],
        duplicateActualFiles: [expectedPath],
        testsStarted: true,
        testExitCode: 0,
        vitestSuccess: true,
      } satisfies Partial<TaskPanelTestGateReport>);
    } finally {
      cleanup(value);
    }
  });

  it("keeps package wiring and the committed manifest at 24 canonical files", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const manifest = JSON.parse(
      readFileSync(
        join(root, "config", "task-panel-focused-tests.json"),
        "utf8",
      ),
    ) as { schemaVersion?: string; tests?: string[] };

    expect(packageJson.scripts?.["test:task-panel:focused"]).toBe(
      "node scripts/task-panel-test-gate.mjs",
    );
    expect(manifest.schemaVersion).toBe(TASK_PANEL_TEST_MANIFEST_SCHEMA);
    expect(manifest.tests).toHaveLength(24);
    expect(new Set(manifest.tests).size).toBe(24);
    expect(manifest.tests).toEqual([...(manifest.tests ?? [])].sort());
    for (const file of COORDINATION_PANEL_TESTS) {
      expect(manifest.tests).toContain(file);
    }
    expect(
      (manifest.tests ?? []).filter(
        (file) =>
          file.includes("task-coordination") ||
          file === "tests/integration/task-hub-static-guards.test.ts",
      ),
    ).toEqual([...COORDINATION_PANEL_TESTS]);
    expect(manifest.tests?.every((file) => file.endsWith(".test.ts"))).toBe(
      true,
    );
    expect(manifest.tests?.every((file) => !file.includes("\\"))).toBe(true);
    expect(manifest.tests).toContain(
      "tests/integration/task-hub-session.test.ts",
    );
    expect(manifest.tests).not.toContain(
      "apps/desktop/test/task-draft-cache.test.ts",
    );
    expect(manifest.tests).not.toContain(
      "tests/integration/task-registry-capacity.test.ts",
    );
  });
});
