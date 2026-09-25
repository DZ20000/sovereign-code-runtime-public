import type { DesktopTaskListItem } from "../shared.js";
import { taskBoardCounts } from "./task-board-model.js";

export interface TaskProjectVisibleMetrics {
  readonly shown: number;
  readonly current: number;
  readonly attention: number;
  readonly waitingMessages: number;
}

export function taskProjectVisibleMetrics(
  tasks: readonly DesktopTaskListItem[],
): TaskProjectVisibleMetrics {
  const counts = taskBoardCounts(tasks);
  return {
    shown: tasks.length,
    current: counts.current,
    attention: counts.attention,
    waitingMessages: tasks.reduce(
      (total, task) => total + task.unreadUserMessageCount,
      0,
    ),
  };
}
