import { renderBrowserView } from "./view-browser.js";
import { renderComputerView } from "./view-computer.js";
import { renderOverviewView } from "./view-overview.js";
import { renderPythonView } from "./view-python.js";
import { renderSettingsView } from "./view-settings.js";
import { renderTasksView } from "./view-tasks.js";
import { renderTerminalView } from "./view-terminal.js";
import { renderWorkflowsView } from "./view-workflows.js";
import { renderApprovalsAuditView } from "./view-approvals-audit.js";
import type { UiIcon } from "./ui-icons.js";

export type NavigationSection = "primary" | "execute";
export type NavigationIcon = UiIcon;
interface ViewDefinitionShape {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly navigationLabel: string;
  readonly navigationIcon: NavigationIcon;
  readonly navigationSection: NavigationSection;
  readonly render: () => string;
  readonly refreshOnActivate?: boolean;
}
export const VIEW_DEFINITIONS = [
  { id: "overview", title: "Home & Connections", description: "Connections and current work", navigationLabel: "Home & Connections", navigationIcon: "home", navigationSection: "primary", render: renderOverviewView },
  { id: "tasks", title: "Tasks", description: "Conversation, progress and run output", navigationLabel: "Tasks", navigationIcon: "tasks", navigationSection: "primary", render: renderTasksView, refreshOnActivate: true },
  { id: "approvals", title: "Approvals & Audit", description: "Pending requests and operation receipts", navigationLabel: "Approvals & Audit", navigationIcon: "approval", navigationSection: "primary", render: renderApprovalsAuditView, refreshOnActivate: true },
  { id: "settings", title: "Settings", description: "Appearance, workspace and diagnostics", navigationLabel: "Settings", navigationIcon: "settings", navigationSection: "primary", render: renderSettingsView },
  { id: "terminal", title: "Terminal", description: "Workspace terminal sessions", navigationLabel: "Terminal", navigationIcon: "terminal", navigationSection: "execute", render: renderTerminalView, refreshOnActivate: true },
  { id: "python", title: "Python", description: "Code, configuration and output", navigationLabel: "Python", navigationIcon: "python", navigationSection: "execute", render: renderPythonView, refreshOnActivate: true },
  { id: "browser", title: "Browser", description: "Managed browsing and observations", navigationLabel: "Browser", navigationIcon: "browser", navigationSection: "execute", render: renderBrowserView, refreshOnActivate: true },
  { id: "computer", title: "Desktop Control", description: "Revision-bound desktop actions", navigationLabel: "Desktop Control", navigationIcon: "computer", navigationSection: "execute", render: renderComputerView, refreshOnActivate: true },
  { id: "workflows", title: "Workflows", description: "Ordered validation and execution", navigationLabel: "Workflows", navigationIcon: "workflows", navigationSection: "execute", render: renderWorkflowsView, refreshOnActivate: true },
] as const satisfies readonly ViewDefinitionShape[];
export type ViewDefinition = (typeof VIEW_DEFINITIONS)[number];
export type CanonicalViewId = ViewDefinition["id"];
/** Legacy identifiers migrate navigation only; there are no duplicate hidden pages. */
export type ViewId = CanonicalViewId | "agent" | "runs";
export const DEFAULT_VIEW_ID: CanonicalViewId = "overview";
export function normalizeViewId(value: ViewId): CanonicalViewId {
  return value === "agent" ? "overview" : value === "runs" ? "tasks" : value;
}
export function isViewId(value: string | undefined): value is ViewId {
  return value === "agent" || value === "runs" || VIEW_DEFINITIONS.some(view => view.id === value);
}
export function getViewDefinition(value: ViewId): ViewDefinition {
  const id = normalizeViewId(value);
  const definition = VIEW_DEFINITIONS.find(view => view.id === id);
  if (!definition) throw new Error(`Unknown renderer view: ${value}`);
  return definition;
}
