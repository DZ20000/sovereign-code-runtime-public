import type { DesktopTaskSummary } from "../shared.js";
import { validateTaskStepList } from "./task-step-integrity.js";

type TaskStep = DesktopTaskSummary["steps"][number];

export interface TaskStepListOptions {
  readonly container: HTMLElement;
  readonly steps: readonly TaskStep[];
  readonly inferred: boolean;
  readonly elapsedLabel: (value: string | null) => string;
}

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function sourceText<T extends HTMLElement>(element: T): T {
  element.setAttribute("data-no-i18n", "");
  return element;
}

function createStepRow(document: Document): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("role", "listitem");
  const marker = document.createElement("span");
  marker.className = "task-step-marker";
  const identity = document.createElement("div");
  identity.className = "task-step-copy";
  const title = sourceText(document.createElement("strong"));
  title.className = "task-step-title";
  const updated = document.createElement("span");
  updated.className = "task-step-updated";
  identity.append(title, updated);
  const state = document.createElement("span");
  state.className = "task-step-state";
  row.append(marker, identity, state);
  return row;
}

function requiredChild<T extends HTMLElement>(
  row: HTMLElement,
  selector: string,
): T {
  const child = row.querySelector<T>(selector);
  if (child === null) {
    throw new Error(`Task step row is missing ${selector}.`);
  }
  return child;
}

function updateStepRow(
  row: HTMLElement,
  step: TaskStep,
  elapsedLabel: TaskStepListOptions["elapsedLabel"],
): void {
  row.dataset.stepId = step.id;
  const className = `task-step task-step-${step.status}`;
  if (row.className !== className) row.className = className;
  setText(
    sourceText(requiredChild<HTMLElement>(row, ".task-step-title")),
    step.title,
  );
  setText(
    requiredChild<HTMLElement>(row, ".task-step-updated"),
    `Updated ${elapsedLabel(step.updatedAt)}`,
  );
  setText(requiredChild<HTMLElement>(row, ".task-step-state"), step.status);
}

export function reconcileTaskStepList(options: TaskStepListOptions): void {
  const { container, steps, inferred, elapsedLabel } = options;
  validateTaskStepList(steps);

  if (steps.length === 0) {
    let empty = container.querySelector<HTMLElement>(
      ":scope > .task-detail-empty",
    );
    for (const child of [...container.children]) {
      if (child !== empty) child.remove();
    }
    if (empty === null) {
      empty = container.ownerDocument.createElement("div");
      empty.className = "task-detail-empty";
      container.append(empty);
    }
    setText(
      empty,
      inferred
        ? "No step plan. This activity has not been claimed by an Agent."
        : "The Agent has not published a step plan.",
    );
    return;
  }

  container.querySelector(":scope > .task-detail-empty")?.remove();
  const existing = new Map(
    [
      ...container.querySelectorAll<HTMLElement>(
        ":scope > .task-step[data-step-id]",
      ),
    ].map((row) => [row.dataset.stepId ?? "", row] as const),
  );
  const desired: HTMLElement[] = [];
  for (const step of steps) {
    const row = existing.get(step.id) ?? createStepRow(container.ownerDocument);
    existing.delete(step.id);
    updateStepRow(row, step, elapsedLabel);
    desired.push(row);
  }
  for (const row of existing.values()) row.remove();

  const desiredSet = new Set(desired);
  for (const child of [...container.children]) {
    if (!desiredSet.has(child as HTMLElement)) child.remove();
  }

  let cursor = container.firstElementChild;
  for (const row of desired) {
    if (row === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      container.insertBefore(row, cursor);
    }
  }
}
