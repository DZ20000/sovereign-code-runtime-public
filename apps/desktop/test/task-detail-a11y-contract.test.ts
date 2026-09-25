import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}
describe("task detail accessibility contract", () => {
  it("exposes the Agent plan as a semantic list", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    const steps = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-step-list.ts",
    );
    expect(view).toContain(
      'id="task-detail-steps" class="task-step-list" role="list" aria-label="Task steps"',
    );
    expect(steps).toContain('row.setAttribute("role", "listitem")');
  });
  it("announces coordination state changes without replaying every message", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    const styles = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-coordination-inbox.css",
    );
    expect(view).toContain(
      'id="task-coordination-load-older" class="button button-ghost" type="button" aria-controls="task-coordination-list" aria-describedby="task-coordination-history-status" hidden',
    );
    expect(view).toContain(
      'id="task-coordination-snapshot-status" class="task-coordination-snapshot-status" role="status" aria-live="polite" aria-atomic="true"',
    );
    expect(view).toContain(
      'id="task-coordination-history-status" class="task-coordination-history-status" role="status" aria-live="polite" aria-atomic="true"',
    );
    const list = view.match(/<div id="task-coordination-list"[^>]*>/u)?.[0];
    expect(list).toContain('role="list"');
    expect(list).toContain(
      'aria-describedby="task-coordination-note task-coordination-snapshot-status task-coordination-history-status"',
    );
    expect(list).not.toContain("aria-live");
    expect(list).not.toContain("aria-relevant");
    expect(list).not.toContain("aria-atomic");
    expect(styles).toContain(
      ".task-coordination-snapshot-status:empty {\n  margin: 0;\n}",
    );
    expect(styles).not.toContain(
      ".task-coordination-snapshot-status:empty {\n  display: none;",
    );
  });

  it("exposes determinate and indeterminate progress semantics", () => {
    const accessibility = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-progress-accessibility.ts",
    );
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    expect(accessibility).toContain('setAttribute("role", "progressbar")');
    expect(accessibility).toContain('setAttribute("aria-valuemin", "0")');
    expect(accessibility).toContain('setAttribute("aria-valuemax", "100")');
    expect(accessibility).toContain('removeAttribute("aria-valuenow")');
    expect(controller.match(/applyTaskProgressAccessibility\(/gu)).toHaveLength(
      2,
    );
  });
});
