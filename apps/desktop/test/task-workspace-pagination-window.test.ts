import { describe, expect, it } from "vitest";

import type { DesktopTaskWorkspaceSnapshot } from "../src/shared.js";
import { TaskWorkspaceSnapshotAssembler } from "../src/renderer/task-workspace-pagination.js";

function snapshot(
  overrides: Partial<DesktopTaskWorkspaceSnapshot> = {},
): DesktopTaskWorkspaceSnapshot {
  return {
    schemaVersion: "scr.task-workspace/v1",
    generatedAt: "2026-08-28T10:00:00.000Z",
    revision: 1,
    offset: 0,
    limit: 64,
    totalTaskCount: 0,
    totalProjectCount: 0,
    nextOffset: null,
    projects: [],
    ...overrides,
  };
}

describe("task workspace pagination numeric window", () => {
  it.each([
    ["revision", { revision: -1 }],
    ["offset", { offset: -1 }],
    ["limit", { limit: 0 }],
    ["task total", { totalTaskCount: -1 }],
    ["project total", { totalProjectCount: -1 }],
    ["next offset", { nextOffset: -1 }],
  ] as const)("rejects a negative or empty %s", (label, overrides) => {
    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(snapshot(overrides)),
    ).toThrow(`pagination ${label} must be a safe integer`);
  });

  it.each([
    ["revision", { revision: 1.5 }],
    ["offset", { offset: 0.5 }],
    ["limit", { limit: 64.5 }],
    ["task total", { totalTaskCount: Number.MAX_SAFE_INTEGER + 1 }],
    ["project total", { totalProjectCount: 0.5 }],
    ["next offset", { nextOffset: 0.5 }],
  ] as const)("rejects a non-safe-integer %s", (label, overrides) => {
    expect(() =>
      new TaskWorkspaceSnapshotAssembler().addPage(snapshot(overrides)),
    ).toThrow(`pagination ${label} must be a safe integer`);
  });

  it("accepts a valid empty workspace page without synthesizing a zero limit", () => {
    const result = new TaskWorkspaceSnapshotAssembler().addPage(snapshot());
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("Expected completion.");
    expect(result.snapshot.limit).toBe(1);
  });
});
