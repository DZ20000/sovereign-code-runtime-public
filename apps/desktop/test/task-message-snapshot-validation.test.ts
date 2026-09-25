import { describe, expect, it } from "vitest";

import type { DesktopTaskMessage } from "../src/shared.js";
import { validateTaskMessageSnapshot } from "../src/renderer/task-message-list.js";

function message(
  id: string,
  sequence: number,
  taskId = "task-1",
): DesktopTaskMessage {
  return {
    id,
    taskId,
    sequence,
    role: "user",
    content: `Message ${sequence}`,
    createdAt: "2026-08-29T00:00:00.000Z",
  } as DesktopTaskMessage;
}

describe("task message snapshot validation", () => {
  it("accepts complete and explicitly truncated ordered snapshots", () => {
    expect(() =>
      validateTaskMessageSnapshot(
        [message("a", 1), message("b", 2)],
        "task-1",
        2,
        false,
      ),
    ).not.toThrow();
    expect(() =>
      validateTaskMessageSnapshot(
        [message("b", 8), message("c", 9)],
        "task-1",
        9,
        true,
      ),
    ).not.toThrow();
  });

  it("rejects duplicate identities and non-increasing sequences", () => {
    expect(() =>
      validateTaskMessageSnapshot(
        [message("a", 1), message("a", 2)],
        "task-1",
        2,
        false,
      ),
    ).toThrow("duplicated message a");
    expect(() =>
      validateTaskMessageSnapshot(
        [message("a", 2), message("b", 2)],
        "task-1",
        2,
        false,
      ),
    ).toThrow("increase strictly");
    expect(() =>
      validateTaskMessageSnapshot(
        [message("a", 2), message("b", 1)],
        "task-1",
        2,
        false,
      ),
    ).toThrow("increase strictly");
  });

  it("fails closed on invalid, incomplete or cross-task metadata", () => {
    expect(() => validateTaskMessageSnapshot([], "task-1", -1, false)).toThrow(
      "count is invalid",
    );
    expect(() =>
      validateTaskMessageSnapshot([message("a", 1)], "task-1", 0, false),
    ).toThrow("exceeds its declared message count");
    expect(() =>
      validateTaskMessageSnapshot([message("a", 1)], "task-1", 2, false),
    ).toThrow("incomplete without truncation metadata");
    expect(() =>
      validateTaskMessageSnapshot([message("a", 1)], "task-1", 1, true),
    ).toThrow("inconsistent truncation metadata");
    expect(() =>
      validateTaskMessageSnapshot(
        [message("a", 1, "task-2")],
        "task-1",
        1,
        false,
      ),
    ).toThrow("belongs to another task");
  });
});
