import { describe, expect, it } from "vitest";
import {
  MemoryRunStore,
  RUN_SCHEMA_VERSION,
  SqliteRunStore,
  type RunRecord,
  type RunStore,
} from "../src/index.js";

function completedRun(
  id: string,
  workspaceId: string,
  createdAt: string,
): RunRecord {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id,
    workspaceId,
    createdAt,
    kind: "terminal",
    label: id,
    state: "succeeded",
    startedAt: createdAt,
    completedAt: createdAt,
    exitCode: 0,
    signal: null,
    durationMs: 0,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    cancelRequested: false,
    metadata: {},
  };
}

describe.each([
  ["memory", () => new MemoryRunStore()],
  ["SQLite", () => new SqliteRunStore(":memory:")],
] as const)("%s workspace run history", (_name, createStore) => {
  it("applies the limit within the requested workspace", () => {
    const store: RunStore = createStore();
    try {
      store.create(completedRun("a-old", "a", "2026-09-08T00:00:00.000Z"));
      store.create(completedRun("a-current", "a", "2026-09-08T00:00:01.000Z"));
      store.create(completedRun("b-current", "b", "2026-09-08T00:00:02.000Z"));
      expect(store.list(1, "a").map((run) => run.id)).toEqual(["a-current"]);
      expect(store.list(2, "a").map((run) => run.id)).toEqual([
        "a-current",
        "a-old",
      ]);
      expect(store.list(1).map((run) => run.id)).toEqual(["b-current"]);
      expect(store.list(10, "unknown")).toEqual([]);
    } finally {
      store.close?.();
    }
  });
});
