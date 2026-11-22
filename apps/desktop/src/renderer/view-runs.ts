/** Mounted once inside Tasks; its controller moves it between scoped output and history. */
export function renderRunsWorkbench(): string {
  return `
    <div id="runs-workbench-root" class="v2-runs" data-run-scope="all">
      <header class="v2-run-toolbar">
        <span id="runs-scope-label" class="state-text">All runs</span>
        <span id="runs-count" class="state-text">0 runs</span>
        <span id="runs-refreshed" class="state-text">Waiting for refresh</span>
        <button id="run-scope-all" class="button button-ghost" type="button" hidden>View all runs</button>
        <button id="runs-refresh" class="button button-ghost" type="button">Refresh</button>
      </header>
      <section id="runs-empty-state" class="v2-run-empty" role="status" aria-live="polite">
        <strong id="runs-empty-title">No run history yet</strong>
        <span id="runs-empty-description">Python tasks, workflows, validation jobs and managed processes appear here with output, duration and exit status.</span>
      </section>
      <div id="runs-workbench" class="v2-run-workbench" hidden>
        <div id="runs-list" class="v2-run-list" role="group" aria-label="Run history"></div>
        <section class="v2-run-detail" aria-labelledby="run-detail-title">
          <header class="v2-run-heading">
            <strong id="run-detail-title">Select a run</strong>
            <span id="run-detail-association" class="state-text"></span>
          </header>
          <p id="run-detail-identity" class="v2-run-identity" data-no-i18n></p>
          <dl id="run-detail-meta" class="v2-run-meta">
            <div><dt>State</dt><dd>—</dd></div>
            <div><dt>Started</dt><dd>—</dd></div>
            <div><dt>Duration</dt><dd>—</dd></div>
            <div><dt>Exit</dt><dd>—</dd></div>
          </dl>
          <div class="v2-run-output">
            <div class="run-output-tabs v2-run-output-tabs" role="tablist" aria-label="Run output">
              <button id="run-output-tab-stdout" class="run-output-tab is-active" role="tab" type="button" data-run-output-tab="stdout" aria-controls="run-output-pane-stdout" aria-selected="true" tabindex="0"><span data-no-i18n>stdout</span> <span id="run-stdout-size">0 B</span></button>
              <button id="run-output-tab-stderr" class="run-output-tab" role="tab" type="button" data-run-output-tab="stderr" aria-controls="run-output-pane-stderr" aria-selected="false" tabindex="-1"><span data-no-i18n>stderr</span> <span id="run-stderr-size">0 B</span></button>
            </div>
            <section id="run-output-pane-stdout" class="run-output-pane is-active" role="tabpanel" aria-labelledby="run-output-tab-stdout" data-run-output-pane="stdout" tabindex="0"><pre id="run-stdout" class="run-output" data-i18n-placeholder>Select a run to inspect output.</pre></section>
            <section id="run-output-pane-stderr" class="run-output-pane" role="tabpanel" aria-labelledby="run-output-tab-stderr" data-run-output-pane="stderr" tabindex="0" hidden><pre id="run-stderr" class="run-output" data-i18n-placeholder>Select a run to inspect output.</pre></section>
            <p id="run-output-truncated" class="state-text" role="status" hidden>Output was truncated.</p>
          </div>
          <footer class="v2-panel-footer">
            <button id="run-cancel" class="button button-secondary" type="button" disabled>Cancel run</button>
            <button id="run-back-conversation" class="button button-primary" type="button" hidden>View task conversation</button>
          </footer>
        </section>
      </div>
    </div>
  `;
}

/** Compatibility export while the root route moves to Tasks. Do not mount twice. */
export function renderRunsView(): string {
  return renderRunsWorkbench();
}
