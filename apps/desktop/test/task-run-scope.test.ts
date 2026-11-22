import { describe, expect, it } from "vitest";
import { runTaskId, runsInTaskScope } from "../src/renderer/task-run-scope.js";

describe("explicit task to run association", () => {
  it.each([
    [{ metadata: {} }, null],
    [{ taskId: "task-a", metadata: {} }, "task-a"],
    [{ metadata: { taskId: "task-a" } }, "task-a"],
    [{ taskId: "task-a", metadata: { taskId: "task-a" } }, "task-a"],
    [{ taskId: "task-a", metadata: { taskId: "task-b" } }, null],
    [{ taskId: " task-a ", metadata: {} }, null],
    [{ taskId: 42, metadata: { taskId: "" } }, null],
    [{ metadata: { taskId: ["task-a"] } }, null],
  ])("accepts only unambiguous producer identifiers: %j", (run, expected) => {
    expect(runTaskId(run)).toBe(expected);
  });

  it("does not infer ownership from the shared workspace, label or other metadata", () => {
    const runs = [
      { id: "linked", label: "task-a", workspaceId: "same-folder", metadata: { taskId: "task-a" } },
      { id: "legacy", label: "task-a", workspaceId: "same-folder", metadata: { task: "task-a" } },
      { id: "other", label: "task-a", workspaceId: "same-folder", metadata: { taskId: "task-b" } },
    ];
    expect(runsInTaskScope(runs, "task-a").map((run) => run.id)).toEqual(["linked"]);
    expect(runsInTaskScope(runs, "TASK-A")).toEqual([]);
    expect(runsInTaskScope(runs, "absent")).toEqual([]);
    expect(runsInTaskScope(runs, null)).toBe(runs);
  });
});
