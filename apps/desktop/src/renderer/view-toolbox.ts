export function renderToolboxView(): string {
  return `
    <div class="section-heading-row toolbox-heading">
      <article class="section-intro compact">
        <span class="panel-kicker">LOCAL EXECUTION</span>
        <h2>Operate the self-hosted runtime directly.</h2>
        <p>
          Use ConPTY, Python, managed Edge, workflows, and revision-bound Windows computer use.
          L1 observations run immediately; L2 workspace actions can use a session grant; every L3 action receives a fresh native confirmation.
        </p>
      </article>
      <button id="toolbox-refresh" class="button button-ghost" type="button">Refresh capabilities</button>
    </div>

    <section class="toolbox-grid">
      <article class="panel toolbox-panel toolbox-terminal-panel">
        <div class="panel-heading">
          <div><span class="panel-kicker">CONPTY</span><h3>Interactive PowerShell</h3></div>
          <span id="toolbox-terminal-state" class="mini-badge">Not connected</span>
        </div>
        <div class="toolbox-action-row">
          <label class="toolbox-inline-field">Columns<input id="toolbox-terminal-columns" class="text-field" type="number" min="20" max="500" value="120"></label>
          <label class="toolbox-inline-field">Rows<input id="toolbox-terminal-rows" class="text-field" type="number" min="5" max="200" value="32"></label>
          <button id="toolbox-terminal-create" class="button button-primary" type="button">Create terminal</button>
          <button id="toolbox-terminal-resize" class="button button-secondary" type="button" disabled>Resize</button>
          <button id="toolbox-terminal-close" class="button button-secondary" type="button" disabled>Close</button>
        </div>
        <pre id="toolbox-terminal-output" class="toolbox-console">Create a terminal to begin.</pre>
        <div class="toolbox-command-row">
          <textarea id="toolbox-terminal-input" class="toolbox-textarea" rows="2" placeholder="PowerShell input; Ctrl+Enter submits"></textarea>
          <button id="toolbox-terminal-send" class="button button-primary" type="button" disabled>Send line</button>
        </div>
      </article>

      <article class="panel toolbox-panel">
        <div class="panel-heading">
          <div><span class="panel-kicker">PYTHON</span><h3>Background execution</h3></div>
          <span id="toolbox-python-state" class="mini-badge">Checking</span>
        </div>
        <p class="toolbox-note">Runs in Python isolated startup mode, but uses the host network and filesystem rights. Every start is L3.</p>
        <textarea id="toolbox-python-code" class="toolbox-textarea toolbox-code" rows="8">print("Sovereign Python ready")</textarea>
        <div class="toolbox-action-row">
          <button id="toolbox-python-run" class="button button-primary" type="button">Start Python run</button>
          <span id="toolbox-python-result" class="toolbox-result">Output appears on Runs.</span>
        </div>
      </article>

      <article class="panel toolbox-panel">
        <div class="panel-heading">
          <div><span class="panel-kicker">MANAGED BROWSER</span><h3>Isolated Edge session</h3></div>
          <span id="toolbox-browser-state" class="mini-badge">Checking</span>
        </div>
        <label class="field-label" for="toolbox-browser-domains">Allowed domains</label>
        <input id="toolbox-browser-domains" class="text-field" value="example.com" placeholder="example.com, docs.example.com">
        <div class="toolbox-action-row">
          <button id="toolbox-browser-create" class="button button-primary" type="button">Create session</button>
          <button id="toolbox-browser-close" class="button button-secondary" type="button" disabled>Close</button>
        </div>
        <label class="field-label" for="toolbox-browser-url">URL</label>
        <div class="toolbox-command-row compact">
          <input id="toolbox-browser-url" class="text-field" value="https://example.com/">
          <button id="toolbox-browser-navigate" class="button button-primary" type="button" disabled>Navigate</button>
          <button id="toolbox-browser-observe" class="button button-secondary" type="button" disabled>Observe</button>
        </div>
        <label class="field-label" for="toolbox-browser-expression">Page expression</label>
        <div class="toolbox-command-row compact">
          <input id="toolbox-browser-expression" class="text-field" value="document.title">
          <button id="toolbox-browser-evaluate" class="button button-secondary" type="button" disabled>Evaluate</button>
        </div>
        <pre id="toolbox-browser-output" class="toolbox-console toolbox-browser-output">No browser observation.</pre>
        <img id="toolbox-browser-shot" class="toolbox-screenshot" alt="Managed browser screenshot" hidden>
      </article>

      <article class="panel toolbox-panel">
        <div class="panel-heading">
          <div><span class="panel-kicker">WORKFLOW</span><h3>Reusable self-hosting run</h3></div>
          <span id="toolbox-workflow-state" class="mini-badge">Ready</span>
        </div>
        <p class="toolbox-note">Templates compile validation, PowerShell, and Python steps into one cancellable <code>scr.run/v1</code> record.</p>
        <label class="field-label" for="toolbox-workflow-template">Template</label>
        <select id="toolbox-workflow-template" class="text-field">
          <option value="verify">Typecheck and test</option>
          <option value="release-check">Typecheck, test, and build</option>
        </select>
        <div class="toolbox-action-row">
          <button id="toolbox-workflow-run" class="button button-primary" type="button">Start workflow</button>
          <span id="toolbox-workflow-result" class="toolbox-result">Output appears on Runs.</span>
        </div>
      </article>

      <article class="panel toolbox-panel toolbox-computer-panel">
        <div class="panel-heading">
          <div><span class="panel-kicker">WINDOWS COMPUTER USE</span><h3>Observe, then act on the same revision</h3></div>
          <span id="toolbox-computer-state" class="mini-badge">Checking</span>
        </div>
        <p class="toolbox-note">Actions are L3, single-use, and bound to the latest desktop observation revision. Secure Desktop, credentials, and elevation remain human-only.</p>
        <div class="toolbox-action-row">
          <button id="toolbox-computer-observe" class="button button-primary" type="button">Observe desktop</button>
          <label class="toolbox-inline-field grow">Window<select id="toolbox-computer-window" class="text-field"><option value="">Observe first</option></select></label>
          <button id="toolbox-computer-focus" class="button button-secondary" type="button" disabled>Focus</button>
        </div>
        <div class="toolbox-action-row">
          <label class="toolbox-inline-field">X<input id="toolbox-computer-x" class="text-field" type="number" value="100"></label>
          <label class="toolbox-inline-field">Y<input id="toolbox-computer-y" class="text-field" type="number" value="100"></label>
          <button id="toolbox-computer-click" class="button button-secondary" type="button" disabled>Click</button>
          <input id="toolbox-computer-text" class="text-field grow" placeholder="Text to type">
          <button id="toolbox-computer-type" class="button button-secondary" type="button" disabled>Type</button>
          <input id="toolbox-computer-key" class="text-field toolbox-key-field" value="ENTER" placeholder="Key">
          <button id="toolbox-computer-key-send" class="button button-secondary" type="button" disabled>Press key</button>
        </div>
        <div class="toolbox-computer-observation">
          <img id="toolbox-computer-shot" class="toolbox-screenshot" alt="Windows desktop observation" hidden>
          <pre id="toolbox-computer-windows" class="toolbox-console">No desktop observation.</pre>
        </div>
      </article>
    </section>
  `;
}
