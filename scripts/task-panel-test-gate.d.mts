export const TASK_PANEL_TEST_MANIFEST_SCHEMA: "scr.task-panel-focused-tests/v1";
export const TASK_PANEL_TEST_GATE_RESULT_SCHEMA: "scr.task-panel-test-gate-result/v1";
export const TASK_PANEL_TEST_GATE_NAME: "task-panel-focused-tests";
export const TASK_PANEL_TEST_MANIFEST_PATH: "config/task-panel-focused-tests.json";

export interface TaskPanelExpectedTestInspection {
  readonly empty: boolean;
  readonly duplicateExpectedFiles: readonly string[];
  readonly missingFiles: readonly string[];
  readonly nonRegularFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
}

export interface TaskPanelTestGateReport {
  readonly schemaVersion: "scr.task-panel-test-gate-result/v1";
  readonly gate: "task-panel-focused-tests";
  readonly status: "passed" | "failed";
  readonly phase:
    "manifest" | "preflight" | "execution" | "postflight" | "complete";
  readonly message: string;
  readonly commit: string;
  readonly manifestPath: string;
  readonly expectedFileCount: number;
  readonly actualFileCount: number;
  readonly expectedFiles: readonly string[];
  readonly actualFiles: readonly string[];
  readonly missingFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly nonRegularFiles: readonly string[];
  readonly duplicateExpectedFiles: readonly string[];
  readonly missingActualFiles: readonly string[];
  readonly unexpectedActualFiles: readonly string[];
  readonly duplicateActualFiles: readonly string[];
  readonly testsStarted: boolean;
  readonly testExitCode: number | null;
  readonly testSignal: NodeJS.Signals | null;
  readonly vitestSuccess: boolean | null;
  readonly runnerError: string | null;
}

export interface TaskPanelVitestExecution {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly report: unknown;
  readonly runnerError: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface TaskPanelTestGateOptions {
  readonly root?: string;
  readonly manifestPath?: string;
  readonly gitContext?: {
    readonly commit: string;
    readonly trackedFiles: ReadonlySet<string>;
  };
  readonly executeVitest?: (
    root: string,
    expectedFiles: readonly string[],
  ) => TaskPanelVitestExecution;
}

export class TaskPanelTestGateError extends Error {
  readonly report: TaskPanelTestGateReport;
  readonly runnerStdout: string;
  readonly runnerStderr: string;
  constructor(
    message: string,
    report: TaskPanelTestGateReport,
    runnerOutput?: { readonly stdout?: string; readonly stderr?: string },
  );
}

export function readTaskPanelTestManifest(
  root: string,
  manifestPath?: string,
): string[];

export function inspectExpectedTaskPanelTests(
  root: string,
  expectedFiles: readonly string[],
  trackedFiles: ReadonlySet<string>,
): TaskPanelExpectedTestInspection;

export function extractVitestTaskPanelTestFiles(
  root: string,
  report: unknown,
): string[];

export function compareTaskPanelTestFileSets(
  expectedFiles: readonly string[],
  actualFiles: readonly string[],
): {
  readonly duplicateActualFiles: readonly string[];
  readonly missingActualFiles: readonly string[];
  readonly unexpectedActualFiles: readonly string[];
};

export function runTaskPanelTestGate(
  options?: TaskPanelTestGateOptions,
): TaskPanelTestGateReport;
