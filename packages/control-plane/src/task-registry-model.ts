import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  DesktopTaskCategory,
  DesktopTaskListItem,
  DesktopTaskMessage,
  DesktopTaskMessageRole,
  DesktopTaskProjectStatus,
  DesktopTaskProjectSummary,
  DesktopTaskSource,
  DesktopTaskStatus,
  DesktopTaskStep,
  DesktopTaskSummary,
} from "@sovereign/control-plane-contract";
import { RuntimeError } from "@sovereign/runtime-core";

import {
  taskSessionLastSeenIso,
  taskSessionPresence,
} from "./task-session-leases.js";

export const TASK_SCHEMA_VERSION = "scr.task-workspace/v1" as const;

export const TASK_INBOX_SCHEMA_VERSION = "scr.task-inbox/v1" as const;

export const MAX_PROJECTS = 50;

export const MAX_TASKS_PER_PROJECT = 200;

export const MAX_TOTAL_TASKS = 500;

export const MAX_MESSAGES = 500;

export const MAX_TOTAL_MESSAGES = 2_000;

export const TASK_MUTATION_MESSAGE_WINDOW = 3;

export const DEFAULT_TASK_SNAPSHOT_LIMIT = 64;

export const MAX_TASK_SNAPSHOT_LIMIT = 100;

export const MAX_TASK_SNAPSHOT_BYTES = 640 * 1024;

export const MAX_TASK_MESSAGE_PAGE_BYTES = 512 * 1024;

export const MAX_TASK_DETAIL_BYTES = 640 * 1024;

export const DEFAULT_TASK_INBOX_TASK_LIMIT = 20;

export const MAX_TASK_INBOX_TASK_LIMIT = 50;

export const DEFAULT_TASK_INBOX_MESSAGE_LIMIT = 20;

export const MAX_TASK_INBOX_MESSAGE_LIMIT = 50;

export const ACTIVE_TASK_STATUSES = new Set<DesktopTaskStatus>([
  "queued",
  "planning",
  "running",
]);

export const ATTENTION_TASK_STATUSES = new Set<DesktopTaskStatus>([
  "waiting-user",
  "blocked",
  "failed",
]);

export const TERMINAL_TASK_STATUSES = new Set<DesktopTaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export const TASK_CATEGORIES = new Set<DesktopTaskCategory>([
  "development",
  "testing",
  "build",
  "research",
  "maintenance",
  "automation",
  "other",
]);

export const TASK_STATUSES = new Set<DesktopTaskStatus>([
  "queued",
  "planning",
  "running",
  "waiting-user",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
]);

export interface ProjectRow {
  readonly id: string;
  readonly root: string;
  readonly normalized_root: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly project_root: string;
  readonly title: string;
  readonly category: string;
  readonly status: string;
  readonly source: string;
  readonly summary: string;
  readonly current_step: string;
  readonly progress_current: number | null;
  readonly progress_total: number | null;
  readonly progress_label: string | null;
  readonly steps_json: string;
  readonly agent_id: string | null;
  readonly agent_name: string | null;
  readonly principal_id: string | null;
  readonly last_heartbeat_at: string | null;
  readonly last_activity_label: string | null;
  readonly last_activity_at: string | null;
  readonly agent_ack_sequence: number;
  readonly next_message_sequence: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly message_count: number;
  readonly unread_user_message_count: number;
  readonly coordination_pending_count: number;
  readonly session_last_seen_at_unix_ms: number | null;
  readonly session_expires_at_unix_ms: number | null;
  readonly session_closed_at_unix_ms: number | null;
}

export interface MessageRow {
  readonly id: string;
  readonly task_id: string;
  readonly sequence: number;
  readonly role: string;
  readonly agent_id: string | null;
  readonly agent_name: string | null;
  readonly content: string;
  readonly created_at: string;
  readonly acknowledged_at: string | null;
}

export interface TaskRegistryOptions {
  readonly databasePath: string;
  readonly onChanged?: () => void;
}

export interface TaskActivityStartInput {
  readonly activityId?: string;
  readonly principalId: string;
  readonly sessionId?: string | null;
  readonly toolName: string;
  readonly title: string;
  readonly category: string;
  readonly startedAt: string;
  readonly projectRoot: string;
  readonly projectName?: string;
}

