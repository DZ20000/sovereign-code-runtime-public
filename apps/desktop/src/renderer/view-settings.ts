export function renderSettingsView(): string {
  return `
    <div class="settings-nav-row">
      <nav class="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="horizontal">
        <button id="settings-tab-appearance" class="settings-tab is-active" role="tab" type="button" data-settings-tab="appearance" aria-controls="settings-pane-appearance" aria-selected="true" tabindex="0">Appearance</button>
        <button id="settings-tab-host" class="settings-tab" role="tab" type="button" data-settings-tab="host" aria-controls="settings-pane-host" aria-selected="false" tabindex="-1">Host</button>
        <button id="settings-tab-security" class="settings-tab" role="tab" type="button" data-settings-tab="security" aria-controls="settings-pane-security" aria-selected="false" tabindex="-1">Permissions &amp; Security</button>
        <button id="settings-tab-diagnostics" class="settings-tab" role="tab" type="button" data-settings-tab="diagnostics" aria-controls="settings-pane-diagnostics" aria-selected="false" tabindex="-1">Diagnostics</button>
      </nav>
      <button id="reset-interface-settings" class="button button-ghost settings-reset-button" type="button">Reset UI preferences</button>
    </div>

    <div class="settings-workbench">
      <div class="settings-content">
        <section id="settings-pane-appearance" class="settings-pane is-active" role="tabpanel" aria-labelledby="settings-tab-appearance" data-settings-pane="appearance" tabindex="0">
          <section class="settings-section settings-section-first">
            <div class="settings-section-heading"><h3>Interface</h3></div>
            <div class="settings-row-list">
              <label class="settings-row settings-row-control" for="ui-language">
                <div><strong>Language</strong><small>Switches the local interface immediately.</small></div>
                <select id="ui-language" class="settings-select">
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label class="settings-row settings-row-control" for="ui-experience-mode">
                <div><strong>Interface mode</strong><small>Simple keeps remote-host essentials; Full shows every local execution and diagnostic surface.</small></div>
                <select id="ui-experience-mode" class="settings-select">
                  <option value="simple">Simple</option>
                  <option value="full">Full</option>
                </select>
              </label>
              <label class="settings-row settings-row-control" for="sidebar-collapsed-setting">
                <div><strong>Icon-only sidebar</strong><small>Shows navigation icons with tooltips and gives the current page more room.</small></div>
                <span class="toggle-control compact-toggle">
                  <input id="sidebar-collapsed-setting" type="checkbox" />
                  <span class="toggle-track" aria-hidden="true"><i></i></span>
                </span>
              </label>
              <label class="settings-row settings-row-control" for="ui-startup-view">
                <div><strong>Startup page</strong></div>
                <select id="ui-startup-view" class="settings-select">
                  <option value="overview">Home</option>
                  <option value="tasks">Tasks</option>
                  <option value="agent">ChatGPT Connection</option>
                  <option value="runs">Task History</option>
                  <option value="last">Last viewed</option>
                </select>
              </label>
              <label class="settings-row settings-row-control" for="ui-scale">
                <div><strong>UI scale</strong><small>Scales Sovereign independently from Windows display scaling.</small></div>
                <select id="ui-scale" class="settings-select">
                  <option value="1">100%</option>
                  <option value="1.1">110%</option>
                  <option value="1.25">125%</option>
                  <option value="1.5">150%</option>
                </select>
              </label>
              <label class="settings-row settings-row-control" for="ui-font-scale">
                <div><strong>Font size</strong><small>Adjusts text independently from the overall UI scale.</small></div>
                <select id="ui-font-scale" class="settings-select">
                  <option value="1">100%</option>
                  <option value="1.1">110%</option>
                  <option value="1.2">120%</option>
                  <option value="1.3">130%</option>
                </select>
              </label>
              <label class="settings-row settings-row-control" for="ui-reduced-motion">
                <div><strong>Reduce motion</strong></div>
                <span class="toggle-control compact-toggle">
                  <input id="ui-reduced-motion" type="checkbox" />
                  <span class="toggle-track" aria-hidden="true"><i></i></span>
                </span>
              </label>
            </div>
          </section>
        </section>

        <section id="settings-pane-host" class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-host" data-settings-pane="host" tabindex="0" hidden>
          <section class="settings-section settings-section-first">
            <div class="settings-section-heading"><h3>Authorized workspace</h3></div>
            <div class="settings-row-list">
              <div class="settings-row settings-row-primary">
                <div class="settings-path-value"><strong id="workspace-page-path">No workspace selected</strong></div>
                <button id="workspace-page-choose" class="button button-secondary" type="button">Choose workspace</button>
              </div>
            </div>
            <p class="settings-inline-note">Changing the workspace restarts the local runtime and closes workspace-bound sessions. The selected permission is kept; the unattended binding is cleared.</p>
          </section>

          <section class="settings-section remote-host-section">
            <div class="settings-section-heading">
              <h3>Remote host</h3>
              <span id="remote-host-status" class="settings-section-meta">Checking…</span>
            </div>
            <div class="remote-host-summary">
              <div>
                <strong>Run workspace tasks after Windows sign-in</strong>
                <small>Sovereign restores the authorized folder and selected permission, starts the Gateway and trusted Secure MCP Tunnel, and keeps running in the notification area.</small>
              </div>
              <button id="remote-host-enable" class="button button-primary" type="button">Enable unattended host</button>
            </div>
            <div class="settings-row-list remote-host-row-list">
              <label class="settings-row settings-row-control" for="host-launch-at-login">
                <div><strong>Start Sovereign at Windows login</strong><small>Registers the current executable for this Windows user; administrator access is not required.</small></div>
                <span class="toggle-control compact-toggle">
                  <input id="host-launch-at-login" type="checkbox" />
                  <span class="toggle-track" aria-hidden="true"><i></i></span>
                  <b id="host-launch-label">Off</b>
                </span>
              </label>
              <label class="settings-row settings-row-control" for="auto-start-runtime">
                <div><strong>Start Gateway with app</strong><small>Creates the loopback-only MCP endpoint after the authorized workspace is restored.</small></div>
                <span class="toggle-control compact-toggle">
                  <input id="auto-start-runtime" type="checkbox" />
                  <span class="toggle-track" aria-hidden="true"><i></i></span>
                  <b id="auto-start-label">Off</b>
                </span>
              </label>
              <label class="settings-row settings-row-control" for="unattended-workspace-access">
                <div><strong>Restore this workspace after sign-in</strong><small>Keeps this exact authorized folder available for unattended tasks after Windows sign-in. This startup setting does not change the selected permission.</small></div>
                <span class="toggle-control compact-toggle">
                  <input id="unattended-workspace-access" type="checkbox" />
                  <span class="toggle-track" aria-hidden="true"><i></i></span>
                  <b id="unattended-workspace-access-label">Off</b>
                </span>
              </label>
              <label class="settings-row settings-row-control" for="tunnel-auto-start">
                <div><strong>Start Secure MCP Tunnel</strong><small>Runs only when the connector digest is trusted and the Tunnel ID and protected runtime key are present.</small></div>
                <span class="toggle-control compact-toggle">
                  <input id="tunnel-auto-start" type="checkbox" />
                  <span class="toggle-track" aria-hidden="true"><i></i></span>
                  <b id="tunnel-auto-start-label">Off</b>
                </span>
              </label>
              <label class="settings-row settings-row-control" for="tunnel-auto-reconnect">
                <div><strong>Restart connector after exit</strong><small>Uses bounded exponential backoff; normal network recovery remains handled by the official connector.</small></div>
                <span class="toggle-control compact-toggle">
                  <input id="tunnel-auto-reconnect" type="checkbox" />
                  <span class="toggle-track" aria-hidden="true"><i></i></span>
                  <b id="tunnel-auto-reconnect-label">On</b>
                </span>
              </label>
              <div class="settings-row">
                <div><strong>Host Guardian</strong><small id="host-guardian-detail">Checking host protection.</small></div>
                <span id="host-guardian-state" class="settings-state">Checking…</span>
              </div>
              <div class="settings-row">
                <div><strong>Power &amp; network recovery</strong><small id="host-availability-detail">Checking power and Tunnel recovery evidence.</small></div>
                <span id="host-availability-state" class="settings-state">Checking…</span>
              </div>
            </div>
            <p id="remote-host-detail" class="settings-inline-note">Checking the local startup and tunnel prerequisites.</p>
            <p id="host-startup-warning" class="settings-inline-note settings-warning-note" hidden></p>
          </section>

          <section class="settings-section simple-mode-hidden">
            <div class="settings-section-heading"><h3>Workspace protection</h3><span class="settings-section-meta">3 protections enforced</span></div>
            <div class="settings-row-list policy-row-list">
              <div class="settings-row"><div><strong>Files stay inside the selected folder</strong><small>Absolute paths, UNC paths and parent traversal are blocked.</small></div><span class="settings-state is-on">Enforced</span></div>
              <div class="settings-row"><div><strong>Links cannot escape the workspace</strong><small>Junctions and reparse points resolving outside the root are rejected.</small></div><span class="settings-state is-on">Enforced</span></div>
              <div class="settings-row"><div><strong>Existing files are protected</strong><small>Replacement requires the current SHA-256 digest to prevent stale overwrites.</small></div><span class="settings-state is-on">Enforced</span></div>
            </div>
          </section>

          <section class="settings-section simple-mode-hidden">
            <div class="settings-section-heading"><h3>Runtime</h3></div>
            <div class="settings-row-list">
              <div class="settings-row"><div><strong>Gateway binding</strong></div><code class="settings-value">127.0.0.1 · ephemeral port</code></div>
              <div class="settings-row"><div><strong>Gateway credential</strong><small>Fresh for each runtime launch; never persisted to disk.</small></div><span class="settings-value">Process memory</span></div>
              <div class="settings-row"><div><strong>Permission after restart</strong><small id="restart-authority-detail">The selected permission is restored only for this authorized workspace.</small></div><span id="restart-authority-value" class="settings-value">Read only · L1</span></div>
            </div>
          </section>
        </section>

        <section id="settings-pane-security" class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-security" data-settings-pane="security" tabindex="0" hidden>
          <section class="settings-section settings-section-first">
            <div class="settings-section-heading"><h3>ChatGPT permissions</h3><span id="settings-authority-label" class="visually-hidden" aria-live="polite">Read only · L1</span></div>
            <p id="settings-permission-guidance" class="settings-inline-note settings-permission-intro">Choose one permission level. Changes apply immediately to connected sessions.</p>
            <div id="settings-permission-profiles" class="permission-segment settings-permission-segment" role="group" aria-label="ChatGPT permission level">
              <button class="permission-profile-option" data-permission-profile="observe" type="button" aria-pressed="false">
                <span class="permission-profile-indicator" aria-hidden="true"></span>
                <span class="permission-profile-copy"><strong class="permission-profile-title">Read only</strong><span class="permission-profile-description">Read files, search and inspect project status.</span></span>
                <span class="permission-profile-level">L1 · Observe</span>
              </button>
              <button class="permission-profile-option" data-permission-profile="workspace" type="button" aria-pressed="false">
                <span class="permission-profile-indicator" aria-hidden="true"></span>
                <span class="permission-profile-copy"><strong class="permission-profile-title">Work in this folder</strong><span class="permission-profile-description">Read and edit files inside the authorized folder.</span></span>
                <span class="permission-profile-level">L2 · Workspace</span>
              </button>
              <button class="permission-profile-option" data-permission-profile="consequential" type="button" aria-pressed="false">
                <span class="permission-profile-indicator" aria-hidden="true"></span>
                <span class="permission-profile-copy"><strong class="permission-profile-title">Ask for high-risk actions</strong><span class="permission-profile-description">Work in this folder; ask before high-risk actions.</span></span>
                <span class="permission-profile-level">L3 · Confirm</span>
              </button>
              <button id="settings-bypass-toggle" class="permission-profile-option permission-bypass-option" data-bypass-toggle data-permission-bypass type="button" aria-pressed="false" aria-describedby="settings-bypass-description">
                <span class="permission-profile-indicator" aria-hidden="true"></span>
                <span class="permission-profile-copy"><strong class="permission-profile-title">Without confirmation</strong><span id="settings-bypass-description" class="permission-profile-description">Allow actions without Sovereign approval prompts.</span></span>
                <span class="permission-profile-level">L4 · No prompts</span>
              </button>
            </div>
            <span id="settings-bypass-state" class="visually-hidden">Off</span>
          </section>

          <details class="settings-details settings-section settings-capabilities-section simple-mode-hidden">
            <summary><span>Capabilities</span><span id="settings-capability-count">0</span></summary>
            <div class="settings-details-body">
              <div class="filter-toolbar">
                <input id="capability-search" class="filter-input" type="search" autocomplete="off" placeholder="Search capabilities" />
                <select id="capability-level-filter" class="settings-select" aria-label="Capability authority filter">
                  <option value="all">All levels</option>
                  <option value="observe">L1 Observe</option>
                  <option value="workspace">L2 Workspace</option>
                  <option value="consequential">L3 Consequential</option>
                </select>
              </div>
              <div class="capability-table">
                <div class="capability-table-header"><span>Group</span><span>Capability</span><span>Authority</span></div>
                <div id="capability-list" class="capability-list"></div>
              </div>
            </div>
          </details>

          <details class="settings-details settings-section simple-mode-hidden">
            <summary><span>Tool manifest</span><span id="manifest-generated">Unavailable</span></summary>
            <div id="manifest-groups" class="manifest-groups"><div class="quiet-empty">Start the runtime to load the manifest.</div></div>
          </details>
        </section>

        <section id="settings-pane-diagnostics" class="settings-pane" role="tabpanel" aria-labelledby="settings-tab-diagnostics" data-settings-pane="diagnostics" tabindex="0" hidden>
          <section class="settings-section settings-section-first">
            <div class="settings-section-heading"><h3>Status monitoring</h3></div>
            <div class="settings-row-list">
              <label class="settings-row settings-row-control" for="ui-refresh-interval">
                <div><strong>Status refresh frequency</strong><small>Controls visible host, task, audit and terminal status updates.</small></div>
                <select id="ui-refresh-interval" class="settings-select">
                  <option value="1000">1 second</option>
                  <option value="3000">3 seconds</option>
                  <option value="5000">5 seconds</option>
                  <option value="10000">10 seconds</option>
                </select>
              </label>
            </div>
          </section>

          <section class="settings-section">
            <div class="settings-section-heading">
              <h3>Renderer updates</h3>
              <div class="settings-heading-actions">
                <span id="renderer-update-meta" class="settings-section-meta">Checking…</span>
                <button id="renderer-update-refresh" class="button button-secondary" type="button">Refresh</button>
              </div>
            </div>
            <div class="settings-row-list">
              <div class="settings-row">
                <div><strong>Active interface</strong><small id="renderer-update-active-detail">Checking the signed renderer slot.</small></div>
                <span id="renderer-update-active" class="settings-state">Checking…</span>
              </div>
              <div class="settings-row">
                <div><strong>Last known good</strong><small>Used automatically when a candidate fails readiness after activation.</small></div>
                <span id="renderer-update-lkg" class="settings-value">Built-in</span>
              </div>
              <label class="settings-row settings-row-control" for="renderer-update-release">
                <div><strong>Candidate release</strong><small>Signed releases appear after they are placed in the local renderer inbox.</small></div>
                <select id="renderer-update-release" class="settings-select">
                  <option value="">No candidate available</option>
                </select>
              </label>
            </div>
            <div class="page-toolbar-actions renderer-update-actions">
              <button id="renderer-update-install" class="button button-secondary" type="button">Install</button>
              <button id="renderer-update-preflight" class="button button-secondary" type="button">Preflight</button>
              <button id="renderer-update-activate" class="button button-primary" type="button">Activate</button>
              <button id="renderer-update-rollback" class="button button-danger-outline" type="button">Rollback</button>
            </div>
            <p id="renderer-update-detail" class="settings-inline-note">Renderer updates are disabled until at least one trusted Ed25519 release key is provisioned by the signed shell.</p>
          </section>

          <section class="settings-section">
            <div class="settings-section-heading">
              <h3>Runtime Host candidates</h3>
              <div class="settings-heading-actions">
                <span id="runtime-candidate-meta" class="settings-section-meta">Checking…</span>
                <button id="runtime-candidate-refresh" class="button button-secondary" type="button">Refresh</button>
              </div>
            </div>
            <div class="settings-row-list">
              <div class="settings-row">
                <div><strong>Active Runtime release</strong><small>The signed release restored after a successful cutover.</small></div>
                <span id="runtime-candidate-active" class="settings-value">Built-in</span>
              </div>
              <div class="settings-row">
                <div><strong>Trusted signing keys</strong><small>Provisioned only by the signed Tauri shell or a controlled test environment.</small></div>
                <span id="runtime-candidate-trust" class="settings-value">0 keys</span>
              </div>
              <label class="settings-row settings-row-control" for="runtime-candidate-release">
                <div><strong>Candidate release</strong><small>Signed packages appear after they are placed in the managed Runtime inbox.</small></div>
                <select id="runtime-candidate-release" class="settings-select">
                  <option value="">No Runtime candidate available</option>
                </select>
              </label>
            </div>
            <div class="page-toolbar-actions runtime-candidate-actions">
              <button id="runtime-candidate-install" class="button button-secondary" type="button">Install</button>
              <button id="runtime-candidate-activate" class="button button-primary" type="button">Activate</button>
            </div>
            <p id="runtime-candidate-detail" class="settings-inline-note">Runtime Host candidates are disabled until at least one trusted Ed25519 signing key is provisioned.</p>
          </section>

          <section class="settings-section">
            <div class="settings-section-heading">
              <h3>Runtime Host rolling updates</h3>
              <div class="settings-heading-actions">
                <span id="runtime-rolling-meta" class="settings-section-meta">Checking…</span>
                <button id="runtime-rolling-refresh" class="button button-secondary" type="button">Refresh</button>
              </div>
            </div>
            <div class="settings-row-list">
              <div class="settings-row">
                <div><strong>Authoritative Runtime Host</strong><small>The desktop control path resolves through the generation-fenced Runtime Host router.</small></div>
                <span id="runtime-rolling-active" class="settings-value">Checking…</span>
              </div>
              <div class="settings-row">
                <div><strong>Traffic generation</strong><small>Changes atomically when a drained, checkpointed candidate becomes authoritative.</small></div>
                <span id="runtime-rolling-generation" class="settings-value">—</span>
              </div>
              <div class="settings-row">
                <div><strong>Checkpoint fence</strong><small>Post-cutover writes must match the durable checkpoint fencing token.</small></div>
                <span id="runtime-rolling-fence" class="settings-value">None</span>
              </div>
            </div>
            <p id="runtime-rolling-detail" class="settings-inline-note">Checking whether a verified side-by-side candidate launcher is configured.</p>
          </section>

          <section class="settings-section">
            <div class="settings-section-heading">
              <h3>Host availability</h3>
              <span id="availability-sampled" class="settings-section-meta">Not sampled</span>
            </div>
            <div class="resource-summary-grid availability-summary-grid">
              <div class="resource-summary-item"><span>Power source</span><strong id="availability-power-source">—</strong></div>
              <div class="resource-summary-item"><span>Battery</span><strong id="availability-battery">—</strong></div>
              <div class="resource-summary-item"><span>Network recovery</span><strong id="availability-network-state">—</strong></div>
              <div class="resource-summary-item"><span>Possible sleep / stall</span><strong id="availability-last-gap">—</strong></div>
              <div class="resource-summary-item"><span>Last recovery</span><strong id="availability-last-recovery">—</strong></div>
              <div class="resource-summary-item"><span>Event evidence</span><strong id="availability-event-storage">—</strong></div>
            </div>
            <p id="availability-detail" class="settings-inline-note">The monitor reports long scheduling gaps as possible sleep/resume or severe host stalls; it does not claim an exact Windows power event.</p>
            <div id="availability-event-list" class="availability-event-list"><div class="compact-empty">No availability events recorded.</div></div>
          </section>

          <section class="settings-section">
            <div class="settings-section-heading">
              <h3>Resources</h3>
              <div class="settings-heading-actions">
                <span id="resources-captured" class="settings-section-meta">Not sampled</span>
                <button id="resources-refresh" class="button button-secondary" type="button">Refresh</button>
              </div>
            </div>
            <div class="resource-summary-grid">
              <div class="resource-summary-item"><span>Product private</span><strong id="resources-product-private">—</strong></div>
              <div class="resource-summary-item"><span>Shell private</span><strong id="resources-shell-private">—</strong></div>
              <div class="resource-summary-item"><span>Runtime private</span><strong id="resources-runtime-private">—</strong></div>
              <div class="resource-summary-item"><span>Services private</span><strong id="resources-services-private">—</strong></div>
              <div class="resource-summary-item"><span>Working set</span><strong id="resources-working-set">—</strong></div>
              <div class="resource-summary-item"><span>Processes</span><strong id="resources-process-count">—</strong></div>
            </div>
            <div class="resource-launch-line">
              <span>Launch</span>
              <strong id="resources-launch-kind">Unknown</strong>
              <code id="resources-executable-path" title="">—</code>
            </div>
            <p class="settings-inline-note">Runtime placement: <strong id="resources-runtime-placement">Embedded in desktop main</strong>. While embedded, desktop-main includes Gateway/runtime memory and is not counted a second time as Runtime. Snapshots are sampled only when this page is opened or refreshed.</p>
          </section>

          <section class="settings-section">
            <div class="settings-section-heading"><h3>Owned processes</h3><span id="resources-process-meta" class="settings-section-meta">0 processes</span></div>
            <div class="resource-process-table">
              <div class="resource-process-header"><span>Role</span><span>Process</span><span>PID</span><span>Private</span><span>Working set</span><span>CPU</span></div>
              <div id="resources-process-list" class="resource-process-list"><div class="compact-empty">Open Diagnostics to sample resources.</div></div>
            </div>
          </section>
        </section>
      </div>
    </div>
  `;
}
