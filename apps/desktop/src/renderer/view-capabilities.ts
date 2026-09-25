export function renderCapabilitiesView(): string {
  return `
    <header class="page-heading">
      <h2>Capabilities</h2>
      <p>Local grants and the versioned MCP tool manifest.</p>
    </header>

    <section class="workbench-panel capability-panel">
      <div id="capability-list" class="capability-list"></div>
    </section>

    <section class="workbench-panel manifest-panel">
      <header class="workbench-panel-header">
        <h2>Tool manifest</h2>
        <span id="manifest-generated" class="state-text">Unavailable</span>
      </header>
      <div id="manifest-groups" class="manifest-groups">
        <div class="quiet-empty">Start the runtime to load the manifest.</div>
      </div>
    </section>
  `;
}
