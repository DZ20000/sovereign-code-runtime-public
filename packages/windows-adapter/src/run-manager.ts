import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  RUN_SCHEMA_VERSION,
  type RunKind,
  type RunRecord,
  type RunState,
  type RunStore,
} from "@sovereign/runtime-core";

import { assertOutputCapacity, BoundedOutputBuffer, outputRetention, runOutputRange } from "./output-buffer.js";
import { sanitizedChildEnvironment } from "./process-environment.js";

const PROCESS_TREE_STARTUP_GRACE_MS = 1_500;

function terminateProcessTree(child: ChildProcess, delayMs = 0): void {
  if (delayMs > 0) {
    setTimeout(() => terminateProcessTree(child), delayMs);
    return;
  }
  if (process.platform !== "win32") {
    child.kill();
    return;
  }

  const taskkillPath = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  const maxAttempts = 6;

  const attempt = (attemptIndex: number): void => {
    const pid = child.pid;
    if (pid === undefined) {
      if (attemptIndex + 1 >= maxAttempts) {
        child.kill();
        return;
      }
      setTimeout(() => attempt(attemptIndex + 1), 50 * (attemptIndex + 1));
      return;
    }

    let finished = false;
    const retryOrFallback = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (attemptIndex + 1 < maxAttempts) {
        setTimeout(() => attempt(attemptIndex + 1), 100 * (attemptIndex + 1));
      } else {
        child.kill();
      }
    };

    const killer = spawn(taskkillPath, ["/pid", String(pid), "/t", "/f"], {
      env: sanitizedChildEnvironment(),
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", retryOrFallback);
    killer.once("close", (exitCode) => {
      if (finished) {
        return;
      }
      finished = true;
      if (exitCode !== 0 && attemptIndex + 1 < maxAttempts) {
        setTimeout(() => attempt(attemptIndex + 1), 100 * (attemptIndex + 1));
      } else if (exitCode !== 0) {
        child.kill();
      }
    });
  };

  attempt(0);
}

export interface ManagedRunProcessSummary {
  readonly runId: string;
  readonly kind: RunKind;
  readonly label: string;
  readonly processId: number;
}

export interface ManagedRunChangeObservation {
  readonly state: RunState;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutEndOffset?: number;
  readonly stderrEndOffset?: number;
  readonly outputTruncated: boolean;
  readonly cancelRequested: boolean;
}

export interface ManagedProcessRequest {
  readonly kind: RunKind;
  readonly label: string;
  readonly workspaceId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ManagedRunCompletionHandler = (run: RunRecord) => Promise<void> | void;

interface ActiveProcessRun {
  record: RunRecord;
  readonly child: ChildProcess;
  readonly stdout: BoundedOutputBuffer;
  readonly stderr: BoundedOutputBuffer;
  timer: NodeJS.Timeout;
  timedOut: boolean;
  settled: boolean;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
  readonly changeWaiters: Set<() => void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function durationMs(startedAt: string | null, completedAt: string): number | null {
  if (startedAt === null) {
    return null;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function isTerminalState(state: RunState): boolean {
  return !["queued", "running"].includes(state);
}

async function waitForSettled(
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (promises.length === 0) {
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class ManagedRunManager {
  readonly #store: RunStore;
  readonly #maxOutputBytes: number;
  readonly #onCompleted: ManagedRunCompletionHandler | undefined;
  readonly #active = new Map<string, ActiveProcessRun>();
  readonly #pendingCompletions = new Map<string, Promise<void>>();
  #closed = false;

  constructor(
    store: RunStore,
    maxOutputBytes: number,
    onCompleted?: ManagedRunCompletionHandler,
  ) {
    assertOutputCapacity(maxOutputBytes);
    this.#store = store;
    this.#maxOutputBytes = maxOutputBytes;
    this.#onCompleted = onCompleted;
    this.#store.interruptActive();
  }

  start(request: ManagedProcessRequest): RunRecord {
    if (this.#closed) {
      throw new Error("The run manager is closed.");
    }

    const createdAt = nowIso();
    let record: RunRecord = {
      schemaVersion: RUN_SCHEMA_VERSION,
      id: randomUUID(),
      kind: request.kind,
      label: request.label,
      workspaceId: request.workspaceId,
      state: "queued",
      createdAt,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      signal: null,
      durationMs: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      cancelRequested: false,
      metadata: { ...(request.metadata ?? {}) },
    };
    this.#store.create(record);

    let child: ChildProcess;
    try {
      child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: { ...sanitizedChildEnvironment(), NO_COLOR: "1", ...(request.env ?? {}), NoDefaultCurrentDirectoryInExePath: "1" },
        shell: false,
        windowsVerbatimArguments: request.windowsVerbatimArguments ?? false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const completedAt = nowIso();
      record = {
        ...record,
        state: "failed",
        completedAt,
        stderr: error instanceof Error ? error.message : String(error),
      };
      this.#store.update(record);
      this.#queueCompletion(record);
      throw error;
    }

    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    record = {
      ...record,
      state: "running",
      startedAt: nowIso(),
    };
    const active: ActiveProcessRun = {
      record,
      child,
      stdout: new BoundedOutputBuffer(this.#maxOutputBytes),
      stderr: new BoundedOutputBuffer(this.#maxOutputBytes),
      timer: setTimeout(() => undefined, 0),
      timedOut: false,
      settled: false,
      completion,
      resolveCompletion,
      changeWaiters: new Set(),
    };
    clearTimeout(active.timer);
    active.timer = setTimeout(() => {
      active.timedOut = true;
      terminateProcessTree(active.child);
    }, request.timeoutMs);

    this.#active.set(record.id, active);
    this.#store.update(record);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!active.settled && active.stdout.append(chunk)) {
        this.#notifyChanged(active);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!active.settled && active.stderr.append(chunk)) {
        this.#notifyChanged(active);
      }
    });
    child.once("error", (error) => {
      this.#finalize(active, "failed", null, null, error.message);
    });
    child.once("close", (exitCode, signal) => {
      const state: RunState = active.timedOut
        ? "timed-out"
        : active.record.cancelRequested
          ? "cancelled"
          : exitCode === 0
            ? "succeeded"
            : "failed";
      this.#finalize(active, state, exitCode, signal, null);
    });

    return this.#snapshot(active);
  }

  get(runId: string): RunRecord | null {
    const active = this.#active.get(runId);
    return active === undefined ? this.#store.get(runId) : this.#snapshot(active);
  }

  list(limit = 100, workspaceId?: string): readonly RunRecord[] {
    return this.#store.list(limit, workspaceId).map((run) => {
      const active = this.#active.get(run.id);
      return active === undefined ? run : this.#snapshot(active);
    });
  }

  activeProcesses(): readonly ManagedRunProcessSummary[] {
    return [...this.#active.values()].flatMap((active) => {
      const processId = active.child.pid;
      return processId === undefined
        ? []
        : [{
            runId: active.record.id,
            kind: active.record.kind,
            label: active.record.label,
            processId,
          }];
    });
  }

  async wait(runId: string, waitMs = 15_000): Promise<RunRecord | null> {
    const current = this.get(runId);
    if (current === null || waitMs === 0) {
      return current;
    }

    const active = this.#active.get(runId);
    const completion = active?.completion ?? this.#pendingCompletions.get(runId);
    if (completion === undefined) {
      return current;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        completion,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    return this.get(runId);
  }

  async waitForChange(
    runId: string,
    observed: ManagedRunChangeObservation,
    waitMs = 15_000,
  ): Promise<RunRecord | null> {
    const changed = (run: RunRecord): boolean => (
      run.state !== observed.state ||
      Buffer.byteLength(run.stdout, "utf8") !== observed.stdoutBytes ||
      Buffer.byteLength(run.stderr, "utf8") !== observed.stderrBytes ||
      (observed.stdoutEndOffset !== undefined && runOutputRange(run, "stdout").endOffset !== observed.stdoutEndOffset) ||
      (observed.stderrEndOffset !== undefined && runOutputRange(run, "stderr").endOffset !== observed.stderrEndOffset) ||
      run.outputTruncated !== observed.outputTruncated ||
      run.cancelRequested !== observed.cancelRequested
    );
    let current = this.get(runId);
    if (current === null || waitMs === 0 || changed(current)) {
      return current;
    }

    const active = this.#active.get(runId);
    if (active === undefined) {
      return current;
    }

    let resolveChange = (): void => undefined;
    const change = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    active.changeWaiters.add(resolveChange);
    try {
      current = this.get(runId);
      if (current === null || changed(current)) {
        return current;
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          change,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
      return this.get(runId);
    } finally {
      active.changeWaiters.delete(resolveChange);
    }
  }

  cancel(runId: string): RunRecord | null {
    const active = this.#active.get(runId);
    if (active === undefined) {
      return this.#store.get(runId);
    }
    if (active.record.cancelRequested) {
      return this.#snapshot(active);
    }

    active.record = {
      ...active.record,
      cancelRequested: true,
    };
    this.#store.update(this.#snapshot(active));
    this.#notifyChanged(active);
    const startedAt = active.record.startedAt === null ? Date.now() : Date.parse(active.record.startedAt);
    const runAgeMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
    terminateProcessTree(active.child, Math.max(0, PROCESS_TREE_STARTUP_GRACE_MS - runAgeMs));
    return this.#snapshot(active);
  }

  async shutdown(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    const activeRuns = [...this.#active.values()];
    for (const active of activeRuns) {
      if (!active.record.cancelRequested) {
        active.record = { ...active.record, cancelRequested: true };
        this.#store.update(this.#snapshot(active));
        this.#notifyChanged(active);
      }
      terminateProcessTree(active.child);
    }

    await waitForSettled(activeRuns.map((active) => active.completion), 5_000);

    for (const active of [...this.#active.values()]) {
      this.#finalize(active, "interrupted", null, null, "Runtime stopped before process completion.");
    }

    const finalCompletions = [
      ...activeRuns.map((active) => active.completion),
      ...this.#pendingCompletions.values(),
    ];
    await waitForSettled(finalCompletions, 10_000);
    this.#store.close?.();
  }

  #queueCompletion(run: RunRecord, resolveCompletion?: () => void): void {
    if (this.#onCompleted === undefined) {
      resolveCompletion?.();
      return;
    }

    let callback: Promise<void>;
    try {
      callback = Promise.resolve(this.#onCompleted(run));
    } catch {
      callback = Promise.resolve();
    }
    const tracked = callback
      .catch(() => undefined)
      .finally(() => {
        this.#pendingCompletions.delete(run.id);
        resolveCompletion?.();
      });
    this.#pendingCompletions.set(run.id, tracked);
  }

  #notifyChanged(active: ActiveProcessRun): void {
    for (const resolveChange of [...active.changeWaiters]) {
      resolveChange();
    }
    active.changeWaiters.clear();
  }

  #snapshot(active: ActiveProcessRun): RunRecord {
    return {
      ...active.record,
      stdout: active.stdout.text(),
      stderr: active.stderr.text(),
      outputTruncated: active.stdout.truncated() || active.stderr.truncated(),
      metadata: { ...active.record.metadata, outputRetention: outputRetention(active.stdout, active.stderr) },
    };
  }

  #finalize(
    active: ActiveProcessRun,
    state: RunState,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    errorMessage: string | null,
  ): void {
    if (active.settled) {
      return;
    }
    active.settled = true;
    clearTimeout(active.timer);
    const completedAt = nowIso();
    active.stdout.finish();
    if (errorMessage !== null) active.stderr.append(Buffer.from(`\n${errorMessage}`, "utf8"));
    active.stderr.finish();
    const snapshot = this.#snapshot(active);
    active.record = {
      ...snapshot,
      state,
      completedAt,
      exitCode,
      signal,
      durationMs: durationMs(snapshot.startedAt, completedAt),
      cancelRequested: state === "cancelled",
    };
    this.#store.update(active.record);
    this.#notifyChanged(active);
    this.#active.delete(active.record.id);
    this.#queueCompletion(active.record, active.resolveCompletion);
  }
}

export function runIsActive(run: RunRecord): boolean {
  return !isTerminalState(run.state);
}
