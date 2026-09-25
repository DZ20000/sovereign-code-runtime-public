import type { TaskBoardLane } from "./task-board-model.js";

export interface TaskBoardLaneContent {
  readonly title: string;
  readonly description: string;
  readonly emptyTitle: string;
  readonly emptyDetail: string;
  readonly visibleLabel: string;
}

export const BOARD_LANE_CONTENT: Readonly<
  Record<TaskBoardLane, TaskBoardLaneContent>
> = {
  current: {
    title: "Current work",
    description:
      "Queued, planned and running work. Agent connection status is shown separately.",
    emptyTitle: "No current work",
    emptyDetail:
      "Queued, planned and running tasks will appear here, including work whose Agent connection is not confirmed.",
    visibleLabel: "current tasks shown",
  },
  attention: {
    title: "Needs action",
    description:
      "Review requests for your reply, blockers, failures and follow-up messages awaiting acknowledgement.",
    emptyTitle: "Nothing needs action",
    emptyDetail:
      "No task needs a response, blocker review, failure review or follow-up acknowledgement.",
    visibleLabel: "action items shown",
  },
  history: {
    title: "History",
    description:
      "Completed and cancelled tasks are retained here. Unfinished work stays visible even when its Agent connection is not confirmed.",
    emptyTitle: "No task history",
    emptyDetail:
      "Completed and cancelled tasks without pending user messages will appear here.",
    visibleLabel: "history records shown",
  },
  activity: {
    title: "Automatic activity",
    description:
      "Tool activity inferred by Sovereign stays separate until a task Agent explicitly claims it.",
    emptyTitle: "No automatic activity",
    emptyDetail:
      "Unclaimed tool activity will appear here without being presented as formal current work.",
    visibleLabel: "activity records shown",
  },
  all: {
    title: "All records",
    description:
      "Audit every formal task and automatic activity record without changing their derived board state.",
    emptyTitle: "No task records",
    emptyDetail:
      "Agents can register formal work. Sovereign also retains meaningful automatic activity separately.",
    visibleLabel: "records shown",
  },
};
