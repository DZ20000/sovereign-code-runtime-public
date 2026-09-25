import { TaskStatementCache } from "./task-statement-cache.js";
import { createHash, randomUUID } from "node:crypto";

import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DesktopTaskClaimInput,
  DesktopTaskCreateInput,
  DesktopTaskDetail,
  DesktopTaskHeartbeatInput,
  DesktopTaskHeartbeatResult,
  DesktopTaskInbox,
  DesktopTaskListItem,
  DesktopTaskMessage,
  DesktopTaskMessageListInput,
  DesktopTaskMessageRole,
  DesktopTaskSource,
  DesktopTaskSummary,
  DesktopTaskUnassignInput,
  DesktopTaskUpdateInput,
  DesktopTaskWorkspaceSnapshot,
} from "@sovereign/control-plane-contract";
import { RuntimeError } from "@sovereign/runtime-core";
import { requireCurrentTaskAgent } from "./task-agent-ownership.js";
import { TaskCoordinationStore } from "./task-coordination-store.js";
import { taskCoordinationPendingProjection } from "./task-coordination-store-core.js";
import { TaskMessageRetentionStore } from "./task-message-retention.js";
import {
  TaskSessionLeaseStore,
  taskSessionId,
  taskSessionLeaseProjection,
} from "./task-session-leases.js";
import {
  TASK_SCHEMA_VERSION,
  TASK_INBOX_SCHEMA_VERSION,
  MAX_PROJECTS,
  MAX_TASKS_PER_PROJECT,
  MAX_TOTAL_TASKS,
  MAX_MESSAGES,
  MAX_TOTAL_MESSAGES,
  TASK_MUTATION_MESSAGE_WINDOW,
  DEFAULT_TASK_SNAPSHOT_LIMIT,
  MAX_TASK_SNAPSHOT_BYTES,
  MAX_TASK_MESSAGE_PAGE_BYTES,
  MAX_TASK_DETAIL_BYTES,
  DEFAULT_TASK_INBOX_TASK_LIMIT,
  MAX_TASK_INBOX_TASK_LIMIT,
  DEFAULT_TASK_INBOX_MESSAGE_LIMIT,
  MAX_TASK_INBOX_MESSAGE_LIMIT,
  ACTIVE_TASK_STATUSES,
  ATTENTION_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type ProjectRow,
  type TaskRow,
  type MessageRow,
  type TaskRegistryOptions,
  type TaskActivityStartInput,
  boundedText,
  requiredText,
  normalizeRoot,
  existingDirectoryRoot,
  projectWithinWorkspace,
  assertProjectWithinWorkspace,
  isoNow,
  validCategory,
  validStatus,
  messageSequenceValue,
  normalizedProgress,
  normalizeSteps,
  taskFromRow,
  compactPreview,
  taskListItem,
  projectPageSummary,
  normalizedSnapshotOffset,
  normalizedSnapshotLimit,
  normalizedInboxLimit,
  messageFromRow,
  boundedMessagePage,
  categoryFromTool,
} from "./task-registry-model.js";
import { initializeTaskRegistrySchema } from "./task-registry-schema.js";
import {
  assertTaskTerminalExecutionSucceeded,
  currentTaskProjectRoot as currentProjectRootForTaskSession,
  recordTaskToolExecutionCompletion,
  recordTaskToolExecutionStart,
  type TaskToolExecutionCompletionEvidence,
} from "./task-tool-execution-evidence.js";

export { defaultTaskDatabasePath } from "./task-registry-model.js";
export type { TaskRegistryOptions, TaskActivityStartInput } from "./task-registry-model.js";
export type { TaskToolExecutionCompletionEvidence } from "./task-tool-execution-evidence.js";

export class TaskRegistry {
  readonly #database: DatabaseSync;
  readonly #statements: TaskStatementCache;
  readonly #messageRetention: TaskMessageRetentionStore;
  readonly #sessionLeases: TaskSessionLeaseStore;
  readonly #coordinationStore: TaskCoordinationStore;
  readonly #onChanged: (() => void) | undefined;
  #closed = false;
  #revision = 0;

