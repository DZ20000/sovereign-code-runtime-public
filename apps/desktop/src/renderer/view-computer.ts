import { renderActionContract } from "./action-contract.js";

export function renderComputerView(): string {
  return `
    <div class="page-toolbar page-toolbar-actions-only computer-page-toolbar">
      <div class="page-toolbar-actions">
        <span id="computer-capability" class="state-text">Desktop helper check pending</span>
        <button id="computer-observe" class="button button-secondary" type="button" hidden>Capture again</button>
      </div>
    </div>

    <div class="computer-contextbar">
      <span><b>Desktop revision</b><code id="computer-revision">No revision</code></span>
      <span><b>Visible windows</b><strong id="computer-window-count">0</strong></span>
    </div>

    <div class="computer-capture-options">
      <label class="compact-checkbox"><input id="computer-screenshot-toggle" type="checkbox" checked /><span>Include screenshot</span></label>
    </div>

    <section id="computer-empty-state" class="task-empty-state task-empty-with-contract">
      <div class="task-empty-copy">
        <strong>No desktop observation</strong>
        <span>A capture creates a revision. All subsequent desktop actions are bound to that revision and stale targets are rejected.</span>
      </div>
      ${renderActionContract({
        id: "computer-observe-contract",
        operation: "Capture desktop",
        authority: "L2 Workspace",
        scope: "Current Windows desktop",
        network: "No network action",
        approval: "Local observation; no Web Agent profile change",
        result: "Revision-bound window list and optional screenshot",
        actionId: "computer-observe-empty",
        actionLabel: "Capture desktop",
        compact: true,
      })}
    </section>

    <div id="computer-workspace" class="computer-layout computer-direct-layout" hidden>
      <section class="workbench-pane computer-observation-panel">
        <header class="pane-toolbar">
          <strong id="computer-observation-title">Desktop observation</strong>
          <span id="computer-target-position" class="state-text">No click target selected</span>
        </header>

        <div class="computer-preview-stage">
          <div id="computer-preview-empty" class="computer-preview-empty">Screenshot was not requested for this revision.</div>
          <img id="computer-preview" alt="Windows desktop observation. Click to select a desktop target." hidden />
          <span id="computer-target-marker" class="computer-target-marker" hidden aria-hidden="true"></span>
        </div>

        <div class="computer-window-heading"><strong>Visible windows</strong><span>Select one to focus it</span></div>
        <div id="computer-window-list" class="computer-window-list"></div>
      </section>

      <aside class="workbench-pane computer-actions-panel computer-direct-actions">
        ${renderActionContract({
          id: "computer-action-contract",
          operation: "Desktop action",
          authority: "L3 Consequential",
          scope: "Current desktop revision and selected target",
          network: "No network action unless the controlled application performs one",
          approval: "Direct local operator action; Web Agent authority is unchanged",
          result: "Revision-bound focus/click/type/key/launch action with audit receipt",
          compact: true,
        })}

        <div class="computer-selected-target">
          <span>Window</span>
          <strong id="computer-selected-window-label">None selected</strong>
          <input id="computer-window-id" type="hidden" value="" />
          <button id="computer-focus" class="button button-secondary" type="button" disabled>Focus window</button>
        </div>

        <div class="computer-action-section">
          <div class="computer-action-heading"><strong>Pointer</strong><span>Click the screenshot to choose a target</span></div>
          <button id="computer-click" class="button button-primary" type="button" disabled>Click target</button>
          <details class="computer-advanced-target">
            <summary>Advanced coordinates</summary>
            <div class="computer-coordinate-grid">
              <label><span>X</span><input id="computer-x" class="text-field" type="number" value="0" /></label>
              <label><span>Y</span><input id="computer-y" class="text-field" type="number" value="0" /></label>
            </div>
          </details>
        </div>

        <div class="computer-action-section">
          <label><span>Type text</span><textarea id="computer-text" class="computer-text-input" placeholder="Text for the foreground application"></textarea></label>
          <button id="computer-type" class="button button-secondary" type="button" disabled>Type text</button>
        </div>

        <div class="computer-action-section">
          <label><span>Key</span><input id="computer-key" class="text-field" value="ENTER" placeholder="ENTER, TAB, ESC, F5…" /></label>
          <button id="computer-press-key" class="button button-secondary" type="button" disabled>Press key</button>
        </div>

        <details class="computer-advanced-target computer-launch-section">
          <summary>Launch workspace executable</summary>
          <div class="computer-action-section">
            <label><span>Relative executable path</span><input id="computer-launch-path" class="text-field" value="" placeholder="tools/Application.exe" /></label>
            <button id="computer-launch" class="button button-secondary" type="button" disabled>Launch application</button>
          </div>
        </details>
      </aside>
    </div>
  `;
}
