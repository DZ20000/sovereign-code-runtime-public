import type { DesktopTaskDetail } from "../shared.js";

export class TaskDetailIntegrityError extends Error {
  constructor(detail: string) {
    super(`Task detail integrity check failed: ${detail}`);
    this.name = "TaskDetailIntegrityError";
  }
}

export function isTaskDetailIntegrityError(
  error: unknown,
): error is TaskDetailIntegrityError {
  return error instanceof TaskDetailIntegrityError;
}

function integrityError(detail: string): TaskDetailIntegrityError {
  return new TaskDetailIntegrityError(detail);
}

export function assertTaskDetailIntegrity(
  requestedTaskId: string,
  detail: DesktopTaskDetail,
): void {
  if (detail.task.id !== requestedTaskId) {
    throw integrityError("returned task id does not match the requested task.");
  }
  if (
    !Number.isSafeInteger(detail.task.messageCount) ||
    detail.task.messageCount < 0 ||
    !Number.isSafeInteger(detail.task.coordinationPendingCount) ||
    detail.task.coordinationPendingCount < 0 ||
    !Number.isSafeInteger(detail.task.unreadUserMessageCount) ||
    detail.task.unreadUserMessageCount < 0 ||
    detail.task.unreadUserMessageCount > detail.task.messageCount
  ) {
    throw integrityError("task message counters are invalid.");
  }
  if (detail.messages.length > detail.task.messageCount) {
    throw integrityError(
      "returned messages exceed the declared message count.",
    );
  }
  if (
    detail.messagesTruncated !==
    detail.task.messageCount > detail.messages.length
  ) {
    throw integrityError(
      "message truncation state does not match the window size.",
    );
  }

  const expectedOldest = detail.messages[0]?.sequence ?? null;
  const expectedNewest = detail.messages.at(-1)?.sequence ?? null;
  if (
    detail.oldestMessageSequence !== expectedOldest ||
    detail.newestMessageSequence !== expectedNewest
  ) {
    throw integrityError("message window boundaries are inconsistent.");
  }

  const messageIds = new Set<string>();
  let previousSequence = 0;
  let visiblePendingUserMessages = 0;
  for (const message of detail.messages) {
    if (message.taskId !== requestedTaskId) {
      throw integrityError("a message belongs to another task.");
    }
    if (message.id.length === 0 || messageIds.has(message.id)) {
      throw integrityError("message ids are empty or duplicated.");
    }
    messageIds.add(message.id);
    if (
      !Number.isSafeInteger(message.sequence) ||
      message.sequence <= previousSequence
    ) {
      throw integrityError("message sequences are not strictly increasing.");
    }
    previousSequence = message.sequence;
    if (message.role === "user" && message.acknowledgedAt === null) {
      visiblePendingUserMessages += 1;
    }
  }
  if (visiblePendingUserMessages > detail.task.unreadUserMessageCount) {
    throw integrityError("visible pending messages exceed the unread count.");
  }
}
