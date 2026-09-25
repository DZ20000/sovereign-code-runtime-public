import { describe, expect, it } from "vitest";

import type { DesktopTaskListItem } from "../src/shared.js";
import { taskProjectVisibleMetrics } from "../src/renderer/task-project-metrics.js";

function task(
  id: string,
  overrides: Partial<DesktopTaskListItem> = {},
): DesktopTaskListItem {
  return {
    id,
    title: id,
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
      lastHeartbeatAt: "2026-08-28T10:00:00.000Z",
    },
    lastActivityLabel: null,
    lastActivityAt: "2026-08-28T10:00:00.000Z",
    unreadUserMessageCount: 0,
    coordinationPendingCount: 0,
    messageCount: 0,
    updatedAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
}

describe("task project visible metrics", () => {
  it("uses the filtered task subset rather than the project-wide total", () => {
    expect(
      taskProjectVisibleMetrics([
        task("current"),
        task("attention", {
          status: "blocked",
          unreadUserMessageCount: 2,
          coordinationPendingCount: 0,
        }),
      ]),
    ).toEqual({
      shown: 2,
      current: 1,
      attention: 1,
      waitingMessages: 2,
    });
  });

  it("counts pending terminal follow-ups as attention", () => {
    expect(
      taskProjectVisibleMetrics([
        task("done", {
          status: "succeeded",
          unreadUserMessageCount: 1,
          coordinationPendingCount: 0,
        }),
      ]),
    ).toEqual({
      shown: 1,
      current: 0,
      attention: 1,
      waitingMessages: 1,
    });
  });
});
