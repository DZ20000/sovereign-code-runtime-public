const TASK_CARD_SELECTOR = ".task-summary-card[data-task-id]";

interface RectLike {
  readonly top: number;
  readonly bottom: number;
}

export interface TaskListScrollAnchorSnapshot {
  readonly taskId: string | null;
  readonly offset: number | null;
  readonly scrollTop: number;
}

export function firstVisibleTaskIndex(
  taskRects: readonly RectLike[],
  viewport: RectLike,
): number | null {
  const index = taskRects.findIndex(
    (rect) => rect.bottom > viewport.top && rect.top < viewport.bottom,
  );
  return index < 0 ? null : index;
}

export function anchoredTaskListScrollTop(options: {
  readonly previousScrollTop: number;
  readonly previousOffset: number | null;
  readonly nextOffset: number | null;
  readonly maximumScrollTop: number;
}): number {
  const desired =
    options.previousOffset === null || options.nextOffset === null
      ? options.previousScrollTop
      : options.previousScrollTop + options.nextOffset - options.previousOffset;
  return Math.min(Math.max(0, desired), Math.max(0, options.maximumScrollTop));
}

export interface TaskListScrollAnchorOptions {
  readonly container: HTMLElement;
  readonly scroller: HTMLElement;
}

export class TaskListScrollAnchor {
  readonly #container: HTMLElement;
  readonly #scroller: HTMLElement;

  constructor(options: TaskListScrollAnchorOptions) {
    this.#container = options.container;
    this.#scroller = options.scroller;
  }

  capture(): TaskListScrollAnchorSnapshot {
    const cards = this.#cards();
    const viewport = this.#scroller.getBoundingClientRect();
    const index = firstVisibleTaskIndex(
      cards.map((card) => card.getBoundingClientRect()),
      viewport,
    );
    const card = index === null ? null : (cards[index] ?? null);
    return {
      taskId: card?.dataset.taskId ?? null,
      offset:
        card === null ? null : card.getBoundingClientRect().top - viewport.top,
      scrollTop: this.#scroller.scrollTop,
    };
  }

  restore(snapshot: TaskListScrollAnchorSnapshot): void {
    const card =
      snapshot.taskId === null
        ? null
        : (this.#cards().find(
            (candidate) => candidate.dataset.taskId === snapshot.taskId,
          ) ?? null);
    const viewportTop = this.#scroller.getBoundingClientRect().top;
    const nextOffset =
      card === null ? null : card.getBoundingClientRect().top - viewportTop;
    this.#scroller.scrollTop = anchoredTaskListScrollTop({
      previousScrollTop: snapshot.scrollTop,
      previousOffset: snapshot.offset,
      nextOffset,
      maximumScrollTop:
        this.#scroller.scrollHeight - this.#scroller.clientHeight,
    });
  }

  #cards(): HTMLButtonElement[] {
    return [
      ...this.#container.querySelectorAll<HTMLButtonElement>(
        TASK_CARD_SELECTOR,
      ),
    ];
  }
}
