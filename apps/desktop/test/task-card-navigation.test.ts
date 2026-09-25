import { describe, expect, it } from "vitest";

import {
  taskCardIsNavigable,
  taskCardNavigationIndex,
} from "../src/renderer/task-card-navigation.js";

describe("task card keyboard navigation", () => {
  it("moves through visible cards without wrapping past the boundaries", () => {
    expect(taskCardNavigationIndex(1, 4, "ArrowDown")).toBe(2);
    expect(taskCardNavigationIndex(1, 4, "ArrowRight")).toBe(2);
    expect(taskCardNavigationIndex(2, 4, "ArrowUp")).toBe(1);
    expect(taskCardNavigationIndex(2, 4, "ArrowLeft")).toBe(1);
    expect(taskCardNavigationIndex(3, 4, "ArrowDown")).toBeNull();
    expect(taskCardNavigationIndex(0, 4, "ArrowUp")).toBeNull();
  });

  it("supports Home and End while avoiding redundant focus moves", () => {
    expect(taskCardNavigationIndex(2, 5, "Home")).toBe(0);
    expect(taskCardNavigationIndex(2, 5, "End")).toBe(4);
    expect(taskCardNavigationIndex(0, 5, "Home")).toBeNull();
    expect(taskCardNavigationIndex(4, 5, "End")).toBeNull();
  });

  it("excludes cards hidden by a collapsed native details group", () => {
    const visibleCard = {
      closest: () => null,
    } as unknown as Pick<Element, "closest">;
    const collapsedCard = {
      closest: (selector: string) =>
        selector === "details:not([open])" ? ({} as Element) : null,
    } as unknown as Pick<Element, "closest">;

    expect(taskCardIsNavigable(visibleCard)).toBe(true);
    expect(taskCardIsNavigable(collapsedCard)).toBe(false);
  });

  it("rejects unsupported keys and invalid list positions", () => {
    expect(taskCardNavigationIndex(0, 2, "Enter")).toBeNull();
    expect(taskCardNavigationIndex(-1, 2, "ArrowDown")).toBeNull();
    expect(taskCardNavigationIndex(2, 2, "ArrowUp")).toBeNull();
    expect(taskCardNavigationIndex(0, 0, "ArrowDown")).toBeNull();
  });
});
