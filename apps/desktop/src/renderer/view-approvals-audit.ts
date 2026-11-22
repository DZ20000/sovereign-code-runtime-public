export function renderApprovalsAuditView(): string {
  return `

    <section id="v2-approvals-audit" class="v2-approvals-audit" aria-label="Approvals and audit">
      <div class="v2-tabs" role="tablist" aria-label="Approvals and audit">
        <button id="v2-approvals-tab-pending" class="v2-tab" type="button" role="tab" aria-controls="v2-approvals-pending" aria-selected="true">Pending <span id="v2-approvals-count"></span></button>
        <button id="v2-approvals-tab-audit" class="v2-tab" type="button" role="tab" aria-controls="v2-approvals-audit-pane" aria-selected="false" tabindex="-1">Audit</button>
      </div>
      <p id="v2-approvals-feedback" class="v2-secondary" role="status" aria-live="polite"></p>
      <section id="v2-approvals-pending" role="tabpanel" aria-labelledby="v2-approvals-tab-pending">
        <p id="v2-approvals-guidance" class="v2-secondary">Check the requester and target, then decide in the independent approval window.</p>
        <div class="v2-approval-panel">
          <div class="v2-section-heading">
            <h2 id="v2-approvals-heading">Waiting for a decision</h2>
            <button id="v2-approvals-refresh" class="button button-ghost" type="button">Refresh</button>
          </div>
          <div class="v2-approval-columns"><span id="v2-approvals-context-label">Requester and target</span><span id="v2-approvals-time-label">Permission / remaining</span></div>
          <ul id="v2-approvals-list" class="v2-approval-list"></ul>
          <p id="v2-approvals-note" class="v2-muted">Each request expires at its original deadline. Queued requests wait for the active decision.</p>
        </div>
      </section>
      <section id="v2-approvals-audit-pane" role="tabpanel" aria-labelledby="v2-approvals-tab-audit" hidden>
        <div class="v2-audit-toolbar">
          <label class="v2-audit-search-label"><span id="v2-audit-search-label">Search records</span><input id="v2-audit-search" type="search" autocomplete="off" placeholder="Search by tool, operation or path" /></label>
          <label class="v2-audit-outcome-label"><span class="sr-only" id="v2-audit-outcome-label">Outcome</span><select id="v2-audit-outcome"><option value="all">All outcomes</option><option value="succeeded">Succeeded</option><option value="denied">Denied</option><option value="failed">Failed</option></select></label>
          <button id="v2-audit-refresh" class="button button-ghost" type="button">Refresh</button>
        </div>
        <div class="v2-audit-layout">
          <section class="v2-audit-list-panel" aria-labelledby="v2-audit-heading">
            <div class="v2-section-heading"><h2 id="v2-audit-heading">Recent records</h2><span id="v2-audit-count" class="v2-muted"></span></div>
            <ul id="v2-audit-list" class="v2-audit-list"></ul>
          </section>
          <aside id="v2-audit-detail" class="v2-audit-detail" aria-labelledby="v2-audit-detail-heading" hidden>
            <div class="v2-section-heading"><h2 id="v2-audit-detail-heading" tabindex="-1">Audit details</h2><button id="v2-audit-close" class="button button-ghost v2-icon-button" type="button" aria-label="Close details"><span aria-hidden="true">×</span></button></div>
            <div id="v2-audit-detail-content"></div>
          </aside>
        </div>
        <p id="v2-audit-note" class="v2-muted">Search and filters apply to the loaded operation receipts.</p>
      </section>
    </section>
  `;
}
