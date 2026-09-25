import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { DesktopTaskSummary } from "../src/shared.js";
import { validateTaskStepList } from "../src/renderer/task-step-integrity.js";

type TaskStep = DesktopTaskSummary["steps"][number];

const source = (...parts: string[]): string =>
  readFileSync(join(process.cwd(), ...parts), "utf8");

function step(id: string, overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id,
    title: `Step ${id}`,
    status: "pending",
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  } as TaskStep;
}

describe("task step validator wiring", () => {
  it("uses one canonical implementation in both production paths", () => {
    const integrity = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-step-integrity.ts",
    );
    const list = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-step-list.ts",
    );
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );

    expect(
      [integrity, list, controller]
        .join("\n")
        .split("export function validateTaskStepList").length - 1,
    ).toBe(1);
    expect(list).toContain(
      'import { validateTaskStepList } from "./task-step-integrity.js";',
    );
    expect(list).toContain("validateTaskStepList(steps);");
    expect(list).not.toContain("export function validateTaskStepList");
    expect(controller).toContain(
      'import { validateTaskStepList } from "./task-step-integrity.js";',
    );
    expect(controller).toContain("validateTaskStepList(task.steps);");
    expect(controller).not.toContain(
      'validateTaskStepList,\n} from "./task-step-list.js";',
    );
  });

  it("retains timestamp validation in the canonical renderer boundary", () => {
    expect(() => validateTaskStepList([step("valid")])).not.toThrow();
    expect(() =>
      validateTaskStepList([
        step("invalid-time", { updatedAt: "not-a-date" }),
      ]),
    ).toThrow("invalid update timestamp");
  });
});
