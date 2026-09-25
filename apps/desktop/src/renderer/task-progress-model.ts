import type {
  DesktopTaskListItem,
  DesktopTaskStatus,
  DesktopTaskSummary,
} from "../shared.js";

type ProgressTask =
  | Pick<DesktopTaskListItem, "progress" | "source" | "status" | "agent">
  | Pick<DesktopTaskSummary, "progress" | "source" | "status" | "agent">;

type ProgressState =
  | { readonly kind: "numeric"; readonly percent: number }
  | { readonly kind: "unreported" }
  | { readonly kind: "invalid" };

const ACTIVE_STATUSES = new Set<DesktopTaskStatus>([
  "queued",
  "planning",
  "running",
]);

function progressState(task: ProgressTask): ProgressState {
  const { current, total } = task.progress;
  if (current === null && total === null) return { kind: "unreported" };
  if (current === null || total === null) return { kind: "invalid" };
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(total) ||
    current < 0 ||
    total < 0
  ) {
    return { kind: "invalid" };
  }
  if (current === 0 && total === 0) return { kind: "unreported" };
  if (total === 0 || current > total) return { kind: "invalid" };
  return {
    kind: "numeric",
    percent: Math.round((current / total) * 100),
  };
}

export function taskProgressPercent(task: ProgressTask): number | null {
  const state = progressState(task);
  return state.kind === "numeric" ? state.percent : null;
}

export function taskProgressIsInvalid(task: ProgressTask): boolean {
  return progressState(task).kind === "invalid";
}

export function taskProgressIsIndeterminate(task: ProgressTask): boolean {
  if (
    progressState(task).kind !== "unreported" ||
    !ACTIVE_STATUSES.has(task.status)
  ) {
    return false;
  }
  return (
    task.source === "inferred" ||
    (task.agent.id !== null && task.agent.presence === "online")
  );
}

export function taskProgressLabel(task: ProgressTask): string {
  const state = progressState(task);
  if (state.kind === "invalid") return "Progress data invalid";
  if (task.progress.label !== null) return task.progress.label;
  if (state.kind === "numeric") return "Task progress";
  if (taskProgressIsIndeterminate(task)) {
    return task.source === "inferred"
      ? "Live activity · structured progress not reported"
      : "Awaiting progress update";
  }
  return "Progress not reported";
}

export function taskProgressValue(task: ProgressTask): string {
  const state = progressState(task);
  if (state.kind !== "numeric") return taskProgressLabel(task);
  const value = `${task.progress.current} / ${task.progress.total} · ${state.percent}%`;
  return task.progress.label === null
    ? value
    : `${task.progress.label} · ${value}`;
}

export function taskProgressNote(task: ProgressTask): string | null {
  const state = progressState(task);
  if (state.kind === "invalid") {
    return "Reported progress is inconsistent and is not shown as a percentage.";
  }
  if (!taskProgressIsIndeterminate(task)) return null;
  return task.source === "inferred"
    ? "This task is inferred from tool activity. Percentage and steps appear when an Agent reports structured progress."
    : "The Agent has not reported a current step or total yet.";
}
