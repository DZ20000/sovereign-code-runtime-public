import { describe, expect, it } from "vitest";
import {
  activeWorkPositionLabel,
  buildActiveWorkItems,
  moveActiveWorkSelection,
  reconcileActiveWorkSelection,
  visibleActiveWorkItems,
  type ActiveWorkItem,
} from "../src/renderer/active-work-carousel.js";
import {
  taskBoardLane,
  taskBoardState,
  taskBoardStateDetail,
  taskBoardStateLabel,
} from "../src/renderer/task-board-model.js";
import type {
  DesktopTaskListItem,
  DesktopTaskWorkspaceSnapshot,
} from "../src/shared.js";

function selectionItem(id: string): ActiveWorkItem {
  return {
    id,
    source: "task",
    title: id,
    detail: "Live Agent heartbeat confirmed.",
    lane: "current",
    state: "running",
    stateLabel: "Running",
    tone: "active",
    taskId: id,
    updatedAt: "2026-08-25T00:00:00Z",
  };
}

function task(
  overrides: Partial<DesktopTaskListItem> = {},
): DesktopTaskListItem {
  return {
    id: overrides.id ?? "active",
    title: overrides.title ?? "Active task",
    category: overrides.category ?? "development",
    status: overrides.status ?? "running",
    source: overrides.source ?? "agent",
    summaryPreview: overrides.summaryPreview ?? "Summary",
    currentStep: overrides.currentStep ?? "Implement UI",
    progress: overrides.progress ?? { current: 1, total: 3, label: "UI" },
    agent: overrides.agent ?? {
      id: "agent-1",
      name: "Agent",
      presence: "online",
      lastHeartbeatAt: "2026-08-25T00:00:00Z",
    },
    lastActivityLabel: overrides.lastActivityLabel ?? "Edit",
    lastActivityAt: overrides.lastActivityAt ?? "2026-08-25T00:00:00Z",
    unreadUserMessageCount: overrides.unreadUserMessageCount ?? 0,
    coordinationPendingCount: overrides.coordinationPendingCount ?? 0,
    messageCount: overrides.messageCount ?? 0,
    updatedAt: overrides.updatedAt ?? "2026-08-25T00:00:00Z",
  };
}

function workspace(
  tasks: readonly DesktopTaskListItem[],
): DesktopTaskWorkspaceSnapshot {
  return {
    schemaVersion: "scr.task-workspace/v1",
    generatedAt: "2026-08-25T00:00:00Z",
    revision: 1,
    offset: 0,
    limit: 64,
    totalTaskCount: tasks.length,
    totalProjectCount: 1,
    nextOffset: null,
    projects: [
      {
        id: "p",
        name: "Project",
        root: "E:\\project",
        status: "active",
        taskCount: tasks.length,
        activeTaskCount: tasks.filter(
          (value) => taskBoardLane(value) === "current",
        ).length,
        attentionTaskCount: tasks.filter(
          (value) => taskBoardLane(value) === "attention",
        ).length,
        onlineAgentCount: 1,
        updatedAt: "2026-08-25T00:00:00Z",
        tasks,
      },
    ],
  };
}

const activeTask = task();
const blockedTask = task({
  id: "blocked",
  title: "Blocked task",
  status: "blocked",
  currentStep: "pnpm test --filter secret",
  progress: { current: null, total: null, label: null },
  agent: {
    id: "agent-2",
    name: "Agent",
    presence: "online",
    lastHeartbeatAt: "2026-08-25T00:01:00Z",
  },
  lastActivityLabel: null,
  lastActivityAt: null,
  updatedAt: "2026-08-25T00:01:00Z",
});
const taskWorkspace = workspace([activeTask, blockedTask]);

