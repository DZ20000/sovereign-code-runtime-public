import type { DesktopTaskDetail } from "../../../packages/control-plane-contract/src/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderTaskSessionContinuity } from "../src/renderer/task-session-continuity-view.js";

const SELECTORS = [
  "#task-session-continuity",
  "#task-session-continuity-kicker",
  "#task-session-continuity-title",
  "#task-session-continuity-state",
  "#task-session-continuity-detail",
  "#task-session-continuity-owner-caption",
  "#task-session-continuity-owner",
  "#task-session-continuity-conversation-caption",
  "#task-session-continuity-conversation",
  "#task-session-continuity-next-caption",
  "#task-session-continuity-next",
] as const;

function fakeElement(): HTMLElement {
  return {
    textContent: "",
    className: "",
    hidden: true,
    dataset: {},
  } as unknown as HTMLElement;
}

function detail(presence: "online" | "offline" = "online"): DesktopTaskDetail {
  return {
    task: {
      id: "task-1",
      projectId: "project-1",
      projectName: "Sovereign",
      projectRoot: "C:\\Projects\\sovereign-code-runtime",
      title: "Continue the Task",
      category: "development",
      status: "running",
      source: "agent",
      summary: "Durable task context",
      currentStep: "Review continuity",
      progress: { current: null, total: null, label: null },
      steps: [],
      agent: {
        id: "agent-1",
        name: "ChatGPT Pro",
        principalId: "chatgpt-web",
        presence,
        lastHeartbeatAt: "2026-08-26T20:00:00.000Z",
      },
      lastActivityLabel: null,
      lastActivityAt: null,
      unreadUserMessageCount: 0,
      coordinationPendingCount: 0,
      messageCount: 1,
      createdAt: "2026-08-26T19:00:00.000Z",
      updatedAt: "2026-08-26T20:00:00.000Z",
      completedAt: null,
    },
    messages: [
      {
        id: "message-1",
        taskId: "task-1",
        sequence: 1,
        role: "user",
        agentId: null,
        agentName: null,
        content: "Continue safely",
        createdAt: "2026-08-26T20:00:00.000Z",
        acknowledgedAt: null,
      },
    ],
    messagesTruncated: false,
    oldestMessageSequence: 1,
    newestMessageSequence: 1,
  };
}

describe("Task session continuity view", () => {
  let elements: Map<string, HTMLElement>;

  beforeEach(() => {
    elements = new Map(SELECTORS.map((selector) => [selector, fakeElement()]));
    vi.stubGlobal("document", {
      documentElement: { lang: "en" },
      querySelector(selector: string) {
        return elements.get(selector) ?? null;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the online continuity state without replacing the root node", () => {
    const root = elements.get("#task-session-continuity");
    expect(root).toBeDefined();

    renderTaskSessionContinuity(detail());
    renderTaskSessionContinuity(detail());

    expect(elements.get("#task-session-continuity")).toBe(root);
    expect(root?.hidden).toBe(false);
    expect(root?.dataset.continuityTone).toBe("connected");
    expect(root?.className).toContain("task-session-continuity-connected");
    expect(elements.get("#task-session-continuity-title")?.textContent).toBe(
      "Task context is ready to continue",
    );
    expect(elements.get("#task-session-continuity-owner")?.textContent).toBe(
      "ChatGPT Pro · online",
    );
  });

  it("updates the same elements when language and Agent presence change", () => {
    renderTaskSessionContinuity(detail());
    (document.documentElement as { lang: string }).lang = "zh-CN";
    renderTaskSessionContinuity(detail("offline"));

    const root = elements.get("#task-session-continuity");
    expect(root?.dataset.continuityTone).toBe("handoff");
    expect(elements.get("#task-session-continuity-title")?.textContent).toBe(
      "任务上下文已保留",
    );
    expect(elements.get("#task-session-continuity-state")?.textContent).toBe(
      "可交接",
    );
    expect(elements.get("#task-session-continuity-owner")?.textContent).toBe(
      "ChatGPT Pro · 离线",
    );
  });
});
