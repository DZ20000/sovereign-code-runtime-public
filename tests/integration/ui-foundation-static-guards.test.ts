import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("desktop UI foundation", () => {
  it("defines one shared token layer and keeps legacy surfaces mapped to it", () => {
    const styles = source("apps", "desktop", "src", "renderer", "styles.css");
    expect(styles.match(/\/\* sovereign-ui-foundation-v2 \*\//gu)).toHaveLength(1);
    for (const token of [
      "--ui-bg-canvas",
      "--ui-bg-sidebar",
      "--ui-bg-surface",
      "--ui-border-subtle",
      "--ui-text-primary",
      "--ui-text-secondary",
      "--ui-accent",
      "--ui-control-height",
      "--ui-content-gutter",
    ]) {
      expect(styles).toContain(token);
    }
    expect(styles).toContain("--bg: var(--ui-bg-canvas)");
    expect(styles).toContain("--surface: var(--ui-bg-surface)");
    expect(styles).toContain("--text: var(--ui-text-primary)");
    expect(styles).toContain("Segoe UI Variable Text");
    expect(styles).toMatch(/:where\(button, input, select, textarea, \[tabindex\]\):focus-visible/u);
  });

  it("uses a restrained desktop shell with a single navigation selection treatment", () => {
    const shell = source("apps", "desktop", "src", "renderer", "product-shell.css");
    expect(shell.match(/\/\* sovereign-app-shell-v2 \*\//gu)).toHaveLength(1);
    expect(shell).toContain("width: 232px");
    expect(shell).toContain("min-height: 64px");
    expect(shell).toContain("width: min(100%, 1480px)");
    expect(shell).toContain("background: rgba(127, 159, 242, .1)");
    expect(shell).toContain("background: var(--ui-accent)");
    expect(shell).not.toContain("box-shadow: 0 0 30px");
  });

  it("aligns overview and task surfaces without introducing a second card system", () => {
    const workbench = source("apps", "desktop", "src", "renderer", "workbench.css");
    const tasks = ["task-hub.css", "task-board.css"]
      .map((file) => source("apps", "desktop", "src", "renderer", file))
      .join("\n");
    expect(workbench.match(/\/\* sovereign-overview-v2 \*\//gu)).toHaveLength(1);
    expect(workbench).toContain("#view-overview");
    expect(workbench).toContain("background: var(--ui-bg-surface)");
    expect(tasks).toContain("background: var(--ui-surface)");
    expect(tasks).not.toMatch(/--task-(?:surface|card)\s*:/u);
  });
});
