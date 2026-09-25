export function renderWorkspacesView(): string {
  return `
    <div class="page-toolbar">
      <div class="page-toolbar-title">
        <h2>Workspace</h2>
        <code id="workspace-page-path">No workspace selected</code>
      </div>
      <button id="workspace-page-choose" class="button button-secondary" type="button">Change</button>
    </div>

    <section class="settings-section workspace-settings-section">
      <div class="settings-section-heading">
        <h3>Access boundary</h3>
      </div>
      <div class="settings-row-list">
        <div class="settings-row">
          <div><strong>Root</strong></div>
          <span class="settings-value">Selected folder only</span>
        </div>
        <div class="settings-row">
          <div><strong>Paths</strong></div>
          <span class="settings-value">Relative only</span>
        </div>
        <div class="settings-row">
          <div><strong>Traversal</strong></div>
          <span class="settings-value">Rejected</span>
        </div>
        <div class="settings-row">
          <div><strong>Reparse escape</strong></div>
          <span class="settings-value">Rejected</span>
        </div>
        <div class="settings-row">
          <div><strong>Guarded replace</strong></div>
          <span class="settings-value">SHA-256 required</span>
        </div>
      </div>
    </section>
  `;
}
