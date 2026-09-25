import { renderAgentView } from "./view-agent.js";
import { renderBrowserView } from "./view-browser.js";
import { renderComputerView } from "./view-computer.js";
import { renderOverviewView } from "./view-overview.js";
import { renderPythonView } from "./view-python.js";
import { renderRunsView } from "./view-runs.js";
import { renderSettingsView } from "./view-settings.js";
import { renderTasksView } from "./view-tasks.js";
import { renderTerminalView } from "./view-terminal.js";
import { renderWorkflowsView } from "./view-workflows.js";

export type NavigationSection = "primary" | "execute" | "utility";
export type NavigationIcon =
  | "home"
  | "connection"
  | "tasks"
  | "history"
  | "terminal"
  | "python"
  | "browser"
  | "desktop"
  | "workflow"
  | "settings";

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
  {
    id: "overview",
    title: "Home",
    description: "Runtime health, workspace access and current activity",
    navigationLabel: "Home",
    navigationIcon: "home",
    navigationSection: "primary",
    render: renderOverviewView,
  },
  {
    id: "tasks",
    title: "Tasks",
    description: "Projects, Agents, progress and task conversations",
    navigationLabel: "Tasks",
    navigationIcon: "tasks",
    navigationSection: "primary",
    render: renderTasksView,
    refreshOnActivate: true,
  },
  {
    id: "agent",
    title: "ChatGPT Connection",
    description: "Trusted ChatGPT access and remote host readiness",
    navigationLabel: "ChatGPT Connection",
    navigationIcon: "connection",
    navigationSection: "primary",
    render: renderAgentView,
    refreshOnActivate: true,
  },
  {
    id: "runs",
    title: "Task History",
    description: "Managed runs, outputs and audit history",
    navigationLabel: "Task History",
    navigationIcon: "history",
    navigationSection: "primary",
    render: renderRunsView,
    refreshOnActivate: true,
  },
  {
    id: "terminal",
    title: "Terminal",
    description: "Contained shell sessions inside the authorized workspace",
    navigationLabel: "Terminal",
    navigationIcon: "terminal",
    navigationSection: "execute",
    render: renderTerminalView,
    refreshOnActivate: true,
  },
  {
    id: "python",
    title: "Python",
    description: "Persistent Python execution and notebook-style output",
    navigationLabel: "Python",
    navigationIcon: "python",
    navigationSection: "execute",
    render: renderPythonView,
    refreshOnActivate: true,
  },
  {
    id: "browser",
    title: "Browser",
    description: "Isolated browser sessions and observed web activity",
    navigationLabel: "Browser",
    navigationIcon: "browser",
    navigationSection: "execute",
    render: renderBrowserView,
    refreshOnActivate: true,
  },
  {
    id: "computer",
    title: "Desktop Control",
    description: "Observed desktop control with explicit local boundaries",
    navigationLabel: "Desktop Control",
    navigationIcon: "desktop",
    navigationSection: "execute",
    render: renderComputerView,
    refreshOnActivate: true,
  },
  {
    id: "workflows",
    title: "Workflows",
    description: "Reusable multi-step operations and validation chains",
    navigationLabel: "Workflows",
    navigationIcon: "workflow",
    navigationSection: "execute",
    render: renderWorkflowsView,
    refreshOnActivate: true,
  },
  {
    id: "settings",
    title: "Settings",
    description: "Interface, host, security and diagnostic preferences",
    navigationLabel: "Settings",
    navigationIcon: "settings",
    navigationSection: "utility",
    render: renderSettingsView,
  },
] as const satisfies readonly ViewDefinitionShape[];

export type ViewDefinition = (typeof VIEW_DEFINITIONS)[number];
export type ViewId = ViewDefinition["id"];

export const DEFAULT_VIEW_ID: ViewId = VIEW_DEFINITIONS[0].id;

export function isViewId(value: string | undefined): value is ViewId {
  return value !== undefined && VIEW_DEFINITIONS.some((definition) => definition.id === value);
}

export function getViewDefinition(view: ViewId): ViewDefinition {
  const definition = VIEW_DEFINITIONS.find((candidate) => candidate.id === view);
  if (definition === undefined) {
    throw new Error(`Unknown renderer view: ${view}`);
  }
  return definition;
}