describe("active work carousel model", () => {
  it("builds a bounded, safe, priority-ordered work list", () => {
    const values = buildActiveWorkItems({ taskWorkspace });
    expect(values.map((value) => value.id)).toEqual([
      "task:blocked",
      "task:active",
    ]);
    expect(values[0]).toMatchObject({
      lane: "attention",
      state: "blocked",
      stateLabel: "Blocked",
      detail: taskBoardStateDetail(blockedTask),
    });
    expect(values[1]).toMatchObject({
      lane: "current",
      state: "running",
      stateLabel: "Running",
      detail: taskBoardStateDetail(activeTask),
    });
    expect(values.some((value) => /pnpm test/u.test(value.detail))).toBe(false);
    expect(
      values.every(
        (value) => !/\d+\s*s(?:ec(?:ond)?s?)?\b/iu.test(value.detail),
      ),
    ).toBe(true);
  });

  it("keeps Home focused on current work and true action items", () => {
    const values = buildActiveWorkItems({
      taskWorkspace: workspace([
        activeTask,
        task({
          id: "stale-blocked",
          status: "blocked",
          lastActivityAt: "2026-08-20T00:00:00Z",
          agent: {
            id: "agent-stale-blocked",
            name: "Agent",
            presence: "offline",
            lastHeartbeatAt: null,
          },
        }),
        task({
          id: "recent-blocked",
          status: "blocked",
          lastActivityAt: "2026-08-31T00:00:00Z",
        }),
        task({
          id: "waiting-user",
          status: "waiting-user",
          lastActivityAt: "2026-08-20T00:00:00Z",
        }),
      ]),
    });

    expect(values.map((value) => value.id)).toEqual([
      "task:recent-blocked",
      "task:stale-blocked",
      "task:waiting-user",
      "task:active",
    ]);
  });

  it("deduplicates the same task when project groups overlap", () => {
    const project = taskWorkspace.projects[0]!;
    const duplicateWorkspace: DesktopTaskWorkspaceSnapshot = {
      ...taskWorkspace,
      totalProjectCount: 2,
      projects: [project, { ...project, id: "p-duplicate" }],
    };
    expect(
      buildActiveWorkItems({ taskWorkspace: duplicateWorkspace }).map(
        (value) => value.id,
      ),
    ).toEqual(["task:blocked", "task:active"]);
  });

  it("formats a compact orientation label for the current task", () => {
    expect(activeWorkPositionLabel(9, 0)).toBe("1 / 9");
    expect(activeWorkPositionLabel(9, 8)).toBe("9 / 9");
    expect(activeWorkPositionLabel(0, -1)).toBe("0 items");
    expect(activeWorkPositionLabel(1, -1)).toBe("1 item");
  });

  it("keeps unfinished work visible with a delayed-heartbeat warning", () => {
    const value = task({
      id: "running-stale",
      agent: {
        id: "agent-stale",
        name: "Agent",
        presence: "stale",
        lastHeartbeatAt: "2026-08-25T00:00:00Z",
      },
    });
    const activeWork = buildActiveWorkItems({
      taskWorkspace: workspace([value]),
    });

    expect(taskBoardLane(value)).toBe("current");
    expect(taskBoardState(value)).toBe("running");
    expect(taskBoardStateDetail(value)).toContain("heartbeat is delayed");
    expect(activeWork[0]).toMatchObject({
      lane: "current",
      state: "running",
      stateLabel: taskBoardStateLabel(value),
      detail: taskBoardStateDetail(value),
      tone: "neutral",
    });
  });

  it.each([
    [
      "offline Agent",
      {
        id: "agent-offline",
        name: "Agent",
        presence: "offline" as const,
        lastHeartbeatAt: null,
      },
    ],
    [
      "expired heartbeat",
      {
        id: "agent-expired",
        name: "Agent",
        presence: "online" as const,
        lastHeartbeatAt: null,
      },
    ],
    [
      "no owner",
      {
        id: null,
        name: null,
        presence: "unknown" as const,
        lastHeartbeatAt: null,
      },
    ],
  ])(
    "keeps running work with %s visible on Home without changing its status",
    (_name, agent) => {
      const value = task({ agent });
      const activeWork = buildActiveWorkItems({
        taskWorkspace: workspace([value]),
      });

      expect(taskBoardLane(value)).toBe("current");
      expect(taskBoardState(value)).toBe("running");
      expect(taskBoardStateDetail(value)).toContain("unfinished");
      expect(activeWork).toMatchObject([{ taskId: value.id, state: "running", lane: "current", tone: "neutral" }]);
    },
  );

  it("includes terminal follow-ups only through the canonical attention lane", () => {
    const followUp = task({
      id: "completed-follow-up",
      status: "succeeded",
      unreadUserMessageCount: 1,
    });
    const activeWork = buildActiveWorkItems({
      taskWorkspace: workspace([followUp]),
    });

    expect(activeWork).toHaveLength(1);
    expect(activeWork[0]).toMatchObject({
      lane: "attention",
      state: "follow-up-pending",
      stateLabel: taskBoardStateLabel(followUp),
      detail: taskBoardStateDetail(followUp),
    });
    const inactiveFollowUp = task({
      id: "inactive-follow-up",
      status: "succeeded",
      unreadUserMessageCount: 1,
      agent: {
        id: "agent-offline",
        name: "Agent",
        presence: "offline",
        lastHeartbeatAt: null,
      },
    });
    expect(
      buildActiveWorkItems({
        taskWorkspace: workspace([
          task({ id: "completed", status: "succeeded" }),
          inactiveFollowUp,
        ]),
      }),
    ).toMatchObject([{ taskId: inactiveFollowUp.id, state: "follow-up-pending", lane: "attention" }]);
    expect(taskBoardLane(inactiveFollowUp)).toBe("attention");
  });

  it("retains a keyed selection across polling reorder and clamps removal", () => {
    const before = [
      selectionItem("one"),
      selectionItem("two"),
      selectionItem("three"),
    ];
    expect(reconcileActiveWorkSelection(before, "two")).toEqual({
      focusedId: "two",
      focusedIndex: 1,
    });
    const reordered = [before[2]!, before[1]!, before[0]!];
    expect(reconcileActiveWorkSelection(reordered, "two")).toEqual({
      focusedId: "two",
      focusedIndex: 1,
    });
    expect(reconcileActiveWorkSelection(reordered, "two", 1, true)).toEqual({
      focusedId: "three",
      focusedIndex: 0,
    });
    expect(reconcileActiveWorkSelection([before[0]!], "two", 1)).toEqual({
      focusedId: "one",
      focusedIndex: 0,
    });
  });

  it("moves without wrapping and exposes a five-line window", () => {
    const values = ["a", "b", "c", "d", "e", "f"].map(selectionItem);
    expect(moveActiveWorkSelection(values, "c", 1).focusedId).toBe("d");
    expect(moveActiveWorkSelection(values, "a", -1).focusedId).toBe("a");
    expect(
      visibleActiveWorkItems(values, "d").map(({ item: value, offset }) => [
        value.id,
        offset,
      ]),
    ).toEqual([
      ["b", -2],
      ["c", -1],
      ["d", 0],
      ["e", 1],
      ["f", 2],
    ]);
  });
});
