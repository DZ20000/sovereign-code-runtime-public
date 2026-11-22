import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (...parts: string[]): string =>
  readFileSync(join(root, ...parts), "utf8");

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("home active work navigator static guards", () => {
  it("uses a keyed navigator instead of polling text replacement", () => {
    const view = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "view-overview.ts",
    );
    const main = source("apps", "desktop", "src", "renderer", "main.ts");
    const model = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "active-work-carousel.ts",
    );
    expect(view).toContain('id="home-active-work-carousel"');
    expect(view).toContain('role="listbox"');
    expect(model).toContain('row.setAttribute("role", "option")');
    expect(view).not.toContain('id="home-task"');
    expect(view).not.toContain('id="home-task-detail"');
    expect(main).not.toContain('requiredElement<HTMLElement>("#home-task")');
    expect(main).not.toContain(
      'requiredElement<HTMLElement>("#home-task-detail")',
    );
    expect(main).toContain("new ActiveWorkCarousel");
    expect(main).toContain("buildActiveWorkItems");
    expect(model).toContain("reconcileActiveWorkSelection");
    expect(model).toContain("taskBoardLane(task)");
    expect(model).toContain("taskBoardState(task)");
    expect(model).toContain("taskBoardStateLabel(task)");
    expect(model).toContain("taskBoardStateDetail(task)");
    expect(model).not.toContain("ACTIVE_TASK_STATUSES");
    expect(model).not.toContain("ATTENTION_TASK_STATUSES");
    expect(model).toContain(
      "this.#focusedId === null && !this.#selectionPinned",
    );
    expect(model).toContain(
      'root.addEventListener("pointercancel", cancelPointerDrag)',
    );
    expect(model).toContain(
      'root.addEventListener("lostpointercapture", cancelPointerDrag)',
    );
    expect(model).toContain("this.#signature");
    expect(model).toContain("this.#syncRowOrder(orderedRows)");
    expect(model).not.toContain(
      "for (const row of orderedRows) this.#root.append(row)",
    );
    expect(model).not.toContain("setInterval");
  });

  it("contains keyboard, pointer and wheel navigation without moving the page", () => {
    const model = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "active-work-carousel.ts",
    );
    const output = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "output-follow.ts",
    );
    expect(model).toContain('event.key === "ArrowUp"');
    expect(model).toContain('event.key === "ArrowDown"');
    expect(model).toContain('root.addEventListener("wheel"');
    expect(model).toContain('root.addEventListener("pointerdown"');
    expect(model).toContain("const atBoundary");
    const wheelHandler = model.slice(
      model.indexOf("  #onWheel(event: WheelEvent)"),
    );
    const preventDefaultIndex = wheelHandler.indexOf("event.preventDefault();");
    const stopPropagationIndex = wheelHandler.indexOf(
      "event.stopPropagation();",
    );
    const boundaryIndex = wheelHandler.indexOf("if (atBoundary)");
    expect(preventDefaultIndex).toBeGreaterThanOrEqual(0);
    expect(stopPropagationIndex).toBeGreaterThanOrEqual(0);
    expect(preventDefaultIndex).toBeLessThan(boundaryIndex);
    expect(stopPropagationIndex).toBeLessThan(boundaryIndex);
    expect(output).toContain("looksLikeRawCommand");
    expect(output).toContain("safeActivityDetail");
  });

  it("exposes task state and position while showing one compact selected card", () => {
    const model = source("apps", "desktop", "src", "renderer", "active-work-carousel.ts");
    const styles = source("apps", "desktop", "src", "renderer", "v2.css");
    expect(model).toContain('setAttributeIfChanged(row, "aria-label"');
    expect(model).toContain('"aria-posinset"');
    expect(model).toContain('"aria-setsize"');
    expect(model).not.toContain("DesktopRunSummary");
    expect(styles).toContain(".active-work-line:not(.is-focused)");
    expect(styles).toContain(".active-work-line-state");
    expect(styles).toContain(".v2-active-controls");
  });
});
