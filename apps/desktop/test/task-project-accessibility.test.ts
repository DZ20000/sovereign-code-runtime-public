import { describe, expect, it } from "vitest";

import { taskProjectAccessibilityIds } from "../src/renderer/task-project-accessibility.js";

describe("task project accessibility identifiers", () => {
  it("creates stable, token-safe identifiers for every project region", () => {
    const first = taskProjectAccessibilityIds("Project A / main");
    const second = taskProjectAccessibilityIds("Project A / main");

    expect(first).toEqual(second);
    expect(new Set(Object.values(first)).size).toBe(4);
    for (const value of Object.values(first)) {
      expect(value).toMatch(/^[a-z0-9_-]+$/u);
      expect(value).toContain("project-a-main");
    }
  });

  it("keeps normalized collisions distinct with a deterministic hash", () => {
    const slash = taskProjectAccessibilityIds("a/b");
    const space = taskProjectAccessibilityIds("a b");
    expect(slash.titleId).not.toBe(space.titleId);
  });

  it("uses a safe stem for blank or non-Latin identifiers", () => {
    const ids = taskProjectAccessibilityIds("项目");
    expect(ids.titleId).toMatch(/^task-project-project-[a-f0-9]{8}-title$/u);
  });
});
