import { DEFAULT_VIEW_ID, VIEW_DEFINITIONS, type ViewDefinition } from "./view-registry.js";
import { renderUiIcon } from "./ui-icons.js";
import { renderAgentView } from "./view-agent.js";

function renderNavButton(view: ViewDefinition): string {
  const active = view.id === DEFAULT_VIEW_ID;
  return `<button class="navigation-item${active ? " is-active" : ""}" data-view="${view.id}" type="button" title="${view.navigationLabel}" ${active ? 'aria-current="page"' : ""}>
    ${renderUiIcon(view.navigationIcon)}<span class="navigation-label">${view.navigationLabel}</span>
  </button>`;
}
export function mountApplicationShell(root: HTMLElement): void {
  root.innerHTML = `
    <div class="application-shell">
      <aside id="sidebar-navigation" class="sidebar">
        <header class="sidebar-header"><strong>Sovereign</strong><button id="sidebar-toggle" class="icon-button" type="button" aria-label="Collapse sidebar" aria-expanded="true" title="Collapse sidebar">${renderUiIcon("chevron")}</button></header>
        <nav class="navigation" aria-label="Primary navigation">
          <div class="navigation-primary-section">${VIEW_DEFINITIONS.filter(view => view.navigationSection === "primary").map(renderNavButton).join("")}</div>
          <div class="navigation-spacer"></div>
          <div class="navigation-execute-section is-collapsed">
            <button id="execute-group-toggle" class="navigation-group-toggle" type="button" aria-expanded="false" aria-controls="execute-group">${renderUiIcon("code")}<span class="navigation-label">Developer tools</span>${renderUiIcon("chevron")}</button>
            <div id="execute-group" class="navigation-group-items" hidden>${VIEW_DEFINITIONS.filter(view => view.navigationSection === "execute").map(renderNavButton).join("")}</div>
          </div>
          <button id="v2-mode-simple" class="button button-ghost v2-mode-switch" type="button">Simple mode</button>
        </nav>
      </aside>
      <div id="task-navigation-resizer" class="task-pane-resizer v2-navigation-resizer" role="separator" aria-label="Resize navigation" aria-controls="sidebar-navigation" aria-orientation="vertical" tabindex="0"></div>
      <main class="main-surface">
        <header class="topbar">
          <div class="topbar-title-group"><strong class="v2-simple-brand">Sovereign</strong><h1 id="view-title">Home &amp; Connections</h1><p id="view-description" class="visually-hidden">Connections and current work</p></div>
          <button id="global-status" class="v2-host-status" type="button" data-open-connection="advanced" title="Host status"><span class="status-dot" aria-hidden="true"></span><span id="global-status-label">Checking…</span></button>
          <button id="v2-mode-expand" class="button button-ghost" type="button">Expand</button>
        </header>
        <div class="content-scroll">${VIEW_DEFINITIONS.map(view => `<section id="view-${view.id}" class="view${view.id === DEFAULT_VIEW_ID ? " is-active" : ""}" data-view-panel="${view.id}" aria-labelledby="view-title" ${view.id === DEFAULT_VIEW_ID ? "" : "hidden"}>${view.render()}</section>`).join("")}</div>
      </main>
      ${renderAgentView()}
      <div id="toast" class="toast" role="status" aria-live="polite" hidden><span id="toast-message"></span><button id="toast-dismiss" class="icon-button" type="button" aria-label="Dismiss notification">${renderUiIcon("close")}</button></div>
    </div>`;
}
