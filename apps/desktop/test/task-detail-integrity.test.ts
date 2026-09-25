import { describe, expect, it } from "vitest";

import type { DesktopTaskDetail, DesktopTaskMessage } from "../src/shared.js";
import {
  assertTaskDetailIntegrity,
  isTaskDetailIntegrityError,
  TaskDetailIntegrityError,
} from "../src/renderer/task-detail-integrity.js";

function message(
  sequence: number,
  overrides: Partial<DesktopTaskMessage> = {},
): DesktopTaskMessage {
  return {
    id: overrides.id ?? `message-${sequence}`,
    taskId: overrides.taskId ?? "task-1",
    sequence,
    role: overrides.role ?? "assistant",
    agentId: overrides.agentId ?? "agent-1",
    agentName: overrides.agentName ?? "Agent",
    content: overrides.content ?? `Message ${sequence}`,
    createdAt: overrides.createdAt ?? "2026-08-28T10:00:00.000Z",
    acknowledgedAt: overrides.acknowledgedAt ?? null,
  };
}

function detail(
  messages: readonly DesktopTaskMessage[] = [message(1)],
  overrides: Partial<DesktopTaskDetail> = {},
): DesktopTaskDetail {
  const messageCount = overrides.task?.messageCount ?? messages.length;
  return {
    task: {
      id: "task-1",
      projectId: "project-1",
      projectName: "Project",
      projectRoot: "E:\\projects\\one",
      title: "Task",
      category: "development",
      status: "running",
      source: "agent",
      summary: "Summary",
      currentStep: "Current step",
      progress: { current: 1, total: 2, label: "Progress" },
      steps: [],
      agent: {
        id: "agent-1",
        name: "Agent",
        principalId: "principal-1",
        presence: "online",
        lastHeartbeatAt: "2026-08-28T10:00:00.000Z",
      },
      lastActivityLabel: "Working",
      lastActivityAt: "2026-08-28T10:00:00.000Z",
      unreadUserMessageCount: 0,
      coordinationPendingCount: 0,
      messageCount,
      createdAt: "2026-08-28T09:00:00.000Z",
      updatedAt: "2026-08-28T10:00:00.000Z",
      completedAt: null,
      ...overrides.task,
    },
    messages: overrides.messages ?? messages,
    messagesTruncated:
      overrides.messagesTruncated ?? messageCount > messages.length,
    oldestMessageSequence:
      overrides.oldestMessageSequence ?? messages[0]?.sequence ?? null,
    newestMessageSequence:
      overrides.newestMessageSequence ?? messages.at(-1)?.sequence ?? null,
  };
}

describe("task detail integrity", () => {
  it("accepts complete and bounded truncated message windows", () => {
    expect(() => assertTaskDetailIntegrity("task-1", detail())).not.toThrow();
    expect(() =>
      assertTaskDetailIntegrity(
        "task-1",
        detail([message(2), message(3)], {
          task: {
            ...detail().task,
            messageCount: 3,
          },
          messagesTruncated: true,
        }),
      ),
    ).not.toThrow();
  });

  it("exposes a typed integrity failure without weakening its public message", () => {
    let observed: unknown = null;
    try {
      assertTaskDetailIntegrity(
        "task-1",
        detail([], {
          task: { ...detail().task, id: "task-2", messageCount: 0 },
        }),
      );
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(TaskDetailIntegrityError);
    expect(isTaskDetailIntegrityError(observed)).toBe(true);
    expect((observed as Error).message).toContain(
      "Task detail integrity check failed",
    );
    expect(isTaskDetailIntegrityError(new Error("network failed"))).toBe(false);
  });

  it("rejects a detail response for another task", () => {
    expect(() =>
      assertTaskDetailIntegrity(
        "task-1",
        detail([], {
          task: {
            ...detail().task,
            id: "task-2",
            messageCount: 0,
          },
        }),
      ),
    ).toThrow("returned task id does not match");
  });

  it("rejects cross-task, duplicated and out-of-order messages", () => {
    expect(() =>
      assertTaskDetailIntegrity(
        "task-1",
        detail([message(1, { taskId: "task-2" })]),
      ),
    ).toThrow("belongs to another task");

    expect(() =>
      assertTaskDetailIntegrity(
        "task-1",
        detail([message(1, { id: "same" }), message(2, { id: "same" })]),
      ),
    ).toThrow("empty or duplicated");

    expect(() =>
      assertTaskDetailIntegrity("task-1", detail([message(2), message(1)])),
    ).toThrow("not strictly increasing");
  });

  it("rejects an invalid coordination pending count independently of conversation totals", () => {
    expect(() =>
      assertTaskDetailIntegrity(
        "task-1",
        detail(undefined, {
          task: {
            ...detail().task,
            coordinationPendingCount: -1,
          },
        }),
      ),
    ).toThrow("task message counters are invalid");
  });

  it("rejects inconsistent counters, truncation and sequence boundaries", () => {
    expect(() =>
      assertTaskDetailIntegrity(
        "task-1",
        detail([message(1)], {
          task: { ...detail().task, messageCount: 2 },
          messagesTruncated: false,
        }),
      ),
    ).toThrow("truncation state");

    expect(() =>
      assertTaskDetailIntegrity(
        "task-1",
        detail([message(1)], { newestMessageSequence: 2 }),
      ),
    ).toThrow("window boundaries");

    expect(() =>
      assertTaskDetailIntegrity(
        "task-1",
        detail([message(1, { role: "user" })], {
          task: { ...detail().task, unreadUserMessageCount: 0 },
        }),
      ),
    ).toThrow("visible pending messages exceed");
  });
});
