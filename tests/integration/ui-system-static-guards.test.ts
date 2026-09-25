import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("renderer UI system", () => {
  it("imports the shared UI layer after the legacy renderer styles", () => {
    const main = source("apps", "desktop", "src", "renderer", "main.ts");
    const systemIndex = main.indexOf('import "./ui-system.css";');
    expect(systemIndex).toBeGreaterThan(0);
    for (const stylesheet of ["styles.css", "workbench.css", "product-shell.css", "task-hub.css"]) {
      expect(systemIndex).toBeGreaterThan(main.indexOf(`import "./${stylesheet}";`));
    }
  });

  it("defines one token vocabulary for shell, controls and dense workbenches", () => {
    const css = source("apps", "desktop", "src", "renderer", "ui-system.css");
    for (const token of [
      "--ui-canvas",
      "--ui-sidebar",
      "--ui-surface",
      "--ui-border-subtle",
      "--ui-text",
      "--ui-text-muted",
      "--ui-accent",
      "--ui-control-height",
      "--ui-sidebar-width",
      "--ui-content-gutter",
    ]) {
      expect(css).toContain(token);
    }
    expect(css).toContain('.navigation-item.is-active');
    expect(css).toContain(".content-scroll");
    expect(css).toContain(".home-command-grid");
    expect(
      [css, source("apps", "desktop", "src", "renderer", "task-board.css")].join("\n"),
    ).toContain(".task-project-card");
    expect(
      [css, source("apps", "desktop", "src", "renderer", "task-board.css")].join("\n"),
    ).toContain(".task-summary-card:focus-visible");
    expect(css).toContain("@media (max-width: 1180px)");
  });

  it("keeps search focus single-layer and task receipts visually distinct", () => {
    const css = source("apps", "desktop", "src", "renderer", "ui-system.css");
    const taskCss = source("apps", "desktop", "src", "renderer", "task-hub.css");
    const inputFocus = css.match(
      /input:focus,[\s\S]*?\n\}/u,
    )?.[0];
    expect(inputFocus).toBeDefined();
    // Single-layer focus: one treatment only, never an outline stacked on a ring.
    const focusLayers = ["outline: 2px", "box-shadow: 0 0 0"].filter((declaration) =>
      inputFocus?.includes(declaration),
    );
    expect(focusLayers.length).toBeLessThanOrEqual(1);
    expect(inputFocus).toMatch(/border-color: var\(--ui-accent\)|outline: 2px|box-shadow: 0 0 0 1px/u);
    expect(taskCss).toContain(".task-message-delivery-acknowledged");
    expect(taskCss).toContain(".task-message-delivery-pending");
  });

  it("keeps the final desktop surface neutral, padded and overlap-safe", () => {
    const css = source("apps", "desktop", "src", "renderer", "ui-refinement.css");
    const renderer = source("apps", "desktop", "src", "renderer", "main.ts");

    expect(css).toContain("--ui-canvas: #1e1e1e");
    expect(css).toContain("--ui-surface: #252526");
    expect(css).toContain("padding: 15px 18px");
    expect(css).toContain(".overview-attention-marker");
    expect(css).toContain("grid-template-columns: 8px minmax(0, 1fr) auto");
    expect(css).toContain("#view-tasks .task-summary-card");
    expect(
      [css, source("apps", "desktop", "src", "renderer", "home-visualqa-restoration.css")].join("\n"),
    ).toContain("height: 174px");
    expect(css).toContain("--ui-surface-inset: #222223");
    expect(css).toContain("html #view-overview .home-summary-grid");
    expect(css).toContain("html :is(#view-agent, #view-settings) .permission-segment");
    expect(css).toContain("html #view-browser .browser-direct-nav");
    expect(css).toContain("gap: 12px");
    expect(css).toContain("Round 5: remove every remaining legacy blue-black large surface");
    expect(css).toContain("--ui-panel: #252526");
    expect(css).toContain("html #view-overview .overview-run-list");
    expect(css).toContain("#view-terminal .terminal-output");
    expect(css).toContain("#view-computer .computer-preview-stage");
    expect(renderer).toContain('marker.className = "overview-attention-marker"');
  });
});
