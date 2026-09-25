import { setImmediate as defer } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  MemoryAuditStore,
  MemoryRunStore,
  RUN_SCHEMA_VERSION,
  RuntimeError,
  type RunRecord,
} from "@sovereign/runtime-core";
import {
  RunCompletionNotifier,
  type DesktopNotificationInput,
  type DesktopNotificationResult,
  type RunCompletionNotificationPort,
} from "../src/index.js";
import { ManagedRunManager } from "../src/run-manager.js";

const COMPLETED_AT = "2026-08-19T04:00:30.000Z";

class FakeNotificationPort implements RunCompletionNotificationPort {
  availableValue = true;
  readonly calls: DesktopNotificationInput[] = [];
  error: unknown = null;

  available(): boolean {
    return this.availableValue;
  }

  async notify(
    input: DesktopNotificationInput,
  ): Promise<DesktopNotificationResult> {
    this.calls.push(input);
    if (this.error !== null) {
      throw this.error;
    }
    return {
      title: input.title,
      message: input.message,
      severity: input.severity ?? "info",
      durationMs: input.durationMs ?? 6_000,
      accepted: true,
      acceptedAt: COMPLETED_AT,
      mechanism: "windows-notify-icon",
    };
  }
}

function completedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: "11111111-1111-4111-8111-111111111111",
    kind: "terminal",
    label: "Private customer migration command",
    workspaceId: "workspace",
    state: "succeeded",
    createdAt: "2026-08-19T04:00:00.000Z",
    startedAt: "2026-08-19T04:00:01.000Z",
    completedAt: COMPLETED_AT,
    exitCode: 0,
    signal: null,
    durationMs: 29_000,
    stdout: "private progress and file names\n",
    stderr: "private diagnostic text\n",
    outputTruncated: false,
    cancelRequested: false,
    metadata: {
      commandSha256: "a".repeat(64),
      privatePath: "customer-secret.txt",
    },
    ...overrides,
  };
}

