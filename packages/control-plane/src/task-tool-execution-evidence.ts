import type { DatabaseSync } from "node:sqlite";

import { RuntimeError } from "@sovereign/runtime-core";

import type { TaskSessionLeaseStore } from "./task-session-leases.js";

export const TASK_TOOL_EXECUTION_EVIDENCE_TABLE =
  "task_tool_execution_evidence_v1";

const TERMINAL_EXEC_TOOL = "terminal.exec";

interface TaskProjectRow {
  readonly id: string;
  readonly project_root: string;
}

interface TaskToolExecutionEvidenceRow {
  readonly activity_id: string;
  readonly tool_name: string;
  readonly outcome: string;
  readonly receipt_id: string | null;
  readonly error_code: string | null;
}

export interface TaskToolExecutionCompletionEvidence {
  readonly activityId: string;
  readonly toolName: string;
  readonly outcome: "succeeded" | "failed";
  readonly receiptId?: string | null;
  readonly errorCode?: string | null;
}

interface TaskToolExecutionStartEvidence {
  readonly activityId?: string;
  readonly sessionId?: string | null;
  readonly toolName: string;
  readonly startedAt: string;
}

function boundedIdentifier(value: unknown, maximum = 160): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

export function currentTaskProjectRoot(
  database: DatabaseSync,
  leases: TaskSessionLeaseStore,
  principalIdValue: string,
  sessionIdValue: string,
  observedAt = new Date().toISOString(),
): string | null {
  const principalId = boundedIdentifier(principalIdValue);
  const sessionId = boundedIdentifier(sessionIdValue);
  if (principalId === null || sessionId === null) return null;
  const rows = database
    .prepare(
      `
        SELECT task.id, project.root AS project_root
        FROM tasks task
        JOIN task_projects project ON project.id = task.project_id
        WHERE task.principal_id = ?
          AND task.source != 'inferred'
          AND task.status NOT IN ('succeeded', 'failed', 'cancelled')
        ORDER BY COALESCE(task.last_heartbeat_at, task.updated_at) DESC
      `,
    )
    .all(principalId) as unknown as TaskProjectRow[];
  const current = rows.filter((row) =>
    leases.hasLiveCurrentSession(row.id, principalId, sessionId, observedAt),
  );
  return current.length === 1 ? current[0]!.project_root : null;
}

export function recordTaskToolExecutionStart(
  database: DatabaseSync,
  taskId: string,
  input: TaskToolExecutionStartEvidence,
): void {
  if (input.toolName !== TERMINAL_EXEC_TOOL) return;
  const activityId = boundedIdentifier(input.activityId);
  const sessionId = boundedIdentifier(input.sessionId);
  if (activityId === null || sessionId === null) return;
  database
    .prepare(
      `
        INSERT INTO ${TASK_TOOL_EXECUTION_EVIDENCE_TABLE} (
          task_id, activity_id, session_id, tool_name, outcome,
          receipt_id, error_code, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          activity_id = excluded.activity_id,
          session_id = excluded.session_id,
          tool_name = excluded.tool_name,
          outcome = excluded.outcome,
          receipt_id = NULL,
          error_code = NULL,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= ${TASK_TOOL_EXECUTION_EVIDENCE_TABLE}.updated_at
      `,
    )
    .run(taskId, activityId, sessionId, input.toolName, input.startedAt);
}

export function recordTaskToolExecutionCompletion(
  database: DatabaseSync,
  taskId: string,
  sessionIdValue: string | null,
  completedAt: string,
  evidence?: TaskToolExecutionCompletionEvidence,
): "succeeded" | "failed" | null {
  if (evidence?.toolName !== TERMINAL_EXEC_TOOL) return null;
  const activityId = boundedIdentifier(evidence.activityId);
  const sessionId = boundedIdentifier(sessionIdValue);
  if (activityId === null || sessionId === null) return "failed";
  const receiptId = boundedIdentifier(evidence.receiptId);
  const succeeded = evidence.outcome === "succeeded" && receiptId !== null;
  const errorCode = succeeded
    ? null
    : (boundedIdentifier(evidence.errorCode) ??
      (receiptId === null ? "INTERNAL_ERROR" : "PROCESS_FAILED"));
  database
    .prepare(
      `
        INSERT INTO ${TASK_TOOL_EXECUTION_EVIDENCE_TABLE} (
          task_id, activity_id, session_id, tool_name, outcome,
          receipt_id, error_code, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          session_id = excluded.session_id,
          outcome = excluded.outcome,
          receipt_id = excluded.receipt_id,
          error_code = excluded.error_code,
          updated_at = excluded.updated_at
        WHERE ${TASK_TOOL_EXECUTION_EVIDENCE_TABLE}.activity_id = excluded.activity_id
      `,
    )
    .run(
      taskId,
      activityId,
      sessionId,
      evidence.toolName,
      succeeded ? "succeeded" : "failed",
      succeeded ? receiptId : null,
      errorCode,
      completedAt,
    );
  const current = database
    .prepare(
      `SELECT outcome, receipt_id FROM ${TASK_TOOL_EXECUTION_EVIDENCE_TABLE} WHERE task_id = ?`,
    )
    .get(taskId) as Pick<
    TaskToolExecutionEvidenceRow,
    "outcome" | "receipt_id"
  >;
  return current.outcome === "succeeded" && current.receipt_id !== null
    ? "succeeded"
    : "failed";
}

export function assertTaskTerminalExecutionSucceeded(
  database: DatabaseSync,
  taskId: string,
): void {
  const evidence = database
    .prepare(
      `
        SELECT activity_id, tool_name, outcome, receipt_id, error_code
        FROM ${TASK_TOOL_EXECUTION_EVIDENCE_TABLE}
        WHERE task_id = ?
      `,
    )
    .get(taskId) as TaskToolExecutionEvidenceRow | undefined;
  if (
    evidence === undefined ||
    (evidence.outcome === "succeeded" && evidence.receipt_id !== null)
  ) {
    return;
  }
  throw new RuntimeError(
    "POLICY_DENIED",
    "Task cannot be marked succeeded because the latest terminal.exec did not produce a successful execution receipt.",
    409,
    {
      activityId: evidence.activity_id,
      toolName: evidence.tool_name,
      outcome: evidence.outcome,
      receiptId: evidence.receipt_id,
      errorCode: evidence.error_code,
    },
  );
}
