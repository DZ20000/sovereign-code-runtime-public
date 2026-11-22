export function renderGeminiConnectionView(): string {
  const protectedRow = (field: "owner" | "authorization", label: string, inputId: string) => `
    <fieldset class="v2-secret-field"><legend>${label}</legend>
      <div class="v2-segment" role="group" aria-label="${label}">
        <button id="gemini-keep-${field}" type="button" data-secret-field="${field}" data-secret-mode="keep" aria-pressed="true">Keep</button>
        <button id="gemini-replace-${field}" type="button" data-secret-field="${field}" data-secret-mode="replace" aria-pressed="false">Replace</button>
        <button id="gemini-forget-${field}" type="button" data-secret-field="${field}" data-secret-mode="forget" aria-pressed="false">Clear</button>
      </div>
      <input id="${inputId}" type="password" autocomplete="new-password" data-no-i18n aria-label="${label}" hidden />
    </fieldset>`;
  return `<section id="connection-panel-gemini" class="v2-drawer-panel" data-connection-panel="gemini" hidden>
    <p class="v2-setup-steps">① Configure → ② Start → ③ Add to client</p>
    <div class="v2-drawer-scroll">
      <div class="v2-inline-actions"><button id="gemini-import" class="button button-secondary" type="button">Import configuration</button><button id="gemini-presets" class="button button-ghost" type="button">Choose preset</button><span id="gemini-configuration-state" class="connection-status">Checking…</span></div>
      <form id="gemini-config-form" class="connection-form" autocomplete="off">
        <label class="connection-field"><span>Public MCP URL</span><input id="gemini-public-url" type="url" required spellcheck="false" data-no-i18n placeholder="https://mcp.example.com/gemini" /></label>
        <label class="connection-field"><span>OAuth discovery URL</span><input id="gemini-discovery-url" type="url" required spellcheck="false" data-no-i18n placeholder="https://auth.example.com/discovery" /></label>
        <label class="connection-field"><span>Introspection URL</span><input id="gemini-introspection-url" type="url" required spellcheck="false" data-no-i18n placeholder="https://auth.example.com/introspect" /></label>
        <div class="v2-field-pair"><label class="connection-field"><span>Client ID</span><input id="gemini-client-id" type="text" required spellcheck="false" data-no-i18n /></label><label class="connection-field"><span>Local listener port</span><input id="gemini-port" type="number" min="0" max="65535" step="1" value="0" required data-no-i18n /></label></div>
        <div class="v2-field-pair"><div class="connection-field"><span>Owner subject</span><span id="gemini-owner-state" class="v2-protected-state">Not saved</span></div><div class="connection-field"><span>Introspection authorization</span><span id="gemini-authorization-state" class="v2-protected-state">Not saved</span></div></div>
        <div class="v2-inline-actions"><span class="muted">Protected values</span><button id="gemini-protected-open" class="button button-ghost" type="button">Replace or clear</button></div>
        <dialog id="gemini-protected-dialog" class="v2-dialog" aria-labelledby="gemini-protected-title">
          <header><h2 id="gemini-protected-title">Protected values</h2></header><p>Apply to the form first. Save to make changes effective.</p>
          ${protectedRow("owner","Owner subject","gemini-owner-subject")}${protectedRow("authorization","Introspection authorization","gemini-introspection-authorization")}
          <p id="gemini-protected-note" class="muted">Saved values are never displayed.</p>
          <footer><button id="gemini-protected-cancel" class="button button-ghost" type="button">Cancel</button><button id="gemini-protected-apply" class="button button-primary" type="button">Apply to form</button></footer>
        </dialog>
      </form>
      <p id="gemini-error" class="connection-feedback is-error" role="alert" hidden></p>
      <details class="v2-disclosure"><summary>Connection status</summary><dl class="v2-facts"><div><dt>Public MCP URL</dt><dd id="gemini-public-endpoint" data-no-i18n>—</dd></div><div><dt>Local listener</dt><dd id="gemini-listen-endpoint" data-no-i18n>—</dd></div></dl><p id="gemini-listener-note" class="muted">Save configuration, start the listener, then add it to your client.</p><button id="gemini-refresh" class="button button-ghost" type="button">Refresh status</button></details>
    </div>
    <footer class="v2-drawer-footer"><button class="button button-ghost" type="button" data-close-connection>Cancel</button><button id="gemini-stop" class="button button-secondary" type="button" hidden>Stop</button><button id="gemini-save" form="gemini-config-form" class="button button-primary" type="submit">Save</button></footer>
    <dialog id="gemini-import-dialog" class="v2-dialog" aria-labelledby="gemini-import-title">
      <header><h2 id="gemini-import-title">Import configuration</h2></header>
      <label class="connection-field"><span>Configuration JSON</span><textarea id="gemini-import-json" maxlength="65536" rows="6" spellcheck="false" data-no-i18n></textarea></label>
      <button id="gemini-import-preview" class="button button-secondary" type="button">Preview</button><p id="gemini-import-error" role="alert" hidden></p>
      <dl id="gemini-import-fields" class="v2-facts" hidden></dl><p class="muted">Protected values stay unchanged.</p>
      <footer><button id="gemini-import-cancel" class="button button-ghost" type="button">Cancel</button><button id="gemini-import-apply" class="button button-primary" type="button" disabled>Fill form</button></footer>
    </dialog>
    <dialog id="gemini-preset-dialog" class="v2-dialog" aria-labelledby="gemini-preset-title">
      <header><h2 id="gemini-preset-title">Choose preset</h2></header><p>Replace example addresses with your own service before saving.</p>
      <button id="gemini-preset-example" class="v2-preset-choice" type="button"><strong>Example OAuth</strong><span>Five public fields; protected values unchanged</span></button>
      <button id="gemini-preset-manual" class="v2-preset-choice" type="button"><strong>Manual configuration</strong><span>Empty public fields; protected values unchanged</span></button>
      <footer><button id="gemini-preset-cancel" class="button button-ghost" type="button">Cancel</button></footer>
    </dialog>
  </section>`;
}
