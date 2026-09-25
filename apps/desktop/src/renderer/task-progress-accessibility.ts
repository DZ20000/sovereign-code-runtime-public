interface ProgressbarTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface TaskProgressAccessibility {
  readonly label: string | null | undefined;
  readonly percent: number | null;
  readonly valueText: string;
}

export function taskProgressAccessibleLabel(
  label: string | null | undefined,
): string {
  const normalized = label?.trim() ?? "";
  return normalized.length > 0 ? normalized : "Task progress";
}

export function applyTaskProgressAccessibility(
  target: ProgressbarTarget,
  progress: TaskProgressAccessibility,
): void {
  target.setAttribute("role", "progressbar");
  target.setAttribute(
    "aria-label",
    taskProgressAccessibleLabel(progress.label),
  );
  target.setAttribute("aria-valuemin", "0");
  target.setAttribute("aria-valuemax", "100");
  target.setAttribute("aria-valuetext", progress.valueText);
  if (progress.percent === null) {
    target.removeAttribute("aria-valuenow");
    return;
  }
  const value = Math.max(0, Math.min(100, Math.round(progress.percent)));
  target.setAttribute("aria-valuenow", String(value));
}
