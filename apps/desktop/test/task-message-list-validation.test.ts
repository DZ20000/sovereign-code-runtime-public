import { describe, expect, it } from "vitest";

import type { DesktopTaskMessage, DesktopTaskSummary } from "../src/shared.js";
import { validateTaskMessagePage } from "../src/renderer/task-message-list.js";

function message(id: string, sequence: number): DesktopTaskMessage {
  return {
    id,
    taskId: "task-1",
    sequence,
    role: "assistant",
    content: `Message ${id}`,
    createdAt: "2026-08-29T00:00:00.000Z",
    acknowledgedAt: null,
    agentId: "agent-1",
    agentName: "Agent",
  } as DesktopTaskMessage;
}

function task(
  messageCount: number,
): Pick<DesktopTaskSummary, "id" | "messageCount"> {
  return { id: "task-1", messageCount };
}

describe("task message page validation", () => {
  it("accepts complete and explicitly truncated ordered pages", () => {
    expect(() =>
      validateTaskMessagePage(
        [message("a", 1), message("b", 2)],
        task(2),
        false,
      ),
    ).not.toThrow();
    expect(() =>
      validateTaskMessagePage([message("b", 2)], task(2), true),
    ).not.toThrow();
  });

  it("rejects duplicate IDs and non-increasing sequences", () => {
    expect(() =>
      validateTaskMessagePage(
        [message("a", 1), message("a", 2)],
        task(2),
        false,
      ),
    ).toThrow("duplicated or omitted a message ID");
    expect(() =>
      validateTaskMessagePage(
        [message("a", 2), message("b", 2)],
        task(2),
        false,
      ),
    ).toThrow("strictly increasing sequence order");
    expect(() =>
      validateTaskMessagePage(
        [message("a", 2), message("b", 1)],
        task(2),
        false,
      ),
    ).toThrow("strictly increasing sequence order");
  });

  it("rejects messages returned for another task", () => {
    expect(() =>
      validateTaskMessagePage(
        [{ ...message("a", 1), taskId: "task-2" }],
        task(1),
        false,
      ),
    ).toThrow("another task");
  });

  it("rejects invalid sequence and count metadata", () => {
    expect(() =>
      validateTaskMessagePage([message("a", -1)], task(1), false),
    ).toThrow("invalid sequence");
    expect(() => validateTaskMessagePage([], task(-1), false)).toThrow(
      "invalid message count",
    );
    expect(() =>
      validateTaskMessagePage(
        [message("a", 1), message("b", 2)],
        task(1),
        false,
      ),
    ).toThrow("more messages than its declared total");
  });

  it("requires truncation metadata to match the declared total", () => {
    expect(() =>
      validateTaskMessagePage([message("a", 1)], task(2), false),
    ).toThrow("inconsistent message truncation metadata");
    expect(() =>
      validateTaskMessagePage([message("a", 1)], task(1), true),
    ).toThrow("inconsistent message truncation metadata");
  });
});
