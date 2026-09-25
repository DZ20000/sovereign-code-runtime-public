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

  it("moves complete card surfaces and exposes semantic source and state labels", () => {
    const model = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "active-work-carousel.ts",
    );
    const localization = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "localization.ts",
    ) + source("apps", "desktop", "src", "renderer", "localization-messages.ts");
    const styles = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "ui-refinement.css",
    );
    expect(model).toContain('copy.className = "active-work-line-copy"');
    expect(model).toContain('state.className = "active-work-line-state"');
    expect(model).toContain('setAttributeIfChanged(row, "aria-label"');
    expect(model).toContain('return "Task"');
    expect(model).toContain("item.stateLabel");
    expect(model).toContain('lane === "attention" ? "attention" : taskHasLiveAgent(task) ? "active" : "neutral"');
    expect(model).not.toContain('return "Background run"');
    expect(model).not.toContain('return "Tool activity"');
    expect(model).not.toContain("DesktopRunSummary");
    expect(model).not.toContain("DesktopActiveToolActivity");
    expect(styles).toContain("position: absolute;");
    expect(styles).toContain(
      "transform: translate(-50%, calc(-50% + var(--active-work-shift))) scale(var(--active-work-scale));",
    );
    expect(styles).toContain("background: transparent !important;");
    expect(styles).toContain("mask-image: linear-gradient");
    expect(localization).toContain('["Live", "活动中"]');
    expect(localization).toContain("/^(\\d+) items?$/u");
  });

  it("anchors keyboard navigation on current work without a selected-card surface", () => {
    const main = source("apps", "desktop", "src", "renderer", "main.ts");
    const model = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "active-work-carousel.ts",
    );
    const polish = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "home-active-work-polish.css",
    );
    const restorationIndex = main.indexOf(
      'import "./home-visualqa-restoration.css";',
    );
    const polishIndex = main.indexOf('import "./home-active-work-polish.css";');
    const convergence = polish.slice(
      polish.lastIndexOf("/* Operate convergence:"),
    );
    const currentStart = convergence.indexOf(
      "html #view-overview .active-work-line.is-focused,",
    );
    const markerStart = convergence.indexOf(
      "html #view-overview .active-work-line-marker",
      currentStart,
    );
    const currentSurface = convergence.slice(currentStart, markerStart);

    expect(restorationIndex).toBeGreaterThan(0);
    expect(polishIndex).toBeGreaterThan(restorationIndex);
    expect(main).toContain("activeWorkPositionLabel(total, focusedIndex)");
    expect(model).toContain('"aria-posinset"');
    expect(model).toContain('"aria-setsize"');
    expect(polish).toContain(".active-work-carousel::before");
    expect(polish).toContain("--active-work-opacity: 0.42;");
    expect(polish).toContain("--active-work-opacity: 0.12;");
    expect(polish).toContain(".active-work-carousel:focus-visible");
    expect(polish).toContain("overscroll-behavior-y: contain;");
    expect(polish).toContain("height: 180px !important;");
    expect(polish).toContain("height: 130px !important;");
    expect(polish).toContain(
      ".active-work-line.is-focused .active-work-line-state",
    );
    expect(currentStart).toBeGreaterThan(-1);
    expect(markerStart).toBeGreaterThan(currentStart);
    expect(currentSurface).toContain("border-color: transparent !important;");
    expect(currentSurface).toContain("background: transparent !important;");
    expect(currentSurface).toContain("box-shadow: none !important;");
    expect(currentSurface).not.toContain("0 0 0 2px");
    expect(polish).toContain("animation: active-work-boundary-before");
    expect(polish).toContain("animation: active-work-boundary-after");
    expect(polish).toContain("transform 300ms cubic-bezier");
    expect(polish).toContain(
      "html.reduce-motion #view-overview .active-work-line",
    );
    expect(polish).not.toContain("@media (prefers-reduced-motion: reduce)");
    expect(polish).toContain("animation: none !important;");
  });
  it("uses a text-only sidebar brand", () => {
    const shell = source("apps", "desktop", "src", "renderer", "shell.ts");
    const styles = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "ui-system.css",
    );
    expect(shell).not.toContain("brand-monogram");
    expect(styles).not.toContain(".brand-monogram {");
  });

  it("loads the last visual-QA homepage after experimental shell overrides", () => {
    const main = source("apps", "desktop", "src", "renderer", "main.ts");
    const refinement = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "ui-refinement.css",
    );
    const restoration = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "home-visualqa-restoration.css",
    );
    const taskBoardIndex = main.indexOf('import "./task-board.css";');
    const restorationIndex = main.indexOf(
      'import "./home-visualqa-restoration.css";',
    );

    expect(taskBoardIndex).toBeGreaterThan(0);
    expect(restorationIndex).toBeGreaterThan(taskBoardIndex);
    expect(occurrences(refinement, "/* FINAL_LAYOUT_QA_START */")).toBe(1);
    expect(occurrences(refinement, "/* USER_SCREENSHOT_FIX_START */")).toBe(1);
    expect(restoration).toContain("Screenshot QA correction");
    expect(restoration).toContain("Installed-window visual QA v2");
    expect(restoration).not.toContain("FINAL_LAYOUT_QA_START");
    expect(restoration).not.toContain("USER_SCREENSHOT_FIX_START");
    expect(restoration).toContain("grid-template-rows: 48px minmax(0, 1fr);");
    expect(restoration).toContain("padding-bottom: 32px;");
    expect(restoration).toContain("position: absolute;");
    expect(restoration).toContain("height: 32px;");
    expect(restoration).toMatch(
      /\.home-active-work-card[\s\S]*?grid-row:\s*1;/u,
    );
    expect(restoration).toMatch(
      /\.home-summary-card:nth-child\(1\)[\s\S]*?grid-row:\s*2;/u,
    );
    expect(restoration).toContain("min-height: 182px;");
    expect(restoration).toContain("min-height: 60px;");
    expect(restoration).toContain("--active-work-shift: -43px;");
    expect(restoration).toContain("transform 220ms cubic-bezier(0.2, 0, 0, 1)");
    expect(restoration).toContain("@media (prefers-reduced-motion: reduce)");
    expect(restoration).toContain("@media (max-width: 1120px)");
    expect(restoration).toContain("max-width: min(260px, 34vw);");
    expect(restoration).toContain("flex: 1 1 180px !important;");
    expect(restoration).toMatch(
      /\.statusbar > \.statusbar-local[\s\S]*?display:\s*none !important;/u,
    );
  });

  it("retains scroll handoff and settled Renderer activation semantics", () => {
    const main = source("apps", "desktop", "src", "renderer", "main.ts");
    expect(main).toContain(
      'Math.round(requiredElement<HTMLElement>(".content-scroll").scrollTop)',
    );
    expect(main).toContain(
      'requiredElement<HTMLElement>(".content-scroll").scrollTop = 0;',
    );
    expect(main).toMatch(
      /requiredElement<HTMLElement>\("\.content-scroll"\)\.scrollTop\s*=\s*rendererHandoff\.scrollTop;/u,
    );
    expect(main).toContain(
      "rendererUpdateSettlementPoller.reconcile(status.pendingActivation !== null);",
    );
    expect(main).not.toContain(
      "rendererUpdateSettlementPoller.reconcile(status.busy);",
    );
  });
});
