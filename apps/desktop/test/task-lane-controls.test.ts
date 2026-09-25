import { describe, expect, it } from "vitest";

import {
  nextTaskLaneIndex,
  taskBoardLaneFromValue,
} from "../src/renderer/task-lane-controls.js";

describe("task lane controls", () => {
  it("accepts only trusted board lane values", () => {
    for (const lane of [
      "current",
      "attention",
      "history",
      "activity",
      "all",
    ] as const) {
      expect(taskBoardLaneFromValue(lane)).toBe(lane);
    }
    expect(taskBoardLaneFromValue(undefined)).toBeNull();
    expect(taskBoardLaneFromValue("unknown")).toBeNull();
  });

  it("wraps directional navigation in DOM order", () => {
    expect(nextTaskLaneIndex(0, 5, "ArrowRight")).toBe(1);
    expect(nextTaskLaneIndex(4, 5, "ArrowRight")).toBe(0);
    expect(nextTaskLaneIndex(0, 5, "ArrowLeft")).toBe(4);
    expect(nextTaskLaneIndex(2, 5, "ArrowUp")).toBe(1);
    expect(nextTaskLaneIndex(2, 5, "ArrowDown")).toBe(3);
  });

  it("supports Home and End and rejects invalid requests", () => {
    expect(nextTaskLaneIndex(3, 5, "Home")).toBe(0);
    expect(nextTaskLaneIndex(1, 5, "End")).toBe(4);
    expect(nextTaskLaneIndex(0, 5, "Enter")).toBeNull();
    expect(nextTaskLaneIndex(-1, 5, "ArrowRight")).toBeNull();
    expect(nextTaskLaneIndex(5, 5, "ArrowLeft")).toBeNull();
    expect(nextTaskLaneIndex(0, 0, "Home")).toBeNull();
  });
});
