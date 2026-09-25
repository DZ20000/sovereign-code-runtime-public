import { describe, expect, it } from "vitest";

import type { DesktopTaskListItem } from "../src/shared.js";
import { validateTaskListItemIntegrity } from "../src/renderer/task-list-item-integrity.js";

function task(
  overrides: Partial<DesktopTaskListItem> = {},
): DesktopTaskListItem {
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

describe("task list item integrity", () => {
  it("accepts valid determinate and indeterminate progress", () => {
    expect(() => validateTaskListItemIntegrity(task())).not.toThrow();
    expect(() =>
      validateTaskListItemIntegrity(
        task({ progress: { current: null, total: null, label: "Working" } }),
      ),
    ).not.toThrow();
  });

  it.each([
    { messageCount: -1 },
    { messageCount: 0.5 },
    { unreadUserMessageCount: -1 },
    { unreadUserMessageCount: Number.MAX_SAFE_INTEGER + 1 },
    { coordinationPendingCount: -1 },
    { coordinationPendingCount: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid message counters", (overrides) => {
    expect(() => validateTaskListItemIntegrity(task(overrides))).toThrow(
      "non-negative safe integer",
    );
  });

  it("rejects unread messages above the message total", () => {
    expect(() =>
      validateTaskListItemIntegrity(
        task({ messageCount: 1, unreadUserMessageCount: 2 }),
      ),
    ).toThrow("unread message count exceeds its message total");
  });

  it.each([
    { current: -1, total: 2, label: "Progress" },
    { current: Number.POSITIVE_INFINITY, total: 2, label: "Progress" },
    { current: 1, total: -1, label: "Progress" },
    { current: 1, total: Number.NaN, label: "Progress" },
  ])("rejects invalid progress values", (progress) => {
    expect(() => validateTaskListItemIntegrity(task({ progress }))).toThrow(
      "progress",
    );
  });

  it("rejects positive current work against a zero total", () => {
    expect(() =>
      validateTaskListItemIntegrity(
        task({ progress: { current: 1, total: 0, label: "Progress" } }),
      ),
    ).toThrow("cannot be positive when total is zero");
  });
});
