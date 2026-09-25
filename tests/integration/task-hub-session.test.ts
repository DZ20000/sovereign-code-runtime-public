import { describe, expect, it } from "vitest";

import {
  TASK_HUB_SESSION_KEY,
  readTaskHubSessionState,
  writeTaskHubSessionState,
  type TaskHubStorage,
} from "../../apps/desktop/src/renderer/task-hub-session.js";

class MemoryStorage implements TaskHubStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("task hub session continuity", () => {
  it("round-trips the selected task, queue, filters and bounded drafts", () => {
    const storage = new MemoryStorage();
    writeTaskHubSessionState(storage, {
      selectedTaskId: "task-1",
      searchQuery: "agent recovery",
      laneFilter: "attention",
      categoryFilter: "development",
      messageDrafts: { "task-1": "Keep this draft" },
    });

    expect(readTaskHubSessionState(storage)).toEqual({
      selectedTaskId: "task-1",
      searchQuery: "agent recovery",
      laneFilter: "attention",
      categoryFilter: "development",
      messageDrafts: { "task-1": "Keep this draft" },
    });
  });

  it("migrates the previous status filter without restoring the unreliable all view", () => {
    const storage = new MemoryStorage();
    for (const [statusFilter, laneFilter] of [
      ["active", "current"],
      ["attention", "attention"],
      ["completed", "history"],
      ["all", "current"],
    ] as const) {
      storage.values.set(
        TASK_HUB_SESSION_KEY,
        JSON.stringify({ statusFilter, categoryFilter: "all" }),
      );
      expect(readTaskHubSessionState(storage).laneFilter).toBe(laneFilter);
    }
  });

  it("falls back safely for corrupt or unbounded session data", () => {
    const storage = new MemoryStorage();
    storage.values.set(TASK_HUB_SESSION_KEY, "not-json");
    expect(readTaskHubSessionState(storage)).toMatchObject({
      selectedTaskId: null,
      searchQuery: "",
      laneFilter: "current",
      categoryFilter: "all",
    });

    storage.values.set(
      TASK_HUB_SESSION_KEY,
      JSON.stringify({
        selectedTaskId: "x".repeat(129),
        searchQuery: "x".repeat(1_000),
        laneFilter: "invalid",
        statusFilter: "invalid",
        categoryFilter: "invalid",
        messageDrafts: {
          oversized: "x".repeat(8_001),
          __proto__: "must not mutate the result prototype",
          constructor: "must not shadow record construction",
          keep: "ok",
        },
      }),
    );
    const restored = readTaskHubSessionState(storage);
    expect(restored).toEqual({
      selectedTaskId: null,
      searchQuery: "",
      laneFilter: "current",
      categoryFilter: "all",
      messageDrafts: { keep: "ok" },
    });
    expect(Object.getPrototypeOf(restored.messageDrafts)).toBeNull();
    expect(Object.hasOwn(restored.messageDrafts, "__proto__")).toBe(false);
    expect(Object.hasOwn(restored.messageDrafts, "constructor")).toBe(false);
  });

  it("never lets storage failures block task operations", () => {
    const storage: TaskHubStorage = {
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("storage unavailable");
      },
    };
    expect(readTaskHubSessionState(storage).selectedTaskId).toBeNull();
    expect(readTaskHubSessionState(null).selectedTaskId).toBeNull();
    expect(() =>
      writeTaskHubSessionState(null, {
        selectedTaskId: null,
        searchQuery: "",
        laneFilter: "current",
        categoryFilter: "all",
        messageDrafts: {},
      }),
    ).not.toThrow();
    expect(() =>
      writeTaskHubSessionState(storage, {
        selectedTaskId: null,
        searchQuery: "",
        laneFilter: "current",
        categoryFilter: "all",
        messageDrafts: {},
      }),
    ).not.toThrow();
  });
});
