import { describe, expect, it } from "vitest";

import type {
  DesktopTaskListItem,
  DesktopTaskProjectSummary,
  DesktopTaskWorkspaceSnapshot,
} from "../src/shared.js";
import { TaskWorkspaceSnapshotAssembler } from "../src/renderer/task-workspace-pagination.js";

function task(id: string): DesktopTaskListItem {
  return {
    id,
    title: `Task ${id}`,
    category: "development",
    status: "running",
    source: "agent",
    summaryPreview: "Summary",
    currentStep: "Current step",
    progress: { current: 1, total: 2, label: "Progress" },
    agent: {
      id: "agent-1",
      name: "Agent",
      presence: "online",
      lastHeartbeatAt: "2026-08-28T10:00:00.000Z",
    },
    lastActivityLabel: "Working",
    lastActivityAt: "2026-08-28T10:00:00.000Z",
    unreadUserMessageCount: 0,
    coordinationPendingCount: 0,
    messageCount: 0,
    updatedAt: "2026-08-28T10:00:00.000Z",
  };
}

function project(
  id: string,
  tasks: readonly DesktopTaskListItem[],
  taskCount = tasks.length,
): DesktopTaskProjectSummary {
  return {
    id,
    name: `Project ${id}`,
    root: `E:\\projects\\${id}`,
    status: "active",
    taskCount,
    activeTaskCount: taskCount,
    attentionTaskCount: 0,
    onlineAgentCount: 1,
    updatedAt: "2026-08-28T10:00:00.000Z",
    tasks,
  };
}

function page(options: {
  readonly offset: number;
  readonly totalTaskCount: number;
  readonly totalProjectCount: number;
  readonly nextOffset: number | null;
  readonly projects: readonly DesktopTaskProjectSummary[];
  readonly revision?: number;
  readonly limit?: number;
}): DesktopTaskWorkspaceSnapshot {
  const returnedTaskCount = options.projects.reduce(
    (count, value) => count + value.tasks.length,
    0,
  );
  return {
    schemaVersion: "scr.task-workspace/v1",
    generatedAt: "2026-08-28T10:00:00.000Z",
    revision: options.revision ?? 7,
    offset: options.offset,
    limit: options.limit ?? returnedTaskCount,
    totalTaskCount: options.totalTaskCount,
    totalProjectCount: options.totalProjectCount,
    nextOffset: options.nextOffset,
    projects: options.projects,
  };
}

describe("task workspace snapshot pagination", () => {
  it("assembles split project pages into one complete trusted snapshot", () => {
    const assembler = new TaskWorkspaceSnapshotAssembler();

    expect(
      assembler.addPage(
        page({
          offset: 0,
          totalTaskCount: 2,
          totalProjectCount: 1,
          nextOffset: 1,
          projects: [project("p", [task("a")], 2)],
        }),
      ),
    ).toEqual({ kind: "continue", nextOffset: 1 });

    const result = assembler.addPage(
      page({
        offset: 1,
        totalTaskCount: 2,
        totalProjectCount: 1,
        nextOffset: null,
        projects: [project("p", [task("b")], 2)],
      }),
    );

    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("Expected completion.");
    expect(result.snapshot).toMatchObject({
      offset: 0,
      limit: 2,
      nextOffset: null,
      totalTaskCount: 2,
      totalProjectCount: 1,
    });
    expect(result.snapshot.projects[0]?.tasks.map((value) => value.id)).toEqual(
      ["a", "b"],
    );
  });

  it("requests a retry when revision or declared totals change between pages", () => {
    const assembler = new TaskWorkspaceSnapshotAssembler();
    assembler.addPage(
      page({
        offset: 0,
        totalTaskCount: 2,
        totalProjectCount: 1,
        nextOffset: 1,
        projects: [project("p", [task("a")], 2)],
      }),
    );

    expect(
      assembler.addPage(
        page({
          offset: 1,
          totalTaskCount: 3,
          totalProjectCount: 1,
          nextOffset: null,
          projects: [project("p", [task("b")], 3)],
          revision: 8,
        }),
      ),
    ).toEqual({ kind: "retry" });
  });

  it("fails closed when project metadata changes within one revision", () => {
    const assembler = new TaskWorkspaceSnapshotAssembler();
    assembler.addPage(
      page({
        offset: 0,
        totalTaskCount: 2,
        totalProjectCount: 1,
        nextOffset: 1,
        projects: [project("p", [task("a")], 2)],
      }),
    );

    const changedProject = {
      ...project("p", [task("b")], 2),
      attentionTaskCount: 1,
      onlineAgentCount: 0,
      status: "attention" as const,
    };
    expect(() =>
      assembler.addPage(
        page({
          offset: 1,
          totalTaskCount: 2,
          totalProjectCount: 1,
          nextOffset: null,
          projects: [changedProject],
        }),
      ),
    ).toThrow("changed project p");
  });

  it("fails closed when a task is duplicated across advancing pages", () => {
    const assembler = new TaskWorkspaceSnapshotAssembler();
    assembler.addPage(
      page({
        offset: 0,
        totalTaskCount: 2,
        totalProjectCount: 1,
        nextOffset: 1,
        projects: [project("p", [task("a")], 2)],
      }),
    );

    expect(() =>
      assembler.addPage(
        page({
          offset: 1,
          totalTaskCount: 2,
          totalProjectCount: 1,
          nextOffset: null,
          projects: [project("p", [task("a")], 2)],
        }),
      ),
    ).toThrow("duplicated task a");
  });

  it("accepts a short final page while rejecting responses above the requested limit", () => {
    const result = new TaskWorkspaceSnapshotAssembler().addPage(
      page({
        offset: 0,
        totalTaskCount: 1,
        totalProjectCount: 1,
        nextOffset: null,
        projects: [project("p", [task("a")])],
        limit: 64,
      }),
    );
    expect(result.kind).toBe("complete");

    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(
        page({
          offset: 0,
          totalTaskCount: 2,
          totalProjectCount: 1,
          nextOffset: null,
          projects: [project("p", [task("a"), task("b")])],
          limit: 1,
        }),
      ),
    ).toThrow("more items than its declared limit");
  });

  it("rejects offsets that do not match the returned item count", () => {
    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(
        page({
          offset: 0,
          totalTaskCount: 2,
          totalProjectCount: 1,
          nextOffset: 2,
          projects: [project("p", [task("a")], 2)],
        }),
      ),
    ).toThrow("did not advance safely");
  });

  it("rejects a globally complete snapshot with mismatched per-project totals", () => {
    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(
        page({
          offset: 0,
          totalTaskCount: 3,
          totalProjectCount: 2,
          nextOffset: null,
          projects: [
            project("a", [task("a-1")], 2),
            project("b", [task("b-1"), task("b-2")], 2),
          ],
        }),
      ),
    ).toThrow("project a task count did not match its declared total");
  });

  it("rejects a final page that omits declared tasks or projects", () => {
    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(
        page({
          offset: 0,
          totalTaskCount: 2,
          totalProjectCount: 1,
          nextOffset: null,
          projects: [project("p", [task("a")], 2)],
        }),
      ),
    ).toThrow("ended before every declared task");

    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(
        page({
          offset: 0,
          totalTaskCount: 1,
          totalProjectCount: 2,
          nextOffset: null,
          projects: [project("p", [task("a")])],
        }),
      ),
    ).toThrow("project count did not match");
  });
});
