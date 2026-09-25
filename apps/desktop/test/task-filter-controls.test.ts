import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TASK_FILTER_SEARCH_DEBOUNCE_MS,
  TaskFilterControls,
  hasActiveTaskFilters,
  normalizeTaskSearchQuery,
  type TaskFilterState,
} from "../src/renderer/task-filter-controls.js";

class FakeValueControl extends EventTarget {
  value = "";
}

class FakeButton extends EventTarget {
  disabled = false;
}

function inputEvent(isComposing = false): Event {
  const event = new Event("input");
  Object.defineProperty(event, "isComposing", { value: isComposing });
  return event;
}

function keyboardEvent(key: string): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  return event;
}

function fixture(
  initialState: TaskFilterState = { searchQuery: "", category: "all" },
) {
  const searchInput = new FakeValueControl();
  const categorySelect = new FakeValueControl();
  const clearButton = new FakeButton();
  const changes: TaskFilterState[] = [];
  const controls = new TaskFilterControls({
    searchInput: searchInput as unknown as HTMLInputElement,
    categorySelect: categorySelect as unknown as HTMLSelectElement,
    clearButton: clearButton as unknown as HTMLButtonElement,
    initialState,
    onChange: (state) => changes.push(state),
  });
  controls.mount();
  return { searchInput, categorySelect, clearButton, changes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("task filter controls", () => {
  it("normalizes search input for stable matching and session persistence", () => {
    expect(normalizeTaskSearchQuery("  Agent HEARTBEAT  ")).toBe(
      "agent heartbeat",
    );
    expect(normalizeTaskSearchQuery("   ")).toBe("");
    expect(normalizeTaskSearchQuery("Q".repeat(300))).toHaveLength(256);
  });

  it("reports active search and category filters independently", () => {
    expect(hasActiveTaskFilters({ searchQuery: "", category: "all" })).toBe(
      false,
    );
    expect(
      hasActiveTaskFilters({ searchQuery: "runtime", category: "all" }),
    ).toBe(true);
    expect(
      hasActiveTaskFilters({ searchQuery: "", category: "maintenance" }),
    ).toBe(true);
  });

  it("coalesces rapid ordinary search input into one bounded publication", () => {
    vi.useFakeTimers();
    const { searchInput, clearButton, changes } = fixture();

    searchInput.value = "r";
    searchInput.dispatchEvent(inputEvent());
    searchInput.value = "ru";
    searchInput.dispatchEvent(inputEvent());
    searchInput.value = "runtime";
    searchInput.dispatchEvent(inputEvent());

    expect(clearButton.disabled).toBe(false);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(TASK_FILTER_SEARCH_DEBOUNCE_MS - 1);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([{ searchQuery: "runtime", category: "all" }]);

    searchInput.value = "  RUNTIME  ";
    searchInput.dispatchEvent(inputEvent());
    vi.advanceTimersByTime(TASK_FILTER_SEARCH_DEBOUNCE_MS);
    expect(changes).toHaveLength(1);
  });

  it("suppresses intermediate IME text and publishes composition completion immediately", () => {
    vi.useFakeTimers();
    const { searchInput, changes } = fixture();

    searchInput.dispatchEvent(new Event("compositionstart"));
    searchInput.value = "に";
    searchInput.dispatchEvent(inputEvent(true));
    searchInput.value = "日本";
    searchInput.dispatchEvent(inputEvent(true));
    vi.advanceTimersByTime(TASK_FILTER_SEARCH_DEBOUNCE_MS * 2);
    expect(changes).toEqual([]);

    searchInput.dispatchEvent(new Event("compositionend"));
    expect(changes).toEqual([{ searchQuery: "日本", category: "all" }]);

    searchInput.dispatchEvent(inputEvent(false));
    vi.advanceTimersByTime(TASK_FILTER_SEARCH_DEBOUNCE_MS);
    expect(changes).toHaveLength(1);
  });

  it("applies category changes, clearing and Escape immediately", () => {
    vi.useFakeTimers();
    const first = fixture({ searchQuery: "runtime", category: "all" });

    first.searchInput.dispatchEvent(new Event("compositionstart"));
    first.searchInput.value = "运行";
    first.searchInput.dispatchEvent(inputEvent(true));
    first.categorySelect.value = "maintenance";
    first.categorySelect.dispatchEvent(new Event("change"));
    expect(first.changes).toEqual([
      { searchQuery: "runtime", category: "maintenance" },
    ]);

    first.clearButton.dispatchEvent(new Event("click"));
    expect(first.changes.at(-1)).toEqual({ searchQuery: "", category: "all" });
    expect(first.clearButton.disabled).toBe(true);

    const second = fixture({ searchQuery: "agent", category: "all" });
    const escape = keyboardEvent("Escape");
    second.searchInput.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(second.changes).toEqual([{ searchQuery: "", category: "all" }]);
  });
});
