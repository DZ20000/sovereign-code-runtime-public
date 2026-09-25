import { randomUUID } from "node:crypto";

import {
  type AuditOutcome,
  type AuditReceipt,
  type AuditStore,
  type RunRecord,
  type RunState,
  RuntimeError,
} from "@sovereign/runtime-core";

import {
  type DesktopNotificationInput,
  type DesktopNotificationResult,
  type DesktopNotificationSeverity,
} from "./notification-manager.js";

export interface RunCompletionNotificationPort {
  available(): boolean;
  notify(input: DesktopNotificationInput): Promise<DesktopNotificationResult>;
}

export interface RunCompletionNotifierOptions {
  readonly enabled?: boolean;
  readonly now?: () => number;
}

export type RunCompletionNotificationStatus =
  "accepted" | "disabled" | "unavailable" | "failed" | "suppressed";

export interface RunCompletionNotifierResult {
  readonly status: RunCompletionNotificationStatus | "duplicate";
  readonly receiptId: string | null;
}

interface NotificationObservation {
  readonly status: RunCompletionNotificationStatus;
  readonly severity: DesktopNotificationSeverity;
  readonly reason?: string;
  readonly errorCode?: string;
  readonly acceptedAt?: string;
  readonly mechanism?: DesktopNotificationResult["mechanism"];
}

const TERMINAL_RUN_STATES = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
  "timed-out",
  "interrupted",
]);
const MAXIMUM_TRACKED_RUNS = 10_000;
const AUTOMATIC_NOTIFICATION_DURATION_MS = 3_000;

function notificationSeverity(state: RunState): DesktopNotificationSeverity {
  switch (state) {
    case "succeeded":
      return "success";
    case "cancelled":
      return "warning";
    case "failed":
    case "timed-out":
    case "interrupted":
      return "error";
    case "queued":
    case "running":
      return "info";
  }
}

function notificationTitle(run: RunRecord): string {
  switch (run.state) {
    case "succeeded":
      return "Sovereign work completed";
    case "cancelled":
      return "Sovereign run cancelled";
    case "timed-out":
      return "Sovereign run timed out";
    case "failed":
    case "interrupted":
      return "Sovereign run failed";
    case "queued":
    case "running":
      return "Sovereign run update";
  }
}

function runKindLabel(run: RunRecord): string {
  switch (run.kind) {
    case "validation":
      return "Validation";
    case "terminal":
      return "PowerShell";
    case "python":
      return "Python";
    case "workflow":
      return "Workflow";
  }
}

function durationLabel(durationMs: number | null): string | null {
  if (durationMs === null) {
    return null;
  }
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  const seconds = durationMs / 1_000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
}

function notificationMessage(run: RunRecord): string {
  const prefix = `${runKindLabel(run)} run ${run.id.slice(0, 8)}`;
  const elapsed = durationLabel(run.durationMs);
  const durationSuffix = elapsed === null ? "" : ` in ${elapsed}`;
  const exitSuffix =
    run.exitCode === null ? "" : ` with exit code ${run.exitCode}`;
  switch (run.state) {
    case "succeeded":
      return `${prefix} completed${exitSuffix}${durationSuffix}.`;
    case "failed":
      return `${prefix} failed${exitSuffix}${durationSuffix}.`;
    case "cancelled":
      return `${prefix} was cancelled${durationSuffix}.`;
    case "timed-out":
      return `${prefix} timed out${durationSuffix}.`;
    case "interrupted":
      return `${prefix} was interrupted${durationSuffix}.`;
    case "queued":
    case "running":
      return `${prefix} is still running.`;
  }
}

function runOutcome(state: RunState): AuditOutcome {
  return state === "succeeded" ? "succeeded" : "failed";
}

function runErrorCode(state: RunState): string | undefined {
  switch (state) {
    case "failed":
      return "PROCESS_FAILED";
    case "cancelled":
      return "RUN_CANCELLED";
    case "timed-out":
      return "PROCESS_TIMEOUT";
    case "interrupted":
      return "RUN_INTERRUPTED";
    case "queued":
    case "running":
    case "succeeded":
      return undefined;
  }
}

function errorCode(error: unknown): string {
  return error instanceof RuntimeError ? error.code : "INTERNAL_ERROR";
}

