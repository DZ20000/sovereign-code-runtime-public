import { renderActionContract } from "./action-contract.js";

export function renderWorkflowsView(): string {
  return `
    <div class="page-toolbar page-toolbar-actions-only workflows-page-toolbar">
      <div class="page-toolbar-actions">
        <span id="workflow-validation" class="state-text">Workflow valid</span>
        <button id="workflow-refresh" class="button button-ghost" type="button">Refresh templates</button>
      </div>
    </div>

    <div class="workflow-workbench">
      <aside class="workbench-pane workflow-template-panel workflow-direct-templates">
        <header class="pane-toolbar"><strong>Templates</strong><span id="workflow-template-count" class="state-text">0</span></header>
        <div id="workflow-template-list" class="workflow-template-list compact-workflow-templates">
          <div class="compact-empty">Loading templates…</div>
        </div>
      </aside>

      <section class="workbench-pane workflow-editor-panel workflow-direct-editor">
        <div class="workflow-meta-grid">
          <label><span>Label</span><input id="workflow-label" class="text-field" value="Verify workspace" maxlength="200" /></label>
          <label><span>Working directory</span><input id="workflow-cwd" class="text-field" value="" placeholder="workspace root" /></label>
          <label><span>Timeout</span><div class="number-with-unit"><input id="workflow-timeout" class="text-field" type="number" min="1" max="3600" value="900" /><span>seconds</span></div></label>
        </div>

        <div class="workflow-builder-heading">
          <div><strong>Steps</strong><span id="workflow-step-count">2 steps</span></div>
          <button id="workflow-undo" class="button button-ghost" type="button" disabled>Undo last change</button>
          <details class="workflow-add-menu">
            <summary class="button button-secondary">+ Add step</summary>
            <div class="workflow-add-menu-popover">
              <button type="button" data-workflow-add="validation"><strong>Validation</strong><span>L2 Workspace</span></button>
              <button type="button" data-workflow-add="terminal"><strong>Terminal command</strong><span>L3 Consequential</span></button>
              <button type="button" data-workflow-add="python"><strong>Python script</strong><span>L3 Consequential</span></button>
            </div>
          </details>
        </div>

        <div id="workflow-step-builder" class="workflow-step-builder"></div>

        <details id="workflow-json-advanced" class="workflow-json-advanced">
          <summary>Advanced JSON <span id="workflow-json-status">Workflow valid</span></summary>
          <div id="workflow-json-editor" class="workbench-code-editor workflow-json-editor"></div>
        </details>

        ${renderActionContract({
          id: "workflow-action-contract",
          operation: "Run workflow",
          authority: "L2 Workspace",
          authorityElementId: "workflow-contract-authority",
          scope: "Current workspace and selected working directory",
          network: "Depends on step types; validation is fixed, Terminal/Python use host access",
          approval: "Direct local operator action; Web Agent authority is unchanged",
          approvalElementId: "workflow-contract-approval",
          result: "One background workflow run with ordered step output and cancellation",
          actionId: "workflow-start-secondary",
          actionLabel: "Run now",
        })}
      </section>
    </div>
  `;
}
