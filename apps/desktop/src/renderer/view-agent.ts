export function renderAgentView(): string {
  return `
    <div class="agent-workbench">
      <section class="agent-status-strip agent-status-strip-two agent-status-strip-compact" aria-label="ChatGPT connection status">
        <div class="agent-status-item">
          <span>Host</span>
          <strong id="web-agent-gateway">Host offline</strong>
        </div>
        <div class="agent-status-item">
          <span>ChatGPT</span>
          <strong id="web-agent-client">ChatGPT disconnected</strong>
        </div>
        <span class="visually-hidden" aria-live="polite"><strong id="web-session-badge">Connection not configured</strong></span>
      </section>

      <section class="agent-authority-section agent-authority-priority">
        <div class="agent-authority-heading">
          <div>
            <h2>ChatGPT permissions</h2>
            <span id="web-permission-description">Read-only access</span>
          </div>
          <strong id="web-profile-badge" class="visually-hidden" aria-live="polite">Read only · L1</strong>
        </div>
        <p id="web-permission-guidance" class="agent-authority-intro">Choose one permission level. Changes apply immediately to connected sessions.</p>
        <div id="web-permission-profiles" class="permission-segment" role="group" aria-label="ChatGPT permission level">
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
          <button id="web-bypass-toggle" class="permission-profile-option permission-bypass-option" data-bypass-toggle data-permission-bypass type="button" aria-pressed="false" aria-describedby="web-bypass-description">
            <span class="permission-profile-indicator" aria-hidden="true"></span>
            <span class="permission-profile-copy"><strong class="permission-profile-title">Without confirmation</strong><span id="web-bypass-description" class="permission-profile-description">Allow actions without Sovereign approval prompts.</span></span>
            <span class="permission-profile-level">L4 · No prompts</span>
          </button>
        </div>
        <span id="web-bypass-state" class="visually-hidden">Confirmation behavior follows the selected permission level.</span>
        <span id="web-agent-authority" hidden>Read only · L1</span>
      </section>

      <section class="agent-connect-section">
        <div class="agent-section-heading">
          <div>
            <h2>Secure MCP Tunnel</h2>
            <span id="secure-tunnel-status">Checking connector…</span>
          </div>
          <div class="agent-connect-actions">
            <button id="secure-tunnel-start" class="button button-primary" type="button">Start connection</button>
            <button id="secure-tunnel-stop" class="button button-secondary" type="button">Stop connection</button>
            <button id="secure-tunnel-refresh" class="button button-ghost" type="button">Retry detection</button>
          </div>
        </div>

        <ul id="agent-route-strip" class="agent-route-strip" hidden></ul>

        <div class="agent-field-grid agent-field-grid-primary">
          <label class="agent-field" for="secure-tunnel-id">
            <span>Tunnel ID</span>
            <input id="secure-tunnel-id" class="agent-input" type="text" autocomplete="off" spellcheck="false" placeholder="Paste tunnel ID" />
            <small class="field-security-note">From OpenAI Platform · this computer answers on this tunnel.</small>
          </label>
          <label class="agent-field" for="secure-tunnel-api-key">
            <span>Runtime key</span>
            <div class="agent-input-action">
              <input id="secure-tunnel-api-key" class="agent-input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste runtime key" />
              <button id="secure-tunnel-clear-key" class="inline-field-button" type="button">Forget</button>
            </div>
            <small id="secure-tunnel-key-storage" class="field-security-note">Not saved · paste once and Sovereign will protect it with your Windows account.</small>
          </label>
        </div>

        <div class="agent-inline-action-row">
          <div id="secure-tunnel-instructions" class="agent-inline-note">Paste the Tunnel ID and runtime key, then start the connection.</div>
          <button id="secure-tunnel-choose" class="button button-secondary" type="button">Choose connector…</button>
          <button id="secure-tunnel-retry" class="button button-ghost" type="button" hidden>Retry detection</button>
        </div>

        <details class="agent-connection-advanced agent-advanced">
          <summary>Advanced connection options</summary>
          <div class="agent-connection-advanced-body agent-advanced-content">
            <label class="agent-field agent-field-wide" for="secure-tunnel-proxy">
              <span>Primary OpenAI control-plane proxy <em>Optional</em></span>
              <div class="agent-input-action">
                <input id="secure-tunnel-proxy" class="agent-input" type="password" autocomplete="off" spellcheck="false" placeholder="http://proxy-host:port" />
                <button id="secure-tunnel-save-proxy" class="inline-field-button" type="button">Save</button>
                <button id="secure-tunnel-clear-proxy" class="inline-field-button" type="button">Forget</button>
              </div>
              <small id="secure-tunnel-proxy-storage" class="field-security-note">Not configured · only OpenAI control-plane requests use this proxy; the local MCP endpoint remains direct on 127.0.0.1.</small>
            </label>

            <section class="agent-routing-panel" aria-label="Control-plane failover">
              <div class="agent-routing-heading">
                <div>
                  <strong>Control-plane failover</strong>
                  <span>Changes route only after confirmed control-plane transport failure.</span>
                </div>
                <span id="secure-tunnel-route-state" class="agent-route-state">Single route</span>
              </div>

              <label class="agent-field agent-field-wide" for="secure-tunnel-backup-proxy">
                <span>Backup control-plane proxy <em>Optional</em></span>
                <div class="agent-input-action">
                  <input id="secure-tunnel-backup-proxy" class="agent-input" type="password" autocomplete="off" spellcheck="false" placeholder="http://independent-backup:port" />
                  <button id="secure-tunnel-save-backup-proxy" class="inline-field-button" type="button">Save</button>
                  <button id="secure-tunnel-clear-backup-proxy" class="inline-field-button" type="button">Forget</button>
                </div>
                <small id="secure-tunnel-backup-proxy-storage" class="field-security-note">Not configured · use an endpoint with an independent service or exit when possible.</small>
              </label>

              <label class="agent-routing-toggle" for="secure-tunnel-direct-fallback">
                <div>
                  <strong>Allow direct fallback</strong>
                  <span>Off by default. A direct route may change egress location and service reachability.</span>
                </div>
                <span class="toggle-control compact-toggle">
                  <input id="secure-tunnel-direct-fallback" type="checkbox" />
                  <span class="toggle-track" aria-hidden="true"><i></i></span>
                  <b id="secure-tunnel-direct-fallback-label">Off</b>
                </span>
              </label>

              <div id="secure-tunnel-route-list" class="agent-route-list" aria-label="Control-plane routes"></div>
              <p id="secure-tunnel-route-detail" class="agent-inline-note">Configure a backup proxy to enable classified route failover.</p>
            </section>

            <div class="agent-advanced-row agent-endpoint-row agent-connector-row">
              <div><strong>Connector executable</strong><span>Selected locally and SHA-pinned before use</span></div>
              <code id="secure-tunnel-path">Not detected</code>
            </div>

            <div class="agent-local-connection-options">
              <div class="agent-advanced-row agent-endpoint-row">
                <div><strong>Local MCP endpoint</strong><span>Loopback only</span></div>
                <code id="web-agent-endpoint">Offline</code>
              </div>
              <label class="agent-field" for="web-bridge-url">
                <span>Fallback HTTPS bridge</span>
                <div class="agent-input-action">
                  <input id="web-bridge-url" class="agent-input" type="url" autocomplete="off" spellcheck="false" placeholder="https://bridge.example/mcp" />
                  <button id="web-save-bridge" class="inline-field-button" type="button">Save</button>
                  <button id="web-clear-bridge" class="inline-field-button" type="button">Clear</button>
                </div>
              </label>
              <div id="web-bridge-status" class="agent-inline-note">No fallback bridge configured.</div>
              <div class="agent-advanced-row">
                <div>
                  <strong>Connection bundle</strong>
                  <span id="web-connection-target">Local/fallback clients only.</span>
                </div>
                <button id="web-copy-connection" class="button button-secondary" type="button">Copy connection</button>
              </div>
            </div>
          </div>
        </details>
      </section>
    </div>
  `;
}
