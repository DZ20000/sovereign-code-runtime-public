import type {
  DesktopTaskDetail,
  DesktopTaskStatus,
} from "../../packages/control-plane-contract/src/index.js";
import { describe, expect, it } from "vitest";

import { buildTaskSessionContinuity } from "../../apps/desktop/src/renderer/task-session-continuity.js";

function detail(
  options: {
    status?: DesktopTaskStatus;
    source?: "agent" | "inferred" | "user";
    agentId?: string | null;
    presence?: "online" | "stale" | "offline" | "unknown";
    messageCount?: number;
    shownMessages?: number;
    truncated?: boolean;
  } = {},
): DesktopTaskDetail {
  const messageCount = options.messageCount ?? 2;
  const shownMessages = options.shownMessages ?? messageCount;
  return {
    task: {
      id: "task-1",
      projectId: "project-1",
      projectName: "Sovereign",
      projectRoot: "C:\\Projects\\sovereign-code-runtime",
      title: "Continue the Task",
      category: "development",
      status: options.status ?? "running",
      source: options.source ?? "agent",
      summary: "Durable task context",
      currentStep: "Review continuity",
      progress: { current: null, total: null, label: null },
      steps: [],
      agent: {
        id: options.agentId === undefined ? "agent-1" : options.agentId,
        name: "ChatGPT Pro",
        principalId: "chatgpt-web",
        presence: options.presence ?? "online",
        lastHeartbeatAt: "2026-08-26T20:00:00.000Z",
      },
      lastActivityLabel: null,
      lastActivityAt: null,
      unreadUserMessageCount: 0,
      coordinationPendingCount: 0,
      messageCount,
      createdAt: "2026-08-26T19:00:00.000Z",
      updatedAt: "2026-08-26T20:00:00.000Z",
      completedAt: null,
    },
    messages: Array.from({ length: shownMessages }, (_, index) => ({
      id: `message-${index + 1}`,
      taskId: "task-1",
      sequence: index + 1,
      role: index % 2 === 0 ? "user" : "assistant",
      agentId: index % 2 === 0 ? null : "agent-1",
      agentName: index % 2 === 0 ? null : "ChatGPT Pro",
      content: `Message ${index + 1}`,
      createdAt: `2026-08-26T20:00:0${index}.000Z`,
      acknowledgedAt: null,
    })),
    messagesTruncated: options.truncated ?? false,
    oldestMessageSequence: shownMessages > 0 ? 1 : null,
    newestMessageSequence: shownMessages > 0 ? shownMessages : null,
  };
}

describe("Task web session continuity model", () => {
  it("describes an online Agent as resumable through saved Task scope", () => {
    const model = buildTaskSessionContinuity(detail(), "en");
    expect(model).toMatchObject({
      tone: "connected",
      stateLabel: "Agent online",
      ownerLabel: "ChatGPT Pro · online",
      conversationLabel: "2 saved task messages",
    });
    expect(model.nextLabel).toContain("Browser memory is not copied");
  });

  it("preserves a handoff when the Agent is stale or offline", () => {
    expect(
      buildTaskSessionContinuity(detail({ presence: "stale" }), "en").tone,
    ).toBe("handoff");
    expect(
      buildTaskSessionContinuity(detail({ presence: "offline" }), "zh-CN")
        .stateLabel,
    ).toBe("可交接");
    const unconfirmed = detail();
    expect(buildTaskSessionContinuity({ ...unconfirmed, task: { ...unconfirmed.task,
      agent: { ...unconfirmed.task.agent, lastHeartbeatAt: null } } }, "en"))
      .toMatchObject({ tone: "handoff", ownerLabel: "ChatGPT Pro · not checked in" });
  });

  it("does not claim continuity for inferred or unassigned work", () => {
    expect(
      buildTaskSessionContinuity(detail({ source: "inferred" }), "en"),
    ).toMatchObject({ tone: "captured", stateLabel: "Awaiting claim" });
    expect(
      buildTaskSessionContinuity(detail({ agentId: null }), "en"),
    ).toMatchObject({ tone: "unassigned", stateLabel: "Unassigned" });
  });

  it.each(["waiting-user", "blocked", "failed"] as const)(
    "marks %s work as attention before continuation",
    (status) => {
      expect(buildTaskSessionContinuity(detail({ status }), "en").tone).toBe(
        "attention",
      );
    },
  );

  it.each(["succeeded", "cancelled"] as const)(
    "retains %s tasks as history rather than live continuation",
    (status) => {
      expect(buildTaskSessionContinuity(detail({ status }), "en").tone).toBe(
        "complete",
      );
    },
  );

  it("reports the saved total independently of the displayed conversation window", () => {
    const model = buildTaskSessionContinuity(
      detail({ messageCount: 300, shownMessages: 12, truncated: true }),
      "en",
    );
    expect(model.conversationLabel).toBe("300 saved task messages");
    const serialized = JSON.stringify(model);
    expect(serialized).not.toMatch(
      /sessionId|token|digest|command|stdout|stderr/iu,
    );
  });
});
