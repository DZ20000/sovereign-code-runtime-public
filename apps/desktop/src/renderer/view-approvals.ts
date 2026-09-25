export function renderApprovalsView(): string {
  return `
    <article class="section-intro">
      <span class="panel-kicker">LOCAL AUTHORITY</span>
      <h2>Four permission profiles, one Windows authority.</h2>
      <p>Each tool keeps its L1/L2/L3 risk metadata. The selected profile decides how far a connected ChatGPT Web conversation may act through Sovereign.</p>
    </article>

    <div class="capability-grid">
      <article class="panel setting-card">
        <span>L1 · OBSERVE</span>
        <strong>Read only</strong>
        <small>Workspace reads, search, Git inspection, run inspection and other observation tools.</small>
      </article>
      <article class="panel setting-card">
        <span>L2 · WORKSPACE</span>
        <strong>Workspace authority</strong>
        <small>L1 plus contained file changes, local Git stage/commit, fixed validation and run cancellation.</small>
      </article>
      <article class="panel setting-card">
        <span>L3 · CONSEQUENTIAL</span>
        <strong>Approve high-impact calls</strong>
        <small>L1 and L2 run directly. Each L3 delete, PowerShell, Python, browser mutation, workflow or computer-control call asks locally.</small>
      </article>
      <article class="panel setting-card permission-bypass-card">
        <span>L4 · BYPASS</span>
        <strong>Full current-user authority</strong>
        <small>Skips Sovereign L2/L3 approval prompts for this application session. Audit receipts and run records stay enabled. It does not grant Administrator elevation.</small>
      </article>
    </div>

    <article class="panel approval-empty permission-empty">
      <div class="approval-lock"><span></span></div>
      <h3>Local approval broker</h3>
      <p>L3 external calls appear as native desktop dialogs. The selected permission is remembered for the authorized workspace; L4 must first be enabled locally, is protected by your Windows account, and is restored only for that exact workspace.</p>
    </article>
  `;
}
