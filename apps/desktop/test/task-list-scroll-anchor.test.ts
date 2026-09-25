import { describe, expect, it } from "vitest";
import {
  anchoredTaskListScrollTop,
  firstVisibleTaskIndex,
} from "../src/renderer/task-list-scroll-anchor.js";
describe("task list scroll anchor", () => {
  it("selects the first task intersecting the visible scroll viewport", () => {
    expect(
      firstVisibleTaskIndex(
        [
          { top: -80, bottom: -5 },
          { top: -5, bottom: 40 },
          { top: 40, bottom: 90 },
        ],
        { top: 0, bottom: 80 },
      ),
    ).toBe(1);
  });
  it("preserves the visible task offset when content above it changes", () => {
    expect(
      anchoredTaskListScrollTop({
        previousScrollTop: 320,
        previousOffset: 20,
        nextOffset: 65,
        maximumScrollTop: 1000,
      }),
    ).toBe(365);
  });
  it("falls back to the previous position when the anchor disappears", () => {
    expect(
      anchoredTaskListScrollTop({
        previousScrollTop: 320,
        previousOffset: 20,
        nextOffset: null,
        maximumScrollTop: 1000,
      }),
    ).toBe(320);
  });
  it("clamps restored positions to the current scroll range", () => {
    expect(
      anchoredTaskListScrollTop({
        previousScrollTop: 20,
        previousOffset: 100,
        nextOffset: 0,
        maximumScrollTop: 500,
      }),
    ).toBe(0);
    expect(
      anchoredTaskListScrollTop({
        previousScrollTop: 490,
        previousOffset: 0,
        nextOffset: 80,
        maximumScrollTop: 500,
      }),
    ).toBe(500);
  });
});
