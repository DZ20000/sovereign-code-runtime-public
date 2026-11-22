import type { DesktopWorkflowStep } from "../shared.js";
import { renderUiIcon } from "./ui-icons.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function workflowStepSummary(step: DesktopWorkflowStep): { title: string; detail: string; authority: "L2" | "L3" } {
  if (step.kind === "validation") {
    return { title: { typecheck: "Typecheck", test: "Tests", build: "Build" }[step.task], detail: "Validation · " + step.task, authority: "L2" };
  }
  return {
    title: step.kind === "terminal" ? "Terminal command" : "Python script",
    detail: (step.kind === "terminal" ? step.command : step.code).replace(/\s+/gu, " ").trim() || "—",
    authority: "L3",
  };
}

export function renderWorkflowStep(step: DesktopWorkflowStep, index: number, count: number, expanded: boolean): string {
  const summary = workflowStepSummary(step);
  const controls = step.kind === "validation"
    ? `<label><span>Task</span><select class="settings-select" data-workflow-step-index="${index}" data-workflow-step-field="task">
        <option value="typecheck"${step.task === "typecheck" ? " selected" : ""}>Typecheck</option>
        <option value="test"${step.task === "test" ? " selected" : ""}>Tests</option>
        <option value="build"${step.task === "build" ? " selected" : ""}>Build</option>
      </select></label>`
    : step.kind === "terminal"
      ? `<label class="workflow-step-wide"><span>Command</span><input class="text-field" data-workflow-step-index="${index}" data-workflow-step-field="command" value="${escapeHtml(step.command)}" /></label>`
      : `<label class="workflow-step-wide"><span>Python code</span><textarea class="workflow-step-code" data-workflow-step-index="${index}" data-workflow-step-field="code">${escapeHtml(step.code)}</textarea></label>`;
  return `<article class="workflow-step-row">
    <details class="v2-workflow-step" data-workflow-step-index="${index}"${expanded ? " open" : ""}>
      <summary class="v2-workflow-step-summary" aria-label="Edit step ${index + 1}">
        <strong><span class="workflow-step-index">${index + 1}.</span> <span data-workflow-step-title="${index}">${summary.title}</span></strong>
        <span class="v2-workflow-step-meta"><span data-workflow-step-detail="${index}" data-no-i18n>${escapeHtml(summary.detail)}</span><span class="workflow-step-authority authority-${summary.authority.toLowerCase()}">${summary.authority}</span></span>
        ${renderUiIcon("chevron")}
      </summary>
      <div class="workflow-step-controls">
        <label><span>Step type</span><select class="workflow-kind-select" data-workflow-step-index="${index}" data-workflow-step-field="kind" aria-label="Step ${index + 1} kind">
          <option value="validation"${step.kind === "validation" ? " selected" : ""}>Validation</option>
          <option value="terminal"${step.kind === "terminal" ? " selected" : ""}>Terminal</option>
          <option value="python"${step.kind === "python" ? " selected" : ""}>Python</option>
        </select></label>${controls}
      </div>
    </details>
    <div class="workflow-step-actions">
      <button type="button" data-workflow-step-index="${index}" data-workflow-step-action="up" aria-label="Move step up"${index === 0 ? " disabled" : ""}>↑</button>
      <button type="button" data-workflow-step-index="${index}" data-workflow-step-action="down" aria-label="Move step down"${index === count - 1 ? " disabled" : ""}>↓</button>
      <button type="button" data-workflow-step-index="${index}" data-workflow-step-action="remove" aria-label="Remove step">×</button>
    </div>
  </article>`;
}
