import type { DesktopTaskListItem } from "../shared.js";

function assertNonNegativeSafeInteger(
  value: number,
  taskId: string,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Task ${taskId} ${label} must be a non-negative safe integer.`,
    );
  }
}

function assertOptionalProgressNumber(
  value: number | null,
  taskId: string,
  label: string,
): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`Task ${taskId} progress ${label} must be non-negative.`);
  }
}

export function validateTaskListItemIntegrity(task: DesktopTaskListItem): void {
  assertNonNegativeSafeInteger(task.messageCount, task.id, "message count");
  assertNonNegativeSafeInteger(
    task.coordinationPendingCount,
    task.id,
    "coordination pending count",
  );
  assertNonNegativeSafeInteger(
    task.unreadUserMessageCount,
    task.id,
    "unread message count",
  );
  if (task.unreadUserMessageCount > task.messageCount) {
    throw new Error(
      `Task ${task.id} unread message count exceeds its message total.`,
    );
  }

  assertOptionalProgressNumber(task.progress.current, task.id, "current");
  assertOptionalProgressNumber(task.progress.total, task.id, "total");
  if (
    task.progress.current !== null &&
    task.progress.total === 0 &&
    task.progress.current > 0
  ) {
    throw new Error(
      `Task ${task.id} progress current cannot be positive when total is zero.`,
    );
  }
}
