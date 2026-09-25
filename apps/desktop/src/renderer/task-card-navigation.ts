const TASK_CARD_SELECTOR = ".task-summary-card[data-task-id]";

export type TaskCardNavigationKey =
  "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "Home" | "End";

export interface TaskCardNavigationOptions {
  readonly container: HTMLElement;
  readonly fallbackFocus: HTMLElement;
}

export function taskCardNavigationIndex(
  currentIndex: number,
  cardCount: number,
  key: string,
): number | null {
  if (cardCount <= 0 || currentIndex < 0 || currentIndex >= cardCount) {
    return null;
  }
  if (key === "Home") return currentIndex === 0 ? null : 0;
  if (key === "End") {
    const lastIndex = cardCount - 1;
    return currentIndex === lastIndex ? null : lastIndex;
  }
  if (key === "ArrowDown" || key === "ArrowRight") {
    return currentIndex + 1 < cardCount ? currentIndex + 1 : null;
  }
  if (key === "ArrowUp" || key === "ArrowLeft") {
    return currentIndex > 0 ? currentIndex - 1 : null;
  }
  return null;
}

export function taskCardIsNavigable(card: Pick<Element, "closest">): boolean {
  return card.closest("details:not([open])") === null;
}

export class TaskCardNavigation {
  readonly #container: HTMLElement;
  readonly #fallbackFocus: HTMLElement;
  #mounted = false;

  constructor(options: TaskCardNavigationOptions) {
    this.#container = options.container;
    this.#fallbackFocus = options.fallbackFocus;
  }

  mount(): void {
    if (this.#mounted) return;
    this.#mounted = true;
    this.#container.addEventListener("focusin", (event) => {
      const card = this.#cardFromTarget(event.target);
      if (card !== null) this.sync(card.dataset.taskId ?? null);
    });
    this.#container.addEventListener("keydown", (event) => {
      const card = this.#cardFromTarget(event.target);
      if (card === null) return;
      const cards = this.#cards();
      const nextIndex = taskCardNavigationIndex(
        cards.indexOf(card),
        cards.length,
        event.key,
      );
      if (nextIndex === null) return;
      const nextCard = cards[nextIndex];
      if (nextCard === undefined) return;
      event.preventDefault();
      this.#focusCard(nextCard);
    });
  }

  sync(preferredTaskId: string | null = null): HTMLButtonElement | null {
    const cards = this.#cards();
    if (cards.length === 0) return null;
    const activeElement = this.#container.ownerDocument.activeElement;
    const activeCard =
      activeElement instanceof HTMLButtonElement &&
      activeElement.matches(TASK_CARD_SELECTOR) &&
      this.#container.contains(activeElement)
        ? activeElement
        : null;
    const preferred =
      preferredTaskId === null
        ? null
        : (cards.find((card) => card.dataset.taskId === preferredTaskId) ??
          null);
    const target =
      preferred ??
      activeCard ??
      cards.find((card) => card.tabIndex === 0) ??
      cards[0] ??
      null;
    for (const card of cards) card.tabIndex = card === target ? 0 : -1;
    return target;
  }

  focus(taskId: string | null, fallbackWhenMissing: boolean): boolean {
    const cards = this.#cards();
    const target =
      taskId === null
        ? null
        : (cards.find((card) => card.dataset.taskId === taskId) ?? null);
    if (target !== null) {
      this.#focusCard(target);
      return true;
    }
    this.sync();
    if (fallbackWhenMissing) {
      this.#fallbackFocus.focus({ preventScroll: true });
    }
    return false;
  }

  #cards(): HTMLButtonElement[] {
    return [
      ...this.#container.querySelectorAll<HTMLButtonElement>(
        TASK_CARD_SELECTOR,
      ),
    ].filter(taskCardIsNavigable);
  }

  #cardFromTarget(target: EventTarget | null): HTMLButtonElement | null {
    if (!(target instanceof Element)) return null;
    const card = target.closest<HTMLButtonElement>(TASK_CARD_SELECTOR);
    return card !== null && this.#container.contains(card) ? card : null;
  }

  #focusCard(card: HTMLButtonElement): void {
    this.sync(card.dataset.taskId ?? null);
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
