import { describe, expect, it } from "vitest";

import { taskWorkspaceLoadPresentation } from "../src/renderer/task-workspace-load-presentation.js";

describe("task workspace load presentation", () => {
  it("distinguishes an active initial load from an unavailable workspace", () => {
    expect(taskWorkspaceLoadPresentation(null)).toEqual({
      kind: "loading",
      summary: "Loading tasks…",
      title: "Loading task records",
      detail: "Loading projects and tasks…",
      retry: null,
      liveRole: "status",
    });
  });

  it("preserves the failure reason and provides a separate retry instruction", () => {
    expect(taskWorkspaceLoadPresentation("  Tunnel unavailable.  ")).toEqual({
      kind: "unavailable",
      summary: "Tasks unavailable",
      title: "Tasks unavailable",
      detail: "Tunnel unavailable.",
      retry: "Refresh to try again.",
      liveRole: "alert",
    });
  });

  it("uses a safe fallback for empty error messages", () => {
    expect(taskWorkspaceLoadPresentation("   ").detail).toBe(
      "Could not load tasks.",
    );
  });
});
