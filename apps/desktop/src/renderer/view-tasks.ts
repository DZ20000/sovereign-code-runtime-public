import { TASK_HUB_SESSION_MAX_SEARCH_LENGTH } from "./task-hub-session.js";
import { renderRunsWorkbench } from "./view-runs.js";

export function renderTasksView(): string {
  return `
    <div class="task-hub-shell v2-tasks" data-task-selected="false">
      <section id="task-hub-list-pane" class="task-hub-list-pane v2-task-sidebar" aria-labelledby="task-hub-heading">
        <header class="v2-task-list-heading">
          <h2 id="task-hub-heading">Current work</h2>
          <span id="task-hub-summary" class="sr-only">0 current · 0 need action · 0 history</span>
          <button id="task-hub-refresh" class="button button-ghost" type="button" aria-describedby="task-board-sync-state task-hub-refresh-status">Refresh</button>
          <span id="task-hub-refresh-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></span>
        </header>
        <div class="v2-task-search">          <label class="task-hub-search-field">
            <span class="sr-only">Search this queue</span>
            <span class="task-hub-search-control">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"></circle><path d="m10.25 10.25 3 3"></path></svg>
              <input id="task-hub-search" class="filter-input" type="search" autocomplete="off" maxlength="${TASK_HUB_SESSION_MAX_SEARCH_LENGTH}" placeholder="Search this queue" aria-keyshortcuts="Escape" />
            </span>
          </label></div>
        <div id="task-board-lanes" class="v2-task-lanes" role="toolbar" aria-label="Task queues" aria-orientation="horizontal">
          <button id="task-board-lane-current" class="task-board-lane" type="button" data-lane="current" aria-pressed="true" aria-controls="task-project-grid" tabindex="0">
            <span>Current work</span>
            <strong id="task-board-current-count">0</strong>
          </button>
          <button id="task-board-lane-history" class="task-board-lane" type="button" data-lane="history" aria-pressed="false" aria-controls="task-project-grid" tabindex="-1">
            <span>History</span>
            <strong id="task-board-history-count">0</strong>
          </button>
          <details class="v2-task-more-filters">
            <summary>More filters</summary>
            <div class="v2-task-secondary-lanes">
          <button id="task-board-lane-attention" class="task-board-lane" type="button" data-lane="attention" aria-pressed="false" aria-controls="task-project-grid" tabindex="-1">
            <span>Needs action</span>
            <strong id="task-board-attention-count">0</strong>
          </button>
          <button id="task-board-lane-activity" class="task-board-lane" type="button" data-lane="activity" aria-pressed="false" aria-controls="task-project-grid" tabindex="-1">
            <span>Automatic activity</span>
            <strong id="task-board-activity-count">0</strong>
          </button>
          <button id="task-board-lane-all" class="task-board-lane" type="button" data-lane="all" aria-pressed="false" aria-controls="task-project-grid" tabindex="-1">
            <span>All records</span>
            <strong id="task-board-all-count">0</strong>
          </button>
            </div>
            <div class="v2-task-filter-controls" role="group" aria-label="Task filters">
          <label>
            <span class="sr-only">Category</span>
            <select id="task-hub-category-filter" class="settings-select">
              <option value="all">All categories</option>
              <option value="development">Development</option>
              <option value="testing">Testing</option>
              <option value="build">Build and release</option>
              <option value="research">Research</option>
              <option value="maintenance">Maintenance</option>
              <option value="automation">Automation</option>
              <option value="other">Other</option>
            </select>
          </label>
          <button id="task-hub-clear-filters" class="button button-ghost task-hub-clear-filters" type="button" disabled>Clear filters</button>
          <div class="task-hub-filter-result" aria-live="polite">
            <strong id="task-hub-visible-count">0</strong>
            <span id="task-hub-visible-label">tasks shown</span>
          </div></div>
          </details>
        </div>
        <section class="task-board-context sr-only" aria-live="polite" aria-labelledby="task-board-view-title">
          <div>
            <h3 id="task-board-view-title" class="sr-only">Current work</h3>
            <p id="task-board-view-description">Unfinished work stays here until it is completed or cancelled.</p>
          </div>
          <span id="task-board-sync-state" class="state-text">Snapshot not loaded</span>
        </section>

        <div id="task-hub-progress-advisory" class="task-hub-progress-advisory" role="status" aria-live="polite" aria-atomic="true" hidden>
          <span id="task-hub-progress-missing-count" class="task-hub-progress-advisory-count">0</span>
          <div>
            <strong id="task-hub-progress-advisory-title">Current work without structured progress</strong>
            <span id="task-hub-progress-advisory-detail">Active Agent work without a numeric total is shown without a misleading percentage.</span>
          </div>
        </div>
        <div id="task-project-grid" class="task-project-grid v2-task-list" role="group" aria-label="Task list" aria-describedby="task-board-view-description" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End Enter">
          <div class="task-hub-empty"><strong>No projects or tasks yet</strong><span>Agents can register work directly. Sovereign also groups meaningful project activity automatically.</span></div>
        </div>
        <footer class="v2-task-project-footer">
          <button id="task-show-all-runs" class="button button-secondary" type="button">View all runs</button>
          <div class="v2-task-project-summary"><span>Project directory</span><strong id="task-project-workspace-root" data-no-i18n>—</strong></div>
          <details class="v2-task-project-chooser">
            <summary>Switch project / directory</summary>
          <section id="task-project-filter" class="task-project-filter" aria-labelledby="task-project-filter-title" hidden>
            <label id="task-project-filter-title" class="sr-only" for="task-project-select">Project</label>
            <div id="task-project-filter-options" class="task-project-filter-options" role="group" aria-label="Project filter"></div>
            <span id="task-project-filter-mode" class="sr-only">All projects</span>
            <div id="task-project-group-manager"></div>
          </section>

            <section id="task-project-workspace" class="v2-task-project-workspace" aria-labelledby="task-project-workspace-label" hidden>
              <label id="task-project-workspace-label" for="task-project-workspace-select">This project's working directory</label>
              <select id="task-project-workspace-select" class="settings-select" disabled><option value="">No working directory selected</option></select>
              <button id="task-project-workspace-choose" class="button button-ghost" type="button">Change directory</button>
              <button id="task-project-workspace-retry" class="button button-ghost" type="button" hidden>Retry</button>
              <p id="task-project-workspace-status" role="status" aria-live="polite"></p>
            </section>
          </details>
          <div id="task-project-workspace-access" class="v2-task-project-access" hidden>
            <span id="task-project-workspace-permission-summary" class="state-text"></span>
            <button id="task-project-workspace-permissions" class="button button-ghost" type="button">Permission settings</button>
          </div>
        </footer>
      </section>
      <div id="task-list-resizer" class="task-pane-resizer" role="separator" aria-label="Resize task list" aria-controls="task-hub-list-pane" aria-orientation="vertical" tabindex="0"></div>
      <section id="task-workbench-empty" class="task-workbench-empty v2-task-empty" aria-labelledby="task-workbench-empty-title">
        <h2 id="task-workbench-empty-title">Choose a task</h2>
        <p>Open a task to see its conversation and steps.</p>
      </section>
      <section id="task-detail-pane" class="task-detail-pane v2-task-detail" aria-labelledby="task-detail-title" hidden>
        <header class="task-detail-header v2-task-heading">
          <button id="task-detail-back" class="button button-ghost task-detail-back" type="button" aria-label="Back to task list">Tasks</button>
          <div id="task-detail-heading" class="task-detail-heading">
            <h2 id="task-detail-title" tabindex="-1">Task detail</h2>
            <p id="task-detail-project" class="state-text">Project</p>
          </div>
          <div id="task-detail-heading-state" class="v2-task-heading-state">
            <span id="task-detail-status" class="task-chip">Queued</span>
            <span id="task-detail-agent-presence" class="task-chip">Agent unknown</span>
            <button id="task-info-toggle" class="button button-ghost" type="button" popovertarget="task-info-popover" aria-haspopup="dialog">Details</button>
            <small id="task-detail-freshness" class="task-detail-freshness" role="status" aria-live="polite" aria-atomic="true" hidden>Snapshot unavailable</small>
          </div>
        </header>
        <div id="task-detail-loading" class="task-detail-loading" role="status" aria-live="polite" aria-atomic="true" hidden><strong id="task-detail-loading-label">Loading snapshot…</strong></div>
        <div id="task-detail-layout" class="v2-task-detail-layout">
          <section class="v2-task-progress" aria-label="Task progress">
            <div class="task-progress-row">
              <strong id="task-detail-progress-label">Progress not reported</strong>
              <span id="task-detail-progress-value">—</span>
              <span id="task-detail-current-step" data-no-i18n>No current step</span>
            </div>
            <div id="task-detail-progress-track" class="task-progress-track" role="progressbar" aria-label="Task progress" aria-valuemin="0" aria-valuemax="100" aria-valuetext="Progress not reported"><span id="task-detail-progress-bar"></span></div>
            <p id="task-detail-progress-note" class="task-detail-progress-note" hidden></p>
          </section>
          <div class="v2-task-detail-toolbar">
            <div class="v2-task-tabs" role="tablist" aria-label="Task detail">
              <button id="task-tab-conversation" class="v2-tab is-active" role="tab" type="button" data-task-detail-tab="conversation" aria-controls="task-panel-conversation" aria-selected="true" tabindex="0">Conversation</button>
              <button id="task-tab-steps" class="v2-tab" role="tab" type="button" data-task-detail-tab="steps" aria-controls="task-panel-steps" aria-selected="false" tabindex="-1">Steps <span id="task-detail-step-count" data-no-i18n>0 / 0</span></button>
              <button id="task-tab-output" class="v2-tab" role="tab" type="button" data-task-detail-tab="output" aria-controls="task-panel-output" aria-selected="false" tabindex="-1">Terminal output and logs</button>
            </div>
            <button id="task-coordination-open" class="button button-ghost" type="button" popovertarget="task-info-popover" popovertargetaction="show" aria-haspopup="dialog">Coordination inbox</button>
          </div>
          <section id="task-panel-conversation" class="task-conversation-card v2-task-conversation" role="tabpanel" aria-labelledby="task-tab-conversation" data-task-detail-panel="conversation">
            <header class="task-conversation-header">
              <div>
                <h3 id="task-conversation-title" class="sr-only">Talk to the Agent</h3>
              </div>
              <span id="task-conversation-delivery" class="state-text">Messages are stored locally</span>
            </header>
            <div class="task-message-history-controls">
              <button id="task-message-load-older" class="button button-ghost" type="button" hidden aria-controls="task-message-list" aria-describedby="task-message-history-status">Load earlier messages</button>
              <span id="task-message-history-status" role="status" aria-live="polite"></span>
            </div>
            <div id="task-message-list" class="task-message-list" role="log" tabindex="0" aria-live="polite" aria-relevant="additions text" aria-atomic="false" aria-labelledby="task-conversation-title" aria-describedby="task-conversation-delivery task-message-history-status">
              <div class="task-detail-empty">No conversation yet.</div>
            </div>
            <form id="task-message-form" class="task-message-form" aria-describedby="task-message-help task-message-submit-status">
              <label id="task-message-label" for="task-message-input">Message the Agent</label>
              <textarea id="task-message-input" rows="2" maxlength="8000" aria-describedby="task-message-help task-message-shortcuts task-message-character-count task-message-submit-status" aria-keyshortcuts="Enter Control+Enter Meta+Enter" placeholder="Message the Agent…"></textarea>
              <div class="task-message-form-footer">
                <span id="task-message-shortcuts">Enter to send · Shift+Enter for a new line</span>
                <span id="task-message-help" class="sr-only">Sovereign surfaces saved messages with the Agent's next tool result and through Tasks Inbox.</span>
                <span id="task-message-character-count" class="task-message-character-count" aria-live="polite">0 / 8000</span>
                <span id="task-message-submit-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></span>
                <button id="task-message-send" class="button button-primary" type="submit" aria-describedby="task-message-submit-status" disabled>Send message</button>
              </div>
            </form>
          </section>
          <section id="task-panel-steps" class="v2-task-steps" role="tabpanel" aria-labelledby="task-tab-steps" data-task-detail-panel="steps" tabindex="0" hidden>
            <h3 id="task-steps-title">Steps reported by the Agent</h3>
            <div id="task-detail-steps" class="task-step-list" role="list" aria-label="Task steps"><div class="task-detail-empty">The Agent has not published a step plan.</div></div>
            <span id="task-detail-updated" class="state-text">Not updated</span>
            <footer class="v2-panel-footer">
              <button id="task-steps-output" class="button button-secondary" type="button">View run output</button>
              <button id="task-steps-message" class="button button-primary" type="button">Add a message</button>
            </footer>
          </section>
          <section id="task-panel-output" class="v2-task-output" role="tabpanel" aria-labelledby="task-tab-output" data-task-detail-panel="output" tabindex="0" hidden>
            <div id="task-run-output-slot" class="v2-run-slot">${renderRunsWorkbench()}</div>
          </section>
          <div id="task-info-popover" class="task-detail-information task-workbench-popover" popover="auto" role="dialog" aria-labelledby="task-info-title" tabindex="-1">
            <header class="task-popover-heading">
              <h3 id="task-info-title">Task details</h3>
              <button class="button button-ghost task-popover-close" type="button" popovertarget="task-info-popover" popovertargetaction="hide" aria-label="Close details">×</button>
            </header>
            <p id="task-detail-summary">Select a task to inspect its progress and conversation.</p>
            <p id="task-detail-trust" class="task-detail-trust">Task state not verified</p>
              <details class="task-technical-details">
                <summary>Task details</summary>
                <dl class="task-detail-metadata">
                <div><dt>Board state</dt><dd id="task-detail-board-state">Unverified</dd></div>
                <div><dt>Recorded status</dt><dd id="task-detail-recorded-status">Queued</dd></div>
                <div><dt>Category</dt><dd id="task-detail-category">Other</dd></div>
                <div><dt>Source</dt><dd id="task-detail-source">Agent registered</dd></div>
                <div><dt>Agent</dt><dd id="task-detail-agent">Unassigned</dd></div>
                <div><dt id="task-detail-heartbeat-label">Last heartbeat</dt><dd id="task-detail-heartbeat">None</dd></div>
                <div><dt>Last activity</dt><dd id="task-detail-last-activity">None</dd></div>
                <div><dt>Project root</dt><dd class="task-project-terminal"><code id="task-detail-project-root">—</code><button id="task-detail-open-terminal" class="button button-ghost task-project-terminal-action simple-mode-hidden" type="button">Open terminal in working directory</button></dd></div>
                </dl>
              </details>

            <section id="task-session-continuity" class="task-detail-card task-session-continuity-card" aria-labelledby="task-session-continuity-title" hidden>
              <div class="task-session-continuity-heading">
                <div>
                  <p id="task-session-continuity-kicker" class="panel-kicker" data-no-i18n=""></p>
                  <h3 id="task-session-continuity-title" data-no-i18n=""></h3>
                </div>
                <span id="task-session-continuity-state" class="task-session-continuity-state" data-no-i18n=""></span>
              </div>
              <p id="task-session-continuity-detail" class="task-session-continuity-detail" data-no-i18n=""></p>
              <dl class="task-session-continuity-grid">
                <div>
                  <dt id="task-session-continuity-owner-caption" data-no-i18n=""></dt>
                  <dd id="task-session-continuity-owner" data-no-i18n=""></dd>
                </div>
                <div>
                  <dt id="task-session-continuity-conversation-caption" data-no-i18n=""></dt>
                  <dd id="task-session-continuity-conversation" data-no-i18n=""></dd>
                </div>
              </dl>
              <p class="task-session-continuity-next">
                <strong id="task-session-continuity-next-caption" data-no-i18n=""></strong>
                <span id="task-session-continuity-next" data-no-i18n=""></span>
              </p>
            </section>

            <details id="task-coordination-panel" class="task-detail-card task-coordination-card">
              <summary class="task-coordination-summary">
                <span id="task-coordination-title">Coordination inbox</span>
                <span id="task-coordination-unread-count" class="task-coordination-unread-count" aria-describedby="task-coordination-snapshot-status">Coordination unread count unavailable</span>
                <span id="task-coordination-count" class="task-coordination-pending-count" aria-describedby="task-coordination-snapshot-status">Coordination count unavailable</span>
              </summary>
              <div class="task-detail-card-heading">
                <button id="task-coordination-refresh" class="button button-ghost" type="button">Refresh coordination</button>
              </div>
              <p id="task-coordination-note" class="task-coordination-note">Separate from Task conversation. Viewing here does not change Agent delivery, read or acknowledgement state.</p>
              <p id="task-coordination-snapshot-status" class="task-coordination-snapshot-status" role="status" aria-live="polite" aria-atomic="true"></p>
              <div class="task-coordination-history-controls">
                <button id="task-coordination-load-older" class="button button-ghost" type="button" aria-controls="task-coordination-list" aria-describedby="task-coordination-history-status" hidden>Load earlier coordination</button>
                <span id="task-coordination-history-status" class="task-coordination-history-status" role="status" aria-live="polite" aria-atomic="true"></span>
              </div>
              <div id="task-coordination-list" class="task-coordination-list" role="list" tabindex="0" aria-labelledby="task-coordination-title" aria-describedby="task-coordination-note task-coordination-snapshot-status task-coordination-history-status">
                <p class="task-coordination-state">Loading coordination…</p>
              </div>
            </details>
          </div>
        </div>
      </section>
      <section id="task-run-history" class="v2-task-history" aria-labelledby="task-run-history-title" hidden>
        <header class="v2-task-history-heading"><h2 id="task-run-history-title" tabindex="-1">History and runs</h2><button id="task-history-back" class="button button-ghost" type="button">Task history</button></header>
        <div id="task-run-history-slot" class="v2-run-slot"></div>
      </section>
    </div>
  `;
}