export function boundedText(
  value: string | undefined,
  label: string,
  maximum: number,
): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length > maximum) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `${label} must contain at most ${maximum} characters.`,
      400,
    );
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `${label} contains an unsupported control character.`,
      400,
    );
  }
  return normalized;
}

export function requiredText(
  value: string | undefined,
  label: string,
  maximum: number,
): string {
  const normalized = boundedText(value, label, maximum);
  if (normalized.length === 0) {
    throw new RuntimeError("INVALID_INPUT", `${label} must not be empty.`, 400);
  }
  return normalized;
}

export function normalizedRootValue(root: string): {
  readonly root: string;
  readonly normalized: string;
} {
  return {
    root,
    normalized:
      process.platform === "win32" ? root.toLocaleLowerCase("en-US") : root,
  };
}

export function normalizeRoot(root: string): {
  readonly root: string;
  readonly normalized: string;
} {
  return normalizedRootValue(
    resolve(requiredText(root, "Project root", 4_096)),
  );
}

export function existingDirectoryRoot(
  root: string,
  label: string,
): { readonly root: string; readonly normalized: string } {
  const resolved = resolve(requiredText(root, label, 4_096));
  let info;
  try {
    info = statSync(resolved);
  } catch (error) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `${label} must exist and be readable.`,
      400,
      { cause: error },
    );
  }
  if (!info.isDirectory()) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `${label} must be a directory.`,
      400,
    );
  }
  return normalizedRootValue(realpathSync.native(resolved));
}

export function containmentRoot(root: string): {
  readonly root: string;
  readonly normalized: string;
} {
  try {
    return existingDirectoryRoot(root, "Project root");
  } catch {
    return normalizeRoot(root);
  }
}

export function projectWithinWorkspace(
  projectRoot: string,
  workspaceRoot: string,
): boolean {
  const project = containmentRoot(projectRoot);
  const workspace = containmentRoot(workspaceRoot);
  const relation = relative(workspace.root, project.root);
  return (
    relation === "" ||
    !(
      relation === ".." ||
      relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)
    )
  );
}

export function assertProjectWithinWorkspace(
  projectRoot: string,
  workspaceRoot: string,
  requireExisting = false,
): string {
  const project = requireExisting
    ? existingDirectoryRoot(projectRoot, "Task project root")
    : containmentRoot(projectRoot);
  const workspace = requireExisting
    ? existingDirectoryRoot(workspaceRoot, "Authorized workspace root")
    : containmentRoot(workspaceRoot);
  const relation = relative(workspace.root, project.root);
  const contained =
    relation === "" ||
    !(
      relation === ".." ||
      relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)
    );
  if (!contained) {
    throw new RuntimeError(
      "PATH_ESCAPE",
      "Task project root must be the authorized workspace or one of its descendants.",
      403,
    );
  }
  return project.root;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function validCategory(
  value: DesktopTaskCategory | undefined,
): DesktopTaskCategory {
  const category = value ?? "other";
  if (!TASK_CATEGORIES.has(category)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `Unknown task category: ${String(category)}`,
      400,
    );
  }
  return category;
}

export function validStatus(
  value: DesktopTaskStatus | undefined,
  fallback: DesktopTaskStatus,
): DesktopTaskStatus {
  const status = value ?? fallback;
  if (!TASK_STATUSES.has(status)) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `Unknown task status: ${String(status)}`,
      400,
    );
  }
  return status;
}

export function progressValue(
  value: number | null | undefined,
  label: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `${label} must be a non-negative integer no larger than 1,000,000.`,
      400,
    );
  }
  return value;
}

export function messageSequenceValue(
  value: number | undefined,
  label: string,
): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `${label} must be a non-negative safe integer.`,
      400,
    );
  }
  return value;
}

export function normalizedProgress(
  current: number | null | undefined,
  total: number | null | undefined,
): { readonly current: number | null; readonly total: number | null } {
  const normalizedCurrent = progressValue(current, "Progress current");
  const normalizedTotal = progressValue(total, "Progress total");
  if (
    normalizedCurrent !== null &&
    normalizedTotal !== null &&
    normalizedCurrent > normalizedTotal
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "Progress current must not exceed progress total.",
      400,
    );
  }
  return { current: normalizedCurrent, total: normalizedTotal };
}

