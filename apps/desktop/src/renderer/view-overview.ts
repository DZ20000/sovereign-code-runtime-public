import { renderUiIcon } from "./ui-icons.js";

function connectionCard(provider: "chatgpt" | "gemini"): string {
  const chatgpt = provider === "chatgpt";
  const name = chatgpt ? "ChatGPT" : "Gemini";
  return `<section class="v2-connection-card ${provider}-connection-card" aria-labelledby="v2-${provider}-title">
    <header><h2 id="v2-${provider}-title">${name}</h2><button id="v2-${provider}-config" class="icon-button v2-config-button" type="button" data-open-connection="${provider}" aria-label="Configure ${name}" title="Configure ${name}">${renderUiIcon("chevron")}</button></header>
    <span id="${chatgpt ? "web-agent-client" : "gemini-status"}" class="connection-status" role="status">Checking…</span>
    <div class="v2-connection-actions">
      <button id="${chatgpt ? "v2-chatgpt-copy" : "gemini-copy-url"}" class="button button-ghost" type="button" disabled>${chatgpt ? "Copy tunnel ID" : "Copy address"}</button>
      ${chatgpt ? '<button id="secure-tunnel-start" class="button button-primary" type="button">Start</button><button id="secure-tunnel-stop" class="button button-secondary" type="button" hidden>Stop</button>' : '<button id="gemini-primary" class="button button-primary" type="button" disabled>Configure</button>'}
    </div>
  </section>`;
}
export function renderOverviewView(): string {
  return `<div class="v2-overview">
    <section class="v2-workspace-summary" aria-label="Current workspace and permission">
      <div><span>Workspace</span><strong id="home-workspace-name">Not selected</strong></div>
      <span id="home-permission" class="v2-permission-summary">Read only · L1</span>
      <button class="button button-ghost" type="button" data-open-settings-tab="security">Manage</button>
    </section>
    <div class="v2-connections-grid">${connectionCard("chatgpt")}${connectionCard("gemini")}</div>
    <section class="v2-active-work" aria-labelledby="home-active-work-title">
      <header><h2 id="home-active-work-title">Active work</h2><span id="home-active-work-count" class="muted" aria-live="polite">0 items</span><div class="v2-active-controls"><button id="v2-active-previous" class="icon-button" type="button" aria-label="Previous task">${renderUiIcon("chevron")}</button><span id="v2-active-position"></span><button id="v2-active-next" class="icon-button" type="button" aria-label="Next task">${renderUiIcon("chevron")}</button></div><button id="home-task-action" class="button button-ghost" type="button" data-open-view="tasks">View all</button></header>
      <div id="home-active-work-carousel" class="active-work-carousel" role="listbox" tabindex="0" aria-label="Active work navigator"><div class="active-work-empty">No active work</div></div>
      <div class="v2-active-progress" id="v2-active-progress" role="progressbar" aria-label="Agent-reported progress" hidden><span id="v2-active-progress-fill"></span></div>
    </section>
    <section id="v2-pending-summary" class="v2-pending-summary" aria-label="Pending approvals"><span id="v2-pending-count" class="connection-status">Checking approvals…</span><button class="button button-secondary" type="button" data-open-view="approvals">View requests</button></section>
    <div id="setup-banner" class="v2-setup-banner" hidden><span>Choose a workspace to begin.</span><button class="button button-secondary" type="button" data-open-settings-tab="security">Manage workspace</button></div>
    <button class="v2-home-advanced" type="button" data-open-connection="advanced"><span>Advanced connections &amp; host</span>${renderUiIcon("chevron")}</button>
  </div>`;
}
