import type {
  DesktopActiveToolActivity,
  DesktopAuditReceipt,
  DesktopRunState,
  DesktopRunSummary,
} from "../shared.js";

export type DesktopActivityCategory =
  | "terminal"
  | "files"
  | "search"
  | "git"
  | "python"
  | "workflow"
  | "browser"
  | "computer"
  | "system"
  | "other";

export type DesktopActivityState = DesktopRunState | "denied";

export interface DesktopActivityItem {
  readonly id: string;
  readonly source: "run" | "audit" | "live";
  readonly category: DesktopActivityCategory;
  readonly label: string;
  readonly detail: string;
  readonly occurredAt: string;
  readonly state: DesktopActivityState;
  readonly active: boolean;
  readonly failed: boolean;
  readonly runId: string | null;
}

export interface DesktopActivityFeed {
  readonly items: readonly DesktopActivityItem[];
  readonly activeCount: number;
  readonly recentFailureCount: number;
}

export interface BuildDesktopActivityFeedOptions {
  readonly limit?: number;
  readonly activeToolActivities?: readonly DesktopActiveToolActivity[];
}

const ACTIVE_RUN_STATES = new Set<DesktopRunState>(["queued", "running"]);
const FAILED_RUN_STATES = new Set<DesktopRunState>([
  "failed",
  "timed-out",
  "interrupted",
]);

const MANAGED_RUN_RECEIPTS = new Set([
  "terminal.start",
  "python.start",
  "workflow.start",
  "validation.start",
  "runs.complete",
  "runs.cancel",
]);

const PASSIVE_BACKGROUND_RECEIPTS = new Set([
  "system.audit_receipts",
  "system.capabilities",
  "system.manifest",
  "system.resources",
  "workspace.list",
  "runs.list",
  "runs.get",
  "runs.wait",
  "terminal.session.list",
  "terminal.session.read",
  "browser.capabilities",
  "browser.session.list",
  "computer.capabilities",
  "python.capabilities",
  "workflow.templates",
]);

export const ACTIVITY_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  "terminal.exec": "PowerShell command",
  "terminal.session.create": "Terminal session created",
  "terminal.session.write": "Terminal input sent",
  "terminal.session.close": "Terminal session closed",
  "files.read": "File read",
  "files.create": "File created",
  "files.replace": "File replaced",
  "files.replace_text": "File updated",
  "files.delete": "File deleted",
  "files.mkdir": "Folder created",
  "search.text": "Source searched",
  "git.status": "Git status checked",
  "git.diff": "Git changes reviewed",
  "git.stage": "Git changes staged",
  "git.commit": "Git checkpoint created",
  "git.log": "Git history reviewed",
  "browser.session.create": "Browser session created",
  "browser.navigate": "Browser navigated",
  "browser.observe": "Browser page observed",
  "browser.action": "Browser action completed",
  "browser.evaluate": "Browser expression evaluated",
  "browser.session.close": "Browser session closed",
  "computer.observe": "Desktop captured",
  "computer.action": "Desktop action completed",
  "python.exec": "Python command",
  "workflow.validate": "Workflow validated",
  "validation.run": "Validation completed",
  "system.notify": "Windows notification sent",
};

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function categoryForTool(toolName: string): DesktopActivityCategory {
  const prefix = toolName.split(".")[0] ?? "";
  if (
    prefix === "terminal" ||
    prefix === "files" ||
    prefix === "search" ||
    prefix === "git" ||
    prefix === "python" ||
    prefix === "workflow" ||
    prefix === "browser" ||
    prefix === "computer" ||
    prefix === "system"
  ) {
    return prefix;
  }
  return "other";
}

function categoryForRun(run: DesktopRunSummary): DesktopActivityCategory {
  return run.kind === "validation" ? "system" : run.kind;
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^./u, (character) => character.toUpperCase());
}

function auditLabel(receipt: DesktopAuditReceipt): string {
  return ACTIVITY_DISPLAY_LABELS[receipt.toolName] ?? humanize(receipt.operation || receipt.toolName);
}

