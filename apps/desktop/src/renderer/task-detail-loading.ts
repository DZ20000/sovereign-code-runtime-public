interface TaskDetailLoadingElement {
  hidden: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface TaskDetailLoadingDocument {
  getElementById(id: string): TaskDetailLoadingElement | null;
}

export type TaskDetailSnapshotState = "loading" | "ready" | "unavailable";

const STALE_REGION_IDS = [
  "task-detail-heading",
  "task-detail-heading-state",
  "task-detail-layout",
] as const;

function requiredElement(
  document: TaskDetailLoadingDocument,
  id: string,
): TaskDetailLoadingElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Required task detail loading element is missing: #${id}`);
  }
  return element;
}

export function setTaskDetailLoading(
  document: TaskDetailLoadingDocument,
  state: TaskDetailSnapshotState,
): void {
  const pane = requiredElement(document, "task-detail-pane");
  const indicator = requiredElement(document, "task-detail-loading");
  const freshness = requiredElement(document, "task-detail-freshness");
  const loading = state === "loading";
  const unavailable = state === "unavailable";

  if (loading) {
    pane.setAttribute("aria-busy", "true");
    pane.setAttribute("aria-labelledby", "task-detail-loading-label");
  } else {
    pane.removeAttribute("aria-busy");
    pane.setAttribute("aria-labelledby", "task-detail-title");
  }
  if (unavailable) {
    pane.setAttribute("aria-describedby", "task-detail-freshness");
  } else {
    pane.removeAttribute("aria-describedby");
  }
  indicator.hidden = !loading;
  freshness.hidden = !unavailable;
  for (const id of STALE_REGION_IDS) {
    requiredElement(document, id).hidden = loading;
  }
}
