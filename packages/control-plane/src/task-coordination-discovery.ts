import { resolve } from "node:path";
import {
  TASK_COORDINATION_DIRECTORY_SCHEMA_VERSION,
  TASK_COORDINATION_PENDING_SCHEMA_VERSION,
  type TaskCoordinationDirectory,
  type TaskCoordinationDirectoryEntry,
  type TaskCoordinationDirectoryInput,
  type TaskCoordinationEndpointAvailability,
  type TaskCoordinationPending,
  type TaskCoordinationPendingEntry,
  type TaskCoordinationPendingInput,
} from "@sovereign/control-plane-contract";
import {
  DEFAULT_DIRECTORY_LIMIT,
  DEFAULT_PENDING_MESSAGE_LIMIT,
  DEFAULT_PENDING_TASK_LIMIT,
  MAX_DIRECTORY_LIMIT,
  MAX_PENDING_MESSAGE_LIMIT,
  MAX_PENDING_TASK_LIMIT,
  MAX_RESPONSE_BYTES,
  MESSAGE_TABLE,
  TERMINAL_STATUSES,
  TaskCoordinationStoreCore,
  boundedLimit,
  conflict,
  invalid,
  isoTimestamp,
  pathWithin,
  pendingSql,
  requiredIdentifier,
  requiredSequence,
  responseBytes,
  type CoordinationRow,
  type TaskCoordinationContext,
  type TaskIdentityRow,
} from "./task-coordination-store-core.js";

interface PendingTaskRow {
  readonly id: string;
  readonly pending_count: number;
  readonly oldest_pending_at: string;
  readonly newest_pending_at: string;
  readonly oldest_ordinal: number;
}

export class TaskCoordinationDiscovery extends TaskCoordinationStoreCore {
  pending(
    input: TaskCoordinationPendingInput,
    context: TaskCoordinationContext,
  ): TaskCoordinationPending {
    const agentId = requiredIdentifier(input.agentId, "Task Agent ID");
    const principalId = requiredIdentifier(context.principalId, "Principal ID");
    const workspaceRoot = this.workspaceRoot(context);
    const taskLimit = boundedLimit(
      input.taskLimit,
      DEFAULT_PENDING_TASK_LIMIT,
      MAX_PENDING_TASK_LIMIT,
      "Coordination pending Task limit",
    );
    const messageLimit = boundedLimit(
      input.messageLimit,
      DEFAULT_PENDING_MESSAGE_LIMIT,
      MAX_PENDING_MESSAGE_LIMIT,
      "Coordination pending message limit",
    );
    const timestamp = isoTimestamp(context.now);
    const candidateRows = this.database
      .prepare(
        `
        SELECT
          t.id,
          COUNT(*) AS pending_count,
          MIN(m.created_at) AS oldest_pending_at,
          MAX(m.created_at) AS newest_pending_at,
          MIN(m.ordinal) AS oldest_ordinal
        FROM tasks t
        JOIN ${MESSAGE_TABLE} m ON m.recipient_task_id = t.id
        WHERE t.agent_id = ?
          AND t.principal_id = ?
          AND t.source != 'inferred'
          AND m.recipient_principal_id = ?
          AND ${pendingSql("m")}
        GROUP BY t.id
        ORDER BY oldest_ordinal ASC, t.id ASC
      `,
      )
      .all(
        agentId,
        principalId,
        principalId,
        timestamp,
      ) as unknown as PendingTaskRow[];
    const valid: Array<{
      readonly row: PendingTaskRow;
      readonly task: TaskIdentityRow;
    }> = [];
    let skippedTaskCount = 0;
    for (const row of candidateRows) {
      const task = this.task(row.id);
      if (this.taskWithinWorkspace(task, workspaceRoot)) {
        valid.push({ row, task });
      } else {
        skippedTaskCount += 1;
      }
    }
    const totalPendingMessageCount = valid.reduce(
      (total, value) => total + value.row.pending_count,
      0,
    );
    const totalTaskCount = valid.length;
    const entries: TaskCoordinationPendingEntry[] = valid
      .slice(0, taskLimit)
      .map(({ row, task }) => {
        const messages = this.database
          .prepare(
            `
            SELECT * FROM ${MESSAGE_TABLE}
            WHERE recipient_task_id = ?
              AND recipient_principal_id = ?
              AND ${pendingSql()}
            ORDER BY recipient_sequence ASC
            LIMIT ?
          `,
          )
          .all(
            task.id,
            principalId,
            timestamp,
            messageLimit,
          ) as unknown as CoordinationRow[];
        return {
          taskId: task.id,
          taskTitle: task.title,
          taskStatus: task.status,
          pendingCount: row.pending_count,
          oldestPendingAt: row.oldest_pending_at,
          newestPendingAt: row.newest_pending_at,
          messages: messages.map((message) =>
            this.mapMessage(message, timestamp),
          ),
        };
      });
    let visibleEntries = entries;
    while (responseBytes(visibleEntries) > MAX_RESPONSE_BYTES) {
      const reducible = visibleEntries.findIndex(
        (entry) => entry.messages.length > 1,
      );
      if (reducible >= 0) {
        visibleEntries = visibleEntries.map((entry, index) =>
          index === reducible
            ? { ...entry, messages: entry.messages.slice(0, -1) }
            : entry,
        );
      } else if (visibleEntries.length > 1) {
        visibleEntries = visibleEntries.slice(0, -1);
      } else {
        conflict(
          "Coordination pending inbox exceeds the bounded response size.",
        );
      }
    }
    return {
      schemaVersion: TASK_COORDINATION_PENDING_SCHEMA_VERSION,
      generatedAt: timestamp,
      totalPendingMessageCount,
      totalTaskCount,
      skippedTaskCount,
      truncated:
        totalTaskCount > visibleEntries.length ||
        visibleEntries.some(
          (entry) =>
            entry.messages.length < Math.min(entry.pendingCount, messageLimit),
        ),
      entries: visibleEntries,
    };
  }

