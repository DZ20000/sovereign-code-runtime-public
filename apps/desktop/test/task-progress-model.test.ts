import { describe, expect, it } from "vitest";

import type { DesktopTaskListItem } from "../src/shared.js";
import {
  taskProgressIsIndeterminate,
  taskProgressIsInvalid,
  taskProgressLabel,
  taskProgressNote,
  taskProgressPercent,
  taskProgressValue,
} from "../src/renderer/task-progress-model.js";

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
    currentStep: "",
    progress: { current: null, total: null, label: null },
    agent: {
      id: "agent-1",
      name: "Agent",
      presence: "online",
      lastHeartbeatAt: "2026-08-29T00:00:00.000Z",
    },
    lastActivityLabel: null,
    lastActivityAt: null,
    unreadUserMessageCount: 0,
    messageCount: 0,
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  } as DesktopTaskListItem;
}

describe("task progress model", () => {
  it("renders bounded numeric progress", () => {
    const value = task({
      progress: { current: 3, total: 4, label: "Validation" },
    });
    expect(taskProgressPercent(value)).toBe(75);
    expect(taskProgressIsInvalid(value)).toBe(false);
    expect(taskProgressIsIndeterminate(value)).toBe(false);
    expect(taskProgressLabel(value)).toBe("Validation");
    expect(taskProgressValue(value)).toBe("Validation · 3 / 4 · 75%");
    expect(taskProgressNote(value)).toBeNull();
  });

  it("marks live Agent and inferred work as indeterminate without inventing a percent", () => {
    const agent = task();
    expect(taskProgressPercent(agent)).toBeNull();
    expect(taskProgressIsIndeterminate(agent)).toBe(true);
    expect(taskProgressLabel(agent)).toBe("Awaiting progress update");
    expect(taskProgressNote(agent)).toContain("has not reported");

    const inferred = task({
      source: "inferred",
      agent: { ...agent.agent, id: null, presence: "unknown" },
    });
    expect(taskProgressIsIndeterminate(inferred)).toBe(true);
    expect(taskProgressLabel(inferred)).toContain("Live activity");
  });

  it("fails closed for partial, negative and over-total progress", () => {
    for (const progress of [
      { current: 1, total: null, label: null },
      { current: -1, total: 10, label: null },
      { current: 11, total: 10, label: null },
    ]) {
      const value = task({ progress });
      expect(taskProgressPercent(value)).toBeNull();
      expect(taskProgressIsInvalid(value)).toBe(true);
      expect(taskProgressIsIndeterminate(value)).toBe(false);
      expect(taskProgressLabel(value)).toBe("Progress data invalid");
      expect(taskProgressNote(value)).toContain("inconsistent");
    }
  });

  it("does not animate inactive work with missing progress", () => {
    const value = task({ status: "succeeded" });
    expect(taskProgressIsIndeterminate(value)).toBe(false);
    expect(taskProgressLabel(value)).toBe("Progress not reported");
  });
});