export function normalizeSteps(
  steps: readonly DesktopTaskStep[] | undefined,
): readonly DesktopTaskStep[] {
  if (steps === undefined) {
    return [];
  }
  if (steps.length > 100) {
    throw new RuntimeError(
      "INVALID_INPUT",
      "A task may contain at most 100 steps.",
      400,
    );
  }
  const ids = new Set<string>();
  return steps.map((step, index) => {
    const id = requiredText(step.id || `step-${index + 1}`, "Step id", 128);
    if (ids.has(id)) {
      throw new RuntimeError(
        "INVALID_INPUT",
        `Duplicate task step id: ${id}`,
        400,
      );
    }
    ids.add(id);
    if (
      step.status !== "pending" &&
      step.status !== "running" &&
      step.status !== "succeeded" &&
      step.status !== "failed" &&
      step.status !== "skipped"
    ) {
      throw new RuntimeError(
        "INVALID_INPUT",
        `Unknown task step status: ${String(step.status)}`,
        400,
      );
    }
    const updatedAt = requiredText(step.updatedAt, "Step update time", 64);
    if (!Number.isFinite(Date.parse(updatedAt))) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Step update time is invalid.",
        400,
      );
    }
    return {
      id,
      title: requiredText(step.title, "Step title", 240),
      status: step.status,
      updatedAt,
    } satisfies DesktopTaskStep;
  });
}

export function parsedSteps(source: string): readonly DesktopTaskStep[] {
  try {
    const parsed: unknown = JSON.parse(source);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is DesktopTaskStep => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const record = value as Record<string, unknown>;
      return (
        typeof record.id === "string" &&
        typeof record.title === "string" &&
        typeof record.status === "string" &&
        typeof record.updatedAt === "string"
      );
    });
  } catch {
    return [];
  }
}

