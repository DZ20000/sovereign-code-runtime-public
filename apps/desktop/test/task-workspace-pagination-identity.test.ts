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
  tasks: readonly DesktopTaskListItem[],
): DesktopTaskProjectSummary {
  return {
    id: "project-1",
    name: "Project",
    root: "E:\\project",
    status: "active",
    taskCount: 2,
    activeTaskCount: 2,
    attentionTaskCount: 0,
    onlineAgentCount: 1,
    updatedAt: "2026-08-28T10:00:00.000Z",
    tasks,
  };
}

function page(options: {
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly tasks: readonly DesktopTaskListItem[];
  readonly generatedAt?: string;
}): DesktopTaskWorkspaceSnapshot {
  return {
    schemaVersion: "scr.task-workspace/v1",
    generatedAt: options.generatedAt ?? "2026-08-28T10:00:00.000Z",
    revision: 7,
    offset: options.offset,
    limit: 64,
    totalTaskCount: 2,
    totalProjectCount: 1,
    nextOffset: options.nextOffset,
    projects: [project(options.tasks)],
  };
}

describe("task workspace pagination snapshot identity", () => {
  it("rejects unsupported runtime schema values", () => {
    const invalid = {
      ...page({ offset: 0, nextOffset: null, tasks: [task("a"), task("b")] }),
      schemaVersion: "scr.task-workspace/v0",
    } as unknown as DesktopTaskWorkspaceSnapshot;
    expect(() => new TaskWorkspaceSnapshotAssembler().addPage(invalid)).toThrow(
      "schema version is unsupported",
    );
  });

  it.each(["", "not-a-timestamp"])(
    "rejects invalid generatedAt %s",
    (generatedAt) => {
      expect(() =>
        new TaskWorkspaceSnapshotAssembler().addPage(
          page({
            offset: 0,
            nextOffset: null,
            tasks: [task("a"), task("b")],
            generatedAt,
          }),
        ),
      ).toThrow("generatedAt must be a valid timestamp");
    },
  );

  it("accepts per-page generatedAt values inside one unchanged revision", () => {
    const assembler = new TaskWorkspaceSnapshotAssembler();
    expect(
      assembler.addPage(page({ offset: 0, nextOffset: 1, tasks: [task("a")] })),
    ).toEqual({ kind: "continue", nextOffset: 1 });

    const result = assembler.addPage(
      page({
        offset: 1,
        nextOffset: null,
        tasks: [task("b")],
        generatedAt: "2026-08-28T10:00:01.000Z",
      }),
    );

    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("Expected completion.");
    expect(result.snapshot.generatedAt).toBe("2026-08-28T10:00:00.000Z");
    expect(result.snapshot.projects[0]?.tasks.map((value) => value.id)).toEqual(
      ["a", "b"],
    );
  });
});
