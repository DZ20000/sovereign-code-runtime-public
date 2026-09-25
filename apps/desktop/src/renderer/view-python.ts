import { renderActionContract } from "./action-contract.js";

export function renderPythonView(): string {
  return `
    <div class="page-toolbar page-toolbar-actions-only python-page-toolbar">
      <div class="page-toolbar-actions">
        <span id="python-capability" class="state-text">Python check pending</span>
        <button id="python-refresh" class="button button-ghost" type="button">Refresh Python</button>
        <button id="python-start-secondary" class="button button-primary" type="button">Run now</button>
      </div>
    </div>

    <div class="python-workbench">
      <section class="workbench-pane python-editor-panel python-direct-editor">
        <header class="pane-toolbar">
          <strong>script.py</strong>
          <span class="state-text">Python source</span>
        </header>
        <div id="python-code-editor" class="workbench-code-editor python-code-editor"></div>
      </section>

      <aside class="workbench-pane python-status-panel python-run-config">
        <header class="pane-toolbar">
          <strong>Run configuration</strong>
          <span class="authority-badge authority-l3">L3 Consequential</span>
        </header>

        <div class="run-config-section">
          <label><span>Working directory</span><input id="python-cwd" class="text-field" value="" placeholder="workspace root" /></label>
          <label><span>Timeout</span><div class="number-with-unit"><input id="python-timeout" class="text-field" type="number" min="1" max="900" value="120" /><span>seconds</span></div></label>
          <div class="token-field python-artifact-field">
            <span>Artifacts</span>
            <div class="token-editor">
              <div id="python-artifact-chips" class="token-chip-list"></div>
              <input id="python-artifact-entry" class="token-entry" type="text" autocomplete="off" spellcheck="false" aria-label="Add artifact path" placeholder="Add workspace-relative path and press Enter" />
            </div>
            <input id="python-artifacts" type="hidden" value="" />
            <small>Workspace-relative paths only. Add each output path separately.</small>
          </div>
        </div>

        <details class="run-config-section runtime-posture">
          <summary class="run-config-heading"><strong>Execution posture</strong></summary>
          <dl class="detail-list compact-detail-list python-posture-list">
            <div><dt>Runtime</dt><dd id="python-runtime-title">Discovering Python…</dd></div>
            <div><dt>Launcher</dt><dd id="python-launcher">—</dd></div>
            <div><dt>Version</dt><dd id="python-version">—</dd></div>
            <div><dt>Isolation</dt><dd>CPython isolated mode (-I). User site-packages and PYTHON* environment variables are ignored.</dd></div>
            <div><dt>Network</dt><dd>Host network is available. No domain-level network restriction is applied.</dd></div>
          </dl>
        </details>

        ${renderActionContract({
          id: "python-action-contract",
          operation: "Run Python",
          authority: "L3 Consequential",
          scope: "Current workspace and selected working directory",
          network: "Host network available",
          approval: "Direct local operator action; Web Agent authority is unchanged",
          result: "Background run with stdout, stderr, cancellation and no declared artifacts",
          resultElementId: "python-contract-result",
          compact: true,
        })}
      </aside>
    </div>

    <details id="python-live-console" class="python-live-console" hidden>
      <summary>
        <span>Live console</span>
        <strong id="python-live-state">Python run pending</strong>
      </summary>
      <div class="python-live-console-body">
        <div class="python-live-toolbar">
          <div>
            <strong id="python-live-run-id">—</strong>
            <span id="python-live-meta">Run output appears here.</span>
          </div>
          <div class="python-live-actions">
            <button id="python-live-cancel" class="button button-secondary" type="button" disabled>Cancel run</button>
            <button class="button button-ghost" type="button" data-open-view="runs">Open Activity</button>
          </div>
        </div>
        <div class="python-live-output-grid">
          <section><header>stdout</header><pre id="python-live-stdout">No stdout yet.</pre></section>
          <section><header>stderr</header><pre id="python-live-stderr">No stderr yet.</pre></section>
        </div>
      </div>
    </details>
  `;
}
