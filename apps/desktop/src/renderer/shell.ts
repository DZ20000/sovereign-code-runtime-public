import {
  DEFAULT_VIEW_ID,
  VIEW_DEFINITIONS,
  type NavigationIcon,
  type NavigationSection,
} from "./view-registry.js";

function renderNavigationIcon(icon: NavigationIcon): string {
  const paths: Readonly<Record<NavigationIcon, string>> = {
    home: '<path d="M2.75 7.25 8 2.9l5.25 4.35v5.35a.9.9 0 0 1-.9.9h-2.9V9.7h-2.9v3.8h-2.9a.9.9 0 0 1-.9-.9Z"/>',
    connection:
      '<path d="M6.15 5.15 7.3 4a3 3 0 0 1 4.25 4.25L10.4 9.4M9.85 10.85 8.7 12a3 3 0 1 1-4.25-4.25L5.6 6.6M5.75 10.25l4.5-4.5"/>',
    tasks:
      '<rect x="2.25" y="1.75" width="11.5" height="12.5" rx="1.6"/><path d="m4.25 5.25.85.85 1.55-1.75M8.4 5.25h3.1M4.25 9.9l.85.85L6.65 9M8.4 9.9h3.1"/>',
    history:
      '<circle cx="8" cy="8" r="5.25"/><path d="M8 4.75V8l2.2 1.35"/><path d="M3.35 3.8H1.9v-1.45"/>',
    terminal:
      '<rect x="1.75" y="2.5" width="12.5" height="11" rx="1.5"/><path d="m4.2 6 2 2-2 2M8.2 10h3"/>',
    python:
      '<path d="M8 1.75c-2.55 0-2.45 1.1-2.45 1.1v2.1H9.9c.85 0 1.55.7 1.55 1.55v1.15H5.2a3.1 3.1 0 0 0 0 6.2h1.15V12.3M8 14.25c2.55 0 2.45-1.1 2.45-1.1v-2.1H6.1c-.85 0-1.55-.7-1.55-1.55V8.35h6.25a3.1 3.1 0 0 0 0-6.2H9.65V3.7"/><circle cx="7.1" cy="3.55" r=".55" fill="currentColor" stroke="none"/><circle cx="8.9" cy="12.45" r=".55" fill="currentColor" stroke="none"/>',
    browser:
      '<rect x="1.75" y="2.5" width="12.5" height="11" rx="1.5"/><path d="M1.75 5.5h12.5"/><circle cx="4" cy="4" r=".45" fill="currentColor" stroke="none"/><circle cx="5.7" cy="4" r=".45" fill="currentColor" stroke="none"/>',
    desktop:
      '<rect x="1.75" y="2.25" width="12.5" height="8.75" rx="1.35"/><path d="M5.25 13.75h5.5M8 11v2.75"/><path d="m9.6 6.1 3.1 1.15-1.5.65.75 1.55-.95.45-.75-1.55-1.15.95Z"/>',
    workflow:
      '<circle cx="3.25" cy="3.25" r="1.35"/><circle cx="12.75" cy="8" r="1.35"/><circle cx="3.25" cy="12.75" r="1.35"/><path d="M4.6 3.25h2A2.4 2.4 0 0 1 9 5.65v.1A2.25 2.25 0 0 0 11.25 8M4.6 12.75h2A2.4 2.4 0 0 0 9 10.35v-.1A2.25 2.25 0 0 1 11.25 8"/>',
    settings:
      '<path d="M3 4.25h10M3 8h10M3 11.75h10"/><circle cx="6" cy="4.25" r="1.25" fill="#0d1015"/><circle cx="10.5" cy="8" r="1.25" fill="#0d1015"/><circle cx="7.5" cy="11.75" r="1.25" fill="#0d1015"/>',
  };
  return `<svg class="navigation-icon-svg" viewBox="0 0 16 16" aria-hidden="true">${paths[icon]}</svg>`;
}

function renderNavButton(
  view: (typeof VIEW_DEFINITIONS)[number],
  nested = false,
): string {
  const active = view.id === DEFAULT_VIEW_ID;
  return `
    <button
      class="navigation-item${nested ? " is-nested" : ""}${active ? " is-active" : ""}"
      data-view="${view.id}"
      type="button"
      title="${view.navigationLabel}"
      ${active ? 'aria-current="page"' : ""}
    >
      <span class="navigation-icon">${renderNavigationIcon(view.navigationIcon)}</span>
      <span class="navigation-label">${view.navigationLabel}</span>
    </button>
  `;
}

function viewsInSection(section: NavigationSection) {
  return VIEW_DEFINITIONS.filter((view) => view.navigationSection === section);
}

function renderNavigation(): string {
  const primary = viewsInSection("primary");
  const execute = viewsInSection("execute");
  const utility = viewsInSection("utility");

  return `
    <div class="navigation-section navigation-primary-section">
      ${primary.map((view) => renderNavButton(view)).join("")}
    </div>

    <div class="navigation-section navigation-execute-section">
      <button id="execute-group-toggle" class="navigation-group-toggle" type="button" aria-expanded="true">
        <span>Workbench</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.75 6.5 2.25 2.25L10.25 6.5"/></svg>
      </button>
      <div id="execute-group" class="navigation-group-items">
        ${execute.map((view) => renderNavButton(view, true)).join("")}
      </div>
    </div>

    <div class="navigation-spacer"></div>

    <div class="navigation-section navigation-utility-section">
      ${utility.map((view) => renderNavButton(view)).join("")}
    </div>
  `;
}

