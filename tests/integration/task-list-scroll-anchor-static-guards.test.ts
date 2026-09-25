import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("task list scroll anchor static guards", () => {
  it("captures only rendered task lists and restores after each replacement path", () => {
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    expect(controller).toContain("new TaskListScrollAnchor");
    expect(controller).toContain("container.getClientRects().length > 0");
    expect(controller).toContain("this.#listScrollAnchor?.capture()");
    expect(controller.match(/restoreScrollAnchor\(\);/gu)).toHaveLength(3);
  });
  it("uses task identity and a bounded absolute-position fallback", () => {
    const anchor = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-list-scroll-anchor.ts",
    );
    expect(anchor).toContain("taskId: card?.dataset.taskId ?? null");
    expect(anchor).toContain("previousScrollTop");
    expect(anchor).toContain("maximumScrollTop");
    expect(anchor).toContain("Math.min(Math.max(0, desired)");
  });
});
