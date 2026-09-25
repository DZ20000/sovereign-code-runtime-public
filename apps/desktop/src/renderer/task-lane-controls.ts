import type { TaskBoardLane } from "./task-board-model.js";

export const TASK_BOARD_LANES = [
  "current",
  "attention",
  "history",
  "activity",
  "all",
] as const satisfies readonly TaskBoardLane[];

const TASK_BOARD_LANE_SET = new Set<string>(TASK_BOARD_LANES);

export interface TaskLaneControlsOptions {
  readonly buttons: readonly HTMLButtonElement[];
  readonly initialLane: TaskBoardLane;
  readonly onChange: (lane: TaskBoardLane) => void;
}

export function taskBoardLaneFromValue(
  value: string | undefined,
): TaskBoardLane | null {
  return value !== undefined && TASK_BOARD_LANE_SET.has(value)
    ? (value as TaskBoardLane)
    : null;
}

export function nextTaskLaneIndex(
  currentIndex: number,
  buttonCount: number,
  key: string,
): number | null {
  if (buttonCount <= 0 || currentIndex < 0 || currentIndex >= buttonCount) {
    return null;
  }
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (currentIndex + 1) % buttonCount;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (currentIndex - 1 + buttonCount) % buttonCount;
  }
  if (key === "Home") return 0;
  if (key === "End") return buttonCount - 1;
  return null;
}

export class TaskLaneControls {
  readonly #buttons: readonly HTMLButtonElement[];
  readonly #onChange: (lane: TaskBoardLane) => void;
  #activeLane: TaskBoardLane;
  #mounted = false;

  constructor(options: TaskLaneControlsOptions) {
    this.#buttons = options.buttons;
    this.#onChange = options.onChange;
    this.#activeLane = options.initialLane;
    const lanes = this.#buttons.map((button) =>
      taskBoardLaneFromValue(button.dataset.lane),
    );
    if (
      lanes.some((lane) => lane === null) ||
      new Set(lanes).size !== TASK_BOARD_LANES.length ||
      lanes.length !== TASK_BOARD_LANES.length
    ) {
      throw new Error(
        "Task lane controls require one button for every trusted board lane.",
      );
    }
  }

  mount(): void {
    if (this.#mounted) return;
    this.#mounted = true;
    for (const button of this.#buttons) {
      button.addEventListener("click", () => this.#activate(button));
      button.addEventListener("keydown", (event) => {
        const nextIndex = nextTaskLaneIndex(
          this.#buttons.indexOf(button),
          this.#buttons.length,
          event.key,
        );
        if (nextIndex === null) return;
        const nextButton = this.#buttons[nextIndex];
        if (nextButton === undefined) return;
        event.preventDefault();
        nextButton.focus();
        this.#activate(nextButton);
      });
    }
    this.#sync();
  }

  setActiveLane(lane: TaskBoardLane): void {
    this.#activeLane = lane;
    this.#sync();
  }

  #activate(button: HTMLButtonElement): void {
    const lane = taskBoardLaneFromValue(button.dataset.lane);
    if (lane === null) return;
    const changed = lane !== this.#activeLane;
    this.#activeLane = lane;
    this.#sync();
    if (changed) this.#onChange(lane);
  }

  #sync(): void {
    for (const button of this.#buttons) {
      const selected = button.dataset.lane === this.#activeLane;
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("is-selected", selected);
      button.tabIndex = selected ? 0 : -1;
    }
  }
}
