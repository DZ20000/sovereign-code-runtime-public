import type { DesktopTaskListItem, DesktopTaskStatus } from "../shared.js";

export type TaskBoardLane =
  "current" | "attention" | "history" | "activity" | "all";

export type TaskBoardState =
  | DesktopTaskStatus
  | "follow-up-pending"
  | "observed-activity"
  | "activity-ended";

type TaskBoardItem = Pick<
  DesktopTaskListItem,
  | "id"
  | "title"
  | "status"
  | "source"
  | "agent"
  | "lastActivityAt"
  | "updatedAt"
  | "unreadUserMessageCount"
  | "coordinationPendingCount"
>;

const ACTIVE_STATUSES = new Set<DesktopTaskStatus>([
  "queued",
  "planning",
  "running",
]);
const HISTORY_STATUSES = new Set<DesktopTaskStatus>(["succeeded", "cancelled"]);

const STATE_LABELS: Readonly<Record<TaskBoardState, string>> = {
  queued: "Queued",
  planning: "Planning",
  running: "Running",
  "waiting-user": "Waiting for you",
  blocked: "Blocked",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  "follow-up-pending": "Follow-up pending",
  "observed-activity": "Observed activity",
  "activity-ended": "Activity ended",
};

const LANE_PRIORITY: Readonly<Record<Exclude<TaskBoardLane, "all">, number>> = {
  current: 0,
  attention: 1,
  history: 2,
  activity: 3,
};

const STATE_PRIORITY: Readonly<Record<TaskBoardState, number>> = {
  "waiting-user": 0,
  "follow-up-pending": 1,
  failed: 2,
  blocked: 3,
  running: 6,
  planning: 7,
  queued: 8,
  "observed-activity": 9,
  succeeded: 10,
  cancelled: 11,
  "activity-ended": 12,
};

export interface TaskBoardCounts {
  readonly current: number;
  readonly attention: number;
  readonly history: number;
  readonly activity: number;
  readonly all: number;
}

function taskHasPendingTerminalFollowUp(task: TaskBoardItem): boolean {
  return (
    task.source !== "inferred" &&
    HISTORY_STATUSES.has(task.status) &&
    task.unreadUserMessageCount > 0
  );
}

function taskHasValidAgentHeartbeat(
  task: Pick<TaskBoardItem, "agent">,
): boolean {
  if (task.agent.lastHeartbeatAt === null) return false;
  return Number.isFinite(Date.parse(task.agent.lastHeartbeatAt));
}
export function taskBoardAgentPresence(task: Pick<TaskBoardItem, "agent">) {
  if (
    (task.agent.presence === "online" || task.agent.presence === "stale") &&
    !taskHasValidAgentHeartbeat(task)
  ) {
    return "unknown" as const;
  }
  return task.agent.presence;
}

export function taskHasCurrentAgentSession(task: TaskBoardItem): boolean {
  const presence = taskBoardAgentPresence(task);
  return (
    task.source !== "inferred" &&
    task.agent.id !== null &&
    (presence === "online" || presence === "stale") &&
    taskHasValidAgentHeartbeat(task)
  );
}

export function taskHasLiveAgent(task: TaskBoardItem): boolean {
  return (
    ACTIVE_STATUSES.has(task.status) &&
    taskHasCurrentAgentSession(task) &&
    taskBoardAgentPresence(task) === "online"
  );
}

export function taskNeedsOperatorAction(task: TaskBoardItem): boolean {
  if (task.source === "inferred") return false;
  if (
    task.status === "waiting-user" ||
    task.status === "blocked" ||
    task.status === "failed"
  ) return true;
  return taskHasPendingTerminalFollowUp(task);
}

export function taskBoardLane(
  task: TaskBoardItem,
): Exclude<TaskBoardLane, "all"> {
  if (task.source === "inferred") return "activity";
  if (HISTORY_STATUSES.has(task.status)) {
    return taskNeedsOperatorAction(task) ? "attention" : "history";
  }
  if (taskNeedsOperatorAction(task)) return "attention";
  if (ACTIVE_STATUSES.has(task.status)) return "current";
  return "history";
}

