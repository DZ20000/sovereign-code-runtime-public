export type TaskDetailTab = "conversation" | "steps" | "output";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing task panel: ${id}`);
  return found as T;
}

/** Presentation state only: task drafts and run ownership remain in their controllers. */
export class TaskDetailPanels {
  readonly #onScopeChanged: (taskId: string | null) => void;
  readonly #showHistory: () => void;
  readonly #showProjects: () => void;
  readonly #tabs = new Map<string, TaskDetailTab>();
  #taskId: string | null = null;

  constructor(onScopeChanged: (taskId: string | null) => void, showHistory: () => void, showProjects: () => void) {
    this.#onScopeChanged = onScopeChanged;
    this.#showHistory = showHistory;
    this.#showProjects = showProjects;
  }

  mount(): void {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-task-detail-tab]")];
    for (const button of buttons) {
      const activate = (): void => this.setDetailTab(button.dataset.taskDetailTab as TaskDetailTab);
      button.addEventListener("click", activate);
      button.addEventListener("keydown", (event) => {
        const index = buttons.indexOf(button);
        const next = event.key === "ArrowRight" ? (index + 1) % buttons.length
          : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length
          : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        const target = buttons[next];
        target?.focus();
        if (target) this.setDetailTab(target.dataset.taskDetailTab as TaskDetailTab);
      });
    }
    for (const id of ["task-show-all-runs", "run-scope-all"]) {
      element(id).addEventListener("click", this.#showHistory);
    }
    element("task-history-back").addEventListener("click", this.#showProjects);
    for (const id of ["task-steps-message", "run-back-conversation"]) {
      element(id).addEventListener("click", () => {
        this.setDetailTab("conversation");
        element("task-message-input").focus();
      });
    }
    element("task-steps-output").addEventListener("click", () => this.setDetailTab("output"));
    element("task-coordination-open").addEventListener("click", () => {
      element<HTMLDetailsElement>("task-coordination-panel").open = true;
    });
  }

  showTask(taskId: string): void {
    this.#taskId = taskId;
    element("task-run-history").hidden = true;
    element("task-run-output-slot").append(element("runs-workbench-root"));
    this.#onScopeChanged(taskId);
    this.setDetailTab(this.#tabs.get(taskId) ?? "conversation");
  }

  showList(): void {
    this.#taskId = null;
    element("task-run-history").hidden = true;
    this.#onScopeChanged(null);
  }

  showRunHistory(): void {
    this.#taskId = null;
    element("task-workbench-empty").hidden = true;
    element("task-detail-pane").hidden = true;
    element("task-run-history").hidden = false;
    element("task-run-history-slot").append(element("runs-workbench-root"));
    const shell = document.querySelector<HTMLElement>(".task-hub-shell");
    if (shell) shell.dataset.taskSelected = "true";
    this.#onScopeChanged(null);
    element("task-run-history-title").focus({ preventScroll: true });
  }

  setDetailTab(tab: TaskDetailTab): void {
    if (this.#taskId === null) return;
    this.#tabs.set(this.#taskId, tab);
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-task-detail-tab]")) {
      const selected = button.dataset.taskDetailTab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle("is-active", selected);
    }
    for (const panel of document.querySelectorAll<HTMLElement>("[data-task-detail-panel]")) {
      panel.hidden = panel.dataset.taskDetailPanel !== tab;
    }
  }
}
