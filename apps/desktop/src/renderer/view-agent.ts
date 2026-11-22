import { renderGeminiConnectionView } from "./view-gemini-connection.js";
import { renderUiIcon } from "./ui-icons.js";

export function renderAgentView(): string {
  return `
    <dialog id="connection-drawer" class="v2-drawer" aria-labelledby="connection-drawer-title">
      <header class="v2-drawer-heading"><h2 id="connection-drawer-title">Connect ChatGPT</h2><button id="connection-drawer-close" class="icon-button" type="button" aria-label="Close configuration">${renderUiIcon("close")}</button></header>
      <section id="connection-panel-chatgpt" class="v2-drawer-panel" data-connection-panel="chatgpt" hidden>
        <p class="v2-setup-steps">① Configure → ② Start → ③ Add to ChatGPT</p>
        <div class="v2-drawer-scroll">
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
            <ul id="agent-route-strip" class="agent-route-strip" hidden></ul>
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


          </div>
        </details>
        <p id="secure-tunnel-status" class="connection-feedback"></p>
        </div>
        <footer class="v2-drawer-footer"><button id="secure-tunnel-refresh" class="button button-ghost" type="button">Refresh status</button><span></span><button id="v2-chatgpt-drawer-start" class="button button-primary" type="button">Start connection</button><button id="v2-chatgpt-drawer-stop" class="button button-secondary" type="button" hidden>Stop connection</button></footer>
      </section>
      ${renderGeminiConnectionView()}
      <section id="connection-panel-advanced" class="v2-drawer-panel" data-connection-panel="advanced" hidden>
        <div class="v2-drawer-scroll">
          <div class="v2-section-heading"><h3>Host</h3><span id="runtime-command-state" class="connection-status">Stopped</span></div>
          <div class="v2-inline-actions"><button id="start-runtime" class="button button-primary" type="button">Start runtime</button><button id="stop-runtime" class="button button-secondary" type="button">Stop runtime</button><button id="refresh-runtime" class="button button-ghost" type="button">Refresh</button></div>
          <dl class="v2-facts"><div><dt>Active MCP sessions</dt><dd id="connections-session-count">0</dd></div></dl>
          <details class="v2-disclosure"><summary>Local and other MCP clients</summary>
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
          </details>
          <details class="v2-disclosure"><summary>Runtime details</summary>
            <dl class="v2-facts">
              <div><dt>Runtime state</dt><dd id="metric-runtime-state">Stopped</dd></div>
              <div><dt>Version</dt><dd id="metric-runtime-version">—</dd></div>
              <div><dt>Workspace</dt><dd id="detail-workspace" data-no-i18n>Not selected</dd></div>
              <div><dt>Local endpoint</dt><dd id="detail-endpoint" data-no-i18n>Not running</dd></div>
              <div><dt>Tools</dt><dd id="metric-tool-count">0</dd></div>
              <div><dt>Capabilities</dt><dd id="metric-capability-count">0</dd></div>
              <div><dt>Self-hosting</dt><dd id="detail-self-hosting">Checking…</dd></div>
              <div><dt>Manifest</dt><dd id="detail-manifest" data-no-i18n>—</dd></div>
              <div><dt>Credential</dt><dd id="detail-credential">Not issued</dd></div>
            </dl>
            <div class="v2-inline-actions"><button id="copy-connection" class="button button-secondary" type="button">Copy connection</button><button id="rotate-credentials" class="button button-secondary" type="button">Rotate credential</button></div>
          </details>
          <section id="overview-attention-section" class="v2-disclosure" hidden><h3>Needs attention <span id="overview-attention-count">0</span></h3><div id="overview-attention-list"></div></section>
          <details class="v2-disclosure"><summary>Recent activity <span id="overview-activity-state"></span></summary><div id="overview-run-list"></div></details>
        </div>
        <footer class="v2-drawer-footer"><span id="connection-badge" class="connection-status">Stopped</span><button class="button button-secondary" type="button" data-open-settings-tab="diagnostics">Open diagnostics</button></footer>
      </section>
    </dialog>`;
}