  constructor(options: TaskRegistryOptions) {
    this.#onChanged = options.onChanged;
    this.#database = new DatabaseSync(resolve(options.databasePath));
    this.#statements = new TaskStatementCache(this.#database);
    try {
      initializeTaskRegistrySchema(this.#database);
      this.#messageRetention = new TaskMessageRetentionStore(this.#database, {
        perTask: MAX_MESSAGES,
        total: MAX_TOTAL_MESSAGES,
      });
      this.#sessionLeases = new TaskSessionLeaseStore(this.#database);
      this.#coordinationStore = new TaskCoordinationStore(this.#database, {
        onChanged: () => this.#changed(),
        sessionLeases: this.#sessionLeases,
      });
    } catch (error) {
      try {
        this.#database.close();
      } catch {
        // Preserve the initialization error; the unopened Registry is unusable.
      }
      this.#closed = true;
      throw error;
    }
  }

  coordinationStore(): TaskCoordinationStore { return this.#coordinationStore; }
  coordinationInbox(...args: Parameters<TaskCoordinationStore["operatorInboxForTask"]>) { return this.#coordinationStore.operatorInboxForTask(...args); }

  touchSessionActivity(principalId: string, sessionId: string | null, observedAt?: string): readonly string[] {
    if (sessionId === null) return [];
    const normalizedPrincipal = requiredText(principalId, "Principal id", 160);
    let touched: readonly string[] = [];
    this.#transaction(() => {
      touched = this.#sessionLeases.touchSession(
        normalizedPrincipal,
        sessionId,
        observedAt,
      );
    });
    if (touched.length > 0) this.#changed();
    return touched;
  }

  closeSession(
    principalId: string,
    sessionId: string,
    reason: string,
    observedAt?: string,
  ): readonly string[] {
    const normalizedPrincipal = requiredText(principalId, "Principal id", 160);
    const normalizedReason = requiredText(reason, "Session close reason", 240);
    const now = observedAt ?? isoNow();
    let closed: readonly string[] = [];
    this.#transaction(() => {
      closed = this.#sessionLeases.closeSession({
        principalId: normalizedPrincipal,
        sessionId,
        observedAt: now,
        reason: normalizedReason,
      });
    });
    if (closed.length > 0) this.#changed();
    return closed;
  }

  currentTaskProjectRoot(principalId: string, sessionId: string, observedAt = isoNow()): string | null { return currentProjectRootForTaskSession(this.#database, this.#sessionLeases, principalId, sessionId, observedAt); }

  sweepExpiredSessionLeases(observedAt = isoNow()): readonly string[] {
    return this.#sessionLeases.expiredOwnedTasks(observedAt);
  }

  #touchTaskSession(
    task: DesktopTaskSummary,
    sessionId: string | null | undefined,
    observedAt?: string,
  ): void {
    if (
      task.agent.id === null ||
      task.agent.principalId === null ||
      TERMINAL_TASK_STATUSES.has(task.status)
    ) {
      return;
    }
    const normalizedSessionId = taskSessionId(
      sessionId,
      task.id,
      task.agent.id,
      task.agent.principalId,
    );
    this.#sessionLeases.touchTask({
      taskId: task.id,
      sessionId: normalizedSessionId,
      legacy: sessionId === null || sessionId === undefined,
      agentId: task.agent.id,
      principalId: task.agent.principalId,
      ...(observedAt === undefined ? {} : { observedAt }),
    });
  }

  #observeTaskSession(
    task: DesktopTaskSummary,
    sessionId: string | null | undefined,
    observedAt?: string,
    allowNewBinding = false,
  ): void {
    if (
      sessionId === null ||
      sessionId === undefined ||
      task.agent.id === null ||
      task.agent.principalId === null ||
      TERMINAL_TASK_STATUSES.has(task.status)
    ) {
      return;
    }
    const input = {
      taskId: task.id,
      sessionId: taskSessionId(
        sessionId,
        task.id,
        task.agent.id,
        task.agent.principalId,
      ),
      agentId: task.agent.id,
      principalId: task.agent.principalId,
      ...(observedAt === undefined ? {} : { observedAt }),
    };
    if (allowNewBinding) {
      const touched = this.#sessionLeases.touchTaskWithoutReopen(input);
      if (
        !touched &&
        !this.#sessionLeases.hasLiveCurrentSession(task.id, input.principalId, input.sessionId, observedAt)
      )
        throw new RuntimeError("POLICY_DENIED", "Task message requires a live current-owner session.", 403);
    } else {
      this.#sessionLeases.renewTask(input);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Closing the handle remains authoritative even when checkpointing is unavailable.
    }
    this.#database.close();
    this.#closed = true;
  }

  #ensureProject(projectRoot: string, projectName?: string): ProjectRow {
    const normalized = normalizeRoot(projectRoot);
    const existing = this.#statements
      .prepare(
        `
      SELECT id, root, normalized_root, name, created_at, updated_at
      FROM task_projects
      WHERE normalized_root = ?
    `,
      )
      .get(normalized.normalized) as ProjectRow | undefined;
    if (existing !== undefined) {
      const requestedName = boundedText(projectName, "Project name", 160);
      if (requestedName.length > 0 && requestedName !== existing.name) {
        const explicitTaskCount = this.#statements
          .prepare(
            `
          SELECT COUNT(*) AS count FROM tasks
          WHERE project_id = ? AND source != 'inferred'
        `,
          )
          .get(existing.id) as { readonly count: number };
        const defaultName = basename(existing.root) || "Workspace";
        if (explicitTaskCount.count === 0 || existing.name === defaultName) {
          const updatedAt = isoNow();
          this.#statements
            .prepare(
              `
            UPDATE task_projects SET name = ?, root = ?, updated_at = ? WHERE id = ?
          `,
            )
            .run(requestedName, normalized.root, updatedAt, existing.id);
          return {
            ...existing,
            name: requestedName,
            root: normalized.root,
            updated_at: updatedAt,
          };
        }
      }
      return existing;
    }
    const projectCount = this.#statements
      .prepare("SELECT COUNT(*) AS count FROM task_projects")
      .get() as { readonly count: number };
    if (projectCount.count >= MAX_PROJECTS) {
      throw new RuntimeError(
        "POLICY_DENIED",
        `The task registry may contain at most ${MAX_PROJECTS} projects.`,
        409,
      );
    }
    const now = isoNow();
    const row: ProjectRow = {
      id: randomUUID(),
      root: normalized.root,
      normalized_root: normalized.normalized,
      name:
        boundedText(projectName, "Project name", 160) ||
        basename(normalized.root) ||
        "Workspace",
      created_at: now,
      updated_at: now,
    };
    this.#statements
      .prepare(
        `
      INSERT INTO task_projects(id, root, normalized_root, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        row.id,
        row.root,
        row.normalized_root,
        row.name,
        row.created_at,
        row.updated_at,
      );
    return row;
  }

  createTask(
    input: DesktopTaskCreateInput,
    principalId: string,
    defaultProjectRoot: string,
    source: DesktopTaskSource = "agent",
    sessionId?: string | null,
  ): DesktopTaskSummary {
    const normalizedPrincipalId = requiredText(principalId, "Principal id", 160);
    const projectRoot = assertProjectWithinWorkspace(
      input.projectRoot ?? defaultProjectRoot,
      defaultProjectRoot,
      true,
    );
    const requestedProjectName = boundedText(
      input.projectName,
      "Project name",
      160,
    );
    const title = requiredText(input.title, "Task title", 200);
    const category = validCategory(input.category);
    const status = validStatus(input.status, "planning");
    const summary = boundedText(input.summary, "Task summary", 2_000);
    const currentStep = boundedText(input.currentStep, "Current step", 400);
    const progress = normalizedProgress(
      input.progressCurrent,
      input.progressTotal,
    );
    const progressLabel =
      boundedText(input.progressLabel ?? undefined, "Progress label", 240) ||
      null;
    const stepsJson = JSON.stringify(normalizeSteps(input.steps));
    const agentId =
      boundedText(input.agentId, "Agent id", 128) || normalizedPrincipalId;
    const agentName =
      boundedText(input.agentName, "Agent name", 160) || "ChatGPT Agent";
    const requestedIdempotencyKey =
      boundedText(input.idempotencyKey, "Idempotency key", 256) || null;
    const idempotencyKey =
      requestedIdempotencyKey === null
        ? null
        : createHash("sha256")
            .update(normalizedPrincipalId, "utf8")
            .update("\0", "utf8")
            .update(requestedIdempotencyKey, "utf8")
            .digest("hex");
    const projectIdentity = normalizeRoot(projectRoot);
    const taskId = randomUUID();

    const result = this.#transaction(() => {
      const existingProject = this.#statements
        .prepare(
          `
        SELECT id, root, normalized_root, name, created_at, updated_at
        FROM task_projects
        WHERE normalized_root = ?
      `,
        )
        .get(projectIdentity.normalized) as ProjectRow | undefined;
      if (existingProject !== undefined && idempotencyKey !== null) {
        const existing = this.#taskRowByIdempotency(
          existingProject.id,
          idempotencyKey,
        );
        if (existing !== undefined) {
          const task = taskFromRow(existing);
          requireCurrentTaskAgent(
            task,
            normalizedPrincipalId,
            agentId,
            input.agentName,
            "Task creation replay",
          );
          if (
            source !== "inferred" ||
            (sessionId !== null && sessionId !== undefined)
          ) {
            this.#touchTaskSession(task, sessionId, isoNow());
          }
          return { created: false as const, taskId: task.id };
        }
      }

      const totalTaskCount = this.#statements
        .prepare("SELECT COUNT(*) AS count FROM tasks")
        .get() as { readonly count: number };
      if (totalTaskCount.count >= MAX_TOTAL_TASKS) {
        throw new RuntimeError(
          "POLICY_DENIED",
          `The task registry may contain at most ${MAX_TOTAL_TASKS} tasks in total.`,
          409,
        );
      }
      if (existingProject !== undefined) {
        const taskCount = this.#statements
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?")
          .get(existingProject.id) as { readonly count: number };
        if (taskCount.count >= MAX_TASKS_PER_PROJECT) {
          throw new RuntimeError(
            "POLICY_DENIED",
            `A project may contain at most ${MAX_TASKS_PER_PROJECT} tasks.`,
            409,
          );
        }
      }

      const project = this.#ensureProject(
        projectRoot,
        requestedProjectName.length === 0 ? undefined : requestedProjectName,
      );
      const now = isoNow();
      this.#statements
        .prepare(
          `
        INSERT INTO tasks(
          id, project_id, idempotency_key, title, category, status, source, summary,
          current_step, progress_current, progress_total, progress_label, steps_json,
          agent_id, agent_name, principal_id, last_heartbeat_at,
          last_activity_label, last_activity_at, agent_ack_sequence,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)
      `,
        )
        .run(
          taskId,
          project.id,
          idempotencyKey,
          title,
          category,
          status,
          source,
          summary,
          currentStep,
          progress.current,
          progress.total,
          progressLabel,
          stepsJson,
          agentId,
          agentName,
          normalizedPrincipalId,
          now,
          now,
          now,
          TERMINAL_TASK_STATUSES.has(status) ? now : null,
        );
      this.#touchProject(project.id, now);
      this.#appendMessage(
        taskId,
        "system",
        `Task created with status ${status}.`,
        null,
        null,
        now,
      );
      if (
        source !== "inferred" ||
        (sessionId !== null && sessionId !== undefined)
      ) {
        this.#touchTaskSession(this.requiredTask(taskId), sessionId, now);
      }
      return { created: true as const, taskId };
    });
    this.#changed();
    return this.requiredTask(result.taskId);
  }

  updateTask(
    input: DesktopTaskUpdateInput,
    principalId: string,
    sessionId?: string | null,
  ): DesktopTaskSummary {
    const normalizedPrincipalId = requiredText(
      principalId,
      "Principal id",
      160,
    );
    const current = this.requiredTask(input.taskId);
    this.#assertPrincipalCanMutate(current, normalizedPrincipalId);
    requireCurrentTaskAgent(
      current,
      normalizedPrincipalId,
      requiredText(input.agentId, "Agent id", 128),
      input.agentName,
      "Task update",
    );
    const progress = normalizedProgress(
      input.progressCurrent === undefined
        ? current.progress.current
        : input.progressCurrent,
      input.progressTotal === undefined
        ? current.progress.total
        : input.progressTotal,
    );
    const status = validStatus(input.status, current.status);
    const now = isoNow();
    const title =
      input.title === undefined
        ? current.title
        : requiredText(input.title, "Task title", 200);
    const category =
      input.category === undefined
        ? current.category
        : validCategory(input.category);
    const summary =
      input.summary === undefined
        ? current.summary
        : boundedText(input.summary, "Task summary", 2_000);
    const currentStep = input.currentStep === undefined ? current.currentStep : boundedText(input.currentStep, "Current step", 400);
    const progressLabel =
      input.progressLabel === undefined
        ? current.progress.label
        : boundedText(
            input.progressLabel ?? undefined,
            "Progress label",
            240,
          ) || null;
    const stepsJson =
      input.steps === undefined
        ? JSON.stringify(current.steps)
        : JSON.stringify(normalizeSteps(input.steps));

    this.#transaction(() => {
      if (status === "succeeded") assertTaskTerminalExecutionSucceeded(this.#database, current.id);
      this.#touchTaskSession(current, sessionId, now);
      const update = this.#statements
        .prepare(
          `
        UPDATE tasks SET
          title = ?, category = ?, status = ?, summary = ?, current_step = ?,
          progress_current = ?, progress_total = ?, progress_label = ?, steps_json = ?,
          updated_at = ?, completed_at = ?
        WHERE id = ? AND principal_id = ? AND agent_id = ?
      `,
        )
        .run(
          title,
          category,
          status,
          summary,
          currentStep,
          progress.current,
          progress.total,
          progressLabel,
          stepsJson,
          now,
          TERMINAL_TASK_STATUSES.has(status)
            ? (current.completedAt ?? now)
            : null,
          input.taskId,
          normalizedPrincipalId,
          input.agentId,
        );
      if (update.changes !== 1) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Task owner changed before the update could be committed.",
          409,
        );
      }
      this.#touchProject(current.projectId, now);
      if (status !== current.status) {
        this.#appendMessage(
          input.taskId,
          "system",
          `Status changed from ${current.status} to ${status}.`,
          null,
          null,
          now,
        );
      }
    });
    this.#changed();
    return this.requiredTask(input.taskId);
  }

  unassignTask(
    input: DesktopTaskUnassignInput,
    principalId: string,
  ): DesktopTaskSummary {
    const normalizedPrincipalId = requiredText(
      principalId,
      "Principal id",
      160,
    );
    const current = this.requiredTask(input.taskId);
    this.#assertPrincipalCanMutate(current, normalizedPrincipalId);
    requireCurrentTaskAgent(
      current,
      normalizedPrincipalId,
      requiredText(input.agentId, "Agent id", 128),
      input.agentName,
      "Task unassignment",
    );
    if (
      current.source === "inferred" ||
      TERMINAL_TASK_STATUSES.has(current.status)
    ) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Only non-terminal formal Tasks can be explicitly unassigned.",
        403,
      );
    }
    const now = isoNow();
    this.#transaction(() => {
      if (current.agent.id !== null && current.agent.principalId !== null) {
        this.#sessionLeases.closeTaskOwner(
          current.id,
          current.agent.id,
          current.agent.principalId,
          "Task owner explicitly unassigned.",
          now,
        );
      }
      const update = this.#statements
        .prepare(
          `
        UPDATE tasks
        SET agent_id = NULL, agent_name = NULL, last_heartbeat_at = NULL, updated_at = ?
        WHERE id = ? AND principal_id = ? AND agent_id = ?
      `,
        )
        .run(now, input.taskId, normalizedPrincipalId, input.agentId);
      if (update.changes !== 1) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Task owner changed before the unassignment could be committed.",
          409,
        );
      }
      this.#touchProject(current.projectId, now);
      this.#appendMessage(
        input.taskId,
        "system",
        `Task Agent ${current.agent.id} was explicitly unassigned.`,
        null,
        null,
        now,
      );
    });
    this.#changed();
    return this.requiredTask(input.taskId);
  }

  claimTask(
    input: DesktopTaskClaimInput,
    principalId: string,
    sessionId?: string | null,
  ): DesktopTaskSummary {
    const normalizedPrincipalId = requiredText(
      principalId,
      "Principal id",
      160,
    );
    const nextAgentId = requiredText(input.agentId, "Agent id", 128);
    const nextAgentName = requiredText(input.agentName, "Agent name", 160);
    const result = this.#transaction(() => {
      // Read ownership and liveness after acquiring the write lock. A failed
      // lease binding must roll back ownership, lease revocation and audit rows.
      const current = this.requiredTask(input.taskId);
      this.#assertPrincipalCanMutate(current, normalizedPrincipalId);
      if (
        current.source === "inferred" ||
        TERMINAL_TASK_STATUSES.has(current.status)
      ) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Only non-terminal formal Tasks can be explicitly claimed.",
          403,
        );
      }
      if (
        input.expectedCurrentAgentId !== undefined &&
        input.expectedCurrentAgentId !== current.agent.id
      ) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Task owner changed before the explicit claim could be applied.",
          409,
        );
      }
      if (
        current.agent.id !== null &&
        current.agent.id !== nextAgentId &&
        current.agent.presence === "online"
      ) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "An online Task Agent cannot be replaced by another session.",
          409,
        );
      }
      const now = isoNow();
      if (
        current.agent.id === nextAgentId &&
        current.agent.name === nextAgentName
      ) {
        this.#touchTaskSession(current, sessionId, now);
        return this.requiredTask(current.id);
      }
      if (
        current.agent.id !== null &&
        current.agent.principalId !== null &&
        current.agent.id !== nextAgentId
      ) {
        this.#sessionLeases.closeTaskOwner(
          current.id,
          current.agent.id,
          current.agent.principalId,
          "Task ownership explicitly changed.",
          now,
        );
      }
      const update = this.#statements
        .prepare(
          `
        UPDATE tasks
        SET agent_id = ?, agent_name = ?, principal_id = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND principal_id = ?
          AND ((agent_id IS NULL AND ? IS NULL) OR agent_id = ?)
      `,
        )
        .run(
          nextAgentId,
          nextAgentName,
          normalizedPrincipalId,
          now,
          now,
          input.taskId,
          normalizedPrincipalId,
          current.agent.id,
          current.agent.id,
        );
      if (update.changes !== 1) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Task owner changed before the explicit claim could be committed.",
          409,
        );
      }
      this.#touchTaskSession(this.requiredTask(input.taskId), sessionId, now);
      this.#touchProject(current.projectId, now);
      this.#appendMessage(
        input.taskId,
        "system",
        `Task ownership explicitly changed from ${current.agent.id ?? "unassigned"} to ${nextAgentId}.`,
        null,
        null,
        now,
      );
      return this.requiredTask(input.taskId);
    });
    this.#changed();
    return result;
  }

  heartbeat(
    input: DesktopTaskHeartbeatInput,
    principalId: string,
    sessionId?: string | null,
  ): DesktopTaskHeartbeatResult {
    const normalizedPrincipalId = requiredText(
      principalId,
      "Principal id",
      160,
    );
    const current = this.requiredTask(input.taskId);
    this.#assertPrincipalCanMutate(current, normalizedPrincipalId);
    const agentId = requiredText(input.agentId, "Agent id", 128);
    const agentName = requireCurrentTaskAgent(
      current,
      normalizedPrincipalId,
      agentId,
      input.agentName,
      "Task heartbeat",
    );
    const progress = normalizedProgress(
      input.progressCurrent === undefined
        ? current.progress.current
        : input.progressCurrent,
      input.progressTotal === undefined
        ? current.progress.total
        : input.progressTotal,
    );
    const status = input.status === undefined ? current.status : validStatus(input.status, current.status);
    const now = isoNow();
    const acknowledgeThrough =
      input.acknowledgeThroughSequence === undefined
        ? null
        : messageSequenceValue(
            input.acknowledgeThroughSequence,
            "Acknowledged message sequence",
          );
    const currentStep =
      input.currentStep === undefined
        ? current.currentStep
        : boundedText(input.currentStep, "Current step", 400);
    const progressLabel =
      input.progressLabel === undefined
        ? current.progress.label
        : boundedText(
            input.progressLabel ?? undefined,
            "Progress label",
            240,
          ) || null;
    const nextAck = this.#transaction(() => {
      this.#touchTaskSession(current, sessionId, now);
      const currentAck = this.#statements
        .prepare(
          `
        SELECT t.agent_ack_sequence,
          COALESCE((SELECT MAX(sequence) FROM task_messages WHERE task_id = t.id), 0)
            AS maximum_message_sequence
        FROM tasks t
        WHERE t.id = ?
      `,
        )
        .get(input.taskId) as {
        readonly agent_ack_sequence: number;
        readonly maximum_message_sequence: number;
      };
      const acknowledgedSequence =
        acknowledgeThrough === null
          ? currentAck.agent_ack_sequence
          : Math.min(
              currentAck.maximum_message_sequence,
              Math.max(currentAck.agent_ack_sequence, acknowledgeThrough),
            );
      const update = this.#statements
        .prepare(
          `
        UPDATE tasks SET
          status = ?, current_step = ?, progress_current = ?, progress_total = ?,
          progress_label = ?, agent_id = ?, agent_name = ?, principal_id = ?,
          last_heartbeat_at = ?, agent_ack_sequence = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND principal_id = ? AND agent_id = ?
      `,
        )
        .run(
          status,
          currentStep,
          progress.current,
          progress.total,
          progressLabel,
          agentId,
          agentName,
          normalizedPrincipalId,
          now,
          acknowledgedSequence,
          now,
          TERMINAL_TASK_STATUSES.has(status)
            ? (current.completedAt ?? now)
            : null,
          input.taskId,
          normalizedPrincipalId,
          agentId,
        );
      if (update.changes !== 1) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Task owner changed before the heartbeat could be committed.",
          409,
        );
      }
      if (acknowledgedSequence > currentAck.agent_ack_sequence) {
        this.#statements
          .prepare(
            `
          UPDATE task_messages
          SET acknowledged_at = COALESCE(acknowledged_at, ?)
          WHERE task_id = ? AND role = 'user' AND sequence <= ?
        `,
          )
          .run(now, input.taskId, acknowledgedSequence);
      }
      this.#touchProject(current.projectId, now);
      return acknowledgedSequence;
    });
    this.#changed();
    const task = this.requiredTask(input.taskId);
    let pendingUserMessages = this.#pendingUserMessages(
      input.taskId,
      nextAck,
      50,
    );
    let result: DesktopTaskHeartbeatResult = { task, pendingUserMessages };
    while (
      pendingUserMessages.length > 1 &&
      Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") >
        MAX_TASK_DETAIL_BYTES
    ) {
      pendingUserMessages = pendingUserMessages.slice(
        0,
        Math.max(1, Math.floor(pendingUserMessages.length / 2)),
      );
      result = { task, pendingUserMessages };
    }
    if (
      Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") >
      MAX_TASK_DETAIL_BYTES
    ) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "One task heartbeat response exceeds the bounded control-plane size.",
        409,
      );
    }
    return result;
  }

  inboxForPrincipal(
    principalId: string,
    taskLimitValue?: number,
    messageLimitValue?: number,
  ): DesktopTaskInbox {
    const normalizedPrincipal = requiredText(principalId, "Principal id", 160);
    const taskLimit = normalizedInboxLimit(
      taskLimitValue,
      DEFAULT_TASK_INBOX_TASK_LIMIT,
      MAX_TASK_INBOX_TASK_LIMIT,
      "Task inbox task limit",
    );
    const messageLimit = normalizedInboxLimit(
      messageLimitValue,
      DEFAULT_TASK_INBOX_MESSAGE_LIMIT,
      MAX_TASK_INBOX_MESSAGE_LIMIT,
      "Task inbox message limit",
    );
    const rows = this.#statements
      .prepare(
        `
      SELECT t.*, p.name AS project_name, p.root AS project_root,
        (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id) AS message_count,
        (SELECT COUNT(*) FROM task_messages m
           WHERE m.task_id = t.id AND m.role = 'user' AND m.sequence > t.agent_ack_sequence
        ) AS unread_user_message_count,
        ${taskCoordinationPendingProjection("t")},
        ${taskSessionLeaseProjection("t")}
      FROM tasks t
      JOIN task_projects p ON p.id = t.project_id
      WHERE t.principal_id = ?
        AND EXISTS (
          SELECT 1 FROM task_messages m
          WHERE m.task_id = t.id AND m.role = 'user' AND m.sequence > t.agent_ack_sequence
        )
      ORDER BY
        CASE t.status
          WHEN 'running' THEN 0
          WHEN 'planning' THEN 1
          WHEN 'queued' THEN 2
          WHEN 'waiting-user' THEN 3
          WHEN 'blocked' THEN 4
          ELSE 5
        END,
        t.updated_at DESC
      LIMIT ?
    `,
      )
      .all(
        isoNow(),
        normalizedPrincipal,
        MAX_TOTAL_TASKS,
      ) as unknown as TaskRow[];
    const eligible = rows.map(taskFromRow);
    const selected = eligible.slice(0, taskLimit);
    let entries = selected.map((task) => ({
      projectId: task.projectId,
      projectName: task.projectName,
      projectRoot: task.projectRoot,
      task: taskListItem(task),
      pendingUserMessages: this.#pendingUserMessages(
        task.id,
        this.#taskRow(task.id)?.agent_ack_sequence ?? 0,
        messageLimit,
      ),
    }));
    let truncated =
      eligible.length > selected.length ||
      entries.some(
        (entry) =>
          entry.task.unreadUserMessageCount > entry.pendingUserMessages.length,
      );
    const totalPendingUserMessageCount = eligible.reduce(
      (total, task) => total + task.unreadUserMessageCount,
      0,
    );
    const build = (): DesktopTaskInbox => ({
      schemaVersion: TASK_INBOX_SCHEMA_VERSION,
      generatedAt: isoNow(),
      totalPendingUserMessageCount,
      totalTaskCount: eligible.length,
      truncated,
      entries,
    });
    let inbox = build();
    while (
      entries.length > 1 &&
      Buffer.byteLength(JSON.stringify(inbox, null, 2), "utf8") >
        MAX_TASK_DETAIL_BYTES
    ) {
      entries = entries.slice(0, entries.length - 1);
      truncated = true;
      inbox = build();
    }
    while (
      entries.length === 1 &&
      entries[0]!.pendingUserMessages.length > 1 &&
      Buffer.byteLength(JSON.stringify(inbox, null, 2), "utf8") >
        MAX_TASK_DETAIL_BYTES
    ) {
      const entry = entries[0]!;
      entries = [
        {
          ...entry,
          pendingUserMessages: entry.pendingUserMessages.slice(
            0,
            Math.max(1, Math.floor(entry.pendingUserMessages.length / 2)),
          ),
        },
      ];
      truncated = true;
      inbox = build();
    }
    if (
      Buffer.byteLength(JSON.stringify(inbox, null, 2), "utf8") >
      MAX_TASK_DETAIL_BYTES
    ) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "One task inbox entry exceeds the bounded control-plane size.",
        409,
      );
    }
    return inbox;
  }

  addUserMessage(taskId: string, content: string): DesktopTaskDetail {
    const task = this.requiredTask(taskId);
    const message = requiredText(content, "Message", 8_000);
    const now = isoNow();
    this.#transaction(() => {
      this.#appendMessage(taskId, "user", message, null, null, now);
      this.#statements
        .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
        .run(now, taskId);
      this.#touchProject(task.projectId, now);
    });
    this.#changed();
    return this.detail(taskId, TASK_MUTATION_MESSAGE_WINDOW);
  }

  addAgentMessage(
    taskId: string,
    content: string,
    role: Extract<DesktopTaskMessageRole, "assistant" | "system">,
    agentId: string,
    agentName: string | undefined,
    principalId: string,
    sessionId?: string | null,
  ): DesktopTaskDetail {
    const normalizedPrincipalId = requiredText(principalId, "Principal id", 160);
    const normalizedAgentId = requiredText(agentId, "Agent id", 128);
    const message = requiredText(content, "Message", 8_000);
    this.#transaction(() => {
      const task = this.requiredTask(taskId);
      this.#assertPrincipalCanMutate(task, normalizedPrincipalId);
      const normalizedAgentName = requireCurrentTaskAgent(
        task,
        normalizedPrincipalId,
        normalizedAgentId,
        agentName,
        "Task message",
      );
      const now = isoNow();
      this.#observeTaskSession(task, sessionId, now, true);
      this.#appendMessage(
        taskId,
        role,
        message,
        normalizedAgentId,
        normalizedAgentName,
        now,
      );
      this.#statements
        .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
        .run(now, taskId);
      this.#touchProject(task.projectId, now);
    });
    this.#changed();
    return this.detail(taskId, TASK_MUTATION_MESSAGE_WINDOW);
  }

  listMessages(
    input: DesktopTaskMessageListInput,
  ): readonly DesktopTaskMessage[] {
    this.requiredTask(input.taskId);
    const afterSequence =
      messageSequenceValue(input.afterSequence, "After sequence") ?? 0;
    const limit = Math.max(1, Math.min(input.limit ?? 100, MAX_MESSAGES));
    const messages = (
      this.#statements
        .prepare(
          `
      SELECT id, task_id, sequence, role, agent_id, agent_name, content, created_at, acknowledged_at
      FROM task_messages
      WHERE task_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `,
        )
        .all(input.taskId, afterSequence, limit) as unknown as MessageRow[]
    ).map(messageFromRow);
    return boundedMessagePage(messages, MAX_TASK_MESSAGE_PAGE_BYTES);
  }

  detail(taskId: string, messageLimit = 200, beforeSequence?: number): DesktopTaskDetail {
    const task = this.requiredTask(taskId);
    const before = messageSequenceValue(beforeSequence, "Before sequence");
    if (before === 0) throw new RuntimeError("INVALID_INPUT", "Before sequence must be positive.", 400);
    const limit = Math.max(1, Math.min(messageLimit, MAX_MESSAGES));
    const latest = (
      this.#statements
        .prepare(
          `
      SELECT id, task_id, sequence, role, agent_id, agent_name, content, created_at, acknowledged_at
      FROM task_messages
      WHERE task_id = ? AND (? IS NULL OR sequence < ?)
      ORDER BY sequence DESC
      LIMIT ?
    `,
        )
        .all(taskId, before, before, limit) as unknown as MessageRow[]
    )
      .map(messageFromRow)
      .reverse();
    let messages: readonly DesktopTaskMessage[] = latest;
    let detail: DesktopTaskDetail;
    while (true) {
      detail = {
        task,
        messages,
        messagesTruncated: task.messageCount > messages.length,
        oldestMessageSequence: messages[0]?.sequence ?? null,
        newestMessageSequence: messages.at(-1)?.sequence ?? null,
      };
      if (
        Buffer.byteLength(JSON.stringify(detail, null, 2), "utf8") <=
        MAX_TASK_DETAIL_BYTES
      ) {
        return detail;
      }
      if (messages.length <= 1) {
        throw new RuntimeError(
          "POLICY_DENIED",
          "One task detail response exceeds the bounded control-plane size.",
          409,
        );
      }
      messages = boundedMessagePage(
        messages,
        Math.max(1, Math.floor(MAX_TASK_DETAIL_BYTES / 2)),
        true,
      );
    }
  }

  taskForWorkspace(taskId: string, workspaceRoot: string): DesktopTaskSummary {
    const task = this.requiredTask(taskId);
    assertProjectWithinWorkspace(task.projectRoot, workspaceRoot);
    return task;
  }

  detailForWorkspace(
    taskId: string,
    workspaceRoot: string,
    messageLimit = 200,
  ): DesktopTaskDetail {
    this.taskForWorkspace(taskId, workspaceRoot);
    return this.detail(taskId, messageLimit);
  }

  taskForPrincipalWorkspace(
    taskId: string,
    workspaceRoot: string,
    principalId: string,
  ): DesktopTaskSummary {
    const task = this.taskForWorkspace(taskId, workspaceRoot);
    this.#assertPrincipalCanRead(task, principalId);
    return task;
  }

  taskForPrincipal(taskId: string, principalId: string): DesktopTaskSummary {
    const task = this.requiredTask(taskId);
    this.#assertPrincipalCanRead(task, principalId);
    return task;
  }

  detailForPrincipal(
    taskId: string,
    principalId: string,
    messageLimit = 200,
  ): DesktopTaskDetail {
    this.taskForPrincipal(taskId, principalId);
    return this.detail(taskId, messageLimit);
  }

  snapshotForWorkspace(
    workspaceRoot: string,
    offset = 0,
    limit = DEFAULT_TASK_SNAPSHOT_LIMIT,
  ): DesktopTaskWorkspaceSnapshot {
    return this.#snapshotPage(
      (project) => projectWithinWorkspace(project.root, workspaceRoot),
      () => true,
      offset,
      limit,
    );
  }

  snapshotForPrincipal(
    principalId: string,
    offset = 0,
    limit = DEFAULT_TASK_SNAPSHOT_LIMIT,
  ): DesktopTaskWorkspaceSnapshot {
    const normalizedPrincipalId = requiredText(
      principalId,
      "Principal id",
      160,
    );
    return this.#snapshotPage(
      () => true,
      (task) => task.agent.principalId === normalizedPrincipalId,
      offset,
      limit,
    );
  }

  snapshot(
    offset = 0,
    limit = DEFAULT_TASK_SNAPSHOT_LIMIT,
  ): DesktopTaskWorkspaceSnapshot {
    return this.#snapshotPage(
      () => true,
      () => true,
      offset,
      limit,
    );
  }

  requiredTask(taskId: string): DesktopTaskSummary {
    const id = requiredText(taskId, "Task id", 128);
    const row = this.#taskRow(id);
    if (row === undefined) {
      throw new RuntimeError("TASK_NOT_FOUND", `Unknown task: ${id}`, 404);
    }
    return taskFromRow(row);
  }

  attachActivity(input: TaskActivityStartInput): DesktopTaskSummary {
    const principalId = requiredText(input.principalId, "Principal id", 160);
    const startedAt = requiredText(input.startedAt, "Activity start time", 64);
    if (!Number.isFinite(Date.parse(startedAt))) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Activity start time is invalid.",
        400,
      );
    }
    const workspaceRoot = existingDirectoryRoot(
      input.projectRoot,
      "Activity workspace root",
    ).root;
    const candidates = this.#statements
      .prepare(
        `
      SELECT t.*, p.name AS project_name, p.root AS project_root,
        (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id) AS message_count,
        (SELECT COUNT(*) FROM task_messages m
           WHERE m.task_id = t.id AND m.role = 'user' AND m.sequence > t.agent_ack_sequence
        ) AS unread_user_message_count,
        ${taskCoordinationPendingProjection("t")},
        ${taskSessionLeaseProjection("t")}
      FROM tasks t
      JOIN task_projects p ON p.id = t.project_id
      WHERE t.principal_id = ?
        AND t.status NOT IN ('succeeded', 'failed', 'cancelled')
      ORDER BY
        CASE WHEN t.source = 'inferred' THEN 1 ELSE 0 END,
        COALESCE(t.last_heartbeat_at, t.updated_at) DESC
      LIMIT ?
    `,
      )
      .all(isoNow(), principalId, MAX_PROJECTS * 2) as unknown as TaskRow[];
    const containedCandidates = candidates.filter((candidate) =>
      projectWithinWorkspace(candidate.project_root, workspaceRoot),
    );
    const explicitCandidates = containedCandidates.filter(
      (candidate) =>
        candidate.source !== "inferred" &&
        input.sessionId !== null &&
        input.sessionId !== undefined &&
        this.#sessionLeases.hasLiveCurrentSession(
          candidate.id,
          principalId,
          input.sessionId,
          startedAt,
        ),
    );
    const active =
      explicitCandidates.length === 1
        ? explicitCandidates[0]
        : explicitCandidates.length === 0
          ? containedCandidates.find(
              (candidate) => candidate.source === "inferred",
            )
          : undefined;
    const now = startedAt;
    if (active !== undefined) {
      const activityTitle = requiredText(input.title, "Activity title", 200);
      this.#transaction(() => {
        this.#observeTaskSession(taskFromRow(active), input.sessionId, now);
        recordTaskToolExecutionStart(this.#database, active.id, input);
        this.#statements
          .prepare(
            `
          UPDATE tasks SET last_activity_label = ?, last_activity_at = ?,
            updated_at = ? WHERE id = ?
        `,
          )
          .run(activityTitle, now, now, active.id);
        this.#touchProject(active.project_id, now);
      });
      this.#changed();
      return this.requiredTask(active.id);
    }

    const inferred = this.createTask(
      {
        projectRoot: workspaceRoot,
        ...(input.projectName === undefined
          ? {}
          : { projectName: input.projectName }),
        title: "ChatGPT activity",
        category: categoryFromTool(input.category, input.toolName),
        summary:
          "Automatically grouped activity that has not yet been claimed by an explicit Agent task.",
        status: "running",
        currentStep: input.title,
        agentId: principalId,
        idempotencyKey: `inferred:${principalId}`,
      },
      principalId,
      workspaceRoot,
      "inferred",
    );
    const activityTitle = requiredText(input.title, "Activity title", 200);
    this.#transaction(() => {
      recordTaskToolExecutionStart(this.#database, inferred.id, input);
      this.#statements
        .prepare(
          `
        UPDATE tasks SET status = 'running', current_step = ?, last_activity_label = ?,
          last_activity_at = ?, updated_at = ?, completed_at = NULL
        WHERE id = ?
      `,
        )
        .run(activityTitle, activityTitle, now, now, inferred.id);
      this.#touchProject(inferred.projectId, now);
    });
    this.#changed();
    return this.requiredTask(inferred.id);
  }

  completeActivity(
    taskId: string,
    outcome: "succeeded" | "failed",
    completedAt: string,
    remainingActiveCount: number,
    activityLabel: string,
    sessionId?: string | null,
    evidence?: TaskToolExecutionCompletionEvidence,
  ): DesktopTaskSummary {
    const current = this.requiredTask(taskId);
    if (!Number.isInteger(remainingActiveCount) || remainingActiveCount < 0) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Remaining active activity count must be a non-negative integer.",
        400,
      );
    }
    if (!Number.isFinite(Date.parse(completedAt))) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Activity completion time is invalid.",
        400,
      );
    }
    const normalizedActivityLabel = boundedText(
      activityLabel,
      "Activity label",
      200,
    );
    this.#transaction(() => {
      const verifiedOutcome = recordTaskToolExecutionCompletion(this.#database, taskId, sessionId ?? null, completedAt, evidence);
      const nextStatus = current.source === "inferred" && remainingActiveCount === 0 ? (verifiedOutcome ?? outcome) : current.status;
      this.#observeTaskSession(current, sessionId, completedAt);
      this.#statements
        .prepare(
          `
        UPDATE tasks SET last_activity_label = ?, last_activity_at = ?,
          status = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `,
        )
        .run(
          normalizedActivityLabel,
          completedAt,
          nextStatus,
          completedAt,
          TERMINAL_TASK_STATUSES.has(nextStatus)
            ? completedAt
            : current.completedAt,
          taskId,
        );
      this.#touchProject(current.projectId, completedAt);
    });
    this.#changed();
    return this.requiredTask(taskId);
  }

  #pendingUserMessages(
    taskId: string,
    afterSequence: number,
    limit: number,
  ): readonly DesktopTaskMessage[] {
    const messages = (
      this.#statements
        .prepare(
          `
      SELECT id, task_id, sequence, role, agent_id, agent_name, content, created_at, acknowledged_at
      FROM task_messages
      WHERE task_id = ? AND role = 'user' AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `,
        )
        .all(taskId, afterSequence, limit) as unknown as MessageRow[]
    ).map(messageFromRow);
    return boundedMessagePage(messages, MAX_TASK_MESSAGE_PAGE_BYTES);
  }

  #projectTasks(project: ProjectRow): readonly DesktopTaskSummary[] {
    return (
      this.#statements
        .prepare(
          `
      SELECT
        t.id, t.project_id,
        p.name AS project_name, p.root AS project_root,
        t.title, t.category, t.status, t.source,
        substr(t.summary, 1, 241) AS summary,
        substr(t.current_step, 1, 241) AS current_step,
        t.progress_current, t.progress_total,
        CASE WHEN t.progress_label IS NULL THEN NULL ELSE substr(t.progress_label, 1, 121) END AS progress_label,
        '[]' AS steps_json,
        t.agent_id,
        CASE WHEN t.agent_name IS NULL THEN NULL ELSE substr(t.agent_name, 1, 121) END AS agent_name,
        t.principal_id, t.last_heartbeat_at,
        CASE WHEN t.last_activity_label IS NULL THEN NULL ELSE substr(t.last_activity_label, 1, 161) END AS last_activity_label,
        t.last_activity_at, t.agent_ack_sequence, t.next_message_sequence,
        t.created_at, t.updated_at, t.completed_at,
        (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id) AS message_count,
        (SELECT COUNT(*) FROM task_messages m
           WHERE m.task_id = t.id AND m.role = 'user' AND m.sequence > t.agent_ack_sequence
        ) AS unread_user_message_count,
        ${taskCoordinationPendingProjection("t")},
        ${taskSessionLeaseProjection("t")}
      FROM tasks t
      JOIN task_projects p ON p.id = t.project_id
      WHERE t.project_id = ?
      ORDER BY
        CASE t.status
          WHEN 'running' THEN 0
          WHEN 'planning' THEN 1
          WHEN 'queued' THEN 2
          WHEN 'waiting-user' THEN 3
          WHEN 'blocked' THEN 4
          ELSE 5
        END,
        t.updated_at DESC
      LIMIT ?
    `,
        )
        .all(
          isoNow(),
          project.id,
          MAX_TASKS_PER_PROJECT,
        ) as unknown as TaskRow[]
    ).map(taskFromRow);
  }

  projectIdentity(projectId: string): Pick<ProjectRow, "id" | "name" | "root"> {
    const project = this.#statements.prepare("SELECT id, name, root FROM task_projects WHERE id = ?")
      .get(requiredText(projectId, "Project id", 128)) as Pick<ProjectRow, "id" | "name" | "root"> | undefined;
    if (project === undefined) throw new RuntimeError("TASK_NOT_FOUND", "Task project was not found.", 404);
    return project;
  }

  #snapshotPage(
    projectPredicate: (project: ProjectRow) => boolean,
    taskPredicate: (task: DesktopTaskSummary) => boolean,
    offsetValue: number | undefined,
    limitValue: number | undefined,
  ): DesktopTaskWorkspaceSnapshot {
    const offset = normalizedSnapshotOffset(offsetValue);
    const requestedLimit = normalizedSnapshotLimit(limitValue);
    const projectRows = this.#statements
      .prepare(
        `
      SELECT id, root, normalized_root, name, created_at, updated_at
      FROM task_projects
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      )
      .all(MAX_PROJECTS) as unknown as ProjectRow[];
    const sources = projectRows.flatMap((project) => {
      if (!projectPredicate(project)) return [];
      const tasks = this.#projectTasks(project).filter(taskPredicate);
      return tasks.length === 0 ? [] : [{ project, tasks }];
    });
    const entries = sources.flatMap((source) =>
      source.tasks.map((task) => ({ source, task })),
    );
    const totalTaskCount = entries.length;
    const totalProjectCount = sources.length;
    let pageSize = Math.min(
      requestedLimit,
      Math.max(0, totalTaskCount - offset),
    );

    const buildPage = (size: number): DesktopTaskWorkspaceSnapshot => {
      const selected = entries.slice(offset, offset + size);
      const tasksByProject = new Map<string, DesktopTaskListItem[]>();
      for (const entry of selected) {
        const tasks = tasksByProject.get(entry.source.project.id) ?? [];
        tasks.push(taskListItem(entry.task));
        tasksByProject.set(entry.source.project.id, tasks);
      }
      const projects = sources.flatMap((source) => {
        const pageTasks = tasksByProject.get(source.project.id);
        return pageTasks === undefined
          ? []
          : [projectPageSummary(source.project, source.tasks, pageTasks)];
      });
      const nextOffset = offset + size < totalTaskCount ? offset + size : null;
      return {
        schemaVersion: TASK_SCHEMA_VERSION,
        generatedAt: isoNow(),
        revision: this.#revision,
        offset,
        limit: size,
        totalTaskCount,
        totalProjectCount,
        nextOffset,
        projects,
      };
    };

    let snapshot = buildPage(pageSize);
    while (
      pageSize > 1 &&
      Buffer.byteLength(JSON.stringify(snapshot, null, 2), "utf8") >
        MAX_TASK_SNAPSHOT_BYTES
    ) {
      pageSize = Math.max(1, Math.floor(pageSize / 2));
      snapshot = buildPage(pageSize);
    }
    if (
      Buffer.byteLength(JSON.stringify(snapshot, null, 2), "utf8") >
      MAX_TASK_SNAPSHOT_BYTES
    ) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "One task snapshot item exceeds the bounded control-plane response size.",
        409,
      );
    }
    return snapshot;
  }

  #assertPrincipalCanRead(task: DesktopTaskSummary, principalId: string): void {
    const normalizedPrincipal = requiredText(principalId, "Principal id", 160);
    if (task.agent.principalId !== normalizedPrincipal) {
      throw new RuntimeError("TASK_NOT_FOUND", `Unknown task: ${task.id}`, 404);
    }
  }

  #assertPrincipalCanMutate(
    task: DesktopTaskSummary,
    principalId: string,
  ): void {
    const normalizedPrincipal = requiredText(principalId, "Principal id", 160);
    if (task.agent.principalId !== normalizedPrincipal) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "This task belongs to another Agent principal.",
        403,
      );
    }
  }

  #taskRow(taskId: string): TaskRow | undefined {
    return this.#statements
      .prepare(
        `
      SELECT t.*, p.name AS project_name, p.root AS project_root,
        (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id) AS message_count,
        (SELECT COUNT(*) FROM task_messages m
           WHERE m.task_id = t.id AND m.role = 'user' AND m.sequence > t.agent_ack_sequence
        ) AS unread_user_message_count,
        ${taskCoordinationPendingProjection("t")},
        ${taskSessionLeaseProjection("t")}
      FROM tasks t
      JOIN task_projects p ON p.id = t.project_id
      WHERE t.id = ?
    `,
      )
      .get(isoNow(), taskId) as TaskRow | undefined;
  }

  #taskRowByIdempotency(
    projectId: string,
    idempotencyKey: string,
  ): TaskRow | undefined {
    return this.#statements
      .prepare(
        `
      SELECT t.*, p.name AS project_name, p.root AS project_root,
        (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id) AS message_count,
        (SELECT COUNT(*) FROM task_messages m
           WHERE m.task_id = t.id AND m.role = 'user' AND m.sequence > t.agent_ack_sequence
        ) AS unread_user_message_count,
        ${taskCoordinationPendingProjection("t")},
        ${taskSessionLeaseProjection("t")}
      FROM tasks t
      JOIN task_projects p ON p.id = t.project_id
      WHERE t.project_id = ? AND t.idempotency_key = ?
    `,
      )
      .get(isoNow(), projectId, idempotencyKey) as TaskRow | undefined;
  }

  #appendMessage(
    taskId: string,
    role: DesktopTaskMessageRole,
    content: string,
    agentId: string | null,
    agentName: string | null,
    createdAt: string,
  ): DesktopTaskMessage {
    const next = this.#statements
      .prepare(
        `
      SELECT next_message_sequence AS sequence
      FROM tasks
      WHERE id = ?
    `,
      )
      .get(taskId) as { readonly sequence: number } | undefined;
    if (next === undefined) {
      throw new RuntimeError("TASK_NOT_FOUND", `Unknown task: ${taskId}`, 404);
    }
    if (
      !Number.isSafeInteger(next.sequence) ||
      next.sequence < 1 ||
      next.sequence >= Number.MAX_SAFE_INTEGER
    ) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Task conversation sequence capacity is exhausted.",
        409,
      );
    }
    const row: MessageRow = {
      id: randomUUID(),
      task_id: taskId,
      sequence: next.sequence,
      role,
      agent_id: agentId,
      agent_name: agentName,
      content,
      created_at: createdAt,
      acknowledged_at: null,
    };
    this.#statements
      .prepare("UPDATE tasks SET next_message_sequence = ? WHERE id = ?")
      .run(next.sequence + 1, taskId);
    this.#statements
      .prepare(
        `
      INSERT INTO task_messages(
        id, task_id, sequence, role, agent_id, agent_name, content, created_at, acknowledged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
      )
      .run(
        row.id,
        row.task_id,
        row.sequence,
        row.role,
        row.agent_id,
        row.agent_name,
        row.content,
        row.created_at,
      );

    this.#messageRetention.enforceAfterAppend({
      taskId,
      messageId: row.id,
      role,
    });

    return messageFromRow(row);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK;");
      } catch {
        // Preserve the original operation failure.
      }
      throw error;
    }
  }

  #touchProject(projectId: string, updatedAt: string): void {
    this.#statements
      .prepare("UPDATE task_projects SET updated_at = ? WHERE id = ?")
      .run(updatedAt, projectId);
  }

  #changed(): void {
    this.#revision += 1;
    try {
      this.#onChanged?.();
    } catch {
      // UI notification is best effort and never changes persisted task state.
    }
  }
}
