import { describe, expect, it } from "vitest";

import type { DesktopTaskWorkspaceSnapshot } from "../src/shared.js";
import { taskProjectForTask } from "../src/renderer/task-project-terminal.js";

const snapshot = {
  projects: [
    { root: "E:\\work\\alpha", tasks: [{ id: "formal", source: "agent" }] },
    {
      root: "E:\\work\\observed",
      tasks: [{ id: "observed", source: "inferred" }],
    },
  ],
} as unknown as DesktopTaskWorkspaceSnapshot;

describe("task project terminal", () => {
  it("resolves only a selected formal task through the canonical snapshot", () => {
    expect(taskProjectForTask(snapshot, "formal")).toBe(snapshot.projects[0]);
    expect(taskProjectForTask(snapshot, "observed")).toBeNull();
    expect(taskProjectForTask(snapshot, "missing")).toBeNull();
    expect(taskProjectForTask(null, "formal")).toBeNull();
    expect(taskProjectForTask(snapshot, null)).toBeNull();
  });
});
