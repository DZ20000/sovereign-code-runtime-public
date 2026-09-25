import { describe, expect, it } from "vitest";
import { taskPaneWidth } from "../src/renderer/task-workbench-layout.js";

describe("task pane widths", () => {
  it("restores finite preferences while keeping both panes usable", () => {
    expect(taskPaneWidth(402.4, 300, 620, 360)).toBe(402);
    expect(taskPaneWidth(900, 300, 480, 360)).toBe(480);
    expect(taskPaneWidth(-10, 300, 480, 360)).toBe(300);
    for (const invalid of [null, "400", {}, NaN, Infinity]) {
      expect(taskPaneWidth(invalid, 300, 620, 360)).toBe(360);
    }
    expect(taskPaneWidth(400, 300, 200, 360)).toBe(300);
  });
});
