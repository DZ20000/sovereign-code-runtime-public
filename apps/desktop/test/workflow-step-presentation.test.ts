import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DesktopWorkflowStep } from "../src/shared.js";
import { renderWorkflowStep, workflowStepSummary } from "../src/renderer/workflow-step-presentation.js";
import { renderWorkflowsView } from "../src/renderer/view-workflows.js";
import { renderBrowserView } from "../src/renderer/view-browser.js";

describe("workflow step presentation", () => {
  it.each<DesktopWorkflowStep>([
    { kind: "validation", task: "test" }, { kind: "terminal", command: "pnpm test" }, { kind: "python", code: "print(1)" },
  ])("retains $kind fields and its actual permission in the collapsed row", step => {
    const before = JSON.stringify(step);
    const summary = workflowStepSummary(step);
    const html = renderWorkflowStep(step, 1, 3, false);
    expect(html).toContain('class="v2-workflow-step" data-workflow-step-index="1">');
    expect(html).toContain('data-workflow-step-field="kind"');
    expect(html).toContain('data-workflow-step-field="' + (step.kind === "validation" ? "task" : step.kind === "terminal" ? "command" : "code") + '"');
    expect(summary.authority).toBe(step.kind === "validation" ? "L2" : "L3");
    for (const action of ["up", "down", "remove"]) expect(html).toContain('data-workflow-step-action="' + action + '"');
    expect(JSON.stringify(step)).toBe(before);
  });

  it("escapes command and Python content in both summary and editable controls", () => {
    for (const step of [
      { kind: "terminal", command: '\"><script>alert(1)</script>' },
      { kind: "python", code: '</textarea><script>alert(1)</script>' },
    ] as const) {
      const html = renderWorkflowStep(step, 0, 1, true);
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain('data-workflow-step-index="0" open');
      expect(html).toMatch(/data-workflow-step-action="up"[^>]+ disabled/u);
      expect(html).toMatch(/data-workflow-step-action="down"[^>]+ disabled/u);
    }
  });

  it("updates the compact validation label from the actual task", () => {
    expect(workflowStepSummary({ kind: "validation", task: "build" })).toEqual({ title: "Build", detail: "Validation · build", authority: "L2" });
  });

  it.each([
    ["browser", renderBrowserView], ["workflow", renderWorkflowsView],
  ] as const)("keeps every %s controller field wired with unique IDs", (name, render) => {
    const html = render();
    const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    const controller = readFileSync(new URL("../src/renderer/" + name + "-controller.ts", import.meta.url), "utf8");
    for (const match of controller.matchAll(/requiredElement<[^>]+>\(\s*"#([^"\n]+)"\s*\)/gu)) expect(ids).toContain(match[1]);
    if (name === "workflow") {
      expect(html).toMatch(/<footer class="v2-workflow-footer">[\s\S]+id="workflow-start-secondary"/u);
      for (const id of ["workflow-undo", "workflow-timeout", "workflow-json-advanced", "workflow-contract-authority", "workflow-contract-approval"]) expect(ids).toContain(id);
    }
  });
});
