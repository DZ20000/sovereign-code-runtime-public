import type { DesktopTaskDetail } from "../shared.js";

type TaskStep = DesktopTaskDetail["task"]["steps"][number];

const TASK_STEP_STATUSES = new Set<string>([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export function validateTaskStepList(steps: readonly TaskStep[]): void {
  const ids = new Set<string>();
  let runningCount = 0;

  for (const step of steps) {
    if (typeof step.id !== "string" || step.id.trim().length === 0) {
      throw new Error("Task steps must use a non-empty identity.");
    }
    if (ids.has(step.id)) {
      throw new Error(`Task step list duplicated step ${step.id}.`);
    }
    ids.add(step.id);

    if (typeof step.title !== "string" || step.title.trim().length === 0) {
      throw new Error(`Task step ${step.id} must use a non-empty title.`);
    }
    if (!TASK_STEP_STATUSES.has(step.status)) {
      throw new Error(
        `Task step ${step.id} uses unsupported status ${String(step.status)}.`,
      );
    }
    if (
      typeof step.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(step.updatedAt))
    ) {
      throw new Error(`Task step ${step.id} has an invalid update timestamp.`);
    }
    if (step.status === "running") runningCount += 1;
  }

  if (runningCount > 1) {
    throw new Error(
      "Task step list cannot contain more than one running step.",
    );
  }
}