export function taskBoardState(task: TaskBoardItem): TaskBoardState {
  if (task.source === "inferred") {
    return ACTIVE_STATUSES.has(task.status)
      ? "observed-activity"
      : "activity-ended";
  }
  if (taskHasPendingTerminalFollowUp(task)) return "follow-up-pending";
  return task.status;
}

export function taskBoardStateLabel(task: TaskBoardItem): string {
  return STATE_LABELS[taskBoardState(task)];
}

export function taskBoardStateDetail(task: TaskBoardItem): string {
  const state = taskBoardState(task);
  if (state === "waiting-user") return "The Agent is waiting for your reply.";
  if (state === "follow-up-pending") {
    return "A user message is waiting for acknowledgement. The recorded task status has not changed.";
  }
  if (state === "blocked") {
    return "This work is blocked and needs review before it can continue.";
  }
  if (state === "failed") {
    return "This work failed and stays in Needs action until it is reviewed.";
  }
  if (state === "observed-activity") {
    return "Automatic activity is separate from tasks until an Agent claims it.";
  }
  if (state === "activity-ended") {
    return "Automatic activity ended and is retained separately for audit.";
  }
  if (state === "succeeded") return "Completed work is retained in History.";
  if (state === "cancelled") return "Cancelled work is retained in History.";
  if (task.agent.id === null) return "No Agent is assigned. This work remains unfinished.";
  const presence = taskBoardAgentPresence(task);
  if (presence === "stale") return "The Agent heartbeat is delayed. This work remains unfinished.";
  if (presence === "offline") return "The Agent connection is not confirmed. This work remains unfinished.";
  if (presence === "unknown") return "The Agent heartbeat has not been confirmed. This work remains unfinished.";
  return "The latest Agent heartbeat is current.";
}

export function taskWaitingMessageLabel(
  task: Pick<TaskBoardItem, "unreadUserMessageCount">,
): string | null {
  const count = task.unreadUserMessageCount;
  if (count <= 0) return null;
  return `${count} waiting message${count === 1 ? "" : "s"}`;
}

export function taskCoordinationPendingLabel(
  task: Pick<TaskBoardItem, "coordinationPendingCount">,
): string | null {
  const count = task.coordinationPendingCount;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Task coordination pending count is invalid.");
  }
  return count === 0 ? null : `${count} coordination pending`;
}
export function taskMatchesBoardLane(
  task: TaskBoardItem,
  lane: TaskBoardLane,
): boolean {
  return lane === "all" || taskBoardLane(task) === lane;
}

export function taskBoardCounts(
  tasks: readonly TaskBoardItem[],
): TaskBoardCounts {
  const counts = {
    current: 0,
    attention: 0,
    history: 0,
    activity: 0,
    all: tasks.length,
  };
  for (const task of tasks) counts[taskBoardLane(task)] += 1;
  return counts;
}

function taskActivityTime(task: TaskBoardItem): number {
  const lastActivity =
    task.lastActivityAt === null ? Number.NaN : Date.parse(task.lastActivityAt);
  if (Number.isFinite(lastActivity)) return lastActivity;
  const updated = Date.parse(task.updatedAt);
  return Number.isFinite(updated) ? updated : 0;
}

export function compareTaskBoardTasks(
  left: TaskBoardItem,
  right: TaskBoardItem,
): number {
  const leftLane = taskBoardLane(left);
  const rightLane = taskBoardLane(right);
  const laneDifference = LANE_PRIORITY[leftLane] - LANE_PRIORITY[rightLane];
  if (laneDifference !== 0) return laneDifference;

  const unreadDifference =
    right.unreadUserMessageCount - left.unreadUserMessageCount;
  if (unreadDifference !== 0) return unreadDifference;

  const stateDifference =
    STATE_PRIORITY[taskBoardState(left)] -
    STATE_PRIORITY[taskBoardState(right)];
  if (stateDifference !== 0) return stateDifference;

  const activityDifference = taskActivityTime(right) - taskActivityTime(left);
  if (activityDifference !== 0) return activityDifference;
  const titleDifference = left.title.localeCompare(right.title);
  if (titleDifference !== 0) return titleDifference;
  return left.id.localeCompare(right.id);
}
