import { renderActionContract } from "./action-contract.js";

export function renderBrowserView(): string {
  return `
    <div class="page-toolbar page-toolbar-actions-only browser-page-toolbar">
      <div class="page-toolbar-actions">
        <span id="browser-capability" class="state-text">Browser helper check pending</span>
        <button id="browser-refresh" class="button button-ghost" type="button">Refresh browser helper</button>
        <button id="browser-create" class="button button-secondary" type="button" hidden>New browser</button>
      </div>
    </div>

    <div class="browser-create-panel browser-scopebar">
      <div class="token-field browser-domain-field">
        <span>Allowed domains</span>
        <div class="token-editor">
          <div id="browser-domain-chips" class="token-chip-list"></div>
          <input id="browser-domain-entry" class="token-entry" type="text" autocomplete="off" spellcheck="false" aria-label="Add allowed domain" placeholder="Add hostname and press Enter" />
        </div>
        <input id="browser-domains" type="hidden" value="localhost" />
        <small>Hostnames only. Schemes, paths, ports and wildcards are not allowed. A listed domain also permits its subdomains.</small>
      </div>
      <span class="authority-badge authority-l3">L3 Consequential to create</span>
    </div>

    <section id="browser-empty-state" class="task-empty-state task-empty-with-contract">
      <div class="task-empty-copy">
        <strong>No managed browser session</strong>
        <span>Create an Edge session restricted to the allowed domains above. Navigation and page actions appear after the session exists.</span>
      </div>
      ${renderActionContract({
        id: "browser-create-contract",
        operation: "Create managed browser",
        authority: "L3 Consequential",
        scope: "Allowed domains: localhost",
        scopeElementId: "browser-contract-scope",
        network: "Requests restricted to the declared domain allowlist",
        approval: "Direct local operator action; Web Agent authority is unchanged",
        result: "Managed Edge/CDP session with revision-bound observations and audit receipt",
        actionId: "browser-create-empty",
        actionLabel: "Create browser",
        compact: true,
      })}
    </section>

    <div id="browser-workspace" class="browser-layout browser-workbench" hidden>
      <section class="workbench-pane browser-session-panel">
        <header class="pane-toolbar"><strong>Sessions</strong><span id="browser-session-count" class="state-text">0 sessions</span></header>
        <div id="browser-session-list" class="browser-session-list compact-browser-list"></div>
      </section>

      <section class="workbench-pane browser-inspector-panel browser-direct-inspector">
        <header class="pane-toolbar">
          <div class="pane-title"><strong id="browser-title">Select a session</strong><span id="browser-network-status">0 blocked requests</span></div>
          <button id="browser-close" class="button button-secondary" type="button" disabled>Close browser</button>
        </header>

        <div class="browser-navigation-row browser-direct-nav">
          <input id="browser-url" class="text-field" aria-label="Page URL" value="http://localhost" placeholder="https://allowed-domain/path" disabled />
          <button id="browser-navigate" class="button button-primary" type="button" disabled>Navigate</button>
          <button id="browser-observe" class="button button-ghost" type="button" disabled>Observe page</button>
          <label class="compact-checkbox"><input id="browser-screenshot-toggle" type="checkbox" checked /><span>Screenshot</span></label>
        </div>

        <div class="browser-observation-grid browser-direct-observation">
          <section>
            <div class="pane-subheading"><strong>Page</strong><span id="browser-revision">No page revision</span></div>
            <pre id="browser-text" class="browser-text-output">Observe the selected page to inspect text and accessibility.</pre>
          </section>
          <section class="browser-preview-section">
            <div class="pane-subheading"><strong>Screenshot</strong><span id="browser-page-url">—</span></div>
            <div id="browser-preview-empty" class="browser-preview-empty">No screenshot captured.</div>
            <img id="browser-preview" alt="Managed browser screenshot" hidden />
          </section>
        </div>

        <div class="browser-interaction-grid browser-direct-actions">
          <section class="browser-elements-section">
            <div class="pane-subheading"><strong>Elements</strong><span id="browser-element-count">0 elements</span></div>
            <div id="browser-element-list" class="browser-element-list"><div class="browser-preview-empty">Observe the page to generate element refs.</div></div>
          </section>
          <section class="browser-action-section">
            <div class="pane-subheading"><strong>Action</strong><span class="authority-badge authority-l3">L3 Consequential</span></div>
            <div class="browser-selected-element">
              <span>Selected element</span><strong id="browser-selected-ref">—</strong>
              <button id="browser-click" class="button button-secondary" type="button" disabled>Click selected</button>
            </div>
            <input id="browser-type-text" class="text-field" aria-label="Text for selected element" placeholder="Text for selected editable element" disabled />
            <div class="browser-type-options">
              <label class="compact-checkbox"><input id="browser-replace-toggle" type="checkbox" checked /><span>Replace</span></label>
              <label class="compact-checkbox"><input id="browser-submit-toggle" type="checkbox" /><span>Enter</span></label>
              <span class="local-action-note">Direct local action · current page revision</span>
              <button id="browser-type" class="button button-primary" type="button" disabled>Type</button>
            </div>
          </section>
        </div>

        <details class="browser-advanced">
          <summary>Advanced JavaScript evaluation</summary>
          <div class="browser-evaluate-row">
            <input id="browser-expression" class="text-field" aria-label="JavaScript expression" value="document.title" placeholder="Approved JavaScript expression" disabled />
            <button id="browser-evaluate" class="button button-secondary" type="button" disabled>Evaluate</button>
          </div>
          <pre id="browser-evaluation-result" class="browser-evaluation-result">Evaluation results appear here.</pre>
        </details>
      </section>
    </div>
  `;
}