  directory(
    input: TaskCoordinationDirectoryInput,
    context: TaskCoordinationContext,
  ): TaskCoordinationDirectory {
    const offset =
      input.offset === undefined
        ? 0
        : requiredSequence(input.offset, "Task directory offset");
    if (offset > 500) invalid("Task directory offset must not exceed 500.");
    const limit = boundedLimit(
      input.limit,
      DEFAULT_DIRECTORY_LIMIT,
      MAX_DIRECTORY_LIMIT,
      "Task directory limit",
    );
    const workspaceRoot = this.workspaceRoot(context);
    const rows = this.database
      .prepare(
        `
        SELECT
          t.id,
          t.project_id,
          p.name AS project_name,
          p.root AS project_root,
          t.title,
          t.status,
          t.source,
          t.agent_id,
          t.agent_name,
          t.principal_id,
          t.last_heartbeat_at,
          t.updated_at
        FROM tasks t
        JOIN task_projects p ON p.id = t.project_id
        ORDER BY t.updated_at DESC, t.id ASC
      `,
      )
      .all() as unknown as TaskIdentityRow[];
    const visible: Array<{
      readonly task: TaskIdentityRow;
      readonly missingRoot: boolean;
    }> = [];
    let skippedTaskCount = 0;
    for (const task of rows) {
      if (this.taskWithinWorkspace(task, workspaceRoot)) {
        visible.push({ task, missingRoot: false });
        continue;
      }
      if (pathWithin(workspaceRoot, resolve(task.project_root))) {
        visible.push({ task, missingRoot: true });
      } else {
        skippedTaskCount += 1;
      }
    }
    const pageRows = visible.slice(offset, offset + limit);
    const entries: TaskCoordinationDirectoryEntry[] = pageRows.map(
      ({ task, missingRoot }) => {
        let availability: TaskCoordinationEndpointAvailability;
        if (missingRoot) {
          availability = "missing-root";
        } else if (task.source === "inferred") {
          availability = "inferred";
        } else if (
          task.agent_id === null ||
          task.agent_name === null ||
          task.principal_id === null
        ) {
          availability = "unassigned";
        } else if (TERMINAL_STATUSES.has(task.status)) {
          availability = "terminal";
        } else {
          availability = "available";
        }
        return {
          taskId: task.id,
          taskTitle: task.title,
          taskStatus: task.status,
          projectName: task.project_name,
          projectRoot: task.project_root,
          agentId: task.agent_id,
          agentName: task.agent_name,
          lastHeartbeatAt: task.last_heartbeat_at,
          availability,
          acceptsCoordination: availability === "available",
        };
      },
    );
    return {
      schemaVersion: TASK_COORDINATION_DIRECTORY_SCHEMA_VERSION,
      generatedAt: isoTimestamp(context.now),
      offset,
      limit,
      totalTaskCount: visible.length,
      skippedTaskCount,
      nextOffset:
        offset + entries.length < visible.length
          ? offset + entries.length
          : null,
      tasks: entries,
    };
  }
}
