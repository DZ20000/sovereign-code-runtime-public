import { describe, expect, it } from "vitest";

import type { DesktopTaskDetail } from "../src/shared.js";
import { validateTaskStepList } from "../src/renderer/task-step-integrity.js";

type TaskStep = DesktopTaskDetail["task"]["steps"][number];

function step(
  id: string,
  status: string,
  overrides: Partial<TaskStep> = {},
): TaskStep {
  return {
    id,
    status,
    title: `Step ${id}`,
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  } as TaskStep;
}

describe("task step integrity", () => {
  it("accepts every supported state in one serial task plan", () => {
    expect(() =>
      validateTaskStepList([
        step("one", "succeeded"),
        step("two", "running"),
        step("three", "pending"),
        step("four", "failed"),
        step("five", "skipped"),
      ]),
    ).not.toThrow();
    expect(() => validateTaskStepList([])).not.toThrow();
  });

  it("rejects missing and duplicate identities", () => {
    expect(() => validateTaskStepList([step("", "pending")])).toThrow(
      "non-empty identity",
    );
    expect(() =>
      validateTaskStepList([
        step("duplicate", "pending"),
        step("duplicate", "succeeded"),
      ]),
    ).toThrow("duplicated step duplicate");
  });

  it("rejects empty titles and unsupported states", () => {
    expect(() =>
      validateTaskStepList([
        step("one", "pending", { title: "  " }),
      ]),
    ).toThrow("non-empty title");
    expect(() =>
      validateTaskStepList([step("one", "invented")]),
    ).toThrow("unsupported status invented");
  });

  it.each(["", "not-a-date"])(
    "rejects an invalid update timestamp: %s",
    (updatedAt) => {
      expect(() =>
        validateTaskStepList([
          step("one", "pending", { updatedAt }),
        ]),
      ).toThrow("invalid update timestamp");
    },
  );

  it("rejects concurrent running steps", () => {
    expect(() =>
      validateTaskStepList([
        step("one", "running"),
        step("two", "running"),
      ]),
    ).toThrow("more than one running step");
  });
});
