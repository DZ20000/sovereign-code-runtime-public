export function renderOverviewView(): string {
  return `
    <section id="simple-overview" class="simple-overview" aria-labelledby="simple-overview-title">
      <div class="simple-overview-lead">
        <div>
          <h2 id="simple-overview-title">Checking remote host…</h2>
          <p id="simple-overview-detail">Checking the computer, connection and unattended access.</p>
        </div>
        <span id="simple-overview-badge" class="simple-overview-badge" data-tone="pending" aria-live="polite">Checking…</span>
      </div>

      <dl class="simple-overview-status-list">
        <div>
          <dt>Workspace</dt>
          <dd><strong id="simple-overview-workspace">Not selected</strong><small>Authorized folder</small></dd>
        </div>
        <div>
          <dt>Computer</dt>
          <dd><strong id="simple-overview-runtime" data-tone="pending">Checking…</strong><small id="simple-overview-startup">Checking Windows login startup.</small></dd>
        </div>
        <div>
          <dt>Connection</dt>
          <dd><strong id="simple-overview-connection" data-tone="pending">Checking…</strong><small id="simple-overview-session">No active ChatGPT session</small></dd>
        </div>
        <div class="simple-overview-permission-row">
          <dt>Permission</dt>
          <dd><strong id="simple-overview-access" data-tone="pending">Read only · L1</strong><small id="simple-overview-access-detail">Workspace tasks are off</small></dd>
          <button class="button button-secondary simple-overview-row-action" type="button" data-open-settings-tab="security">Change permission</button>
        </div>
      </dl>

      <div class="simple-overview-actions">
        <button id="simple-overview-primary" class="button button-primary" type="button" data-simple-overview-action="none" disabled>Checking…</button>
      </div>
    </section>

    <div class="overview-full-content">
      <div class="home-command-grid">
        <section class="home-hero" aria-labelledby="home-host-title">
        <div class="home-hero-copy">
          <span id="home-host-badge" class="home-status-badge" data-tone="pending">Checking…</span>
          <h2 id="home-host-title">Checking this computer…</h2>
          <p id="home-host-detail">Reading the host, ChatGPT connection, permission and task state.</p>
          <div class="home-workspace-line">
            <span>Workspace</span>
            <strong id="detail-workspace">Not selected</strong>
          </div>
        </div>
        <div class="home-hero-actions">
          <button id="choose-workspace" class="button button-secondary" type="button">Choose workspace</button>
          <span id="runtime-command-state" class="state-text">Runtime stopped</span>
          <button id="start-runtime" class="button button-primary" type="button">Start runtime</button>
          <button id="stop-runtime" class="button button-secondary" type="button">Stop runtime</button>
          <button id="refresh-runtime" class="icon-button" type="button" aria-label="Refresh runtime" title="Refresh runtime">↻</button>
        </div>
        </section>

        <section class="home-summary-grid" aria-label="Home status">
        <button class="home-summary-card" type="button" data-open-view="agent">
          <span>ChatGPT</span>
          <strong id="home-connection">Checking…</strong>
          <small id="home-session">No active ChatGPT session</small>
          <i>Open connection</i>
        </button>
        <button class="home-summary-card home-permission-card" type="button" data-open-settings-tab="security">
          <span>Permission</span>
          <strong id="home-permission">Read only</strong>
          <small id="home-permission-detail">Read-only access</small>
          <i>Change permission</i>
        </button>
        <section class="home-summary-card home-active-work-card" aria-labelledby="home-active-work-title">
          <div class="home-active-work-heading">
            <span id="home-active-work-title">Active work</span>
            <small id="home-active-work-count" aria-live="polite">0 items</small>
          </div>
          <div id="home-active-work-carousel" class="active-work-carousel" role="listbox" tabindex="0" aria-label="Active work navigator">
            <div class="active-work-empty">No active work</div>
          </div>
          <button id="home-task-action" class="button button-ghost home-active-work-open" type="button" data-open-view="tasks">Open tasks</button>
        </section>
        <button class="home-summary-card" type="button" data-open-settings-tab="host">
          <span>Workspace</span>
          <strong id="home-workspace-name">Not selected</strong>
          <small>Authorized folder</small>
          <i>Manage workspace</i>
        </button>
        </section>

      </div>

      <div id="setup-banner" class="setup-banner">
        <span>Select a workspace to initialize the local runtime.</span>
        <button id="setup-choose-workspace" class="button button-primary" type="button">Choose workspace</button>
      </div>

      <section id="overview-attention-section" class="workbench-panel overview-attention-panel overview-attention-priority" hidden>
        <header class="workbench-panel-header">
          <h2>Needs attention</h2>
          <span id="overview-attention-count" class="state-text">0</span>
        </header>
        <div id="overview-attention-list" class="overview-attention-list"></div>
      </section>

      <details class="home-technical-details">
        <summary>
          <span>Technical details</span>
          <span id="connection-badge" class="state-text">Runtime offline</span>
        </summary>
        <div class="home-technical-body">
          <table class="overview-runtime-table">
            <tbody>
              <tr><th>Runtime state</th><td id="metric-runtime-state">Stopped</td></tr>
              <tr><th>Version</th><td id="metric-runtime-version">—</td></tr>
              <tr><th>Local endpoint</th><td id="detail-endpoint">Not running</td></tr>
              <tr><th>Tools</th><td id="metric-tool-count">0</td></tr>
              <tr><th>Capabilities</th><td id="metric-capability-count">0</td></tr>
              <tr><th>Self-hosting</th><td id="detail-self-hosting">Checking…</td></tr>
              <tr><th>Manifest</th><td id="detail-manifest">—</td></tr>
              <tr><th>Credential</th><td id="detail-credential">Not issued</td></tr>
            </tbody>
          </table>
          <footer class="workbench-panel-footer home-technical-actions">
            <button id="copy-connection" class="button button-secondary" type="button">Copy connection</button>
            <button id="rotate-credentials" class="button button-secondary" type="button">Rotate credential</button>
            <button class="button button-ghost" type="button" data-open-settings-tab="diagnostics">Open diagnostics</button>
          </footer>
        </div>
      </details>
    </div>
  `;
}
