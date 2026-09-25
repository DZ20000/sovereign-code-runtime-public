export function renderAuditView(): string {
  return `
    <div class="section-heading-row">
      <article class="section-intro compact">
        <span class="panel-kicker">LOCAL LEDGER</span>
        <h2>Audit receipts</h2>
        <p>Every write attempt records its outcome and integrity evidence.</p>
      </article>
      <button id="refresh-audit" class="button button-secondary" type="button">Refresh receipts</button>
    </div>
    <article class="panel audit-panel">
      <div class="table-scroll">
        <table>
          <thead><tr><th>Time</th><th>Tool</th><th>Operation</th><th>Path</th><th>Outcome</th></tr></thead>
          <tbody id="audit-body"><tr><td colspan="5" class="table-empty">No receipts available.</td></tr></tbody>
        </table>
      </div>
    </article>
  `;
}
