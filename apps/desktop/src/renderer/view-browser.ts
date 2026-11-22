import { renderActionContract } from "./action-contract.js";

export function renderBrowserView(): string {
  return `<div class="v2-browser-tool">
    <div class="page-toolbar browser-page-toolbar">
      <span id="browser-capability" class="state-text">Browser helper check pending</span>
      <button id="browser-refresh" class="button button-ghost" type="button">Refresh browser helper</button>
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
      <div class="v2-browser-create-action"><button id="browser-create" class="button button-secondary" type="button" hidden>New browser</button><span class="authority-badge authority-l3">L3 Consequential to create</span></div>
    </div>
    <section id="browser-empty-state" class="task-empty-state task-empty-with-contract">
      <div class="task-empty-copy"><strong>No managed browser session</strong><span>Create an Edge session restricted to the allowed domains above. Navigation and page actions appear after the session exists.</span></div>
      ${renderActionContract({
        id: "browser-create-contract", operation: "Create managed browser", authority: "L3 Consequential",
        scope: "Allowed domains: localhost", scopeElementId: "browser-contract-scope",
        network: "Requests restricted to the declared domain allowlist",
        approval: "Direct local operator action; Web Agent authority is unchanged",
        result: "Managed Edge/CDP session with revision-bound observations and audit receipt",
        actionId: "browser-create-empty", actionLabel: "Create browser", compact: true,
      })}
    </section>
    <div id="browser-workspace" class="browser-layout v2-browser-workbench" hidden>
      <aside class="browser-session-panel v2-browser-sessions">
        <header><strong>Sessions</strong><span id="browser-session-count" class="state-text">0 sessions</span></header>
        <div id="browser-session-list" class="browser-session-list"></div>
      </aside>
      <section class="browser-inspector-panel v2-browser-inspector">
        <header class="v2-browser-session-heading">
          <div class="pane-title"><strong id="browser-title">Select a session</strong><span id="browser-network-status">0 blocked requests</span></div>
          <button id="browser-close" class="button button-secondary" type="button" disabled>Close browser</button>
        </header>
        <div class="browser-navigation-row">
          <label for="browser-url"><span>Page URL</span><input id="browser-url" class="text-field" value="http://localhost" placeholder="https://allowed-domain/path" disabled /></label>
          <button id="browser-navigate" class="button button-primary" type="button" disabled>Navigate</button>
          <button id="browser-observe" class="button button-secondary" type="button" disabled>Observe page</button>
        </div>
        <div class="v2-browser-inspection">
          <section class="v2-browser-observation" aria-label="Page observation">
            <header class="v2-browser-observation-heading">
              <div class="v2-browser-tabs" role="tablist" aria-label="Observation format">
                <button id="browser-text-tab" type="button" role="tab" aria-selected="true" aria-controls="browser-text-panel">Page text</button>
                <button id="browser-screenshot-tab" type="button" role="tab" aria-selected="false" aria-controls="browser-screenshot-panel" tabindex="-1">Screenshot</button>
              </div>
              <span id="browser-revision" class="v2-browser-revision" data-no-i18n>—</span>
            </header>
            <section id="browser-text-panel" class="v2-browser-observation-panel" role="tabpanel" aria-labelledby="browser-text-tab" tabindex="0">
              <pre id="browser-text" class="browser-text-output">Observe the selected page to inspect text and accessibility.</pre>
            </section>
            <section id="browser-screenshot-panel" class="v2-browser-observation-panel browser-preview-section" role="tabpanel" aria-labelledby="browser-screenshot-tab" tabindex="0" hidden>
              <div id="browser-preview-empty" class="browser-preview-empty">No screenshot captured.</div>
              <img id="browser-preview" alt="Managed browser screenshot" hidden />
            </section>
            <footer class="v2-browser-observation-footer">
              <label class="compact-checkbox"><input id="browser-screenshot-toggle" type="checkbox" checked /><span>Capture screenshot</span></label>
              <span id="browser-page-url" data-no-i18n>—</span>
            </footer>
          </section>
          <aside class="v2-browser-actions" aria-label="Elements and actions">
            <section class="browser-elements-section">
              <div class="pane-subheading"><strong>Elements</strong><span id="browser-element-count">0 elements</span></div>
              <div id="browser-element-list" class="browser-element-list"><div class="browser-preview-empty">Observe the page to generate element refs.</div></div>
            </section>
            <section class="browser-action-section">
              <div class="browser-selected-element"><span>Selected element</span><strong id="browser-selected-ref" data-no-i18n>—</strong><span class="authority-badge authority-l3">L3 Consequential</span></div>
              <label for="browser-type-text"><span>Text for selected element</span><input id="browser-type-text" class="text-field" placeholder="Text for selected editable element" disabled /></label>
              <div class="browser-type-options">
                <label class="compact-checkbox"><input id="browser-replace-toggle" type="checkbox" checked /><span>Replace</span></label>
                <label class="compact-checkbox"><input id="browser-submit-toggle" type="checkbox" /><span>Enter</span></label>
                <button id="browser-type" class="button button-secondary" type="button" disabled>Type</button>
              </div>
              <button id="browser-click" class="button button-secondary" type="button" disabled>Click selected</button>
            </section>
            <details class="browser-advanced">
              <summary>Advanced JavaScript evaluation</summary>
              <div class="browser-evaluate-row"><input id="browser-expression" class="text-field" aria-label="JavaScript expression" value="document.title" placeholder="Approved JavaScript expression" disabled /><button id="browser-evaluate" class="button button-secondary" type="button" disabled>Evaluate</button></div>
              <pre id="browser-evaluation-result" class="browser-evaluation-result">Evaluation results appear here.</pre>
            </details>
            <p class="local-action-note">Direct local action · current page revision</p>
          </aside>
        </div>
      </section>
    </div>
  </div>`;
}
