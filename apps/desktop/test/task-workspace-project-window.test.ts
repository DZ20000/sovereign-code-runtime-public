import { describe, expect, it } from "vitest";

import type {
  DesktopTaskListItem,
  DesktopTaskProjectSummary,
  DesktopTaskWorkspaceSnapshot,
} from "../src/shared.js";
import { TaskWorkspaceSnapshotAssembler } from "../src/renderer/task-workspace-pagination.js";

function task(id = "task-1"): DesktopTaskListItem {
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
  };
}

function project(
  overrides: Partial<DesktopTaskProjectSummary> = {},
): DesktopTaskProjectSummary {
  return {
    id: "project-1",
    name: "Project",
    root: "E:\\project",
    status: "active",
    taskCount: 1,
    activeTaskCount: 1,
    attentionTaskCount: 0,
    onlineAgentCount: 1,
    updatedAt: "2026-08-28T10:00:00.000Z",
    tasks: [task()],
    ...overrides,
  };
}

function snapshot(
  value: DesktopTaskProjectSummary,
): DesktopTaskWorkspaceSnapshot {
  return {
    schemaVersion: "scr.task-workspace/v1",
    generatedAt: "2026-08-28T10:00:00.000Z",
    revision: 1,
    offset: 0,
    limit: 64,
    totalTaskCount: value.tasks.length,
    totalProjectCount: 1,
    nextOffset: null,
    projects: [value],
  };
}

describe("task workspace project summary window", () => {
  it.each([
    ["task count", { taskCount: -1 }],
    ["active task count", { activeTaskCount: -1 }],
    ["attention task count", { attentionTaskCount: 0.5 }],
    ["online Agent count", { onlineAgentCount: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)("rejects an invalid project %s", (label, overrides) => {
    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(
        snapshot(project(overrides)),
      ),
    ).toThrow(`${label} must be a non-negative safe integer`);
  });

  it("rejects more returned tasks than the project declares", () => {
    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(
        snapshot(project({ taskCount: 0 })),
      ),
    ).toThrow("returned more tasks than its declared total");
  });

  it.each([
    { activeTaskCount: 2 },
    { attentionTaskCount: 2 },
    { onlineAgentCount: 2 },
  ])("rejects summary counts above the project task total", (overrides) => {
    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(
        snapshot(project(overrides)),
      ),
    ).toThrow("summary count exceeds its task total");
  });

  it("accepts a consistent project summary", () => {
    const result = new TaskWorkspaceSnapshotAssembler().addPage(
      snapshot(project()),
    );
    expect(result.kind).toBe("complete");
  });
});
