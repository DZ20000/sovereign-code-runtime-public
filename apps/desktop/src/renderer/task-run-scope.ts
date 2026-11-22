import type { DesktopRunBase } from "../shared.js";

type TaskScopedRun = Pick<DesktopRunBase, "metadata"> & { readonly taskId?: unknown };

function explicitId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

/** Only producer-supplied identifiers associate a run with a task. */
export function runTaskId(run: TaskScopedRun): string | null {
  const direct = explicitId(run.taskId);
  const metadata = explicitId(run.metadata.taskId);
  if (direct !== null && metadata !== null && direct !== metadata) return null;
  return direct ?? metadata;
}

export function runsInTaskScope<T extends TaskScopedRun>(runs: readonly T[], taskId: string | null): readonly T[] {
  return taskId === null ? runs : runs.filter((run) => runTaskId(run) === taskId);
}
