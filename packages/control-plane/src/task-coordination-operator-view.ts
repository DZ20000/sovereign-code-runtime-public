import {
  TASK_COORDINATION_OPERATOR_INBOX_SCHEMA_VERSION,
  type TaskCoordinationOperatorInbox,
  type TaskCoordinationOperatorInboxInput,
} from "@sovereign/control-plane-contract";
import { TaskCoordinationDiscovery } from "./task-coordination-discovery.js";
import {
  DEFAULT_MAILBOX_LIMIT,
  MAX_MAILBOX_LIMIT,
  MAX_RESPONSE_BYTES,
  MESSAGE_TABLE,
  boundedLimit,
  conflict,
  invalid,
  isoTimestamp,
  pendingSql,
  requiredIdentifier,
  requiredSequence,
  responseBytes,
  type CoordinationRow,
} from "./task-coordination-store-core.js";

/** Local operator projection, not an Agent mailbox read. No receipt/lease writes. */
export class TaskCoordinationOperatorView extends TaskCoordinationDiscovery {
  /** Canonical positional adapter for desktop and registry callers. */
  operatorInboxForTask(
    taskId: string,
    beforeSequence?: number,
    limit = DEFAULT_MAILBOX_LIMIT,
  ): TaskCoordinationOperatorInbox {
    return this.operatorInbox({
      taskId,
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit,
    });
  }

  operatorInbox(
    input: TaskCoordinationOperatorInboxInput,
  ): TaskCoordinationOperatorInbox {
    // A read snapshot keeps ownership, counters and messages coherent with other
    // database connections. This also composes with an existing caller transaction.
    this.database.exec("SAVEPOINT task_coordination_operator_read");
    try {
      const result = this.#snapshot(input);
      this.database.exec("RELEASE SAVEPOINT task_coordination_operator_read");
      return result;
    } catch (error) {
      try {
        this.database.exec(
          "ROLLBACK TO SAVEPOINT task_coordination_operator_read",
        );
        this.database.exec("RELEASE SAVEPOINT task_coordination_operator_read");
      } catch {
        /* Preserve the original error. */
      }
      throw error;
    }
  }

  #snapshot(
    input: TaskCoordinationOperatorInboxInput,
  ): TaskCoordinationOperatorInbox {
    const taskId = requiredIdentifier(input.taskId, "Task ID");
    const before =
      input.beforeSequence === undefined
        ? null
        : requiredSequence(
            input.beforeSequence,
            "Coordination operator inbox cursor",
          );
    if (before !== null && before < 1)
      invalid("Coordination operator inbox cursor must be positive.");
    const limit = boundedLimit(
      input.limit,
      DEFAULT_MAILBOX_LIMIT,
      MAX_MAILBOX_LIMIT,
      "Coordination operator inbox limit",
    );
    const task = this.task(taskId);
    const now = isoTimestamp(undefined);
    const rows = this.database
      .prepare(
        `
      SELECT * FROM ${MESSAGE_TABLE}
      WHERE recipient_task_id = ? AND (? IS NULL OR recipient_sequence < ?)
      ORDER BY recipient_sequence DESC LIMIT ?
    `,
      )
      .all(task.id, before, before, limit + 1) as unknown as CoordinationRow[];
    const counts = this.database
      .prepare(
        `
      SELECT COUNT(*) AS pending_count,
        COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread_count
      FROM ${MESSAGE_TABLE}
      WHERE recipient_task_id = ? AND recipient_principal_id = ? AND ${pendingSql()}
    `,
      )
      .get(task.id, task.principal_id, now) as {
        readonly pending_count: number;
        readonly unread_count: number;
      };
    let visible = rows.slice(0, limit);
    const build = (): TaskCoordinationOperatorInbox => {
      const messages = [...visible]
        .reverse()
        .map((row) => this.mapMessage(row, now));
      const truncated = visible.length < rows.length;
      return {
        schemaVersion: TASK_COORDINATION_OPERATOR_INBOX_SCHEMA_VERSION,
        taskId: task.id,
        generatedAt: now,
        messages,
        unreadCount: counts.unread_count,
        pendingCount: counts.pending_count,
        firstSequence: messages[0]?.recipientSequence ?? null,
        lastSequence: messages.at(-1)?.recipientSequence ?? null,
        nextBeforeSequence: truncated
          ? (messages[0]?.recipientSequence ?? null)
          : null,
        truncated,
      };
    };
    let result = build();
    while (visible.length > 1 && responseBytes(result) > MAX_RESPONSE_BYTES) {
      visible = visible.slice(0, Math.max(1, Math.floor(visible.length / 2)));
      result = build();
    }
    if (responseBytes(result) > MAX_RESPONSE_BYTES)
      conflict("Coordination response exceeds the bounded response size.");
    return result;
  }
}
