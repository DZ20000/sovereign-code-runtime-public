import { renderActionContract } from "./action-contract.js";

export function renderTerminalView(): string {
  return `
    <div class="page-toolbar page-toolbar-actions-only terminal-page-toolbar">
      <div class="page-toolbar-actions">
        <span class="authority-badge authority-l3">L3 Consequential</span>
        <button id="terminal-refresh" class="button button-ghost" type="button">Refresh terminals</button>
        <button id="terminal-create" class="button button-secondary" type="button" hidden>New terminal</button>
      </div>
    </div>

    <details class="terminal-create-options">
      <summary>Terminal options</summary>
      <div class="terminal-create-grid">
        <label><span>Working directory</span><input id="terminal-cwd" class="text-field" value="" placeholder="workspace root" /></label>
        <label><span>Columns</span><input id="terminal-columns" class="text-field" type="number" min="20" max="500" value="120" /></label>
        <label><span>Rows</span><input id="terminal-rows" class="text-field" type="number" min="5" max="200" value="32" /></label>
      </div>
    </details>

    <section id="terminal-empty-state" class="task-empty-state task-empty-with-contract">
      <div class="task-empty-copy">
        <strong>No terminal sessions</strong>
        <span>Create an interactive PowerShell session inside the current workspace. The session console appears here after creation.</span>
      </div>
      ${renderActionContract({
        id: "terminal-create-contract",
        operation: "Create terminal",
        authority: "L3 Consequential",
        scope: "Current workspace and selected working directory",
        network: "Host process under the current Windows user",
        approval: "Direct local operator action; Web Agent authority is unchanged",
        result: "Interactive ConPTY session with bounded output and audit receipt",
        actionId: "terminal-create-empty",
        actionLabel: "Create terminal",
        compact: true,
      })}
    </section>

    <div id="terminal-workspace" class="terminal-layout terminal-workbench" hidden>
      <section class="workbench-pane terminal-sessions-panel">
        <header class="pane-toolbar"><strong>Sessions</strong><span id="terminal-session-count" class="state-text">0 sessions</span></header>
        <div id="terminal-session-list" class="terminal-session-list compact-terminal-list"></div>
      </section>

      <section class="workbench-pane terminal-console-panel terminal-direct-console">
        <header class="pane-toolbar">
          <div class="pane-title"><strong id="terminal-title">Select a terminal</strong></div>
          <div class="terminal-heading-actions">
            <span id="terminal-state" class="state-text">Terminal idle</span>
            <button id="terminal-resize" class="button button-ghost" type="button" disabled>Resize</button>
            <button id="terminal-close" class="button button-secondary" type="button" disabled>Close terminal</button>
          </div>
        </header>
        <pre id="terminal-output" class="terminal-output terminal-direct-output"></pre>
        <div class="terminal-input-row terminal-sticky-input">
          <textarea id="terminal-input" aria-label="Terminal command" placeholder="Type a command · Ctrl+Enter to send" disabled></textarea>
          <label class="compact-checkbox"><input id="terminal-append-enter" type="checkbox" checked /><span>Enter</span></label>
          <span class="local-action-note">Local operator input · L3 Consequential</span>
          <button id="terminal-send" class="button button-primary" type="button" disabled>Send</button>
        </div>
      </section>
    </div>
  `;
}
