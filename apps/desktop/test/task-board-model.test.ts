import { describe, expect, it } from "vitest";

import type { DesktopTaskListItem } from "../src/shared.js";
import {
  compareTaskBoardTasks,
  taskBoardCounts,
  taskBoardLane,
  taskBoardState,
  taskBoardStateDetail,
  taskBoardStateLabel,
  taskCoordinationPendingLabel,
  taskHasCurrentAgentSession,
  taskHasLiveAgent,
  taskMatchesBoardLane,
} from "../src/renderer/task-board-model.js";

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
      name: "Agent",
      presence: "online",
      lastHeartbeatAt: "2026-09-01T10:00:00.000Z",
    },
    lastActivityLabel: overrides.lastActivityLabel ?? null,
    lastActivityAt: overrides.lastActivityAt ?? "2026-09-01T10:00:00.000Z",
    unreadUserMessageCount: overrides.unreadUserMessageCount ?? 0,
    coordinationPendingCount: overrides.coordinationPendingCount ?? 0,
    messageCount: overrides.messageCount ?? 0,
    updatedAt: overrides.updatedAt ?? "2026-09-01T10:00:00.000Z",
  };
}

describe("task board canonical projection", () => {
  it("separates workflow state from a delayed Agent heartbeat", () => {
    const online = task({ id: "online" });
    const stale = task({
      id: "stale",
      agent: {
        id: "agent-stale",
        name: "Agent",
        presence: "stale",
        lastHeartbeatAt: "2026-09-01T09:59:00.000Z",
      },
    });

    expect(taskHasLiveAgent(online)).toBe(true);
    expect(taskHasCurrentAgentSession(online)).toBe(true);
    expect(taskBoardLane(online)).toBe("current");
    expect(taskBoardState(online)).toBe("running");

    expect(taskHasLiveAgent(stale)).toBe(false);
    expect(taskHasCurrentAgentSession(stale)).toBe(true);
    expect(taskBoardLane(stale)).toBe("current");
    expect(taskBoardState(stale)).toBe("running");
    expect(taskBoardStateDetail(stale)).toContain("heartbeat is delayed");
  });

  it("keeps unfinished work visible when its connection is unconfirmed", () => {
    const offline = task({
      id: "offline",
      agent: {
        id: "agent-offline",
        name: "Agent",
        presence: "offline",
        lastHeartbeatAt: null,
      },
    });
    const expired = task({
      id: "expired",
      agent: {
        id: "agent-expired",
        name: "Agent",
        presence: "online",
        lastHeartbeatAt: null,
      },
    });
    const unassigned = task({
      id: "unassigned",
      agent: {
        id: null,
        name: null,
        presence: "unknown",
        lastHeartbeatAt: null,
      },
    });

    for (const candidate of [offline, expired, unassigned]) {
      expect(taskHasCurrentAgentSession(candidate)).toBe(false);
      expect(taskBoardLane(candidate)).toBe("current");
      expect(taskMatchesBoardLane(candidate, "attention")).toBe(false);
      expect(taskMatchesBoardLane(candidate, "history")).toBe(false);
      expect(taskBoardState(candidate)).toBe("running");
      expect(taskBoardStateDetail(candidate)).toContain("unfinished");
    }
    expect(taskBoardStateDetail(offline)).toContain("connection is not confirmed");
    expect(taskBoardStateDetail(expired)).toContain("heartbeat has not been confirmed");
    expect(taskBoardStateDetail(unassigned)).toContain("No Agent is assigned");
  });

  it("never treats an unfinished workflow as history because of its connection state", () => {
    for (const status of ["queued", "planning", "running", "waiting-user", "blocked"] as const) {
      for (const presence of ["online", "stale", "offline", "unknown"] as const) {
        const value = task({ status, agent: { ...task().agent, presence } });
        expect(taskBoardState(value)).toBe(status);
        expect(taskMatchesBoardLane(value, "history")).toBe(false);
        expect(taskBoardLane(value)).toBe(
          status === "waiting-user" || status === "blocked" ? "attention" : "current",
        );
        expect(value.status).toBe(status);
        expect(value.agent.presence).toBe(presence);
      }
    }
  });

  it("keeps blockers and terminal review states in Needs action regardless of connection", () => {
    const liveBlocked = task({ id: "live-blocked", status: "blocked" });
    const offlineBlocked = task({
      id: "offline-blocked",
      status: "blocked",
      agent: {
        id: "agent-offline",
        name: "Agent",
        presence: "offline",
        lastHeartbeatAt: null,
      },
    });

    expect(taskBoardLane(task({ status: "waiting-user" }))).toBe("attention");
    expect(taskBoardLane(liveBlocked)).toBe("attention");
    expect(taskBoardStateDetail(liveBlocked)).toContain("blocked");
    expect(taskBoardLane(offlineBlocked)).toBe("attention");
    expect(taskBoardStateDetail(offlineBlocked)).toContain("blocked");
    expect(taskBoardLane(task({ status: "failed" }))).toBe("attention");
    expect(taskBoardLane(task({ status: "succeeded" }))).toBe("history");
    expect(taskBoardLane(task({ status: "cancelled" }))).toBe("history");
  });

  it("surfaces unread terminal follow-ups without reclassifying live work", () => {
    for (const status of ["succeeded", "cancelled"] as const) {
      const followUp = task({
        id: status,
        status,
        unreadUserMessageCount: 1,
      });
      expect(taskBoardLane(followUp)).toBe("attention");
      expect(taskBoardState(followUp)).toBe("follow-up-pending");
      expect(taskBoardStateLabel(followUp)).toBe("Follow-up pending");
      expect(taskBoardStateDetail(followUp)).toContain(
        "waiting for acknowledgement",
      );
    }

    const inactiveFollowUp = task({
      status: "succeeded",
      unreadUserMessageCount: 1,
      agent: {
        id: "agent-offline",
        name: "Agent",
        presence: "offline",
        lastHeartbeatAt: null,
      },
    });
    expect(taskBoardLane(inactiveFollowUp)).toBe("attention");
    expect(taskBoardStateDetail(inactiveFollowUp)).toContain(
      "waiting for acknowledgement",
    );
    expect(taskBoardLane(task({ unreadUserMessageCount: 1 }))).toBe("current");
  });

  it("shows coordination audit counts without changing the canonical lane", () => {
    const current = task({ coordinationPendingCount: 2 });
    const history = task({ status: "succeeded", coordinationPendingCount: 1 });
    const inactive = task({
      coordinationPendingCount: 3,
      agent: {
        id: "agent-offline",
        name: "Agent",
        presence: "offline",
        lastHeartbeatAt: null,
      },
    });

    expect(taskCoordinationPendingLabel(current)).toBe(
      "2 coordination pending",
    );
    expect(taskBoardLane(current)).toBe("current");
    expect(taskBoardLane(history)).toBe("history");
    expect(taskBoardLane(inactive)).toBe("current");
    expect(taskCoordinationPendingLabel(task())).toBeNull();
  });

  it("isolates inferred activity from formal task queues", () => {
    const runningActivity = task({ source: "inferred", status: "running" });
    const endedActivity = task({ source: "inferred", status: "succeeded" });

    expect(taskHasCurrentAgentSession(runningActivity)).toBe(false);
    expect(taskBoardLane(runningActivity)).toBe("activity");
    expect(taskBoardState(runningActivity)).toBe("observed-activity");
    expect(taskBoardLane(endedActivity)).toBe("activity");
    expect(taskBoardState(endedActivity)).toBe("activity-ended");
  });

  it("uses stable identifiers and update-time fallback for deterministic order", () => {
    const tied = [
      task({ id: "task-b", title: "Same" }),
      task({ id: "task-a", title: "Same" }),
    ];
    expect(
      [...tied].sort(compareTaskBoardTasks).map((value) => value.id),
    ).toEqual(["task-a", "task-b"]);

    const invalidActivity = [
      task({
        id: "older",
        lastActivityAt: "not-a-date",
        updatedAt: "2026-09-01T09:00:00.000Z",
      }),
      task({
        id: "newer",
        lastActivityAt: "not-a-date",
        updatedAt: "2026-09-01T11:00:00.000Z",
      }),
    ];
    expect(
      [...invalidActivity].sort(compareTaskBoardTasks).map((value) => value.id),
    ).toEqual(["newer", "older"]);
  });

  it("counts offline work in its workflow queue without inventing operator action", () => {
    const values = [
      task({ id: "history", status: "succeeded", title: "History" }),
      task({ id: "activity", source: "inferred", title: "Activity" }),
      task({ id: "current", title: "Current" }),
      task({ id: "blocked", status: "blocked", title: "Blocked" }),
      task({
        id: "follow-up",
        status: "succeeded",
        unreadUserMessageCount: 1,
        title: "Follow-up",
      }),
      task({
        id: "offline",
        title: "Offline",
        agent: {
          id: "agent-2",
          name: "Agent",
          presence: "offline",
          lastHeartbeatAt: null,
        },
      }),
    ];

    expect(taskBoardCounts(values)).toEqual({
      current: 2,
      attention: 2,
      history: 1,
      activity: 1,
      all: 6,
    });
    expect(
      [...values].sort(compareTaskBoardTasks).map((value) => value.id),
    ).toEqual([
      "current",
      "offline",
      "follow-up",
      "blocked",
      "history",
      "activity",
    ]);
  });
});
