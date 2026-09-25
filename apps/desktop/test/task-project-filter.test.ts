import { describe, expect, it } from "vitest";

import type {
  DesktopTaskListItem,
  DesktopTaskProjectSummary,
} from "../src/shared.js";
import {
  buildTaskProjectFilterOptions,
  filterTaskProjects,
  normalizeTaskProjectFilterSelection,
} from "../src/renderer/task-project-filter.js";

function task(
  overrides: Partial<DesktopTaskListItem> = {},
): DesktopTaskListItem {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Task",
    category: overrides.category ?? "development",
    status: overrides.status ?? "running",
    source: overrides.source ?? "agent",
    summaryPreview: overrides.summaryPreview ?? "Summary",
    currentStep: overrides.currentStep ?? "Current step",
    progress: overrides.progress ?? { current: 1, total: 2, label: "Progress" },
    agent: overrides.agent ?? {
      id: "agent-1",
      name: "Agent One",
      presence: "online",
      lastHeartbeatAt: "2026-09-01T12:00:00.000Z",
    },
    lastActivityLabel: overrides.lastActivityLabel ?? null,
    lastActivityAt: overrides.lastActivityAt ?? "2026-09-01T12:00:00.000Z",
    unreadUserMessageCount: overrides.unreadUserMessageCount ?? 0,
    coordinationPendingCount: overrides.coordinationPendingCount ?? 0,
    messageCount: overrides.messageCount ?? 0,
    updatedAt: overrides.updatedAt ?? "2026-09-01T12:00:00.000Z",
  };
}

function project(
  id: string,
  name: string,
  root: string,
  tasks: readonly DesktopTaskListItem[],
): DesktopTaskProjectSummary {
  return {
    id,
    name,
    root,
    status: "active",
    taskCount: tasks.length,
    activeTaskCount: 0,
    attentionTaskCount: 0,
    onlineAgentCount: 0,
    updatedAt: "2026-09-01T12:00:00.000Z",
    tasks,
  };
}

describe("task project filter", () => {
  const alpha = project("alpha", "Alpha", "E:\\alpha", [
    task(),
    task({
      id: "stale",
      agent: {
        id: "agent-2",
        name: "Agent Two",
        presence: "stale",
        lastHeartbeatAt: "2026-09-01T11:59:00.000Z",
      },
    }),
  ]);
  const beta = project("beta", "Beta", "E:\\beta", [
    task({
      id: "offline",
      agent: {
        id: "agent-3",
        name: "Offline Agent",
        presence: "offline",
        lastHeartbeatAt: null,
      },
    }),
  ]);

  it("projects existing project roots and active Agent sessions without task counts", () => {
    const options = buildTaskProjectFilterOptions([alpha, beta]);

    expect(options.map((option) => option.projectId)).toEqual([
      null,
      "alpha",
      "beta",
    ]);
    expect(options[0]).toMatchObject({
      label: "All projects",
      root: null,
      hasActiveAgentSession: true,
      activeAgentNames: ["Agent One", "Agent Two"],
    });
    expect(options[1]).toMatchObject({
      label: "Alpha",
      root: "E:\\alpha",
      hasActiveAgentSession: true,
      activeAgentNames: ["Agent One", "Agent Two"],
    });
    expect(options[2]).toMatchObject({
      label: "Beta",
      root: "E:\\beta",
      hasActiveAgentSession: false,
      activeAgentNames: [],
    });
  });

  it("falls back to the all-projects view when a selected project disappears", () => {
    expect(normalizeTaskProjectFilterSelection([alpha, beta], "alpha")).toBe(
      "alpha",
    );
    expect(
      normalizeTaskProjectFilterSelection([alpha, beta], "missing"),
    ).toBeNull();
    expect(normalizeTaskProjectFilterSelection([alpha, beta], null)).toBeNull();
  });

  it("filters the existing project collection without cloning task state", () => {
    expect(filterTaskProjects([alpha, beta], null)).toEqual([alpha, beta]);
    expect(filterTaskProjects([alpha, beta], "beta")).toEqual([beta]);
  });
});
