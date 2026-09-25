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
    const rule = styles("task-board.css").match(
      /\.task-summary-current\s*\{[^}]+\}/u,
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

  it("opens steps and details as native popovers with matching close actions", () => {
    const view = renderTasksView();
    const buttons = view.match(/<button\b[^>]*>/gu) ?? [];

    for (const kind of ["steps", "info"]) {
      const target = `task-${kind}-popover`;
      const trigger = buttons.find((button) =>
        button.includes(`id="task-${kind}-toggle"`),
      );
      const panel = view.match(
        new RegExp(`<[^>]+\\bid="${target}"[^>]*>`, "u"),
      )?.[0];

      expect(trigger).toContain(`popovertarget="${target}"`);
      expect(panel).toContain('popover="auto"');
      expect(panel).toContain('role="dialog"');
      expect(
        buttons.some(
          (button) =>
            button.includes(`popovertarget="${target}"`) &&
            button.includes('popovertargetaction="hide"'),
        ),
      ).toBe(true);
    }
  });

  it("uses existing task snapshots for transient project filtering", () => {
    const board = styles("task-board.css");
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
    expect(board).toContain(".task-project-filter");
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
    const board = styles("task-board.css");
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
    expect(board).toContain(".task-summary-card-compact-success");
  });
});
