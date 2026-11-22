import { renderActionContract } from "./action-contract.js";

export function renderPythonView(): string {
  return `
    <div class="v2-python">
      <header class="python-page-toolbar v2-python-toolbar">
        <span id="python-capability" class="state-text">Python check pending</span>
        <button id="python-refresh" class="button button-ghost" type="button">Refresh Python</button>
      </header>

      <div class="python-workbench v2-python-workbench">
        <section class="workbench-pane python-editor-panel python-direct-editor v2-python-editor">
          <header class="pane-toolbar">
            <strong data-no-i18n>script.py</strong>
            <span class="state-text">Python source</span>
          </header>
          <div id="python-code-editor" class="workbench-code-editor python-code-editor"></div>
        </section>

        <aside class="python-status-panel python-run-config v2-python-config" aria-labelledby="python-config-title">
          <header class="pane-toolbar">
            <strong id="python-config-title">Run configuration</strong>
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
              <div><dt>Launcher</dt><dd id="python-launcher" data-no-i18n>—</dd></div>
              <div><dt>Version</dt><dd id="python-version" data-no-i18n>—</dd></div>
              <div><dt>Isolation</dt><dd>CPython isolated mode (-I). User site-packages and PYTHON* environment variables are ignored.</dd></div>
              <div><dt>Network</dt><dd>Host network is available. No domain-level network restriction is applied.</dd></div>
            </dl>
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
          </details>
        </aside>

        <section id="python-live-console" class="python-live-console v2-python-output" aria-label="Python output">
          <header class="v2-python-output-toolbar">
            <div class="v2-python-output-tabs" role="tablist" aria-label="Python output">
              <button id="python-output-tab-stdout" class="button button-ghost" type="button" role="tab" aria-selected="true" aria-controls="python-live-stdout" tabindex="0" data-no-i18n>stdout</button>
              <button id="python-output-tab-stderr" class="button button-ghost" type="button" role="tab" aria-selected="false" aria-controls="python-live-stderr" tabindex="-1" data-no-i18n>stderr</button>
            </div>
            <button id="python-live-cancel" class="button button-secondary" type="button" disabled>Cancel run</button>
          </header>
          <div class="v2-python-output-content">
            <pre id="python-live-stdout" role="tabpanel" aria-labelledby="python-output-tab-stdout" tabindex="0" data-no-i18n></pre>
            <pre id="python-live-stderr" role="tabpanel" aria-labelledby="python-output-tab-stderr" tabindex="0" data-no-i18n hidden></pre>
            <p id="python-live-empty" class="v2-python-output-empty" role="status">Run output appears here.</p>
          </div>
          <footer class="v2-python-output-status">
            <div class="v2-python-run-meta">
              <span id="python-live-state" class="state-text">Python run pending</span>
              <span id="python-live-meta" class="state-text"></span>
              <span id="python-live-run-id" class="v2-python-run-id" data-no-i18n>—</span>
            </div>
            <button id="python-live-details" class="button button-ghost" type="button" data-open-view="runs" disabled>Details</button>
          </footer>
        </section>
      </div>

      <footer class="v2-python-footer">
        <div class="v2-python-main-actions">
          <button id="python-all-runs" class="button button-ghost" type="button" data-open-view="runs">View all runs</button>
          <button id="python-start-secondary" class="button button-primary" type="button">Run now</button>
        </div>
      </footer>
    </div>
  `;
}
