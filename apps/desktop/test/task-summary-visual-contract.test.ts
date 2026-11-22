import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderTasksView } from "../src/renderer/view-tasks.js";

function styles(file: string): string {
  return readFileSync(
    resolve(process.cwd(), "apps", "desktop", "src", "renderer", file),
    "utf8",
  );
}

describe("task summary visual contract", () => {
  it("keeps the current-work summary bounded to two readable lines", () => {
    const rule = styles("v2.css").match(
      /\.task-summary-current[^{}]*\{[^}]+\}/u,
    )?.[0];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/overflow\s*:\s*hidden\s*[;}]/u);
    expect(rule).toMatch(/-webkit-line-clamp\s*:\s*2\s*[;}]/u);
  });

  it("keeps a keyboard-accessible task-list divider and Back action", () => {
    const view = renderTasksView();
    const divider = view.match(
      /<[^>]+\bid="task-list-resizer"[^>]*>/u,
    )?.[0];
    const back = view.match(
      /<button\b[^>]+\bid="task-detail-back"[^>]*>/u,
    )?.[0];

    expect(divider).toContain('role="separator"');
    expect(divider).toContain('aria-orientation="vertical"');
    expect(divider).toContain('aria-controls="task-hub-list-pane"');
    expect(divider).toContain('tabindex="0"');
    expect(back).toContain('aria-label="Back to task list"');
  });

  it("keeps three accessible task tabs, one Runs workbench and a native Details dialog", () => {
    const view = renderTasksView();
    for (const kind of ["conversation", "steps", "output"]) {
      const trigger = view.match(new RegExp(`<button[^>]+id="task-tab-${kind}"[^>]*>`))?.[0];
      const panel = view.match(new RegExp(`<section[^>]+id="task-panel-${kind}"[^>]*>`))?.[0];
      expect(trigger).toContain('role="tab"');
      expect(trigger).toContain(`aria-controls="task-panel-${kind}"`);
      expect(panel).toContain('role="tabpanel"');
      expect(panel).toContain(`aria-labelledby="task-tab-${kind}"`);
    }
    expect(view.match(/id="runs-workbench-root"/gu)).toHaveLength(1);
    expect(view).toContain('id="task-show-all-runs"');
    expect(view).toContain('id="task-history-back"');
    expect(view).not.toContain('id="runs-pane-audit"');
    expect(view).not.toContain('id="task-steps-popover"');
    expect(view).toContain('popovertarget="task-info-popover"');
    expect(view.match(/<div[^>]+id="task-info-popover"[^>]*>/u)?.[0]).toContain('popover="auto"');
    const ids = [...view.matchAll(/ id="([^"]+)"/gu)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(50);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses existing task snapshots for transient project filtering", () => {
    const controller = styles("tasks-controller.ts");
    const session = styles("task-hub-session.ts");
    const view = styles("view-tasks.ts");
    const projectFilter = styles("task-project-filter.ts");

    expect(view).toContain('id="task-project-filter"');
    expect(view).toContain('id="task-project-filter-options"');
    expect(controller).toContain("#selectedProjectFilterId");
    expect(controller).toContain("filterTaskProjects");
    expect(projectFilter).toContain("taskHasCurrentAgentSession");
    expect(projectFilter).not.toContain("taskBoardCounts");
    expect(projectFilter).not.toContain("sessionStorage");
    expect(projectFilter).not.toContain("localStorage");
    expect(session).not.toContain("selectedProjectFilterId");
  });

  it("opens a canonical task project through the existing terminal flow", () => {
    const helper = styles("task-project-terminal.ts");
    const main = styles("main.ts");
    const terminal = styles("terminal-controller.ts");
    const view = styles("view-tasks.ts");

    expect(view).toContain('id="task-detail-open-terminal"');
    expect(view).toContain("simple-mode-hidden");
    expect(main).toContain("taskProjectForTask");
    expect(main).toContain("await tasksController.selectProject(project.id)");
    expect(main).toContain('terminalController.create("")');
    expect(terminal).toContain('"terminal.session.create"');
    expect(helper).not.toMatch(/localStorage|sessionStorage|rebind/u);
  });

  it("keeps durable success compact and resets the real scroller for all records", () => {
    const board = styles("v2.css");
    const controller = styles("tasks-controller.ts");

    expect(controller).toContain(
      'task.status === "succeeded" && boardLane === "history"',
    );
    expect(controller).toContain("task-summary-card-compact-success");
    expect(controller).toContain("button.append(header, completed)");
    expect(controller).toContain('if (lane === "all")');
    expect(controller).toContain(
      'requiredElement<HTMLElement>("#task-project-grid").scrollTop = 0',
    );
  });
});
