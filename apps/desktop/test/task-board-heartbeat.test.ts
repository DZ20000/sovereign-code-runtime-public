import { describe, expect, it } from "vitest";

import type { DesktopTaskListItem } from "../src/shared.js";
import {
  taskBoardLane,
  taskBoardAgentPresence,
  taskBoardState,
  taskHasLiveAgent,
} from "../src/renderer/task-board-model.js";

function task(lastHeartbeatAt: string | null): DesktopTaskListItem {
  return {
    id: "task-1",
    title: "Task",
    category: "development",
    status: "running",
    source: "agent",
    summaryPreview: "Summary",
    currentStep: "Step",
    progress: { current: 1, total: 2, label: "Progress" },
    agent: {
      id: "agent-1",
      name: "Agent",
      presence: "online",
      lastHeartbeatAt,
    },
    lastActivityLabel: null,
    lastActivityAt: "2026-08-28T10:00:00.000Z",
    unreadUserMessageCount: 0,
    coordinationPendingCount: 0,
    messageCount: 0,
    updatedAt: "2026-08-28T10:00:00.000Z",
  };
}

describe("task board live heartbeat", () => {
  it("accepts an online Agent with a parseable heartbeat", () => {
    const value = task("2026-08-28T10:00:00.000Z");
    expect(taskHasLiveAgent(value)).toBe(true);
    expect(taskBoardLane(value)).toBe("current");
    expect(taskBoardState(value)).toBe("running");
  });

  it.each([null, "", "not-a-timestamp"])(
    "does not trust online presence without a valid heartbeat: %s",
    (lastHeartbeatAt) => {
      const value = task(lastHeartbeatAt);
      expect(taskHasLiveAgent(value)).toBe(false);
      expect(taskBoardLane(value)).toBe("current");
      expect(taskBoardAgentPresence(value)).toBe("unknown");
      expect(taskBoardState(value)).toBe("running");
    },
  );
});
