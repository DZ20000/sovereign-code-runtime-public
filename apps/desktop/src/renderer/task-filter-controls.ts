import { TASK_HUB_SESSION_MAX_SEARCH_LENGTH } from "./task-hub-session.js";

export const TASK_FILTER_SEARCH_DEBOUNCE_MS = 120;

export interface TaskFilterState {
  readonly searchQuery: string;
  readonly category: string;
}

export interface TaskFilterControlsOptions {
  readonly searchInput: HTMLInputElement;
  readonly categorySelect: HTMLSelectElement;
  readonly clearButton: HTMLButtonElement;
  readonly initialState: TaskFilterState;
  readonly onChange: (state: TaskFilterState) => void;
}

export function normalizeTaskSearchQuery(value: string): string {
  return value
    .trim()
    .slice(0, TASK_HUB_SESSION_MAX_SEARCH_LENGTH)
    .toLowerCase();
}

export function hasActiveTaskFilters(state: TaskFilterState): boolean {
  return state.searchQuery.length > 0 || state.category !== "all";
}

function sameTaskFilterState(
  left: TaskFilterState,
  right: TaskFilterState,
): boolean {
  return (
    left.searchQuery === right.searchQuery && left.category === right.category
  );
}

function eventIsComposing(event: Event): boolean {
  return (
    (event as Event & { readonly isComposing?: boolean }).isComposing === true
  );
}

export class TaskFilterControls {
  readonly #searchInput: HTMLInputElement;
  readonly #categorySelect: HTMLSelectElement;
  readonly #clearButton: HTMLButtonElement;
  readonly #onChange: (state: TaskFilterState) => void;
  #publishedState: TaskFilterState;
  #searchPublishTimer: ReturnType<typeof setTimeout> | null = null;
  #isComposing = false;
  #mounted = false;

  constructor(options: TaskFilterControlsOptions) {
    this.#searchInput = options.searchInput;
    this.#categorySelect = options.categorySelect;
    this.#clearButton = options.clearButton;
    this.#onChange = options.onChange;
    this.#searchInput.value = options.initialState.searchQuery;
    this.#categorySelect.value = options.initialState.category;
    this.#publishedState = {
      searchQuery: normalizeTaskSearchQuery(options.initialState.searchQuery),
      category: options.initialState.category || "all",
    };
    this.#syncClearButton();
  }

  mount(): void {
    if (this.#mounted) return;
    this.#mounted = true;
    this.#searchInput.addEventListener("compositionstart", () => {
      this.#isComposing = true;
      this.#cancelSearchPublish();
      this.#syncClearButton();
    });
    this.#searchInput.addEventListener("compositionend", () => {
      this.#isComposing = false;
      this.#cancelSearchPublish();
      this.#publish();
    });
    this.#searchInput.addEventListener("input", (event) => {
      this.#syncClearButton();
      if (this.#isComposing || eventIsComposing(event)) {
        this.#cancelSearchPublish();
        return;
      }
      this.#scheduleSearchPublish();
    });
    this.#searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.#searchInput.value.length === 0) {
        return;
      }
      event.preventDefault();
      this.#isComposing = false;
      this.#cancelSearchPublish();
      this.#searchInput.value = "";
      this.#publish();
    });
    this.#categorySelect.addEventListener("change", () => {
      this.#cancelSearchPublish();
      this.#publish(this.#isComposing);
    });
    this.#clearButton.addEventListener("click", () => this.clear());
  }

  clear(): void {
    if (!hasActiveTaskFilters(this.#domState())) return;
    this.#isComposing = false;
    this.#cancelSearchPublish();
    this.#searchInput.value = "";
    this.#categorySelect.value = "all";
    this.#publish();
  }

  #domState(): TaskFilterState {
    return {
      searchQuery: normalizeTaskSearchQuery(this.#searchInput.value),
      category: this.#categorySelect.value || "all",
    };
  }

  #stateForPublish(preservePublishedSearch: boolean): TaskFilterState {
    const state = this.#domState();
    return preservePublishedSearch
      ? {
          searchQuery: this.#publishedState.searchQuery,
          category: state.category,
        }
      : state;
  }

  #syncClearButton(): void {
    this.#clearButton.disabled = !hasActiveTaskFilters(this.#domState());
  }

  #publish(preservePublishedSearch = false): void {
    const state = this.#stateForPublish(preservePublishedSearch);
    this.#syncClearButton();
    if (sameTaskFilterState(state, this.#publishedState)) return;
    this.#publishedState = state;
    this.#onChange(state);
  }

  #scheduleSearchPublish(): void {
    this.#cancelSearchPublish();
    this.#searchPublishTimer = setTimeout(() => {
      this.#searchPublishTimer = null;
      this.#publish();
    }, TASK_FILTER_SEARCH_DEBOUNCE_MS);
  }

  #cancelSearchPublish(): void {
    if (this.#searchPublishTimer === null) return;
    clearTimeout(this.#searchPublishTimer);
    this.#searchPublishTimer = null;
  }
}
