export function renderRunsView(): string {
  return `
    <div class="page-toolbar task-history-toolbar">
      <div class="page-toolbar-copy">
        <span id="runs-refreshed" class="state-text">Waiting for refresh</span>
      </div>
      <div class="page-toolbar-actions">
        <div class="subview-tabs" role="tablist" aria-label="Task history views">
          <button id="runs-tab-runs" class="subview-tab is-active" role="tab" type="button" data-runs-tab="runs" aria-controls="runs-pane-runs" aria-selected="true" tabindex="0">Run history</button>
          <button id="runs-tab-audit" class="subview-tab" role="tab" type="button" data-runs-tab="audit" aria-controls="runs-pane-audit" aria-selected="false" tabindex="-1">Audit receipts</button>
        </div>
        <button id="runs-refresh" class="button button-ghost" type="button">Refresh</button>
      </div>
    </div>

    <section id="active-run-section" class="active-run-section" aria-labelledby="active-run-heading" hidden>
      <header class="active-run-header">
        <div>
          <span class="panel-kicker">CURRENT TASK</span>
          <h2 id="active-run-heading">Task in progress</h2>
        </div>
        <div class="active-run-header-status">
          <span id="active-run-count" class="state-text">1 active task</span>
          <span id="active-run-state" class="run-state run-state-running" aria-live="polite">running</span>
        </div>
      </header>
      <div class="active-run-body">
        <div class="active-run-identity">
          <strong id="active-run-title">Loading task…</strong>
          <span id="active-run-kind">—</span>
        </div>
        <dl class="active-run-meta">
          <div><dt>Started</dt><dd id="active-run-started">—</dd></div>
          <div><dt>Duration</dt><dd id="active-run-duration">—</dd></div>
        </dl>
        <div class="active-run-output-heading">
          <strong id="active-run-output-label">Recent output</strong>
          <span id="active-run-output-size">0 B</span>
        </div>
        <pre id="active-run-output" class="active-run-output" aria-live="polite" data-i18n-placeholder>No output yet.</pre>
      </div>
      <footer class="active-run-actions">
        <button id="active-run-view" class="button button-secondary" type="button">View details</button>
        <button id="active-run-cancel" class="button button-danger-outline" type="button">Cancel task</button>
      </footer>
    </section>

    <section id="active-run-empty" class="current-task-empty" aria-labelledby="active-run-empty-heading">
      <div>
        <span class="panel-kicker">CURRENT TASK</span>
        <strong id="active-run-empty-heading">No task is running</strong>
        <small>New background tasks will appear here with live output and cancellation.</small>
      </div>
    </section>

    <section id="runs-pane-runs" class="runs-pane is-active" role="tabpanel" aria-labelledby="runs-tab-runs" data-runs-pane="runs" tabindex="0">
      <section id="runs-empty-state" class="task-empty-state runs-empty-state">
        <strong>No run history yet</strong>
        <span>Python tasks, workflows, validation jobs and managed processes appear here with output, duration and exit status.</span>
        <div class="task-empty-actions">
          <button class="button button-primary" type="button" data-open-view="python">Open Python</button>
          <button class="button button-secondary" type="button" data-open-view="workflows">Open Workflows</button>
          <button class="button button-ghost" type="button" data-open-view="terminal">Open Terminal</button>
        </div>
      </section>

      <div id="runs-workbench" class="runs-layout" hidden>
        <section class="workbench-pane runs-list-panel">
          <header class="pane-toolbar">
            <strong>History</strong>
            <span id="runs-count" class="state-text">0 runs</span>
          </header>
          <div id="runs-list" class="runs-list compact-run-list"></div>
        </section>

        <section class="workbench-pane run-detail-panel">
          <header class="pane-toolbar">
            <div class="pane-title"><strong id="run-detail-title">Select a run</strong></div>
            <button id="run-cancel" class="button button-secondary" type="button" disabled>Cancel task</button>
          </header>

          <dl id="run-detail-meta" class="run-detail-meta compact-run-meta">
            <div><dt>State</dt><dd>—</dd></div>
            <div><dt>Started</dt><dd>—</dd></div>
            <div><dt>Duration</dt><dd>—</dd></div>
            <div><dt>Exit</dt><dd>—</dd></div>
          </dl>

          <div class="run-output-tabs" role="tablist" aria-label="Run output">
            <button id="run-output-tab-stdout" class="run-output-tab is-active" role="tab" type="button" data-run-output-tab="stdout" aria-controls="run-output-pane-stdout" aria-selected="true" tabindex="0">Output <span id="run-stdout-size">0 B</span></button>
            <button id="run-output-tab-stderr" class="run-output-tab" role="tab" type="button" data-run-output-tab="stderr" aria-controls="run-output-pane-stderr" aria-selected="false" tabindex="-1">Errors <span id="run-stderr-size">0 B</span></button>
          </div>
          <section id="run-output-pane-stdout" class="run-output-pane is-active" role="tabpanel" aria-labelledby="run-output-tab-stdout" data-run-output-pane="stdout" tabindex="0"><pre id="run-stdout" class="run-output" data-i18n-placeholder>Select a run to inspect output.</pre></section>
          <section id="run-output-pane-stderr" class="run-output-pane" role="tabpanel" aria-labelledby="run-output-tab-stderr" data-run-output-pane="stderr" tabindex="0" hidden><pre id="run-stderr" class="run-output" data-i18n-placeholder>Select a run to inspect output.</pre></section>
        </section>
      </div>
    </section>

    <section id="runs-pane-audit" class="runs-pane" role="tabpanel" aria-labelledby="runs-tab-audit" data-runs-pane="audit" tabindex="0" hidden>
      <div class="audit-toolbar">
        <input id="audit-search" class="filter-input" type="search" aria-label="Search audit receipts" autocomplete="off" placeholder="Filter by tool, operation or path" />
        <select id="audit-outcome-filter" class="settings-select" aria-label="Audit outcome filter">
          <option value="all">All outcomes</option>
          <option value="succeeded">Succeeded</option>
          <option value="denied">Denied</option>
          <option value="failed">Failed</option>
        </select>
        <span id="audit-count" class="state-text">0 receipts</span>
        <button id="refresh-audit" class="button button-ghost" type="button">Refresh</button>
      </div>
      <div class="audit-table-shell">
        <div class="table-scroll">
          <table>
            <thead><tr><th>Time</th><th>Tool</th><th>Operation</th><th>Path</th><th>Outcome</th></tr></thead>
            <tbody id="audit-body"><tr><td class="table-empty" colspan="5">No audit receipts yet.</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}