export class RunCompletionNotifier {
  readonly #notifications: RunCompletionNotificationPort;
  readonly #audit: AuditStore;
  readonly #enabled: boolean;
  readonly #now: () => number;
  readonly #handledRunIds = new Set<string>();
  #closed = false;

  constructor(
    notifications: RunCompletionNotificationPort,
    audit: AuditStore,
    options: RunCompletionNotifierOptions = {},
  ) {
    this.#notifications = notifications;
    this.#audit = audit;
    this.#enabled = options.enabled ?? true;
    this.#now = options.now ?? Date.now;
  }

  async handle(run: RunRecord): Promise<RunCompletionNotifierResult> {
    if (!TERMINAL_RUN_STATES.has(run.state)) {
      throw new Error(
        `Run-completion notifier received non-terminal state: ${run.state}`,
      );
    }

    if (this.#handledRunIds.has(run.id)) {
      return { status: "duplicate", receiptId: null };
    }
    this.#handledRunIds.add(run.id);
    this.#boundHandledRuns();

    const now = this.#now();
    const observation = await this.#notify(run);
    const receipt = this.#completionReceipt(run, observation, now);
    this.#audit.append(receipt);
    return { status: observation.status, receiptId: receipt.id };
  }

  close(): void {
    this.#closed = true;
    this.#handledRunIds.clear();
  }

  async #notify(run: RunRecord): Promise<NotificationObservation> {
    const severity = notificationSeverity(run.state);
    if (!this.#enabled) {
      return { status: "disabled", severity, reason: "configuration" };
    }
    if (this.#closed) {
      return { status: "suppressed", severity, reason: "runtime-shutdown" };
    }
    if (run.state === "interrupted") {
      return { status: "suppressed", severity, reason: "runtime-interrupted" };
    }
    if (run.state === "succeeded" && run.kind !== "workflow") {
      return { status: "suppressed", severity, reason: "routine-success" };
    }
    if (!this.#notifications.available()) {
      return {
        status: "unavailable",
        severity,
        reason: "native-notification-unavailable",
      };
    }

    try {
      const result = await this.#notifications.notify({
        title: notificationTitle(run),
        message: notificationMessage(run),
        severity,
        durationMs: AUTOMATIC_NOTIFICATION_DURATION_MS,
      });
      return {
        status: "accepted",
        severity: result.severity,
        acceptedAt: result.acceptedAt,
        mechanism: result.mechanism,
      };
    } catch (error) {
      return {
        status: "failed",
        severity,
        reason: "native-notification-failed",
        errorCode: errorCode(error),
      };
    }
  }

  #completionReceipt(
    run: RunRecord,
    notification: NotificationObservation,
    now: number,
  ): AuditReceipt {
    const completionErrorCode = runErrorCode(run.state);
    return {
      id: randomUUID(),
      occurredAt: new Date(now).toISOString(),
      principalId: "system:managed-run-completion",
      toolName: "runs.complete",
      operation: "complete_managed_run",
      outcome: runOutcome(run.state),
      workspaceId: run.workspaceId,
      ...(completionErrorCode === undefined
        ? {}
        : { errorCode: completionErrorCode }),
      details: {
        runId: run.id,
        runKind: run.kind,
        runState: run.state,
        completedAt: run.completedAt,
        exitCode: run.exitCode,
        signal: run.signal,
        durationMs: run.durationMs,
        stdoutBytes: Buffer.byteLength(run.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(run.stderr, "utf8"),
        outputTruncated: run.outputTruncated,
        cancelRequested: run.cancelRequested,
        notificationSource: "automatic",
        notificationsConfigured: this.#enabled,
        notificationStatus: notification.status,
        notificationSeverity: notification.severity,
        ...(notification.reason === undefined
          ? {}
          : { notificationReason: notification.reason }),
        ...(notification.errorCode === undefined
          ? {}
          : { notificationErrorCode: notification.errorCode }),
        ...(notification.acceptedAt === undefined
          ? {}
          : { notificationAcceptedAt: notification.acceptedAt }),
        ...(notification.mechanism === undefined
          ? {}
          : { notificationMechanism: notification.mechanism }),
      },
    };
  }

  #boundHandledRuns(): void {
    while (this.#handledRunIds.size > MAXIMUM_TRACKED_RUNS) {
      const oldestRunId = this.#handledRunIds.values().next().value as
        string | undefined;
      if (oldestRunId === undefined) {
        return;
      }
      this.#handledRunIds.delete(oldestRunId);
    }
  }
}
