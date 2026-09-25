import { describe, expect, it } from "vitest";

import { taskDetailBackShortcutRequested } from "../src/renderer/task-detail-navigation.js";

function shortcut(
  overrides: Partial<
    Parameters<typeof taskDetailBackShortcutRequested>[0]
  > = {},
): Parameters<typeof taskDetailBackShortcutRequested>[0] {
  return {
    key: "Escape",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: null,
    ...overrides,
  };
}

function matchingTarget(matches: boolean): EventTarget {
  return {
    matches: () => matches,
  } as unknown as EventTarget;
}

describe("task detail keyboard navigation", () => {
  it("accepts Escape and Alt+ArrowLeft only", () => {
    expect(taskDetailBackShortcutRequested(shortcut())).toBe(true);
    expect(
      taskDetailBackShortcutRequested(
        shortcut({ key: "ArrowLeft", altKey: true }),
      ),
    ).toBe(true);
    expect(
      taskDetailBackShortcutRequested(shortcut({ key: "ArrowLeft" })),
    ).toBe(false);
    expect(
      taskDetailBackShortcutRequested(
        shortcut({ key: "Escape", altKey: true }),
      ),
    ).toBe(false);
  });

  it("does not override modified, handled or editable input events", () => {
    expect(taskDetailBackShortcutRequested(shortcut({ ctrlKey: true }))).toBe(
      false,
    );
    expect(taskDetailBackShortcutRequested(shortcut({ metaKey: true }))).toBe(
      false,
    );
    expect(taskDetailBackShortcutRequested(shortcut({ shiftKey: true }))).toBe(
      false,
    );
    expect(
      taskDetailBackShortcutRequested(shortcut({ defaultPrevented: true })),
    ).toBe(false);
    expect(
      taskDetailBackShortcutRequested(
        shortcut({ target: matchingTarget(true) }),
      ),
    ).toBe(false);
    expect(
      taskDetailBackShortcutRequested(
        shortcut({ target: matchingTarget(false) }),
      ),
    ).toBe(true);
  });
});