export function taskFromRow(row: TaskRow): DesktopTaskSummary {
  const category = TASK_CATEGORIES.has(row.category as DesktopTaskCategory)
    ? (row.category as DesktopTaskCategory)
    : "other";
  const status = TASK_STATUSES.has(row.status as DesktopTaskStatus)
    ? (row.status as DesktopTaskStatus)
    : "failed";
  const source: DesktopTaskSource =
    row.source === "agent" || row.source === "inferred" || row.source === "user"
      ? row.source
      : "inferred";
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectRoot: row.project_root,
    title: row.title,
    category,
    status,
    source,
    summary: row.summary,
    currentStep: row.current_step,
    progress: {
      current: row.progress_current,
      total: row.progress_total,
      label: row.progress_label,
    },
    steps: parsedSteps(row.steps_json),
    agent: {
      id: row.agent_id,
      name: row.agent_name,
      principalId: row.principal_id,
      presence:
        row.agent_id === null
          ? "unknown"
          : taskSessionPresence(
              row.session_last_seen_at_unix_ms,
              row.session_expires_at_unix_ms,
              row.session_closed_at_unix_ms,
            ),
      lastHeartbeatAt: taskSessionLastSeenIso(row.session_last_seen_at_unix_ms),
    },
    lastActivityLabel: row.last_activity_label,
    lastActivityAt: row.last_activity_at,
    unreadUserMessageCount: row.unread_user_message_count,
    coordinationPendingCount: row.coordination_pending_count,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function compactPreview(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}\u2026`;
}

export function taskListItem(task: DesktopTaskSummary): DesktopTaskListItem {
  return {
    id: task.id,
    title: compactPreview(task.title, 160),
    category: task.category,
    status: task.status,
    source: task.source,
    summaryPreview: compactPreview(task.summary, 240),
    currentStep: compactPreview(task.currentStep, 240),
    progress: {
      current: task.progress.current,
      total: task.progress.total,
      label:
        task.progress.label === null
          ? null
          : compactPreview(task.progress.label, 120),
    },
    agent: {
      id: task.agent.id,
      name:
        task.agent.name === null ? null : compactPreview(task.agent.name, 120),
      presence: task.agent.presence,
      lastHeartbeatAt: task.agent.lastHeartbeatAt,
    },
    lastActivityLabel:
      task.lastActivityLabel === null
        ? null
        : compactPreview(task.lastActivityLabel, 160),
    lastActivityAt: task.lastActivityAt,
    unreadUserMessageCount: task.unreadUserMessageCount,
    coordinationPendingCount: task.coordinationPendingCount,
    messageCount: task.messageCount,
    updatedAt: task.updatedAt,
  };
}

export function projectPageSummary(
  project: ProjectRow,
  allTasks: readonly DesktopTaskSummary[],
  pageTasks: readonly DesktopTaskListItem[],
): DesktopTaskProjectSummary {
  const activeTaskCount = allTasks.filter((task) =>
    ACTIVE_TASK_STATUSES.has(task.status),
  ).length;
  const attentionTaskCount = allTasks.filter(
    (task) => ATTENTION_TASK_STATUSES.has(task.status) ||
      (ACTIVE_TASK_STATUSES.has(task.status) &&
        (task.agent.presence === "stale" || task.agent.presence === "offline")),
  ).length;
  const onlineAgentCount = new Set(allTasks
    .filter((task) => task.agent.presence === "online" && task.agent.id !== null)
    .map((task) => task.agent.id)).size;
  const status: DesktopTaskProjectStatus = attentionTaskCount > 0 ? "attention"
    : activeTaskCount > 0 ? "active"
      : allTasks.length > 0 && allTasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status)) ? "completed" : "idle";
  const updatedAt = allTasks.reduce((latest, task) => task.updatedAt > latest ? task.updatedAt : latest,
    allTasks[0]?.updatedAt ?? project.updated_at);
  return {
    id: project.id, name: compactPreview(project.name, 160), root: project.root,
    status, taskCount: allTasks.length, activeTaskCount, attentionTaskCount, onlineAgentCount,
    updatedAt, tasks: pageTasks,
  };
}

export function normalizedSnapshotOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOTAL_TASKS) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `Task snapshot offset must be an integer from 0 through ${MAX_TOTAL_TASKS}.`,
      400,
    );
  }
  return value;
}

export function normalizedSnapshotLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TASK_SNAPSHOT_LIMIT;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TASK_SNAPSHOT_LIMIT
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `Task snapshot limit must be an integer from 1 through ${MAX_TASK_SNAPSHOT_LIMIT}.`,
      400,
    );
  }
  return value;
}

export function normalizedInboxLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `${label} must be an integer from 1 through ${maximum}.`,
      400,
    );
  }
  return value;
}

export function messageFromRow(row: MessageRow): DesktopTaskMessage {
  const role: DesktopTaskMessageRole =
    row.role === "user" || row.role === "assistant" || row.role === "system"
      ? row.role
      : "system";
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    role,
    agentId: row.agent_id,
    agentName: row.agent_name,
    content: row.content,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

export function boundedMessagePage(
  messages: readonly DesktopTaskMessage[],
  maximumBytes: number,
  keepLatest = false,
): readonly DesktopTaskMessage[] {
  let size = messages.length;
  let page = messages;
  while (
    size > 1 &&
    Buffer.byteLength(JSON.stringify(page, null, 2), "utf8") > maximumBytes
  ) {
    size = Math.max(1, Math.floor(size / 2));
    page = keepLatest
      ? messages.slice(messages.length - size)
      : messages.slice(0, size);
  }
  if (Buffer.byteLength(JSON.stringify(page, null, 2), "utf8") > maximumBytes) {
    throw new RuntimeError(
      "POLICY_DENIED",
      "One task message exceeds the bounded response size.",
      409,
    );
  }
  return page;
}

export function categoryFromTool(
  category: string,
  toolName: string,
): DesktopTaskCategory {
  if (category === "validation") {
    return "testing";
  }
  if (category === "workflow") {
    return "automation";
  }
  if (
    category === "terminal" ||
    category === "python" ||
    category === "git" ||
    category === "files"
  ) {
    return "development";
  }
  if (toolName.startsWith("search.")) {
    return "research";
  }
  return "other";
}

export function defaultTaskDatabasePath(userDataPath: string): string {
  return resolve(userDataPath, "tasks.sqlite");
}
