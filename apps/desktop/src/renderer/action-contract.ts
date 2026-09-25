export type ActionAuthority = "L1 Observe" | "L2 Workspace" | "L3 Consequential";

export interface ActionContractOptions {
  readonly id: string;
  readonly operation: string;
  readonly authority: ActionAuthority;
  readonly scope: string;
  readonly network: string;
  readonly approval: string;
  readonly result: string;
  readonly actionId?: string;
  readonly actionLabel?: string;
  readonly compact?: boolean;
  readonly authorityElementId?: string;
  readonly scopeElementId?: string;
  readonly networkElementId?: string;
  readonly approvalElementId?: string;
  readonly resultElementId?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function authorityClass(authority: ActionAuthority): string {
  if (authority.startsWith("L1")) {
    return "authority-l1";
  }
  if (authority.startsWith("L2")) {
    return "authority-l2";
  }
  return "authority-l3";
}

function optionalId(id: string | undefined): string {
  return id === undefined ? "" : ` id="${escapeHtml(id)}"`;
}

export function renderActionContract(options: ActionContractOptions): string {
  const action = options.actionId === undefined || options.actionLabel === undefined
    ? ""
    : `<button id="${escapeHtml(options.actionId)}" class="button button-primary action-contract-button" type="button">${escapeHtml(options.actionLabel)}</button>`;

  return `
    <section id="${escapeHtml(options.id)}" class="action-contract${options.compact === true ? " is-compact" : ""}" aria-label="${escapeHtml(options.operation)} action contract">
      <div class="action-contract-heading">
        <div>
          <span class="action-contract-kicker">Local action</span>
          <strong>${escapeHtml(options.operation)}</strong>
        </div>
        <span${optionalId(options.authorityElementId)} class="authority-badge ${authorityClass(options.authority)}">${escapeHtml(options.authority)}</span>
      </div>
      <details class="action-contract-details">
      <summary>Details and permissions</summary>
      <dl class="action-contract-grid">
        <div><dt>Scope</dt><dd${optionalId(options.scopeElementId)}>${escapeHtml(options.scope)}</dd></div>
        <div><dt>Network</dt><dd${optionalId(options.networkElementId)}>${escapeHtml(options.network)}</dd></div>
        <div><dt>Approval</dt><dd${optionalId(options.approvalElementId)}>${escapeHtml(options.approval)}</dd></div>
        <div><dt>Result</dt><dd${optionalId(options.resultElementId)}>${escapeHtml(options.result)}</dd></div>
        <div><dt>Web Agent</dt><dd data-action-current-profile>L1 Observe</dd></div>
      </dl>
      </details>
      ${action.length === 0 ? "" : `<div class="action-contract-footer">${action}</div>`}
    </section>
  `;
}
