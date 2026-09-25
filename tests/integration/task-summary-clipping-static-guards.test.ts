import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("task summary clipping static guards", () => {
  it("keeps the compact current-work clamp intentional and exposes its full text", () => {
    const styles = source("apps", "desktop", "src", "renderer", "task-board.css");
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const rule = styles.match(/\.task-summary-current\s*\{[^}]+\}/u)?.[0];

    expect(rule).toBeDefined();
    expect(rule).toContain("overflow: hidden");
    expect(rule).toContain("text-overflow: ellipsis");
    expect(rule).toContain("-webkit-line-clamp: 2");
    expect(controller).toContain(
      "const currentWork = listTaskCurrentWork(task);",
    );
    expect(controller).toContain("current.textContent = currentWork;");
    expect(controller).toContain("current.title = currentWork;");
    expect(controller).toContain(
      "${taskBoardStateDetail(task)} ${currentWork}.",
    );
  });
});