function auditDetail(receipt: DesktopAuditReceipt): string {
  if (receipt.relativePath !== null && receipt.relativePath.length > 0) {
    return receipt.relativePath;
  }
  const category = humanize(receipt.toolName.split(".")[0] ?? "Activity");
  return `${category} · ${humanize(receipt.operation)}`;
}

function auditState(receipt: DesktopAuditReceipt): DesktopActivityState {
  if (receipt.outcome === "succeeded") {
    return "succeeded";
  }
  if (receipt.outcome === "denied") {
    return "denied";
  }
  return "failed";
}

function shouldShowToolName(toolName: string): boolean {
  if (toolName.startsWith("tasks.")) {
    return false;
  }
  if (MANAGED_RUN_RECEIPTS.has(toolName)) {
    return false;
  }
  if (PASSIVE_BACKGROUND_RECEIPTS.has(toolName)) {
    return false;
  }
  if (toolName.endsWith(".capabilities")) {
    return false;
  }
  return true;
}

function shouldShowAudit(receipt: DesktopAuditReceipt): boolean {
  return shouldShowToolName(receipt.toolName);
}

function runActivity(run: DesktopRunSummary): DesktopActivityItem {
  return {
    id: `run:${run.id}`,
    source: "run",
    category: categoryForRun(run),
    label: run.label,
    detail: `${humanize(run.kind)} · ${run.id.slice(0, 8)}`,
    occurredAt: run.completedAt ?? run.startedAt ?? run.createdAt,
    state: run.state,
    active: ACTIVE_RUN_STATES.has(run.state),
    failed: FAILED_RUN_STATES.has(run.state),
    runId: run.id,
  };
}

function auditActivity(receipt: DesktopAuditReceipt): DesktopActivityItem {
  const state = auditState(receipt);
  return {
    id: `audit:${receipt.id}`,
    source: "audit",
    category: categoryForTool(receipt.toolName),
    label: auditLabel(receipt),
    detail: auditDetail(receipt),
    occurredAt: receipt.occurredAt,
    state,
    active: false,
    failed: state === "failed" || state === "denied",
    runId: null,
  };
}

function liveActivityCategory(activity: DesktopActiveToolActivity): DesktopActivityCategory {
  if (activity.category === "workspace" || activity.category === "files") {
    return "files";
  }
  if (activity.category === "validation" || activity.category === "runs") {
    return "system";
  }
  return categoryForTool(activity.toolName);
}

function liveToolActivity(activity: DesktopActiveToolActivity): DesktopActivityItem {
  const category = liveActivityCategory(activity);
  return {
    id: `live:${activity.id}`,
    source: "live",
    category,
    label: ACTIVITY_DISPLAY_LABELS[activity.toolName] ?? activity.title,
    detail: `${humanize(category)} · running`,
    occurredAt: activity.startedAt,
    state: "running",
    active: true,
    failed: false,
    runId: null,
  };
}

export function buildDesktopActivityFeed(
  runs: readonly DesktopRunSummary[],
  receipts: readonly DesktopAuditReceipt[],
  options: BuildDesktopActivityFeedOptions = {},
): DesktopActivityFeed {
  const limit = options.limit ?? 10;
  const liveActivities = (options.activeToolActivities ?? [])
    .filter((activity) => shouldShowToolName(activity.toolName));
  const values = [
    ...runs.map(runActivity),
    ...liveActivities.map(liveToolActivity),
    ...receipts.filter(shouldShowAudit).map(auditActivity),
  ].sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    const timestampDifference = parseTimestamp(right.occurredAt) - parseTimestamp(left.occurredAt);
    if (timestampDifference !== 0) {
      return timestampDifference;
    }
    return left.id.localeCompare(right.id);
  });
  const items = values.slice(0, Math.max(1, limit));
  return {
    items,
    activeCount:
      runs.filter((run) => ACTIVE_RUN_STATES.has(run.state)).length + liveActivities.length,
    recentFailureCount: items.filter((item) => item.failed).length,
  };
}