function renderViews(): string {
  return VIEW_DEFINITIONS.map(
    (view) => `
    <section
      id="view-${view.id}"
      class="view${view.id === DEFAULT_VIEW_ID ? " is-active" : ""}"
      data-view-panel="${view.id}"
      aria-labelledby="view-title"
    >
      ${view.render()}
    </section>
  `,
  ).join("");
}

export function mountApplicationShell(root: HTMLElement): void {
  root.innerHTML = `
    <div class="application-shell">
      <aside id="sidebar-navigation" class="sidebar">
        <div class="sidebar-header">
          <div class="brand-lockup">
            <div class="brand-text">
              <strong>Sovereign</strong>
              <small>Code Runtime</small>
            </div>
          </div>
          <button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-label="Collapse sidebar" aria-expanded="true" title="Collapse sidebar">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.75 3.5 6.25 8l4.5 4.5"/></svg>
          </button>
        </div>

        <nav class="navigation" aria-label="Primary navigation">
          ${renderNavigation()}
        </nav>
      </aside>

      <div id="task-navigation-resizer" class="task-pane-resizer" role="separator" aria-label="Resize navigation" aria-controls="sidebar-navigation" aria-orientation="vertical" tabindex="0"></div>

      <main class="main-surface">
        <header class="topbar">
          <div class="topbar-title-group">
            <h1 id="view-title">${VIEW_DEFINITIONS[0].title}</h1>
            <p id="view-description">${VIEW_DEFINITIONS[0].description}</p>
          </div>
          <div class="topbar-local-context" aria-label="Runtime boundary">
            <span class="topbar-local-dot" aria-hidden="true"></span>
            <span>Local runtime</span>
          </div>
        </header>

        <div class="content-scroll">
          ${renderViews()}
        </div>

        <footer class="statusbar" aria-label="Runtime status">
          <button id="global-status" class="statusbar-item statusbar-action statusbar-host status-stopped" type="button" data-status-view="overview" title="Open Home">
            <svg class="statusbar-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10v7H3zM5.25 2.5h5.5M6 13.5h4"/></svg>
            <span class="statusbar-label">Host</span><strong id="global-status-label">Stopped</strong>
          </button>
          <button id="status-connector-action" class="statusbar-item statusbar-action statusbar-connection" type="button" data-status-view="agent" title="Open ChatGPT Connection">
            <svg class="statusbar-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.25 3.25h9.5v7h-5L5 12.75V10.25H3.25z"/></svg>
            <span class="statusbar-label">ChatGPT</span><strong id="status-tunnel">Disconnected</strong><span id="status-sessions" class="statusbar-count">0 sessions</span>
          </button>
          <button id="status-permission-action" class="statusbar-item statusbar-action statusbar-permission" type="button" data-status-settings="security" title="Change ChatGPT permission">
            <svg class="statusbar-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9 13 3.8v3.55c0 3.05-1.9 5.35-5 6.75-3.1-1.4-5-3.7-5-6.75V3.8Z"/><path d="M6 8 7.35 9.35 10.25 6.4"/></svg>
            <span class="statusbar-label">Permission</span><strong id="status-authority">Read only · L1</strong>
          </button>
          <button id="status-task-action" class="statusbar-item statusbar-action statusbar-task" type="button" data-status-view="tasks" title="Open Tasks">
            <svg class="statusbar-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.25" cy="3.25" r="1.35"/><circle cx="12.75" cy="8" r="1.35"/><circle cx="3.25" cy="12.75" r="1.35"/><path d="M4.6 3.25h2A2.4 2.4 0 0 1 9 5.65v.1A2.25 2.25 0 0 0 11.25 8M4.6 12.75h2A2.4 2.4 0 0 0 9 10.35v-.1A2.25 2.25 0 0 1 11.25 8"/></svg>
            <span class="statusbar-label">Tasks</span><strong id="status-task">No active task</strong>
          </button>
          <span class="statusbar-spacer"></span>
          <button id="status-workspace-action" class="statusbar-item statusbar-action statusbar-workspace" type="button" data-status-settings="host" title="Open host and workspace settings">
            <span class="statusbar-label">Workspace</span><strong id="status-workspace">None</strong>
          </button>
          <span class="statusbar-item statusbar-local simple-mode-hidden"><svg class="statusbar-local-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.1 10.9 3.8 12.2a2.15 2.15 0 0 1-3.05-3.04l2.2-2.2A2.15 2.15 0 0 1 6 6.95"/><path d="m10.9 5.1 1.3-1.3a2.15 2.15 0 1 1 3.05 3.04l-2.2 2.2A2.15 2.15 0 0 1 10 9.05"/><path d="m5.6 10.4 4.8-4.8"/></svg><strong>Loopback only</strong></span>
        </footer>
      </main>

      <div id="toast" class="toast" role="status" aria-live="polite" hidden><span id="toast-message"></span><button id="toast-dismiss" class="toast-dismiss" type="button" aria-label="Dismiss notification">×</button></div>
    </div>
  `;
}