describe("managed-run completion notifier", () => {
  it("notifies explicit workflow completion and writes a complete redacted receipt", async () => {
    const notifications = new FakeNotificationPort();
    const audit = new MemoryAuditStore();
    const notifier = new RunCompletionNotifier(notifications, audit, {
      now: () => Date.parse(COMPLETED_AT),
    });
    const run = completedRun({ kind: "workflow" });

    const result = await notifier.handle(run);

    expect(result).toMatchObject({ status: "accepted" });
    expect(result.receiptId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(notifications.calls).toHaveLength(1);
    expect(notifications.calls[0]).toMatchObject({
      title: "Sovereign work completed",
      severity: "success",
      durationMs: 3_000,
    });
    expect(notifications.calls[0]?.message).toContain("Workflow run 11111111");
    expect(notifications.calls[0]?.message).toContain("exit code 0");
    expect(notifications.calls[0]?.message).not.toContain(run.label);
    expect(notifications.calls[0]?.message).not.toContain(run.stdout.trim());

    const receipt = audit.list(10)[0];
    expect(receipt).toMatchObject({
      id: result.receiptId,
      principalId: "system:managed-run-completion",
      toolName: "runs.complete",
      operation: "complete_managed_run",
      outcome: "succeeded",
      workspaceId: "workspace",
      details: {
        runId: run.id,
        runKind: "workflow",
        runState: "succeeded",
        exitCode: 0,
        durationMs: 29_000,
        stdoutBytes: Buffer.byteLength(run.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(run.stderr, "utf8"),
        notificationSource: "automatic",
        notificationsConfigured: true,
        notificationStatus: "accepted",
        notificationSeverity: "success",
        notificationMechanism: "windows-notify-icon",
      },
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(run.label);
    expect(serialized).not.toContain(run.stdout.trim());
    expect(serialized).not.toContain(run.stderr.trim());
    expect(serialized).not.toContain("customer-secret.txt");
  });

  it.each(["terminal", "python", "validation"] as const)(
    "suppresses routine successful %s runs without losing the completion receipt",
    async (kind) => {
      const notifications = new FakeNotificationPort();
      const audit = new MemoryAuditStore();
      const notifier = new RunCompletionNotifier(notifications, audit);
      const run = completedRun({ id: `routine-${kind}`, kind });

      await expect(notifier.handle(run)).resolves.toMatchObject({
        status: "suppressed",
      });
      expect(notifications.calls).toHaveLength(0);
      expect(audit.list(1)[0]).toMatchObject({
        outcome: "succeeded",
        details: {
          runId: run.id,
          runKind: kind,
          runState: "succeeded",
          notificationStatus: "suppressed",
          notificationReason: "routine-success",
        },
      });
    },
  );

  it("deduplicates only the exact managed-run completion callback", async () => {
    const notifications = new FakeNotificationPort();
    const audit = new MemoryAuditStore();
    const notifier = new RunCompletionNotifier(notifications, audit);
    const run = completedRun({ kind: "workflow" });

    await expect(notifier.handle(run)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(notifier.handle(run)).resolves.toEqual({
      status: "duplicate",
      receiptId: null,
    });

    expect(notifications.calls).toHaveLength(1);
    expect(audit.list(10)).toHaveLength(1);
  });

  it("continues to notify failed, timed-out, and cancelled runs that need attention", async () => {
    const notifications = new FakeNotificationPort();
    const audit = new MemoryAuditStore();
    const notifier = new RunCompletionNotifier(notifications, audit);
    const cases = [
      {
        id: "failed-run",
        state: "failed" as const,
        exitCode: 1,
        cancelRequested: false,
        title: "Sovereign run failed",
        severity: "error",
      },
      {
        id: "timed-out-run",
        state: "timed-out" as const,
        exitCode: null,
        cancelRequested: false,
        title: "Sovereign run timed out",
        severity: "error",
      },
      {
        id: "cancelled-run",
        state: "cancelled" as const,
        exitCode: null,
        cancelRequested: true,
        title: "Sovereign run cancelled",
        severity: "warning",
      },
    ];

    for (const candidate of cases) {
      await expect(
        notifier.handle(
          completedRun({
            id: candidate.id,
            state: candidate.state,
            exitCode: candidate.exitCode,
            cancelRequested: candidate.cancelRequested,
          }),
        ),
      ).resolves.toMatchObject({ status: "accepted" });
    }

    expect(notifications.calls.map((call) => call.title)).toEqual(
      cases.map((candidate) => candidate.title),
    );
    expect(notifications.calls.map((call) => call.severity)).toEqual(
      cases.map((candidate) => candidate.severity),
    );
    expect(audit.list(10)).toHaveLength(3);
  });

  it("accepts successive distinct meaningful completions without policy buckets", async () => {
    const notifications = new FakeNotificationPort();
    const audit = new MemoryAuditStore();
    const notifier = new RunCompletionNotifier(notifications, audit);

    for (let index = 1; index <= 8; index += 1) {
      await expect(
        notifier.handle(
          completedRun({ id: `workflow-${index}`, kind: "workflow" }),
        ),
      ).resolves.toMatchObject({ status: "accepted" });
    }

    expect(notifications.calls).toHaveLength(8);
    expect(audit.list(20)).toHaveLength(8);
  });

  it("suppresses runtime interruption without losing its completion receipt", async () => {
    const notifications = new FakeNotificationPort();
    const audit = new MemoryAuditStore();
    const notifier = new RunCompletionNotifier(notifications, audit);

    await expect(
      notifier.handle(
        completedRun({
          id: "interrupted-run",
          state: "interrupted",
          exitCode: null,
        }),
      ),
    ).resolves.toMatchObject({ status: "suppressed" });

    expect(notifications.calls).toHaveLength(0);
    expect(audit.list(1)[0]).toMatchObject({
      outcome: "failed",
      errorCode: "RUN_INTERRUPTED",
      details: {
        runId: "interrupted-run",
        notificationStatus: "suppressed",
        notificationReason: "runtime-interrupted",
      },
    });
  });

  it("can be disabled without losing the managed-run completion receipt", async () => {
    const notifications = new FakeNotificationPort();
    const audit = new MemoryAuditStore();
    const notifier = new RunCompletionNotifier(notifications, audit, {
      enabled: false,
    });

    await expect(
      notifier.handle(completedRun({ kind: "workflow" })),
    ).resolves.toMatchObject({
      status: "disabled",
    });

    expect(notifications.calls).toHaveLength(0);
    expect(audit.list(1)[0]).toMatchObject({
      toolName: "runs.complete",
      details: {
        notificationSource: "automatic",
        notificationsConfigured: false,
        notificationStatus: "disabled",
        notificationReason: "configuration",
      },
    });
  });

  it("records unavailable and native failure outcomes without changing the run result", async () => {
    const unavailableNotifications = new FakeNotificationPort();
    unavailableNotifications.availableValue = false;
    const unavailableAudit = new MemoryAuditStore();
    const unavailable = new RunCompletionNotifier(
      unavailableNotifications,
      unavailableAudit,
    );

    await expect(
      unavailable.handle(completedRun({ kind: "workflow" })),
    ).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(unavailableAudit.list(1)[0]).toMatchObject({
      outcome: "succeeded",
      details: {
        runState: "succeeded",
        notificationStatus: "unavailable",
      },
    });

    const failedNotifications = new FakeNotificationPort();
    failedNotifications.error = new RuntimeError(
      "PROCESS_FAILED",
      "Native notification helper failed.",
      500,
    );
    const failedAudit = new MemoryAuditStore();
    const failed = new RunCompletionNotifier(failedNotifications, failedAudit);

    await expect(
      failed.handle(completedRun({ id: "native-failed", kind: "workflow" })),
    ).resolves.toMatchObject({ status: "failed" });
    expect(failedAudit.list(1)[0]).toMatchObject({
      outcome: "succeeded",
      details: {
        notificationStatus: "failed",
        notificationReason: "native-notification-failed",
        notificationErrorCode: "PROCESS_FAILED",
      },
    });
  });
});

describe("managed-run completion lifecycle", () => {
  it("drops the process from active activity before waiting for completion handling", async () => {
    let releaseCompletion = (): void => undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let signalCompletionStarted = (): void => undefined;
    const completionStarted = new Promise<void>((resolve) => {
      signalCompletionStarted = resolve;
    });
    let observedRun: RunRecord | null = null;
    const manager = new ManagedRunManager(
      new MemoryRunStore(),
      65_536,
      async (run) => {
        observedRun = run;
        signalCompletionStarted();
        await completionGate;
      },
    );

    const started = manager.start({
      kind: "terminal",
      label: "portable lifecycle probe",
      workspaceId: "workspace",
      command: process.execPath,
      args: ["-e", "process.stdout.write('progress\\n'); process.exit(0);"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    await completionStarted;

    expect(manager.activeProcesses()).toHaveLength(0);
    expect(manager.get(started.id)).toMatchObject({
      state: "succeeded",
      exitCode: 0,
    });
    expect(observedRun).toMatchObject({
      state: "succeeded",
      exitCode: 0,
      stdout: "progress\n",
    });

    let waitSettled = false;
    const waited = manager.wait(started.id, 5_000).then((run) => {
      waitSettled = true;
      return run;
    });
    await defer();
    expect(waitSettled).toBe(false);

    releaseCompletion();
    await expect(waited).resolves.toMatchObject({
      state: "succeeded",
      exitCode: 0,
    });
    expect(waitSettled).toBe(true);
    await manager.shutdown();
  });
});
