import "./styles.css";
import "./workbench.css";
import "./product-shell.css";
import "./task-hub.css";
import "./task-session-continuity.css";
import "./ui-system.css";
import "./ui-geometry.css";
import "./ui-refinement.css";
import "./task-board.css";
import "./home-visualqa-restoration.css";
import "./home-active-work-polish.css";
import "./operate-shell-connection-polish.css";
import "./ui-affordance.css";

import type {
  DesktopAuditReceipt,
  DesktopHostStartupState,
  DesktopManifestView,
  DesktopPermissionProfile,
  DesktopRendererHandoff,
  DesktopRendererUpdateStatus,
  DesktopRuntimeRollingStatus,
  RuntimeCandidateUpdateStatus,
  DesktopResourceSnapshot,
  DesktopRunRecord,
  DesktopRunSummary,
  DesktopRuntimeState,
  DesktopTaskWorkspaceSnapshot,
} from "../shared.js";
import {
  ACTIVITY_DISPLAY_LABELS,
  buildDesktopActivityFeed,
  type DesktopActivityItem,
} from "./activity-feed.js";
import {
  ActiveWorkCarousel,
  activeWorkPositionLabel,
  buildActiveWorkItems,
  type ActiveWorkItem,
} from "./active-work-carousel.js";
import { BrowserController } from "./browser-controller.js";
import { ComputerController } from "./computer-controller.js";
import { PythonController } from "./python-controller.js";
import { RunsController } from "./runs-controller.js";
import {
  computeRefreshDelayMs,
  RefreshCoordinator,
  type RefreshMode,
} from "./refresh-coordinator.js";
import { mountApplicationShell } from "./shell.js";
import { RendererUpdateSettlementPoller } from "./renderer-update-settlement.js";
import {
  taskHasLiveAgent,
  taskNeedsOperatorAction,
} from "./task-board-model.js";
import { taskProjectForTask } from "./task-project-terminal.js";
import { TasksController } from "./tasks-controller.js";
import { TaskProjectWorkspaceController } from "./task-project-workspace.js";
import { TerminalController } from "./terminal-controller.js";
import { WorkflowController } from "./workflow-controller.js";
import {
  localizeSubtree,
  observeLocalization,
  type UiLanguage,
} from "./localization.js";
import {
  normalizePersistedView,
  resolveInitialView,
  type ExperienceMode,
  type StartupViewPreference,
} from "./navigation-state.js";
import {
  DEFAULT_VIEW_ID,
  getViewDefinition,
  isViewId,
  type ViewId,
} from "./view-registry.js";

const appRootCandidate = document.querySelector<HTMLDivElement>("#app");
if (appRootCandidate === null) {
  throw new Error("Application root was not found.");
}
const appRoot = appRootCandidate;
mountApplicationShell(appRoot);

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required UI element is missing: ${selector}`);
  }
  return element;
}

const phaseLabels: Readonly<Record<DesktopRuntimeState["phase"], string>> = {
  "setup-required": "Setup required",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  error: "Error",
};

type UiStartupView = StartupViewPreference;
type UiScale = 1 | 1.1 | 1.25 | 1.5;
type UiFontScale = 1 | 1.1 | 1.2 | 1.3;
type UiExperienceMode = ExperienceMode;
type SettingsTab = "appearance" | "host" | "security" | "diagnostics";

interface UiSettings {
  readonly sidebarCollapsed: boolean;
  readonly startupView: UiStartupView;
  readonly refreshIntervalMs: 1000 | 3000 | 5000 | 10000;
  readonly reducedMotion: boolean;
  readonly uiScale: UiScale;
  readonly fontScale: UiFontScale;
  readonly language: UiLanguage;
  readonly experienceMode: UiExperienceMode;
}

const UI_SETTINGS_KEY = "sovereign.ui.settings.v1";
const LAST_VIEW_KEY = "sovereign.ui.last-view.v1";
const LAST_SETTINGS_TAB_KEY = "sovereign.ui.last-settings-tab.v1";
const LAST_RUNS_TAB_KEY = "sovereign.ui.last-runs-tab.v1";
const LAST_RUN_OUTPUT_TAB_KEY = "sovereign.ui.last-run-output-tab.v1";
const DEFAULT_UI_SETTINGS: UiSettings = {
  sidebarCollapsed: false,
  startupView: "overview",
  refreshIntervalMs: 5000,
  reducedMotion: false,
  uiScale: 1.1,
  fontScale: 1,
  language: window.navigator.language.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en",
  experienceMode: "simple",
};

function readUiSettings(): UiSettings {
  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_KEY);
    if (raw === null) {
      return DEFAULT_UI_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    const refreshIntervalMs = [1000, 3000, 5000, 10000].includes(
      parsed.refreshIntervalMs ?? 0,
    )
      ? (parsed.refreshIntervalMs as UiSettings["refreshIntervalMs"])
      : DEFAULT_UI_SETTINGS.refreshIntervalMs;
    const startupView =
      parsed.startupView === "tasks" ||
      parsed.startupView === "agent" ||
      parsed.startupView === "runs" ||
      parsed.startupView === "last"
        ? parsed.startupView
        : "overview";
    const uiScale =
      parsed.uiScale === 1 ||
      parsed.uiScale === 1.1 ||
      parsed.uiScale === 1.25 ||
      parsed.uiScale === 1.5
        ? parsed.uiScale
        : DEFAULT_UI_SETTINGS.uiScale;
    const fontScale =
      parsed.fontScale === 1 ||
      parsed.fontScale === 1.1 ||
      parsed.fontScale === 1.2 ||
      parsed.fontScale === 1.3
        ? parsed.fontScale
        : DEFAULT_UI_SETTINGS.fontScale;
    const language =
      parsed.language === "en" || parsed.language === "zh-CN"
        ? parsed.language
        : DEFAULT_UI_SETTINGS.language;
    const experienceMode =
      parsed.experienceMode === "full" || parsed.experienceMode === "simple"
        ? parsed.experienceMode
        : DEFAULT_UI_SETTINGS.experienceMode;
    return {
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      startupView,
      refreshIntervalMs,
      reducedMotion: parsed.reducedMotion === true,
      uiScale,
      fontScale,
      language,
      experienceMode,
    };
  } catch {
    return DEFAULT_UI_SETTINGS;
  }
}

let currentState: DesktopRuntimeState | null = null;
let currentHostStartup: DesktopHostStartupState | null = null;
let latestOverviewRuns: readonly DesktopRunSummary[] = [];
let latestAuditReceipts: readonly DesktopAuditReceipt[] = [];
let latestTaskWorkspace: DesktopTaskWorkspaceSnapshot | null = null;
let lastExternalActivityReceiptId: string | null = null;
let latestCapabilities: readonly string[] = [];
let capabilitySearchQuery = "";
let capabilityLevelFilter: "all" | "observe" | "workspace" | "consequential" =
  "all";
let auditSearchQuery = "";
let auditOutcomeFilter = "all";
let secureTunnelIdDraft: string | null = null;
let secureTunnelIdDirty = false;
let toastTimer: number | null = null;
let pollTimer: number | null = null;
let refreshCoordinator: RefreshCoordinator | null = null;
let consecutivePollFailures = 0;
let lastHostStartupPollAt = 0;
let uiSettings = readUiSettings();
let currentView: ViewId = DEFAULT_VIEW_ID;
let currentRendererUpdateStatus: DesktopRendererUpdateStatus | null = null;
let currentRuntimeCandidateUpdateStatus: RuntimeCandidateUpdateStatus | null =
  null;
const originalInlineFontSizes = new WeakMap<HTMLElement, string>();
let fontScaleManagedElements = new Set<HTMLElement>();
let fontScaleObserver: MutationObserver | null = null;
let fontScaleApplyScheduled = false;
let stopLocalizationObserver: (() => void) | null = null;

const runsController = new RunsController({
  api: window.sovereign,
  notify: showToast,
  onSummariesChanged: renderOverviewRuns,
  onActiveRunChanged: renderOverviewActiveRun,
});
const projectWorkspaceController = new TaskProjectWorkspaceController({
  api: window.sovereign,
  onChanged: refreshAll,
});
const tasksController = new TasksController({
  api: window.sovereign,
  notify: showToast,
  onProjectSelected: (projectId) => projectWorkspaceController.selectProject(projectId),
  onSnapshotChanged: (snapshot) => {
    latestTaskWorkspace = snapshot;
    renderOverviewRuns(latestOverviewRuns);
  },
});
const terminalController = new TerminalController({
  api: window.sovereign,
  notify: showToast,
});
const pythonController = new PythonController({
  api: window.sovereign,
  notify: showToast,
  onRunStarted: () => void runsController.refresh(),
});
const browserController = new BrowserController({
  api: window.sovereign,
  notify: showToast,
});
const workflowController = new WorkflowController({
  api: window.sovereign,
  notify: showToast,
  onRunStarted: () => void runsController.refresh(),
});
const computerController = new ComputerController({
  api: window.sovereign,
  notify: showToast,
});

async function openSelectedTaskProjectTerminal(): Promise<void> {
  const project = taskProjectForTask(tasksController.snapshot, tasksController.selectedTaskId);
  if (project === null) return;
  await tasksController.selectProject(project.id);
  if (currentState?.activeDesktopWorkspace?.projectId !== project.id ||
      currentState.activeDesktopWorkspace.id !== projectWorkspaceController.activeWorkspaceId) {
    tasksController.showProjects();
    showToast("Choose a working directory for this project before opening a terminal.", true);
    return;
  }
  if (await terminalController.create("")) activateView("terminal");
}

runsController.mount();
tasksController.mount();
projectWorkspaceController.mount();
terminalController.mount();
pythonController.mount();
browserController.mount();
workflowController.mount();
computerController.mount();
requiredElement<HTMLButtonElement>(
  "#task-detail-open-terminal",
).addEventListener("click", () => void openSelectedTaskProjectTerminal());

function openActiveWorkItem(item: ActiveWorkItem): void {
  activateView("tasks");
  void tasksController.openTask(item.taskId);
}

function applyActiveWorkSelection(
  item: ActiveWorkItem | null,
  total: number,
  focusedIndex: number,
): void {
  const action = requiredElement<HTMLButtonElement>("#home-task-action");
  const count = requiredElement<HTMLElement>("#home-active-work-count");
  count.textContent = activeWorkPositionLabel(total, focusedIndex);
  delete action.dataset.taskId;
  if (item === null) {
    action.dataset.openView = "tasks";
    action.textContent = "Open tasks";
    action.title = "Open Tasks";
    return;
  }
  action.dataset.openView = "tasks";
  action.dataset.taskId = item.taskId;
  action.textContent = "Open task";
  action.title = `${item.title} · ${action.textContent}`;
}

const activeWorkCarousel = new ActiveWorkCarousel(
  requiredElement<HTMLElement>("#home-active-work-carousel"),
  {
    onActivate: openActiveWorkItem,
    onSelectionChanged: applyActiveWorkSelection,
  },
);

function syncActiveWorkNavigator(): void {
  activeWorkCarousel.update(
    buildActiveWorkItems({
      taskWorkspace: latestTaskWorkspace,
    }),
  );
}

function abbreviatedDigest(value: string | null): string {
  return value === null ? "—" : `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(
    uiSettings.language === "zh-CN" ? "zh-CN" : "en-US",
    {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    },
  ).format(date);
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  const units = ["B", "KB", "MB", "GB"] as const;
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDurationMs(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 1_000) {
    return `${Math.round(value)} ms`;
  }
  const seconds = value / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(minutes >= 10 ? 0 : 1)} min`;
  }
  const hours = minutes / 60;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)} h`;
}

function showToast(message: string, isError = false): void {
  const toast = requiredElement<HTMLDivElement>("#toast");
  requiredElement<HTMLElement>("#toast-message").textContent = message;
  toast.setAttribute("role", isError ? "alert" : "status");
  toast.setAttribute("aria-live", isError ? "assertive" : "polite");
  toast.hidden = false;
  toast.classList.toggle("is-error", isError);
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = isError ? null : window.setTimeout(() => { toast.hidden = true; }, 3200);
}

requiredElement<HTMLButtonElement>("#toast-dismiss").addEventListener("click", () => {
  requiredElement<HTMLElement>("#toast").hidden = true;
});

function persistUiSettings(): void {
  try {
    window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(uiSettings));
  } catch {
    // Interface preferences are best-effort and never affect runtime safety.
  }
}

function applySidebarState(collapsed: boolean): void {
  const shell = requiredElement<HTMLDivElement>(".application-shell");
  const toggle = requiredElement<HTMLButtonElement>("#sidebar-toggle");
  shell.classList.toggle("sidebar-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.setAttribute(
    "aria-label",
    collapsed ? "Expand sidebar" : "Collapse sidebar",
  );
  toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  requiredElement<HTMLInputElement>("#sidebar-collapsed-setting").checked =
    collapsed;
}

function applyReducedMotion(enabled: boolean): void {
  document.documentElement.classList.toggle("reduce-motion", enabled);
  requiredElement<HTMLInputElement>("#ui-reduced-motion").checked = enabled;
}

function applyExperienceMode(mode: UiExperienceMode): void {
  document.documentElement.dataset.experienceMode = mode;
  requiredElement<HTMLSelectElement>("#ui-experience-mode").value = mode;
  if (mode !== "simple") {
    return;
  }
  const activeView =
    document.querySelector<HTMLElement>(".view.is-active")?.dataset.viewPanel;
  if (
    activeView === "terminal" ||
    activeView === "python" ||
    activeView === "browser" ||
    activeView === "computer" ||
    activeView === "workflows"
  ) {
    activateView("overview");
  }
  const activeSettingsPane = document.querySelector<HTMLElement>(
    "[data-settings-pane].is-active",
  )?.dataset.settingsPane;
  if (activeSettingsPane === "diagnostics") {
    setSettingsTab("appearance");
  }
}

function applyLanguage(language: UiLanguage): void {
  requiredElement<HTMLSelectElement>("#ui-language").value = language;
  localizeSubtree(appRoot, language);
  tasksController.rerenderSelectedDetail();
}

function applyUiScale(scale: UiScale): void {
  requiredElement<HTMLSelectElement>("#ui-scale").value = String(scale);
  void window.sovereign.setUiScale(scale).catch((error: unknown) => {
    showToast(
      error instanceof Error ? error.message : "Could not apply the UI scale.",
      true,
    );
  });
}

function applyFontScale(scale: UiFontScale): void {
  requiredElement<HTMLSelectElement>("#ui-font-scale").value = String(scale);

  for (const element of fontScaleManagedElements) {
    const original = originalInlineFontSizes.get(element);
    if (original !== undefined) {
      element.style.fontSize = original;
    }
  }
  fontScaleManagedElements = new Set<HTMLElement>();

  if (scale === 1) {
    return;
  }

  const elements = [
    document.body,
    ...Array.from(document.body.querySelectorAll("*")).filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    ),
  ];
  const baseSizes = elements.map((element) => {
    if (!originalInlineFontSizes.has(element)) {
      originalInlineFontSizes.set(element, element.style.fontSize);
    }
    return {
      element,
      size: Number.parseFloat(window.getComputedStyle(element).fontSize),
    };
  });

  for (const { element, size } of baseSizes) {
    if (!Number.isFinite(size) || size <= 0) {
      continue;
    }
    element.style.fontSize = `${Math.round(size * scale * 100) / 100}px`;
    fontScaleManagedElements.add(element);
  }
}

function scheduleFontScaleRefresh(): void {
  if (fontScaleApplyScheduled || uiSettings.fontScale === 1) {
    return;
  }
  fontScaleApplyScheduled = true;
  window.requestAnimationFrame(() => {
    fontScaleApplyScheduled = false;
    applyFontScale(uiSettings.fontScale);
  });
}

function startFontScaleObserver(): void {
  fontScaleObserver?.disconnect();
  fontScaleObserver = new MutationObserver((mutations) => {
    if (
      mutations.some(
        (mutation) =>
          mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0,
      )
    ) {
      scheduleFontScaleRefresh();
    }
  });
  fontScaleObserver.observe(document.body, { childList: true, subtree: true });
}

function syncInterfaceSettings(): void {
  applySidebarState(uiSettings.sidebarCollapsed);
  applyReducedMotion(uiSettings.reducedMotion);
  requiredElement<HTMLSelectElement>("#ui-scale").value = String(
    uiSettings.uiScale,
  );
  requiredElement<HTMLSelectElement>("#ui-font-scale").value = String(
    uiSettings.fontScale,
  );
  requiredElement<HTMLSelectElement>("#ui-startup-view").value =
    uiSettings.startupView;
  requiredElement<HTMLSelectElement>("#ui-refresh-interval").value = String(
    uiSettings.refreshIntervalMs,
  );
  applyExperienceMode(uiSettings.experienceMode);
  applyLanguage(uiSettings.language);
}

function setSidebarCollapsed(collapsed: boolean): void {
  uiSettings = { ...uiSettings, sidebarCollapsed: collapsed };
  persistUiSettings();
  applySidebarState(collapsed);
}

function validRendererHandoff(): DesktopRendererHandoff | null {
  const value = window.__SOVEREIGN_RENDERER_HANDOFF__ ?? null;
  if (
    value === null ||
    value.schemaVersion !== "scr.renderer-handoff/v1" ||
    (value.view !== null && !isViewId(value.view)) ||
    (value.settingsTab !== null &&
      value.settingsTab !== "appearance" &&
      value.settingsTab !== "host" &&
      value.settingsTab !== "security" &&
      value.settingsTab !== "diagnostics") ||
    !Number.isSafeInteger(value.scrollTop) ||
    value.scrollTop < 0 ||
    value.scrollTop > 10_000_000
  ) {
    return null;
  }
  return value;
}

const rendererHandoff = validRendererHandoff();

function readLastView(): ViewId | null {
  try {
    return normalizePersistedView(
      window.localStorage.getItem(LAST_VIEW_KEY),
      uiSettings.experienceMode,
    );
  } catch {
    return null;
  }
}

function isPageReload(): boolean {
  const navigation = window.performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  return navigation?.type === "reload";
}

function resolveStartupView(): ViewId {
  const handoffView = rendererHandoff?.view;
  if (
    handoffView !== null &&
    handoffView !== undefined &&
    isViewId(handoffView) &&
    (uiSettings.experienceMode !== "simple" ||
      (handoffView !== "terminal" &&
        handoffView !== "python" &&
        handoffView !== "browser" &&
        handoffView !== "computer" &&
        handoffView !== "workflows"))
  ) {
    return handoffView;
  }
  return resolveInitialView({
    lastView: readLastView(),
    startupView: uiSettings.startupView,
    experienceMode: uiSettings.experienceMode,
    isReload: isPageReload(),
  });
}

function readStoredChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored !== null && allowed.includes(stored as T)
      ? (stored as T)
      : fallback;
  } catch {
    return fallback;
  }
}

async function refreshActiveWorkbench(): Promise<void> {
  if (currentState?.phase !== "running") {
    return;
  }
  if (currentView === "terminal") {
    await terminalController.refresh();
  } else if (currentView === "python") {
    await pythonController.refresh();
  } else if (currentView === "browser") {
    await browserController.refresh();
  } else if (currentView === "computer") {
    await computerController.refresh();
  } else if (currentView === "workflows") {
    await workflowController.refresh();
  }
}

function nextPollingDelay(): number {
  const hasActiveTask =
    latestTaskWorkspace?.projects.some((project) =>
      project.tasks.some(
        (task) =>
          task.status === "queued" ||
          task.status === "planning" ||
          task.status === "running",
      ),
    ) ?? false;
  const hasActiveWork =
    hasActiveTask ||
    latestOverviewRuns.some(
      (run) => run.state === "queued" || run.state === "running",
    ) ||
    (currentState?.activeToolActivities.length ?? 0) > 0;
  const baseDelay = hasActiveWork
    ? Math.min(uiSettings.refreshIntervalMs, 1_000)
    : uiSettings.refreshIntervalMs;
  return computeRefreshDelayMs(baseDelay, consecutivePollFailures);
}

async function performPollRuntimeState(): Promise<void> {
  let coreRefreshSucceeded = false;
  try {
    renderState(await window.sovereign.refresh());
    coreRefreshSucceeded = true;
  } catch {
    // Reconnect windows are expected. Backoff is applied without repeated toast noise.
  }
  consecutivePollFailures = coreRefreshSucceeded
    ? 0
    : Math.min(consecutivePollFailures + 1, 8);

  const tunnelPhase = currentState?.secureTunnel.phase;
  if (tunnelPhase === "starting" || tunnelPhase === "running") {
    await window.sovereign
      .refreshSecureTunnel()
      .then(renderState)
      .catch(() => undefined);
  }
  const now = Date.now();
  if (now - lastHostStartupPollAt >= 15_000) {
    lastHostStartupPollAt = now;
    await window.sovereign
      .getHostStartupState()
      .then((startup) => {
        currentHostStartup = startup;
        renderRemoteHostState();
      })
      .catch(() => undefined);
  }

  const backgroundRefreshes: Array<Promise<unknown>> = [
    runsController.refresh().catch(() => undefined),
    tasksController.refresh().catch(() => undefined),
  ];
  const activeRunsPane = document.querySelector<HTMLElement>(
    "[data-runs-pane].is-active",
  )?.dataset.runsPane;
  if (currentView === "runs" && activeRunsPane === "audit") {
    backgroundRefreshes.push(
      window.sovereign
        .getAuditReceipts(100)
        .then(renderAudit)
        .catch(() => undefined),
    );
  }
  await Promise.all(backgroundRefreshes);
  await refreshActiveWorkbench().catch(() => undefined);
}

function requestRefresh(mode: RefreshMode): Promise<void> {
  refreshCoordinator ??= new RefreshCoordinator(async (nextMode) => {
    if (nextMode === "full") {
      await performRefreshAll();
    } else {
      await performPollRuntimeState();
    }
  });
  return refreshCoordinator.request(mode);
}

function pollRuntimeState(): Promise<void> {
  return requestRefresh("poll");
}

function schedulePolling(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (document.visibilityState === "hidden") {
    return;
  }
  pollTimer = window.setTimeout(() => {
    void pollRuntimeState().finally(schedulePolling);
  }, nextPollingDelay());
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
    return;
  }
  void refreshAll().finally(schedulePolling);
}

function resetInterfaceSettings(): void {
  uiSettings = DEFAULT_UI_SETTINGS;
  persistUiSettings();
  syncInterfaceSettings();
  applyUiScale(uiSettings.uiScale);
  applyFontScale(uiSettings.fontScale);
  schedulePolling();
  showToast(
    "UI preferences reset. Runtime and security settings were not changed.",
  );
}

interface RemoteHostReadiness {
  readonly automationReady: boolean;
  readonly connectionReady: boolean;
  readonly issues: readonly string[];
}

function remoteHostReadiness(
  state: DesktopRuntimeState,
  startup: DesktopHostStartupState,
): RemoteHostReadiness {
  const issues: string[] = [];
  if (!startup.supported) {
    issues.push("Windows login startup is unavailable");
  } else if (!startup.enabled) {
    issues.push("Sovereign does not start at Windows login");
  }
  if (!state.autoStart) {
    issues.push("Gateway auto-start is off");
  }
  if (!state.unattendedWorkspaceAccess) {
    issues.push("Unattended workspace access is off");
  }
  if (!state.secureTunnel.autoStart) {
    issues.push("Tunnel auto-start is off");
  }
  if (!state.secureTunnel.autoReconnect) {
    issues.push("Connector restart supervision is off");
  }
  if (!startup.guardian.available) {
    issues.push("Host Guardian is unavailable");
  } else if (startup.guardian.circuitOpen) {
    issues.push("Host Guardian restart circuit is open");
  } else if (!startup.guardian.closeToTray) {
    issues.push("Close-to-tray protection is unavailable");
  }
  if (!startup.availability.available) {
    issues.push("Power and network recovery monitoring is unavailable");
  }

  const automationReady =
    startup.supported &&
    startup.enabled &&
    state.autoStart &&
    state.unattendedWorkspaceAccess &&
    state.secureTunnel.autoStart &&
    state.secureTunnel.autoReconnect &&
    startup.guardian.available &&
    startup.guardian.closeToTray &&
    !startup.guardian.circuitOpen &&
    startup.availability.available;

  if (state.workspaceRoot === null) {
    issues.push("No workspace is authorized");
  }
  if (!state.secureTunnel.clientAvailable) {
    issues.push("tunnel-client.exe is unavailable");
  } else if (!state.secureTunnel.executableTrusted) {
    issues.push("The connector digest is not trusted");
  }
  if (state.secureTunnel.tunnelId === null) {
    issues.push("Tunnel ID is missing");
  }
  if (!state.secureTunnel.hasRuntimeApiKey) {
    issues.push("Tunnel runtime key is missing");
  } else if (state.secureTunnel.runtimeApiKeyStorage !== "windows-protected") {
    issues.push("Tunnel runtime key is not restart-safe");
  }
  if (
    state.secureTunnel.controlPlaneProxyConfigured &&
    state.secureTunnel.controlPlaneProxyStorage !== "windows-protected"
  ) {
    issues.push("Primary control-plane proxy is not restart-safe");
  }
  if (
    state.secureTunnel.controlPlaneBackupProxyConfigured &&
    state.secureTunnel.controlPlaneBackupProxyStorage !== "windows-protected"
  ) {
    issues.push("Backup control-plane proxy is not restart-safe");
  }

  const connectionReady =
    state.workspaceRoot !== null &&
    state.secureTunnel.clientAvailable &&
    state.secureTunnel.executableTrusted &&
    state.secureTunnel.tunnelId !== null &&
    state.secureTunnel.hasRuntimeApiKey &&
    state.secureTunnel.runtimeApiKeyStorage === "windows-protected" &&
    (!state.secureTunnel.controlPlaneProxyConfigured ||
      state.secureTunnel.controlPlaneProxyStorage === "windows-protected") &&
    (!state.secureTunnel.controlPlaneBackupProxyConfigured ||
      state.secureTunnel.controlPlaneBackupProxyStorage ===
        "windows-protected");
  return { automationReady, connectionReady, issues };
}

type SimpleOverviewTone = "neutral" | "pending" | "success" | "error";
type SimpleOverviewAction =
  | "none"
  | "choose-workspace"
  | "start-runtime"
  | "enable-host"
  | "open-agent"
  | "open-settings";

function setSimpleOverviewTone(
  element: HTMLElement,
  tone: SimpleOverviewTone,
): void {
  element.dataset.tone = tone;
}

function renderSimpleOverviewState(
  state: DesktopRuntimeState | null,
  startup: DesktopHostStartupState | null,
): void {
  const title = requiredElement<HTMLElement>("#simple-overview-title");
  const detail = requiredElement<HTMLElement>("#simple-overview-detail");
  const badge = requiredElement<HTMLElement>("#simple-overview-badge");
  const workspace = requiredElement<HTMLElement>("#simple-overview-workspace");
  const runtime = requiredElement<HTMLElement>("#simple-overview-runtime");
  const startupDetail = requiredElement<HTMLElement>(
    "#simple-overview-startup",
  );
  const connection = requiredElement<HTMLElement>(
    "#simple-overview-connection",
  );
  const session = requiredElement<HTMLElement>("#simple-overview-session");
  const access = requiredElement<HTMLElement>("#simple-overview-access");
  const accessDetail = requiredElement<HTMLElement>(
    "#simple-overview-access-detail",
  );
  const primary = requiredElement<HTMLButtonElement>(
    "#simple-overview-primary",
  );

  if (state === null) {
    title.textContent = "Checking remote host…";
    detail.textContent =
      "Checking the computer, connection and unattended access.";
    badge.textContent = "Checking…";
    setSimpleOverviewTone(badge, "pending");
    workspace.textContent = "Not selected";
    runtime.textContent = "Checking…";
    setSimpleOverviewTone(runtime, "pending");
    startupDetail.textContent = "Checking Windows login startup.";
    connection.textContent = "Checking…";
    setSimpleOverviewTone(connection, "pending");
    session.textContent = "No active ChatGPT session";
    access.textContent = "Read only · L1";
    setSimpleOverviewTone(access, "pending");
    accessDetail.textContent = "Workspace tasks are off";
    primary.textContent = "Checking…";
    primary.dataset.simpleOverviewAction =
      "none" satisfies SimpleOverviewAction;
    primary.disabled = true;
    return;
  }

  workspace.toggleAttribute("data-no-i18n", state.workspaceRoot !== null);
  workspace.textContent = state.workspaceRoot ?? "Not selected";
  workspace.title = state.workspaceRoot ?? "";
  const runtimeLabel = phaseLabels[state.phase];
  runtime.textContent = runtimeLabel;
  setSimpleOverviewTone(
    runtime,
    state.phase === "running"
      ? "success"
      : state.phase === "error"
        ? "error"
        : "pending",
  );
  startupDetail.textContent =
    startup === null
      ? "Checking Windows login startup."
      : startup.enabled
        ? "Starts after Windows sign-in"
        : "Windows login startup is off";

  const tunnelDisplay = tunnelDisplayState(state);
  connection.textContent = tunnelDisplay.label;
  setSimpleOverviewTone(connection, tunnelDisplay.tone);
  session.textContent =
    state.sessionCount > 0
      ? `ChatGPT connected · ${state.sessionCount}`
      : "No active ChatGPT session";

  access.textContent = permissionProfileDisplay(state.permissionProfile);
  setSimpleOverviewTone(
    access,
    state.permissionProfile === "bypass"
      ? "error"
      : state.permissionProfile === "observe"
        ? "pending"
        : "success",
  );
  accessDetail.textContent =
    state.workspaceRoot === null
      ? "Choose a workspace to bind this permission"
      : state.permissionProfile === "bypass"
        ? "Per-action confirmation is off"
        : state.unattendedWorkspaceAccess
          ? "Permission unchanged · workspace restored after sign-in"
          : "Permission remembered for this workspace";

  let action: SimpleOverviewAction = "none";
  let actionLabel = "Checking…";
  let tone: SimpleOverviewTone = "pending";
  if (state.workspaceRoot === null) {
    title.textContent = "Choose a workspace";
    detail.textContent = "Authorize the folder this computer should work in.";
    badge.textContent = "Setup needed";
    action = "choose-workspace";
    actionLabel = "Choose workspace";
  } else if (state.phase === "error") {
    title.textContent = "Remote host needs attention";
    detail.textContent =
      "The runtime needs attention before remote tasks can run.";
    badge.textContent = "Problem";
    tone = "error";
    action = "start-runtime";
    actionLabel = "Restart runtime";
  } else if (startup === null) {
    title.textContent = "Checking remote host…";
    detail.textContent =
      "Checking the computer, connection and unattended access.";
    badge.textContent = "Checking…";
  } else {
    const readiness = remoteHostReadiness(state, startup);
    const automationReady = readiness.automationReady;
    const connectionReady = readiness.connectionReady;
    if (!automationReady) {
      title.textContent = "Finish unattended setup";
      detail.textContent =
        "Complete setup once; Sovereign will reconnect automatically after Windows sign-in.";
      badge.textContent = "Setup needed";
      action = startup.supported ? "enable-host" : "open-settings";
      actionLabel = startup.supported
        ? "Enable unattended host"
        : "Review setup";
    } else if (!connectionReady) {
      title.textContent = "Finish connection setup";
      detail.textContent =
        "Complete the ChatGPT connection once; Sovereign will keep it available after sign-in.";
      badge.textContent = "Setup needed";
      action = "open-agent";
      actionLabel = "Open ChatGPT Connection";
    } else if (state.phase !== "running") {
      title.textContent = "Remote host is offline";
      detail.textContent = "Start the host to receive workspace tasks.";
      badge.textContent = "Offline";
      action =
        state.phase === "starting" || state.phase === "stopping"
          ? "none"
          : "start-runtime";
      actionLabel =
        state.phase === "starting" || state.phase === "stopping"
          ? "Connecting…"
          : "Start remote host";
    } else if (state.secureTunnel.phase !== "ready") {
      title.textContent = "Connecting remote host";
      detail.textContent = "Sovereign will keep reconnecting automatically.";
      badge.textContent = "Connecting";
      action = "open-agent";
      actionLabel = "Open ChatGPT Connection";
    } else {
      title.textContent = "Remote host ready";
      detail.textContent =
        state.sessionCount > 0
          ? "This computer can receive workspace tasks now and after Windows sign-in."
          : "The host is ready. Connect Sovereign from ChatGPT to send tasks.";
      badge.textContent = "Ready";
      tone = "success";
      action = "open-agent";
      actionLabel = "Open ChatGPT Connection";
    }
  }
  setSimpleOverviewTone(badge, tone);
  primary.textContent = actionLabel;
  primary.dataset.simpleOverviewAction = action;
  primary.disabled = action === "none";
}

function renderHomeState(state: DesktopRuntimeState): void {
  const title = requiredElement<HTMLElement>("#home-host-title");
  const detail = requiredElement<HTMLElement>("#home-host-detail");
  const badge = requiredElement<HTMLElement>("#home-host-badge");
  const connection = requiredElement<HTMLElement>("#home-connection");
  const session = requiredElement<HTMLElement>("#home-session");
  const permission = requiredElement<HTMLElement>("#home-permission");
  const permissionDetail = requiredElement<HTMLElement>(
    "#home-permission-detail",
  );
  const workspace = requiredElement<HTMLElement>("#home-workspace-name");

  let badgeTone: SimpleOverviewTone = "pending";
  if (state.workspaceRoot === null) {
    title.textContent = "Choose a workspace";
    detail.textContent =
      "Authorize the folder this computer should work in before connecting ChatGPT.";
    badge.textContent = "Setup needed";
  } else if (state.phase === "error") {
    title.textContent = "This computer needs attention";
    detail.textContent =
      "Resolve the local runtime problem before ChatGPT can send new tasks.";
    badge.textContent = "Problem";
    badgeTone = "error";
  } else if (state.phase !== "running") {
    title.textContent = "Remote host is offline";
    detail.textContent = "Start the host to receive tasks from ChatGPT.";
    badge.textContent = "Offline";
  } else if (state.sessionCount > 0) {
    title.textContent = "This computer is ready for ChatGPT tasks";
    detail.textContent =
      "ChatGPT is connected and can work within the selected permission level.";
    badge.textContent = "Ready";
    badgeTone = "success";
  } else if (state.secureTunnel.phase === "ready") {
    title.textContent = "This computer is ready to connect";
    detail.textContent =
      "The secure connection is ready. Connect Sovereign from ChatGPT to send tasks.";
    badge.textContent = "Ready to connect";
    badgeTone = "success";
  } else {
    title.textContent = "Host is running";
    detail.textContent =
      "Finish the ChatGPT connection to receive remote tasks.";
    badge.textContent = "Host online";
    badgeTone = "pending";
  }
  badge.dataset.tone = badgeTone;

  const tunnelDisplay = tunnelDisplayState(state);
  if (state.sessionCount > 0) {
    connection.textContent = "Connected";
    connection.dataset.tone = "success";
    session.textContent = `${state.sessionCount} active session${state.sessionCount === 1 ? "" : "s"}`;
  } else if (state.secureTunnel.phase === "ready") {
    connection.textContent = "Ready to connect";
    connection.dataset.tone = "success";
    session.textContent = "Open ChatGPT Connection";
  } else {
    connection.textContent = tunnelDisplay.label;
    connection.dataset.tone = tunnelDisplay.tone;
    session.textContent = "Connection setup or recovery required";
  }

  permission.textContent = permissionProfileLabels[state.permissionProfile];
  permission.dataset.tone =
    state.permissionProfile === "bypass"
      ? "error"
      : state.permissionProfile === "observe"
        ? "pending"
        : "success";
  permissionDetail.textContent =
    state.permissionProfile === "observe"
      ? "Read-only access"
      : state.permissionProfile === "workspace"
        ? "Can work inside this folder"
        : state.permissionProfile === "consequential"
          ? "High-risk actions ask every time"
          : "Per-action confirmation is off";

  const workspaceName =
    state.workspaceRoot
      ?.split(/[\\\\/]/u)
      .filter(Boolean)
      .at(-1) ?? "Not selected";
  workspace.toggleAttribute("data-no-i18n", state.workspaceRoot !== null);
  workspace.textContent = workspaceName;
  workspace.title = state.workspaceRoot ?? "";
}

function renderHostAvailability(
  availability: DesktopHostStartupState["availability"],
): void {
  const summaryState = requiredElement<HTMLElement>("#host-availability-state");
  const summaryDetail = requiredElement<HTMLElement>(
    "#host-availability-detail",
  );
  const sampled = requiredElement<HTMLElement>("#availability-sampled");
  const powerSource = requiredElement<HTMLElement>(
    "#availability-power-source",
  );
  const battery = requiredElement<HTMLElement>("#availability-battery");
  const network = requiredElement<HTMLElement>("#availability-network-state");
  const lastGap = requiredElement<HTMLElement>("#availability-last-gap");
  const lastRecovery = requiredElement<HTMLElement>(
    "#availability-last-recovery",
  );
  const eventStorage = requiredElement<HTMLElement>(
    "#availability-event-storage",
  );
  const detail = requiredElement<HTMLElement>("#availability-detail");
  const eventList = requiredElement<HTMLDivElement>("#availability-event-list");

  const powerLabels: Readonly<Record<typeof availability.powerSource, string>> =
    {
      ac: "AC power",
      battery: "Battery",
      unknown: "Unknown",
    };
  const networkLabels: Readonly<
    Record<typeof availability.networkState, string>
  > = {
    "not-configured": "Not configured",
    offline: "Offline",
    connecting: "Connecting",
    retrying: "Retrying",
    ready: "Ready",
    degraded: "Degraded",
  };

  if (!availability.available) {
    summaryState.textContent = "Unavailable";
    summaryState.className = "settings-state is-warning";
    summaryDetail.textContent =
      availability.detail ??
      "Power and network recovery monitoring is unavailable.";
    sampled.textContent = "Unavailable";
    powerSource.textContent = "Unknown";
    battery.textContent = "—";
    network.textContent = "Unavailable";
    lastGap.textContent = "—";
    lastRecovery.textContent = "—";
    eventStorage.textContent = "Memory only";
    detail.textContent = summaryDetail.textContent;
    eventList.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "compact-empty";
    empty.textContent = "Availability monitoring is unavailable in this shell.";
    eventList.append(empty);
    return;
  }

  const networkLabel = networkLabels[availability.networkState];
  summaryState.textContent = availability.networkDesired
    ? networkLabel
    : "Monitoring";
  summaryState.className =
    availability.networkState === "ready"
      ? "settings-state is-on"
      : availability.networkState === "degraded" ||
          (availability.networkDesired &&
            availability.networkState === "offline")
        ? "settings-state is-danger"
        : availability.networkState === "connecting" ||
            availability.networkState === "retrying"
          ? "settings-state is-warning"
          : "settings-state";

  const powerLabel = powerLabels[availability.powerSource];
  const batteryLabel =
    availability.batteryPercent === null
      ? availability.powerSource === "ac"
        ? "Not reported"
        : "Unknown"
      : `${availability.batteryPercent}%${availability.batterySaver === true ? " · saver" : ""}`;
  const gapLabel =
    availability.lastPossibleSuspendAt === null
      ? "None observed"
      : `${formatTimestamp(availability.lastPossibleSuspendAt)} · ${formatDurationMs(availability.lastPossibleSuspendDurationMs)}`;
  const recoveryLabel =
    availability.lastNetworkRecoveryAt === null
      ? availability.lastNetworkReadyAt === null
        ? "None recorded"
        : `Ready ${formatTimestamp(availability.lastNetworkReadyAt)}`
      : `${formatTimestamp(availability.lastNetworkRecoveryAt)} · ${formatDurationMs(availability.lastNetworkOutageDurationMs)}`;

  sampled.textContent =
    availability.sampledAt === null
      ? "Waiting for sample"
      : formatTimestamp(availability.sampledAt);
  powerSource.textContent = powerLabel;
  battery.textContent = batteryLabel;
  network.textContent =
    availability.reconnectAttempt > 0
      ? `${networkLabel} · attempt ${availability.reconnectAttempt}`
      : networkLabel;
  lastGap.textContent = gapLabel;
  lastRecovery.textContent = recoveryLabel;
  eventStorage.textContent = `${availability.eventStorage === "persistent" ? "Persistent" : "Memory only"} · ${availability.recentEvents.length}`;

  const nextRetry =
    availability.nextReconnectAt === null
      ? ""
      : ` Next retry ${formatTimestamp(availability.nextReconnectAt)}.`;
  summaryDetail.textContent =
    availability.detail ??
    `${powerLabel} · Tunnel ${networkLabel.toLowerCase()}.${nextRetry}`;
  detail.textContent =
    availability.lastPossibleSuspendAt === null
      ? "The monitor has not observed a long scheduling gap. Long gaps are classified as possible sleep/resume or severe host stalls, not exact Windows power events."
      : `Observed ${availability.possibleSuspendCount} long scheduling gap${availability.possibleSuspendCount === 1 ? "" : "s"}; the latest was ${formatDurationMs(availability.lastPossibleSuspendDurationMs)}. Tunnel recovery is checked immediately after such a gap.`;

  const eventKindLabels: Readonly<
    Record<
      DesktopHostStartupState["availability"]["recentEvents"][number]["kind"],
      string
    >
  > = {
    "possible-suspend-or-stall": "Possible sleep / stall",
    "power-source-changed": "Power source changed",
    "network-loss": "Tunnel left Ready",
    "network-recovered": "Tunnel recovered",
  };
  eventList.replaceChildren();
  const events = [...availability.recentEvents].reverse().slice(0, 8);
  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "compact-empty";
    empty.textContent = "No availability events recorded.";
    eventList.append(empty);
    return;
  }
  for (const event of events) {
    const row = document.createElement("div");
    row.className = `availability-event-row event-${event.kind}`;
    const identity = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = eventKindLabels[event.kind];
    const eventDetail = document.createElement("span");
    eventDetail.textContent = event.detail;
    identity.append(title, eventDetail);
    const meta = document.createElement("small");
    meta.textContent =
      event.durationMs === null
        ? formatTimestamp(event.occurredAt)
        : `${formatTimestamp(event.occurredAt)} · ${formatDurationMs(event.durationMs)}`;
    row.append(identity, meta);
    eventList.append(row);
  }
}

function renderRemoteHostState(): void {
  const state = currentState;
  const startup = currentHostStartup;
  const status = requiredElement<HTMLElement>("#remote-host-status");
  const detail = requiredElement<HTMLElement>("#remote-host-detail");
  const warning = requiredElement<HTMLElement>("#host-startup-warning");
  const enable = requiredElement<HTMLButtonElement>("#remote-host-enable");
  const launchToggle = requiredElement<HTMLInputElement>(
    "#host-launch-at-login",
  );
  const gatewayToggle = requiredElement<HTMLInputElement>(
    "#auto-start-runtime",
  );
  const unattendedToggle = requiredElement<HTMLInputElement>(
    "#unattended-workspace-access",
  );
  const tunnelAutoStart =
    requiredElement<HTMLInputElement>("#tunnel-auto-start");
  const tunnelAutoReconnect = requiredElement<HTMLInputElement>(
    "#tunnel-auto-reconnect",
  );
  const guardianState = requiredElement<HTMLElement>("#host-guardian-state");
  const guardianDetail = requiredElement<HTMLElement>("#host-guardian-detail");

  renderSimpleOverviewState(state, startup);
  if (startup !== null) {
    renderHostAvailability(startup.availability);
  }

  if (state === null || startup === null) {
    status.textContent = "Checking…";
    status.className = "settings-section-meta remote-host-status";
    detail.textContent = "Checking the local startup and tunnel prerequisites.";
    warning.hidden = true;
    enable.disabled = true;
    launchToggle.disabled = true;
    unattendedToggle.disabled = true;
    tunnelAutoStart.disabled = true;
    tunnelAutoReconnect.disabled = true;
    guardianState.textContent = "Checking…";
    guardianState.className = "settings-state";
    guardianDetail.textContent = "Checking host protection.";
    return;
  }

  launchToggle.checked = startup.enabled;
  launchToggle.disabled = !startup.supported;
  gatewayToggle.checked = state.autoStart;
  unattendedToggle.checked = state.unattendedWorkspaceAccess;
  unattendedToggle.disabled = state.workspaceRoot === null;
  tunnelAutoStart.checked = state.secureTunnel.autoStart;
  tunnelAutoReconnect.checked = state.secureTunnel.autoReconnect;
  requiredElement<HTMLElement>("#host-launch-label").textContent =
    startup.enabled ? "On" : "Off";
  requiredElement<HTMLElement>("#auto-start-label").textContent =
    state.autoStart ? "On" : "Off";
  requiredElement<HTMLElement>(
    "#unattended-workspace-access-label",
  ).textContent = state.unattendedWorkspaceAccess ? "On" : "Off";
  requiredElement<HTMLElement>("#tunnel-auto-start-label").textContent = state
    .secureTunnel.autoStart
    ? "On"
    : "Off";
  requiredElement<HTMLElement>("#tunnel-auto-reconnect-label").textContent =
    state.secureTunnel.autoReconnect ? "On" : "Off";

  const guardian = startup.guardian;
  if (guardian.circuitOpen) {
    guardianState.textContent = "Circuit open";
    guardianState.className = "settings-state is-danger";
    guardianDetail.textContent =
      "Restart circuit is open. Start Sovereign manually after reviewing the last incident.";
  } else if (guardian.available && guardian.closeToTray) {
    guardianState.textContent = "Protected";
    guardianState.className = "settings-state is-on";
    guardianDetail.textContent =
      guardian.lastIncident === null
        ? "Closing the window keeps Sovereign in the notification area. Shell or Runtime Host failure restarts the full host with crash-loop protection."
        : "Host Guardian recovered the full host after the last detected failure.";
    guardianDetail.title =
      guardian.lastIncident === null
        ? ""
        : `${formatTimestamp(guardian.lastIncident.occurredAt)} · ${guardian.lastIncident.reason}`;
  } else {
    guardianState.textContent = "Unavailable";
    guardianState.className = "settings-state is-warning";
    guardianDetail.textContent =
      "Host Guardian is available in packaged Tauri builds.";
    guardianDetail.title = "";
  }

  warning.hidden = startup.warning === null;
  warning.textContent = startup.warning ?? "";
  const readiness = remoteHostReadiness(state, startup);
  const ready = readiness.automationReady && readiness.connectionReady;
  status.textContent = ready
    ? "Unattended after sign-in"
    : readiness.automationReady
      ? "Connection setup incomplete"
      : `${readiness.issues.length} setup item${readiness.issues.length === 1 ? "" : "s"}`;
  status.className = `settings-section-meta remote-host-status${ready ? " is-ready" : " is-pending"}`;
  detail.textContent = ready
    ? "Gateway, Tunnel, connector supervision and Host Guardian recovery start automatically. The selected permission returns for this exact workspace."
    : readiness.issues.join(" · ");

  requiredElement<HTMLElement>("#restart-authority-value").textContent =
    permissionProfileDisplay(state.permissionProfile);
  requiredElement<HTMLElement>("#restart-authority-detail").textContent =
    state.permissionProfile === "bypass"
      ? `Protected by your Windows account for this exact workspace. Turn it off to return to ${permissionProfileDisplay(state.rememberedPermissionProfile)}.`
      : state.unattendedWorkspaceAccess
        ? "This permission selection is bound to the exact authorized folder and restored after sign-in."
        : "This permission selection is remembered for the authorized workspace.";

  enable.disabled = !startup.supported || ready;
  if (ready) {
    enable.textContent = "Remote host ready";
    enable.dataset.remoteHostAction = "ready";
  } else if (!readiness.automationReady) {
    enable.textContent = "Enable unattended host";
    enable.dataset.remoteHostAction = "enable";
  } else {
    enable.textContent = "Review ChatGPT Connection";
    enable.dataset.remoteHostAction = "review";
  }
}

function renderState(state: DesktopRuntimeState): void {
  currentState = state;
  renderHomeState(state);
  const label = phaseLabels[state.phase];
  const globalStatus = requiredElement<HTMLElement>("#global-status");
  globalStatus.className = `statusbar-item statusbar-action statusbar-host status-${state.phase}`;
  requiredElement<HTMLSpanElement>("#global-status-label").textContent = label;
  requiredElement<HTMLElement>("#metric-runtime-state").textContent = label;
  const version = requiredElement<HTMLElement>("#metric-runtime-version");
  version.textContent = state.runtimeVersion + (state.runtimeBuildSource
    ? ` · ${state.runtimeBuildSource.commit.slice(0, 12)}${state.runtimeBuildSource.dirty ? " *" : ""}` : "");
  version.title = state.runtimeBuildSource ? `Runtime Host: ${state.runtimeBuildSource.commit}${state.runtimeBuildSource.dirty ? " (uncommitted changes)" : ""}` : "";
  requiredElement<HTMLElement>("#metric-tool-count").textContent = String(
    state.toolCount,
  );
  requiredElement<HTMLElement>("#metric-capability-count").textContent = String(
    state.capabilities.length,
  );
  const selfHostingRequirements = [
    "workspace.read",
    "files.read",
    "files.write",
    "search.read",
    "git.read",
    "validation.run",
  ] as const;
  const missingSelfHostingCapabilities = selfHostingRequirements.filter(
    (capability) => !state.capabilities.includes(capability),
  );
  const selfHosting = requiredElement<HTMLElement>("#detail-self-hosting");
  if (state.workspaceRoot === null) {
    selfHosting.textContent = "Choose workspace";
    selfHosting.title =
      "Self-hosted development requires an authorized workspace.";
  } else if (state.phase !== "running") {
    selfHosting.textContent = "Start runtime";
    selfHosting.title =
      "The local Gateway must be running before Sovereign can develop itself over MCP.";
  } else if (missingSelfHostingCapabilities.length === 0) {
    selfHosting.textContent = "Ready via MCP";
    selfHosting.title =
      "Core self-hosting primitives are available: workspace, files, search, Git read, and fixed validation. L3 terminal commands still require operator approval.";
  } else {
    selfHosting.textContent = `${missingSelfHostingCapabilities.length} primitive${missingSelfHostingCapabilities.length === 1 ? "" : "s"} missing`;
    selfHosting.title = `Missing: ${missingSelfHostingCapabilities.join(", ")}`;
  }
  requiredElement<HTMLElement>("#detail-endpoint").textContent =
    state.endpoint ?? "Not running";
  requiredElement<HTMLElement>("#detail-workspace").textContent =
    state.workspaceRoot ?? "Not selected";
  requiredElement<HTMLElement>("#detail-manifest").textContent =
    abbreviatedDigest(state.manifestDigest);
  requiredElement<HTMLElement>("#detail-credential").textContent =
    state.credentialGeneration === 0
      ? "Not issued"
      : `Generation ${state.credentialGeneration} · ${state.phase === "running" ? "active" : "inactive"}`;
  const workspacePath = requiredElement<HTMLElement>("#workspace-page-path");
  workspacePath.toggleAttribute("data-no-i18n", state.workspaceRoot !== null);
  workspacePath.textContent = state.workspaceRoot ?? "No workspace selected";
  requiredElement<HTMLElement>("#status-sessions").textContent =
    `${state.sessionCount} session${state.sessionCount === 1 ? "" : "s"}`;
  const desktopWorkspaceRoot = state.activeDesktopWorkspace?.root ?? state.workspaceRoot;
  const workspaceName =
    desktopWorkspaceRoot?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "None";
  const statusWorkspace = requiredElement<HTMLElement>("#status-workspace");
  statusWorkspace.toggleAttribute("data-no-i18n", desktopWorkspaceRoot !== null);
  statusWorkspace.textContent = workspaceName;
  requiredElement<HTMLButtonElement>("#status-workspace-action").title =
    desktopWorkspaceRoot === null
      ? "Choose a workspace"
      : `Workspace: ${desktopWorkspaceRoot}`;

  const connectionBadge = requiredElement<HTMLElement>("#connection-badge");
  connectionBadge.textContent =
    state.phase === "running"
      ? "Runtime online"
      : `Runtime ${label.toLowerCase()}`;
  connectionBadge.className = `state-text${state.phase === "running" ? " is-healthy" : state.phase === "error" ? " is-error" : ""}`;
  requiredElement<HTMLButtonElement>("#copy-connection").disabled =
    state.phase !== "running";
  requiredElement<HTMLButtonElement>("#rotate-credentials").disabled =
    state.phase !== "running";
  const autoStartToggle = requiredElement<HTMLInputElement>(
    "#auto-start-runtime",
  );
  autoStartToggle.checked = state.autoStart;
  requiredElement<HTMLElement>("#auto-start-label").textContent =
    state.autoStart ? "On" : "Off";

  const setupBanner = requiredElement<HTMLElement>("#setup-banner");
  setupBanner.hidden = state.workspaceRoot !== null;

  const startButton = requiredElement<HTMLButtonElement>("#start-runtime");
  const stopButton = requiredElement<HTMLButtonElement>("#stop-runtime");
  const commandState = requiredElement<HTMLElement>("#runtime-command-state");
  startButton.disabled =
    state.workspaceRoot === null ||
    state.phase === "starting" ||
    state.phase === "stopping";
  startButton.hidden = state.phase === "running";
  stopButton.disabled =
    state.phase !== "running" &&
    state.phase !== "starting" &&
    state.phase !== "error";
  startButton.textContent =
    state.phase === "starting" ? "Starting runtime…" : "Start runtime";
  stopButton.textContent =
    state.phase === "stopping" ? "Stopping runtime…" : "Stop runtime";
  commandState.textContent = `Runtime ${label.toLowerCase()}`;
  commandState.className = `state-text${state.phase === "running" ? " is-healthy" : state.phase === "error" ? " is-error" : ""}`;

  renderCapabilities(state.capabilities);
  renderWebAgentState(state);
  renderRemoteHostState();
  renderOverviewRuns(latestOverviewRuns);
  if (state.errorMessage !== null) {
    showToast(state.errorMessage, true);
  }
}

function capabilityAuthority(
  capability: string,
): "observe" | "workspace" | "consequential" {
  if (
    capability.includes("destructive") ||
    capability === "terminal.run" ||
    capability === "python.run" ||
    capability === "browser.control" ||
    capability === "computer.control" ||
    capability === "workflow.run"
  ) {
    return "consequential";
  }
  if (
    capability.endsWith(".write") ||
    capability.endsWith(".cancel") ||
    capability === "validation.run"
  ) {
    return "workspace";
  }
  return "observe";
}

function renderCapabilities(capabilities: readonly string[]): void {
  latestCapabilities = capabilities;
  const container = requiredElement<HTMLDivElement>("#capability-list");
  container.replaceChildren();
  const normalizedQuery = capabilitySearchQuery.trim().toLowerCase();
  const filtered = capabilities.filter((capability) => {
    const authority = capabilityAuthority(capability);
    const matchesLevel =
      capabilityLevelFilter === "all" || capabilityLevelFilter === authority;
    const matchesSearch =
      normalizedQuery.length === 0 ||
      capability.toLowerCase().includes(normalizedQuery);
    return matchesLevel && matchesSearch;
  });
  requiredElement<HTMLElement>("#settings-capability-count").textContent =
    `${filtered.length} / ${capabilities.length}`;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "compact-empty capability-empty";
    empty.textContent = "No matching capabilities.";
    container.append(empty);
    return;
  }

  for (const capability of filtered) {
    const authority = capabilityAuthority(capability);
    const row = document.createElement("div");
    row.className = "capability-row";
    const scope = document.createElement("span");
    scope.className = "capability-scope";
    scope.textContent = capability.split(".")[0] ?? "runtime";
    const name = document.createElement("code");
    name.textContent = capability;
    const mode = document.createElement("span");
    mode.className = `capability-mode authority-${authority}`;
    mode.textContent =
      authority === "observe"
        ? "L1 Observe"
        : authority === "workspace"
          ? "L2 Workspace"
          : "L3 Consequential";
    row.append(scope, name, mode);
    container.append(row);
  }
}

const permissionProfileLabels: Readonly<
  Record<DesktopPermissionProfile, string>
> = {
  observe: "Read only",
  workspace: "Work in this folder",
  consequential: "Ask for high-risk actions",
  bypass: "Bypass confirmations",
};

const permissionProfileCodes: Readonly<
  Record<DesktopPermissionProfile, string>
> = {
  observe: "L1",
  workspace: "L2",
  consequential: "L3",
  bypass: "L4",
};

function permissionProfileDisplay(profile: DesktopPermissionProfile): string {
  return `${permissionProfileLabels[profile]} · ${permissionProfileCodes[profile]}`;
}

const permissionProfileDescriptions: Readonly<
  Record<DesktopPermissionProfile, string>
> = {
  observe: "Read-only access",
  workspace: "Can work inside this folder",
  consequential: "High-risk actions ask every time",
  bypass: "Per-action confirmation is off",
};

const permissionChoiceSurfaces = [
  "settings-permission-profiles",
  "web-permission-profiles",
] as const;

function renderPermissionChoiceState(state: DesktopRuntimeState): void {
  const activeProfile = state.permissionProfile;
  const bypassActive = activeProfile === "bypass";

  for (const groupId of permissionChoiceSurfaces) {
    const group = requiredElement<HTMLElement>(`#${groupId}`);
    group.classList.toggle(
      "shows-advanced-active",
      activeProfile === "consequential",
    );
    group.classList.toggle("shows-bypass-active", bypassActive);
    group.setAttribute("aria-label", "ChatGPT permission level");
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-permission-profile]",
  )) {
    const selected = button.dataset.permissionProfile === activeProfile;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
    delete button.dataset.permissionFallback;
    button.removeAttribute("aria-describedby");
    button.removeAttribute("title");
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-permission-bypass]",
  )) {
    button.classList.toggle("is-selected", bypassActive);
    button.classList.toggle("is-active", bypassActive);
    button.setAttribute("aria-pressed", bypassActive ? "true" : "false");
    button.title = bypassActive
      ? "Confirmation bypass is active"
      : "Enable confirmation bypass";
  }
}

const secureTunnelPhaseLabels: Readonly<
  Record<DesktopRuntimeState["secureTunnel"]["phase"], string>
> = {
  unavailable: "Not installed",
  stopped: "Stopped",
  starting: "Starting",
  running: "Connecting",
  ready: "Ready",
  stopping: "Stopping",
  error: "Error",
};

function tunnelDisplayState(state: DesktopRuntimeState): {
  readonly label: string;
  readonly tone: "neutral" | "pending" | "success" | "error";
} {
  const tunnel = state.secureTunnel;
  if (!tunnel.clientAvailable) {
    return {
      label:
        tunnel.tunnelId === null
          ? "Connector not installed"
          : "Connector missing",
      tone: tunnel.tunnelId === null ? "neutral" : "pending",
    };
  }
  if (tunnel.controlPlaneRouting.lifecycle === "circuit-open") {
    return { label: "Route circuit open", tone: "error" };
  }
  if (tunnel.controlPlaneRouting.lifecycle === "needs-attention") {
    return { label: "Connection needs attention", tone: "error" };
  }
  if (tunnel.nextReconnectAt !== null) {
    return { label: "Route retry scheduled", tone: "pending" };
  }
  if (tunnel.errorMessage !== null || tunnel.phase === "error") {
    return { label: "Connector error", tone: "error" };
  }
  if (!tunnel.executableTrusted) {
    return { label: "Connector trust required", tone: "pending" };
  }
  if (tunnel.tunnelId === null) {
    return { label: "Tunnel not configured", tone: "neutral" };
  }
  if (!tunnel.hasRuntimeApiKey && tunnel.phase === "stopped") {
    return { label: "Runtime key missing", tone: "pending" };
  }
  if (tunnel.phase === "ready") {
    return { label: "Tunnel ready", tone: "success" };
  }
  if (tunnel.phase === "starting") {
    return { label: "Tunnel starting", tone: "pending" };
  }
  if (tunnel.phase === "running") {
    return { label: "Tunnel connecting", tone: "pending" };
  }
  if (tunnel.phase === "stopping") {
    return { label: "Tunnel stopping", tone: "pending" };
  }
  return { label: "Tunnel stopped", tone: "neutral" };
}

const ROUTE_STATUS_LABELS: Readonly<Record<string, string>> = {
  ready: "Ready",
  failed: "Failed",
  probing: "Probing",
  "cooling-down": "Cooling down",
  untested: "Untested",
  disabled: "Disabled",
};

/**
 * Every configured control-plane route in the order they are tried. Without it
 * the operator can only see which route is active by expanding the advanced
 * fold, which is the wrong place to look while a route is failing.
 */
type ControlPlaneRoutingView =
  DesktopRuntimeState["secureTunnel"]["controlPlaneRouting"];

function renderRouteStrip(routing: ControlPlaneRoutingView): void {
  const strip = requiredElement<HTMLUListElement>("#agent-route-strip");
  strip.replaceChildren();
  for (const id of routing.routeOrder) {
    const route = routing.routes[id];
    if (route === undefined) {
      continue;
    }
    const row = document.createElement("li");
    row.className = "agent-route-row";
    row.dataset["routeStatus"] = route.status;
    if (routing.activeRoute === id) {
      row.classList.add("is-active");
    }
    const target = document.createElement("span");
    target.className = "agent-route-target";
    target.textContent = route.display;
    const status = document.createElement("span");
    status.className = "agent-route-status";
    status.textContent = ROUTE_STATUS_LABELS[route.status] ?? route.status;
    row.append(target, status);
    strip.append(row);
  }
  strip.hidden = routing.routeOrder.length === 0;
}

function renderControlPlaneRouting(
  tunnel: DesktopRuntimeState["secureTunnel"],
  tunnelLocked: boolean,
): void {
  const routing = tunnel.controlPlaneRouting;
  const backupInput = requiredElement<HTMLInputElement>(
    "#secure-tunnel-backup-proxy",
  );
  backupInput.disabled = tunnelLocked || !tunnel.controlPlaneProxyConfigured;
  backupInput.placeholder = tunnel.controlPlaneBackupProxyConfigured
    ? "Saved securely · leave blank to reuse"
    : "http://independent-backup:port";

  const backupStorage = requiredElement<HTMLElement>(
    "#secure-tunnel-backup-proxy-storage",
  );
  backupStorage.textContent =
    tunnel.controlPlaneBackupProxyStorage === "windows-protected"
      ? `Saved with Windows DPAPI · ${tunnel.controlPlaneBackupProxyDisplay ?? "backup proxy configured"}. Use an independent service or exit when possible.`
      : tunnel.controlPlaneBackupProxyStorage === "memory-only"
        ? `Available for this session only · ${tunnel.controlPlaneBackupProxyDisplay ?? "backup proxy configured"}. Re-enter it after restart.`
        : tunnel.controlPlaneProxyConfigured
          ? "Not configured · use an endpoint with an independent service or exit when possible."
          : "Save the primary proxy before configuring a backup route.";
  backupStorage.classList.toggle(
    "is-warning",
    tunnel.controlPlaneBackupProxyStorage === "memory-only",
  );
  requiredElement<HTMLButtonElement>(
    "#secure-tunnel-save-backup-proxy",
  ).disabled = tunnelLocked || !tunnel.controlPlaneProxyConfigured;
  requiredElement<HTMLButtonElement>(
    "#secure-tunnel-clear-backup-proxy",
  ).disabled = !tunnel.controlPlaneBackupProxyConfigured || tunnelLocked;

  const directFallback = requiredElement<HTMLInputElement>(
    "#secure-tunnel-direct-fallback",
  );
  directFallback.checked = tunnel.controlPlaneDirectFallbackEnabled;
  directFallback.disabled = tunnelLocked || !tunnel.controlPlaneProxyConfigured;
  requiredElement<HTMLElement>(
    "#secure-tunnel-direct-fallback-label",
  ).textContent = tunnel.controlPlaneDirectFallbackEnabled ? "On" : "Off";

  renderRouteStrip(routing);

  const routeState = requiredElement<HTMLElement>("#secure-tunnel-route-state");
  const activeRoute = routing.activeRoute;
  routeState.className = "agent-route-state";
  if (routing.lifecycle === "circuit-open") {
    routeState.textContent = "Circuit open";
    routeState.classList.add("is-danger");
  } else if (routing.lifecycle === "needs-attention") {
    routeState.textContent = "Needs attention";
    routeState.classList.add("is-danger");
  } else if (!routing.enabled) {
    routeState.textContent = "Single route";
  } else if (activeRoute === null) {
    routeState.textContent = "Waiting";
    routeState.classList.add("is-pending");
  } else {
    routeState.textContent = routing.activeRouteDisplay ?? activeRoute;
    const activeStatus = routing.routes[activeRoute].status;
    if (activeStatus === "ready") {
      routeState.classList.add("is-ready");
    } else if (activeStatus === "failed") {
      routeState.classList.add("is-danger");
    } else {
      routeState.classList.add("is-pending");
    }
  }

  const routeList = requiredElement<HTMLDivElement>(
    "#secure-tunnel-route-list",
  );
  routeList.replaceChildren();
  const routeLabels = {
    primary: "Primary proxy",
    backup: "Backup proxy",
    direct: "Direct fallback",
  } as const;
  const statusLabels = {
    disabled: "Disabled",
    untested: "Untested",
    probing: "Connecting",
    ready: "Ready",
    "cooling-down": "Cooling down",
    failed: "Failed",
  } as const;
  for (const route of ["primary", "backup", "direct"] as const) {
    const routeView = routing.routes[route];
    const row = document.createElement("div");
    row.className = `agent-route-row route-status-${routeView.status}`;
    const identity = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = routeLabels[route];
    const display = document.createElement("span");
    display.textContent = routeView.display;
    identity.append(label, display);
    const status = document.createElement("b");
    status.textContent = routeView.configured
      ? statusLabels[routeView.status]
      : "Not configured";
    row.classList.toggle("is-active", route === activeRoute);
    row.append(identity, status);
    routeList.append(row);
  }

  const routeDetail = requiredElement<HTMLElement>(
    "#secure-tunnel-route-detail",
  );
  if (routing.circuitReason !== null) {
    routeDetail.textContent = routing.circuitReason;
  } else if (tunnel.failureDiagnostic !== null) {
    routeDetail.textContent = `${tunnel.failureDiagnostic.summary} ${tunnel.failureDiagnostic.detail}`;
  } else if (tunnel.nextReconnectAt !== null) {
    routeDetail.textContent = `Recovery attempt ${tunnel.reconnectAttempt} is scheduled for ${formatTimestamp(tunnel.nextReconnectAt)}.`;
  } else if (!routing.enabled) {
    routeDetail.textContent = tunnel.controlPlaneProxyConfigured
      ? "Single proxy route active. Configure a backup proxy to enable classified failover."
      : "Direct control-plane route active. Configure a primary proxy when the network requires one.";
  } else {
    routeDetail.textContent = `${routing.activeRouteDisplay ?? "No route active"} · ${routing.switchCount} switch${routing.switchCount === 1 ? "" : "es"}${routing.lastSwitchAt === null ? "" : ` · last ${formatTimestamp(routing.lastSwitchAt)}`}.`;
  }
}

function updateTunnelStartAvailability(): void {
  const state = currentState;
  if (state === null) {
    return;
  }
  const tunnel = state.secureTunnel;
  const tunnelId =
    requiredElement<HTMLInputElement>("#secure-tunnel-id").value.trim();
  const keyDraft = requiredElement<HTMLInputElement>(
    "#secure-tunnel-api-key",
  ).value.trim();
  const hasValidTunnelId = /^tunnel_[a-f0-9]{32}$/u.test(tunnelId);
  const hasRuntimeKey = tunnel.hasRuntimeApiKey || keyDraft.length > 0;
  const tunnelActive = ["starting", "running", "ready", "stopping"].includes(
    tunnel.phase,
  );
  const tunnelManaged = tunnelActive || tunnel.desiredRunning;
  const start = requiredElement<HTMLButtonElement>("#secure-tunnel-start");
  start.disabled =
    state.phase !== "running" ||
    !tunnel.clientAvailable ||
    tunnelManaged ||
    !hasValidTunnelId ||
    !hasRuntimeKey;

  const instructions = requiredElement<HTMLElement>(
    "#secure-tunnel-instructions",
  );
  if (state.phase !== "running") {
    instructions.textContent = "Start the local Gateway first.";
  } else if (!tunnel.clientAvailable) {
    instructions.textContent =
      "Choose the installed tunnel-client.exe, or make it available on PATH.";
  } else if (!hasValidTunnelId) {
    instructions.textContent =
      "Paste the actual Tunnel ID from OpenAI Platform.";
  } else if (!hasRuntimeKey) {
    instructions.textContent =
      "Paste the Tunnel runtime key. Sovereign will protect it with your Windows account for reuse.";
  } else if (!tunnel.executableTrusted) {
    instructions.textContent =
      "Start will show the resolved client path and SHA-256 for local trust confirmation.";
  } else if (tunnel.controlPlaneRouting.lifecycle === "circuit-open") {
    instructions.textContent =
      "All configured control-plane routes failed. Review the route evidence, then Start to reset the route circuit.";
  } else if (tunnel.controlPlaneRouting.lifecycle === "needs-attention") {
    instructions.textContent =
      tunnel.failureDiagnostic?.summary ??
      "The connection needs local attention before it can restart.";
  } else if (tunnel.nextReconnectAt !== null) {
    instructions.textContent = `Connector restart attempt ${tunnel.reconnectAttempt} is scheduled for ${formatTimestamp(tunnel.nextReconnectAt)}. Stop the tunnel to cancel supervision.`;
  } else if (tunnel.phase === "ready") {
    instructions.textContent =
      state.sessionCount > 0
        ? "ChatGPT is connected."
        : "Tunnel is ready. Connect the Sovereign app from ChatGPT.";
  } else if (tunnel.phase === "running" || tunnel.phase === "starting") {
    instructions.textContent = "Tunnel connection is being established.";
  } else {
    instructions.textContent = "Ready to start the Secure MCP Tunnel.";
  }
}

function renderWebAgentState(state: DesktopRuntimeState): void {
  const profile = state.permissionProfile;
  const profileLabel = permissionProfileDisplay(profile);
  const profileBadge = requiredElement<HTMLElement>("#web-profile-badge");
  profileBadge.textContent = profileLabel;
  requiredElement<HTMLElement>("#web-permission-description").textContent =
    permissionProfileDescriptions[profile];
  requiredElement<HTMLElement>("#web-agent-authority").textContent =
    `${profileLabel} · ${permissionProfileDescriptions[profile]}`;
  requiredElement<HTMLElement>("#web-agent-endpoint").textContent =
    state.endpoint ?? "Start the runtime to create an endpoint.";
  const gatewayBadge = requiredElement<HTMLElement>("#web-agent-gateway");
  gatewayBadge.textContent =
    state.phase === "running"
      ? "Host online"
      : `Host ${phaseLabels[state.phase].toLowerCase()}`;
  gatewayBadge.className = `agent-status-value ${state.phase === "running" ? "is-healthy" : ""}`;

  const tunnel = state.secureTunnel;
  requiredElement<HTMLElement>("#secure-tunnel-path").textContent =
    tunnel.executablePath ?? "Not detected";
  const tunnelDisplay = tunnelDisplayState(state);
  const statusConnectionLabel =
    state.sessionCount > 0
      ? "Connected"
      : tunnel.phase === "ready"
        ? "Ready to connect"
        : tunnelDisplay.label;
  const statusTunnel = requiredElement<HTMLElement>("#status-tunnel");
  statusTunnel.textContent = statusConnectionLabel;
  statusTunnel.className = `statusbar-value status-${state.sessionCount > 0 ? "success" : tunnelDisplay.tone}`;
  requiredElement<HTMLButtonElement>("#status-connector-action").title =
    `${statusConnectionLabel} · Open ChatGPT Connection`;
  const statusAuthority = requiredElement<HTMLElement>("#status-authority");
  statusAuthority.textContent = profileLabel;
  statusAuthority.className = `statusbar-value${profile === "bypass" ? " status-error" : ""}`;
  requiredElement<HTMLButtonElement>("#status-permission-action").title =
    `${profileLabel} · Change ChatGPT permission`;
  requiredElement<HTMLElement>("#settings-authority-label").textContent =
    profileLabel;
  const bypassActive = profile === "bypass";
  const fallbackLabel = permissionProfileDisplay(
    state.rememberedPermissionProfile,
  );
  requiredElement<HTMLElement>("#web-bypass-state").textContent = bypassActive
    ? `Without confirmation is active. Switching levels returns to ${fallbackLabel}.`
    : "Confirmation behavior follows the selected permission level.";
  for (const current of document.querySelectorAll<HTMLElement>(
    "[data-action-current-profile]",
  )) {
    current.textContent = profileLabel;
  }
  const settingsBypassState = requiredElement<HTMLElement>(
    "#settings-bypass-state",
  );
  settingsBypassState.textContent = bypassActive ? "On" : "Off";
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-bypass-toggle]",
  )) {
    button.classList.toggle("is-active", bypassActive);
    button.classList.toggle("is-selected", bypassActive);
    button.setAttribute("aria-pressed", bypassActive ? "true" : "false");
    button.setAttribute(
      "aria-label",
      bypassActive
        ? `Without confirmation is active. Select to return to ${fallbackLabel}.`
        : "Enable without confirmation",
    );
  }
  renderPermissionChoiceState(state);

  const tunnelIdInput = requiredElement<HTMLInputElement>("#secure-tunnel-id");
  if (secureTunnelIdDraft === null) {
    secureTunnelIdDraft = tunnel.tunnelId ?? "";
  } else if (
    !secureTunnelIdDirty &&
    tunnel.tunnelId !== null &&
    tunnel.tunnelId !== secureTunnelIdDraft
  ) {
    secureTunnelIdDraft = tunnel.tunnelId;
  }
  if (document.activeElement !== tunnelIdInput) {
    tunnelIdInput.value = secureTunnelIdDraft;
  }
  const tunnelStatus = requiredElement<HTMLElement>("#secure-tunnel-status");
  tunnelStatus.textContent =
    tunnel.errorMessage ??
    tunnel.failureDiagnostic?.summary ??
    tunnelDisplay.label;
  tunnelStatus.title =
    tunnel.failureDiagnostic === null
      ? ""
      : `${tunnel.failureDiagnostic.failureClass} · ${tunnel.failureDiagnostic.source} · ${tunnel.failureDiagnostic.detail}`;
  tunnelStatus.className = `agent-connection-state state-${tunnelDisplay.tone}`;
  requiredElement<HTMLButtonElement>("#secure-tunnel-retry").hidden =
    tunnel.clientAvailable;
  const tunnelActive = ["starting", "running", "ready", "stopping"].includes(
    tunnel.phase,
  );
  const tunnelLocked = tunnelActive || tunnel.desiredRunning;
  requiredElement<HTMLButtonElement>("#secure-tunnel-stop").disabled =
    !tunnelActive && !tunnel.desiredRunning;
  requiredElement<HTMLButtonElement>("#secure-tunnel-choose").disabled =
    tunnelLocked;
  requiredElement<HTMLButtonElement>("#secure-tunnel-refresh").disabled =
    tunnel.phase === "stopping";
  const runtimeKeyInput = requiredElement<HTMLInputElement>(
    "#secure-tunnel-api-key",
  );
  runtimeKeyInput.placeholder = tunnel.hasRuntimeApiKey
    ? "Saved securely · leave blank to reuse"
    : "Paste runtime key";
  const runtimeKeyStorage = requiredElement<HTMLElement>(
    "#secure-tunnel-key-storage",
  );
  runtimeKeyStorage.textContent =
    tunnel.runtimeApiKeyStorage === "windows-protected"
      ? "Saved with Windows DPAPI · leave this field blank to reuse it after restart."
      : tunnel.runtimeApiKeyStorage === "memory-only"
        ? "Available for this session only · Windows protection failed, so re-enter it after restart."
        : "Not saved · paste once and Sovereign will protect it with your Windows account.";
  runtimeKeyStorage.classList.toggle(
    "is-warning",
    tunnel.runtimeApiKeyStorage === "memory-only",
  );
  requiredElement<HTMLButtonElement>("#secure-tunnel-clear-key").disabled =
    !tunnel.hasRuntimeApiKey || tunnelLocked;

  const proxyInput = requiredElement<HTMLInputElement>("#secure-tunnel-proxy");
  proxyInput.disabled = tunnelLocked;
  proxyInput.placeholder = tunnel.controlPlaneProxyConfigured
    ? "Saved securely · leave blank to reuse"
    : "http://proxy-host:port";
  const proxyStorage = requiredElement<HTMLElement>(
    "#secure-tunnel-proxy-storage",
  );
  proxyStorage.textContent =
    tunnel.controlPlaneProxyStorage === "windows-protected"
      ? `Saved with Windows DPAPI · ${tunnel.controlPlaneProxyDisplay ?? "proxy configured"}. Only OpenAI control-plane requests use it; local MCP remains direct.`
      : tunnel.controlPlaneProxyStorage === "memory-only"
        ? `Available for this session only · ${tunnel.controlPlaneProxyDisplay ?? "proxy configured"}. Re-enter it after restart; local MCP remains direct.`
        : "Not configured · only OpenAI control-plane requests use this proxy; the local MCP endpoint remains direct on 127.0.0.1.";
  proxyStorage.classList.toggle(
    "is-warning",
    tunnel.controlPlaneProxyStorage === "memory-only",
  );
  requiredElement<HTMLButtonElement>("#secure-tunnel-save-proxy").disabled =
    tunnelLocked;
  requiredElement<HTMLButtonElement>("#secure-tunnel-clear-proxy").disabled =
    !tunnel.controlPlaneProxyConfigured || tunnelLocked;
  renderControlPlaneRouting(tunnel, tunnelLocked);

  const bridgeInput = requiredElement<HTMLInputElement>("#web-bridge-url");
  if (document.activeElement !== bridgeInput) {
    bridgeInput.value = state.webBridgeUrl ?? "";
  }
  requiredElement<HTMLElement>("#web-bridge-status").textContent =
    state.webBridgeUrl === null
      ? "No remote bridge configured. Local MCP remains available to local clients."
      : `Saved bridge · ${state.webBridgeUrl}`;
  requiredElement<HTMLElement>("#web-connection-target").textContent =
    tunnel.phase === "ready"
      ? "Secure MCP Tunnel is ready; use its tunnel ID in ChatGPT. This bundle remains for local/fallback connections."
      : state.webBridgeUrl === null
        ? "Current bundle targets the local Gateway only. Configure the Secure MCP Tunnel above or a fallback HTTPS bridge."
        : `Fallback ChatGPT bundle target · ${state.webBridgeUrl}`;

  const tunnelBadge = requiredElement<HTMLElement>("#web-session-badge");
  tunnelBadge.textContent = tunnelDisplay.label;
  tunnelBadge.className = `agent-status-value state-${tunnelDisplay.tone}`;
  const clientBadge = requiredElement<HTMLElement>("#web-agent-client");
  clientBadge.textContent =
    state.sessionCount > 0
      ? `ChatGPT connected · ${state.sessionCount}`
      : tunnel.phase === "ready"
        ? "ChatGPT not connected"
        : "Connection unavailable";
  clientBadge.className = `agent-status-value ${state.sessionCount > 0 ? "is-healthy" : tunnel.phase === "ready" ? "is-pending" : ""}`;
  requiredElement<HTMLButtonElement>("#web-copy-connection").disabled =
    state.phase !== "running";
  updateTunnelStartAvailability();
}

function renderManifest(manifest: DesktopManifestView | null): void {
  const container = requiredElement<HTMLDivElement>("#manifest-groups");
  const generated = requiredElement<HTMLElement>("#manifest-generated");
  container.replaceChildren();
  if (manifest === null) {
    generated.textContent = "Unavailable";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Start the runtime to load its tool manifest.";
    container.append(empty);
    return;
  }

  generated.textContent = `${manifest.schemaVersion} · ${formatTimestamp(manifest.generatedAt)}`;
  const groups = new Map<string, DesktopManifestView["tools"]>();
  for (const tool of manifest.tools) {
    const existing = groups.get(tool.category) ?? [];
    groups.set(tool.category, [...existing, tool]);
  }

  for (const [category, tools] of groups.entries()) {
    const group = document.createElement("section");
    group.className = "manifest-group";
    const heading = document.createElement("div");
    heading.className = "manifest-group-heading";
    const title = document.createElement("strong");
    title.textContent = category;
    const count = document.createElement("span");
    count.textContent = `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
    heading.append(title, count);
    group.append(heading);

    for (const tool of tools) {
      const row = document.createElement("div");
      row.className = "tool-row";
      const identity = document.createElement("div");
      const toolName = document.createElement("strong");
      toolName.textContent = tool.name;
      const toolTitle = document.createElement("small");
      toolTitle.textContent = `${tool.title} · ${tool.version}`;
      identity.append(toolName, toolTitle);
      const effects = document.createElement("div");
      effects.className = "tool-effects";
      const permission = document.createElement("span");
      permission.className = `permission permission-${tool.permissionLevel}`;
      permission.textContent = `${tool.permissionLevel === "observe" ? "L1" : tool.permissionLevel === "workspace" ? "L2" : "L3"} · ${tool.approvalMode}`;
      const sideEffect = document.createElement("span");
      sideEffect.textContent = tool.sideEffect;
      const capability = document.createElement("span");
      capability.textContent = tool.requiredCapabilities.join(", ") || "none";
      effects.append(permission, sideEffect, capability);
      row.append(identity, effects);
      group.append(row);
    }
    container.append(group);
  }
}

function overviewRunDuration(run: DesktopRunRecord): string {
  if (run.durationMs !== null) {
    return formatDurationMs(run.durationMs);
  }
  if (run.startedAt === null) {
    return "Queued";
  }
  const startedAt = Date.parse(run.startedAt);
  return Number.isFinite(startedAt)
    ? formatDurationMs(Math.max(0, Date.now() - startedAt))
    : "Running";
}

const PROGRESS_OUTPUT_PATTERN =
  /(?:\b(?:progress|stage|step|build|building|compile|compiling|typecheck|check|checking|test|testing|install|installing|download|downloading|upload|uploading|process|processing|complete|completed|ready)\b|\b\d{1,3}%\b|\b\d+\s*\/\s*\d+\b)/iu;

function sanitizeProgressLine(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function latestProgressLine(run: DesktopRunRecord): string | null {
  const output = run.stdout.trim().length > 0 ? run.stdout : run.stderr;
  const lines = output
    .split(/\r?\n/gu)
    .map(sanitizeProgressLine)
    .filter(Boolean)
    .reverse();
  const latest = lines.find((line) => PROGRESS_OUTPUT_PATTERN.test(line));
  if (latest === undefined) {
    return null;
  }
  return latest.length > 96 ? `${latest.slice(0, 93)}…` : latest;
}

function overviewActivityDuration(startedAt: string): string {
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp)
    ? formatDurationMs(Math.max(0, Date.now() - timestamp))
    : "Running";
}

function activityStateClass(item: DesktopActivityItem): string {
  if (item.state === "succeeded") {
    return "succeeded";
  }
  if (item.state === "denied") {
    return "denied";
  }
  if (
    item.state === "failed" ||
    item.state === "timed-out" ||
    item.state === "interrupted"
  ) {
    return "failed";
  }
  if (item.state === "cancelled") {
    return "cancelled";
  }
  return "running";
}

function renderOverviewActivity(): void {
  const state = document.querySelector<HTMLElement>("#overview-activity-state");
  const container =
    document.querySelector<HTMLDivElement>("#overview-run-list");
  if (state === null || container === null) return;
  const feed = buildDesktopActivityFeed(
    latestOverviewRuns,
    latestAuditReceipts,
    {
      limit: 10,
      activeToolActivities: currentState?.activeToolActivities ?? [],
    },
  );
  const failureLabel =
    feed.recentFailureCount === 1
      ? "1 recent failure"
      : `${feed.recentFailureCount} recent failures`;
  state.textContent = `${feed.activeCount} active · ${failureLabel}`;

  container.replaceChildren();
  if (feed.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "quiet-empty";
    empty.textContent = "No recent activity.";
    container.append(empty);
    return;
  }

  for (const item of feed.items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "overview-activity-row";
    row.dataset.activityCategory = item.category;
    row.title =
      item.source === "run"
        ? "Open this run"
        : item.source === "live"
          ? "Activity in progress"
          : "Open audit receipts";
    row.disabled = item.source === "live";
    row.setAttribute(
      "aria-disabled",
      item.source === "live" ? "true" : "false",
    );

    const marker = document.createElement("span");
    marker.className = `overview-activity-marker activity-${item.category}`;
    marker.setAttribute("aria-hidden", "true");

    const identity = document.createElement("div");
    identity.className = "overview-activity-identity";
    const label = document.createElement("strong");
    label.textContent = item.label;
    const meta = document.createElement("span");
    meta.textContent = item.active
      ? `${item.detail} · ${overviewActivityDuration(item.occurredAt)}`
      : `${item.detail} · ${formatTimestamp(item.occurredAt)}`;
    identity.append(label, meta);

    const status = document.createElement("span");
    status.className = `activity-state activity-state-${activityStateClass(item)}`;
    status.textContent = item.state;

    row.append(marker, identity, status);
    row.addEventListener("click", () => {
      if (item.source === "live") {
        return;
      }
      activateView("runs");
      if (item.source === "run" && item.runId !== null) {
        setRunsTab("runs");
        runsController.openRun(item.runId);
      } else {
        setRunsTab("audit");
      }
    });
    container.append(row);
  }
}

function renderOverviewActiveRun(
  run: DesktopRunRecord | null,
  activeCount: number,
): void {
  if (run === null) {
    return;
  }
  const activeAgentTasks =
    latestTaskWorkspace?.projects
      .flatMap((project) => project.tasks)
      .filter(taskHasLiveAgent) ?? [];
  if (activeAgentTasks.length > 0) {
    renderOverviewRuns(latestOverviewRuns);
    return;
  }
  const activeAgentTaskCount = activeAgentTasks.length;
  const totalActiveCount =
    activeCount +
    (currentState?.activeToolActivities.length ?? 0) +
    activeAgentTaskCount;
  const statusTask = requiredElement<HTMLElement>("#status-task");
  const statusTaskAction = requiredElement<HTMLButtonElement>(
    "#status-task-action",
  );
  delete statusTaskAction.dataset.taskId;
  statusTask.textContent =
    totalActiveCount === 1 ? "1 running" : `${totalActiveCount} running`;
  statusTask.className = "statusbar-value status-running";
  statusTaskAction.title = `${run.label} · ${overviewRunDuration(run)} · Open Tasks`;
  syncActiveWorkNavigator();
}

function renderOverviewRuns(runs: readonly DesktopRunSummary[]): void {
  latestOverviewRuns = runs;
  pythonController.syncRuns(runs);
  const activeRuns = runs.filter(
    (run) => run.state === "queued" || run.state === "running",
  );
  const statusTask = requiredElement<HTMLElement>("#status-task");
  const statusTaskAction = requiredElement<HTMLButtonElement>(
    "#status-task-action",
  );
  delete statusTaskAction.dataset.taskId;
  const liveActivities = currentState?.activeToolActivities ?? [];
  const projectTasks =
    latestTaskWorkspace?.projects.flatMap((project) => project.tasks) ?? [];
  const explicitTasks = projectTasks.filter(
    (task) => task.source !== "inferred",
  );
  const activeAgentTasks = explicitTasks.filter(taskHasLiveAgent);
  const attentionAgentTasks = explicitTasks.filter(taskNeedsOperatorAction);
  const primaryActiveRun = activeRuns[0];
  const primaryLiveActivity = liveActivities[0];
  const primaryAgentTask = activeAgentTasks[0] ?? attentionAgentTasks[0];
  const fallbackActiveCount = activeRuns.length + liveActivities.length;
  if (
    primaryActiveRun === undefined &&
    primaryLiveActivity === undefined &&
    primaryAgentTask === undefined
  ) {
    statusTask.textContent = "Idle";
    statusTask.className = "statusbar-value";
    statusTaskAction.title = "No active task · Open Tasks";
  } else if (primaryAgentTask !== undefined) {
    const needsAttention = taskNeedsOperatorAction(primaryAgentTask);
    statusTask.textContent = needsAttention
      ? "Needs attention"
      : activeAgentTasks.length === 1
        ? "1 Agent task"
        : `${activeAgentTasks.length} Agent tasks`;
    statusTask.className = needsAttention
      ? "statusbar-value status-warning"
      : "statusbar-value status-running";
    statusTaskAction.title = `${primaryAgentTask.title} · Open task`;
    statusTaskAction.dataset.taskId = primaryAgentTask.id;
  } else if (primaryActiveRun !== undefined) {
    statusTask.textContent = `${fallbackActiveCount} running`;
    statusTask.className = "statusbar-value status-running";
    statusTaskAction.title = `${primaryActiveRun.label} · Open Tasks`;
  } else if (primaryLiveActivity !== undefined) {
    const label =
      ACTIVITY_DISPLAY_LABELS[primaryLiveActivity.toolName] ??
      primaryLiveActivity.title;
    statusTask.textContent = `${fallbackActiveCount} running`;
    statusTask.className = "statusbar-value status-running";
    statusTaskAction.title = `${label} · Open Tasks`;
  }
  syncActiveWorkNavigator();
  renderOverviewActivity();
  renderOverviewAttention();
}

type OverviewIssueAction =
  | {
      readonly label: string;
      readonly view: ViewId;
      readonly settingsTab?: SettingsTab;
      readonly taskId?: string;
    }
  | { readonly label: string; readonly retry: true };

function renderOverviewAttention(): void {
  const container = requiredElement<HTMLDivElement>("#overview-attention-list");
  const issues: Array<{
    title: string;
    detail: string;
    severity: "error" | "warning";
    action?: OverviewIssueAction;
  }> = [];
  // Tasks that need action belong to the active-work carousel, which already
  // sorts them first. Listing them here as well showed the same task twice on
  // one screen, so this panel carries only host and connection problems, which
  // the carousel never shows.
  if (
    currentState?.errorMessage !== null &&
    currentState?.errorMessage !== undefined
  ) {
    issues.push({
      title: "Runtime",
      detail: currentState.errorMessage,
      severity: "error",
      action: { label: "Retry", retry: true },
    });
  }
  const tunnel = currentState?.secureTunnel;
  if (tunnel?.errorMessage !== null && tunnel?.errorMessage !== undefined) {
    const diagnostic = tunnel.failureDiagnostic;
    issues.push({
      title: "Connector",
      detail:
        diagnostic === null
          ? tunnel.errorMessage
          : `${tunnel.errorMessage} ${diagnostic.summary}`,
      severity: "error",
      action: { label: "Open ChatGPT Connection", view: "agent" },
    });
  } else if (tunnel?.tunnelId !== null && tunnel?.tunnelId !== undefined) {
    if (!tunnel.clientAvailable) {
      issues.push({
        title: "Connector",
        detail: "Configured tunnel-client is not available on this machine.",
        severity: "warning",
        action: { label: "Configure connector", view: "agent" },
      });
    } else if (!tunnel.executableTrusted) {
      issues.push({
        title: "Connector trust",
        detail:
          "Review and trust the resolved tunnel-client path and SHA-256 before starting.",
        severity: "warning",
        action: { label: "Review connector", view: "agent" },
      });
    } else if (!tunnel.hasRuntimeApiKey && tunnel.phase === "stopped") {
      issues.push({
        title: "Tunnel runtime key",
        detail:
          "Runtime key is required before the configured tunnel can start.",
        severity: "warning",
        action: { label: "Open ChatGPT Connection", view: "agent" },
      });
    } else if (tunnel.phase === "ready" && currentState?.sessionCount === 0) {
      issues.push({
        title: "ChatGPT session",
        detail: "Tunnel is ready, but no ChatGPT MCP client is connected yet.",
        severity: "warning",
        action: { label: "Open ChatGPT Connection", view: "agent" },
      });
    }
  }
  const availability = currentHostStartup?.availability;
  if (
    availability?.available === true &&
    availability.networkDesired &&
    (availability.networkState === "degraded" ||
      availability.networkState === "offline")
  ) {
    issues.push({
      title: "Host recovery",
      detail:
        availability.detail ??
        "The remote Tunnel is not ready and automatic recovery is expected.",
      severity: "warning",
      action: {
        label: "Open diagnostics",
        view: "settings",
        settingsTab: "diagnostics",
      },
    });
  } else if (
    availability?.available === true &&
    availability.networkState === "retrying"
  ) {
    issues.push({
      title: "Host recovery",
      detail:
        availability.nextReconnectAt === null
          ? "The Tunnel connector is retrying."
          : `The Tunnel connector is retrying at ${formatTimestamp(availability.nextReconnectAt)}.`,
      severity: "warning",
      action: {
        label: "Open diagnostics",
        view: "settings",
        settingsTab: "diagnostics",
      },
    });
  }
  const failedRuns = latestOverviewRuns
    .filter(
      (candidate) =>
        candidate.state === "failed" ||
        candidate.state === "timed-out" ||
        candidate.state === "interrupted",
    )
    .slice(0, 3);
  if (failedRuns.length > 0) {
    issues.push({
      title:
        uiSettings.language === "zh-CN"
          ? `${failedRuns.length} 个最近运行需要检查`
          : `${failedRuns.length} recent run${failedRuns.length === 1 ? "" : "s"} need review`,
      detail:
        uiSettings.language === "zh-CN"
          ? "在任务记录中查看失败、超时或中断的运行。"
          : "Review failed, timed-out or interrupted runs in Task History.",
      severity: "warning",
      action: { label: "Open Task History", view: "runs" },
    });
  }

  const visibleIssues = issues.slice(0, 4);
  const section = requiredElement<HTMLElement>("#overview-attention-section");
  section.hidden = visibleIssues.length === 0;
  requiredElement<HTMLElement>("#overview-attention-count").textContent =
    issues.length > 4 ? "4+" : String(issues.length);
  const signature = JSON.stringify(visibleIssues);
  if (container.dataset.signature === signature) {
    return;
  }
  container.dataset.signature = signature;
  container.replaceChildren();
  if (visibleIssues.length === 0) {
    return;
  }

  for (const issue of visibleIssues) {
    const row = document.createElement("div");
    row.className = `overview-attention-row is-${issue.severity}`;
    const marker = document.createElement("span");
    marker.className = "overview-attention-marker";
    marker.setAttribute("aria-hidden", "true");
    const title = document.createElement("strong");
    title.textContent = issue.title;
    const detail = document.createElement("span");
    detail.textContent = issue.detail;
    row.append(marker, title, detail);
    if (issue.action !== undefined) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "button button-ghost overview-attention-action";
      action.textContent = issue.action.label;
      action.addEventListener("click", () => {
        if ("retry" in issue.action!) {
          void refreshAll();
          return;
        }
        activateView(issue.action!.view);
        if (
          issue.action!.view === "tasks" &&
          issue.action!.taskId !== undefined
        ) {
          void tasksController.openTask(issue.action!.taskId);
        }
        if (
          issue.action!.view === "settings" &&
          issue.action!.settingsTab !== undefined
        ) {
          setSettingsTab(issue.action!.settingsTab);
        }
      });
      row.append(action);
    }
    container.append(row);
  }
}

function syncExternalActivitySurfaces(
  receipts: readonly DesktopAuditReceipt[],
): void {
  const externalReceipts = receipts.filter(
    (receipt) => receipt.principalId === "chatgpt-web",
  );
  const newestId = externalReceipts[0]?.id ?? null;
  if (newestId === null) {
    return;
  }
  const newReceipts =
    lastExternalActivityReceiptId === null
      ? externalReceipts.slice(0, 20)
      : (() => {
          const previousIndex = externalReceipts.findIndex(
            (receipt) => receipt.id === lastExternalActivityReceiptId,
          );
          return previousIndex < 0
            ? externalReceipts
            : externalReceipts.slice(0, previousIndex);
        })();
  lastExternalActivityReceiptId = newestId;
  if (newReceipts.length === 0) {
    return;
  }

  const toolNames = new Set(newReceipts.map((receipt) => receipt.toolName));
  if ([...toolNames].some((toolName) => toolName.startsWith("browser."))) {
    browserController.markExternalActivity();
    if (currentView === "browser") {
      void browserController.refresh();
    }
  }
  if ([...toolNames].some((toolName) => toolName.startsWith("computer."))) {
    computerController.markExternalActivity();
    if (currentView === "computer") {
      void computerController.refresh();
    }
  }
  if (
    currentView === "terminal" &&
    [...toolNames].some((toolName) => toolName.startsWith("terminal.session."))
  ) {
    void terminalController.refresh();
  }
  if (
    currentView === "python" &&
    [...toolNames].some((toolName) => toolName.startsWith("python."))
  ) {
    void pythonController.refresh();
  }
  if (
    currentView === "workflows" &&
    [...toolNames].some((toolName) => toolName.startsWith("workflow."))
  ) {
    void workflowController.refresh();
  }
}

function renderAudit(receipts: readonly DesktopAuditReceipt[]): void {
  syncExternalActivitySurfaces(receipts);
  latestAuditReceipts = receipts;
  renderOverviewActivity();
  const body = requiredElement<HTMLTableSectionElement>("#audit-body");
  body.replaceChildren();
  const normalizedQuery = auditSearchQuery.trim().toLowerCase();
  const filtered = receipts.filter((receipt) => {
    const matchesOutcome =
      auditOutcomeFilter === "all" || receipt.outcome === auditOutcomeFilter;
    const haystack =
      `${receipt.toolName} ${receipt.operation} ${receipt.relativePath ?? ""}`.toLowerCase();
    const matchesSearch =
      normalizedQuery.length === 0 || haystack.includes(normalizedQuery);
    return matchesOutcome && matchesSearch;
  });
  requiredElement<HTMLElement>("#audit-count").textContent =
    `${filtered.length} receipt${filtered.length === 1 ? "" : "s"}`;

  if (filtered.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "table-empty compact-table-empty";
    cell.textContent =
      receipts.length === 0
        ? currentState?.phase === "running"
          ? "No audit receipts yet."
          : "Start the runtime to read the audit ledger."
        : "No receipts match the current filter.";
    row.append(cell);
    body.append(row);
    return;
  }

  for (const receipt of filtered) {
    const row = document.createElement("tr");
    const values = [
      formatTimestamp(receipt.occurredAt),
      receipt.toolName,
      receipt.operation,
      receipt.relativePath ?? "—",
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const outcomeCell = document.createElement("td");
    const outcome = document.createElement("span");
    outcome.className = `outcome outcome-${receipt.outcome}`;
    outcome.textContent = receipt.outcome;
    outcomeCell.append(outcome);
    row.append(outcomeCell);
    body.append(row);
  }
}

function renderResourceSnapshot(snapshot: DesktopResourceSnapshot): void {
  requiredElement<HTMLElement>("#resources-captured").textContent =
    formatTimestamp(snapshot.capturedAt);
  requiredElement<HTMLElement>("#resources-product-private").textContent =
    formatBytes(snapshot.totals.productPrivateBytes);
  requiredElement<HTMLElement>("#resources-shell-private").textContent =
    formatBytes(snapshot.totals.shellPrivateBytes);
  requiredElement<HTMLElement>("#resources-runtime-private").textContent =
    snapshot.runtimePlacement === "embedded-main"
      ? "Embedded"
      : formatBytes(snapshot.totals.runtimePrivateBytes);
  requiredElement<HTMLElement>("#resources-services-private").textContent =
    formatBytes(snapshot.totals.servicePrivateBytes);
  requiredElement<HTMLElement>("#resources-working-set").textContent =
    formatBytes(snapshot.totals.productWorkingSetBytes);
  requiredElement<HTMLElement>("#resources-process-count").textContent = String(
    snapshot.totals.processCount,
  );
  requiredElement<HTMLElement>("#resources-runtime-placement").textContent =
    snapshot.runtimePlacement === "embedded-main"
      ? "Embedded in desktop main"
      : "Node sidecar";
  const launchKindLabels: Readonly<
    Record<DesktopResourceSnapshot["shellLaunchKind"], string>
  > = {
    portable: "Portable",
    installed: "Installed",
    development: "Development",
    "legacy-electron": "Legacy Electron",
    unknown: "Unknown",
  };
  requiredElement<HTMLElement>("#resources-launch-kind").textContent =
    launchKindLabels[snapshot.shellLaunchKind];
  const executablePath = requiredElement<HTMLElement>(
    "#resources-executable-path",
  );
  executablePath.textContent = snapshot.shellExecutablePath;
  executablePath.title = snapshot.shellExecutablePath;
  requiredElement<HTMLElement>("#resources-process-meta").textContent =
    `${snapshot.processes.length} process${snapshot.processes.length === 1 ? "" : "es"}`;

  const container = requiredElement<HTMLDivElement>("#resources-process-list");
  container.replaceChildren();
  if (snapshot.processes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "compact-empty";
    empty.textContent = "No owned process metrics were available.";
    container.append(empty);
    return;
  }

  for (const process of snapshot.processes) {
    const row = document.createElement("div");
    row.className = "resource-process-row";
    const role = document.createElement("span");
    role.className = `resource-role role-${process.role}`;
    role.textContent = process.role;
    const label = document.createElement("strong");
    label.textContent = process.label;
    label.title = process.label;
    const processId = document.createElement("code");
    processId.textContent = String(process.processId);
    const privateBytes = document.createElement("span");
    privateBytes.textContent = formatBytes(process.privateBytes);
    const workingSet = document.createElement("span");
    workingSet.textContent = formatBytes(process.workingSetBytes);
    const cpu = document.createElement("span");
    cpu.textContent =
      process.cpuPercent === null ? "—" : `${process.cpuPercent.toFixed(1)}%`;
    row.append(role, label, processId, privateBytes, workingSet, cpu);
    container.append(row);
  }
}

type RendererReleaseView =
  DesktopRendererUpdateStatus["installedReleases"][number];

function rendererReleaseLabel(release: RendererReleaseView): string {
  return `${release.version} · #${release.releaseSequence} · ${release.releaseId}`;
}

function selectedRendererReleaseId(): string | null {
  const value = requiredElement<HTMLSelectElement>(
    "#renderer-update-release",
  ).value.trim();
  return value.length === 0 ? null : value;
}

function captureRendererHandoff(): DesktopRendererHandoff {
  const activeSettingsTab = document.querySelector<HTMLButtonElement>(
    "[data-settings-tab].is-active",
  )?.dataset.settingsTab;
  const settingsTab: DesktopRendererHandoff["settingsTab"] =
    activeSettingsTab === "appearance" ||
    activeSettingsTab === "host" ||
    activeSettingsTab === "security" ||
    activeSettingsTab === "diagnostics"
      ? activeSettingsTab
      : null;
  const scrollTop = Math.max(
    0,
    Math.min(
      10_000_000,
      Math.round(requiredElement<HTMLElement>(".content-scroll").scrollTop),
    ),
  );
  return {
    schemaVersion: "scr.renderer-handoff/v1",
    view: currentView,
    settingsTab,
    scrollTop,
  };
}

function syncRendererUpdateActionState(
  status: DesktopRendererUpdateStatus,
): void {
  const releaseId = selectedRendererReleaseId();
  const installed =
    releaseId !== null &&
    status.installedReleases.some((release) => release.releaseId === releaseId);
  const inInbox =
    releaseId !== null && status.inboxReleaseIds.includes(releaseId);
  const active = status.activeRelease?.releaseId === releaseId;
  const preflighted =
    releaseId !== null && status.preflightedReleaseIds.includes(releaseId);
  const busy = status.pendingActivation !== null;

  requiredElement<HTMLButtonElement>("#renderer-update-install").disabled =
    !status.enabled || busy || releaseId === null || !inInbox || installed;
  requiredElement<HTMLButtonElement>("#renderer-update-preflight").disabled =
    !status.enabled || busy || releaseId === null || !installed;
  requiredElement<HTMLButtonElement>("#renderer-update-activate").disabled =
    !status.enabled ||
    busy ||
    releaseId === null ||
    !installed ||
    !preflighted ||
    active;
  const distinctRollbackAvailable =
    !status.builtInActive &&
    (status.lastKnownGoodRelease === null ||
      status.lastKnownGoodRelease.releaseId !==
        status.activeRelease?.releaseId);
  requiredElement<HTMLButtonElement>("#renderer-update-rollback").disabled =
    busy || !distinctRollbackAvailable;
}

function renderRendererUpdateStatus(status: DesktopRendererUpdateStatus): void {
  currentRendererUpdateStatus = status;
  const meta = requiredElement<HTMLElement>("#renderer-update-meta");
  const active = requiredElement<HTMLElement>("#renderer-update-active");
  const activeDetail = requiredElement<HTMLElement>(
    "#renderer-update-active-detail",
  );
  const lastKnownGood = requiredElement<HTMLElement>("#renderer-update-lkg");
  const detail = requiredElement<HTMLElement>("#renderer-update-detail");
  const select = requiredElement<HTMLSelectElement>("#renderer-update-release");
  const previousSelection = select.value;

  if (status.pendingActivation !== null) {
    meta.textContent = `${status.pendingActivation.phase} · ${
      status.pendingActivation.releaseId ?? "Built-in"
    }`;
  } else {
    meta.textContent = status.enabled
      ? `${status.trustedKeyCount} trusted key${status.trustedKeyCount === 1 ? "" : "s"}`
      : "Disabled";
  }

  if (status.activeRelease === null) {
    active.textContent = "Built-in";
    activeDetail.textContent = `Bundled with shell ${status.shellVersion} · bridge API ${status.bridgeApiVersion}.`;
  } else {
    active.textContent = rendererReleaseLabel(status.activeRelease);
    activeDetail.textContent = `Signed renderer · ${status.activeRelease.channel} · ${status.activeRelease.manifestSha256.slice(0, 12)}…`;
  }
  active.classList.toggle("is-on", status.pendingActivation === null);
  lastKnownGood.textContent =
    status.lastKnownGoodRelease === null
      ? "Built-in"
      : rendererReleaseLabel(status.lastKnownGoodRelease);

  const installedById = new Map(
    status.installedReleases.map(
      (release) => [release.releaseId, release] as const,
    ),
  );
  const releaseIds = [
    ...new Set([
      ...status.inboxReleaseIds,
      ...status.installedReleases.map((release) => release.releaseId),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  select.replaceChildren();
  if (releaseIds.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No candidate available";
    select.append(option);
  } else {
    for (const releaseId of releaseIds) {
      const option = document.createElement("option");
      option.value = releaseId;
      const installedRelease = installedById.get(releaseId);
      const location = status.inboxReleaseIds.includes(releaseId)
        ? installedRelease === undefined
          ? "Inbox"
          : "Installed · Inbox"
        : "Installed";
      option.textContent =
        installedRelease === undefined
          ? `${releaseId} · ${location}`
          : `${rendererReleaseLabel(installedRelease)} · ${location}`;
      select.append(option);
    }
    const preferred = releaseIds.includes(previousSelection)
      ? previousSelection
      : (status.inboxReleaseIds.find(
          (releaseId) => !installedById.has(releaseId),
        ) ??
        status.installedReleases.find(
          (release) => release.releaseId !== status.activeRelease?.releaseId,
        )?.releaseId ??
        releaseIds[0]!);
    select.value = preferred;
  }

  const inventorySummary = `${status.installedReleases.length} installed · ${status.inboxReleaseIds.length} in inbox · ${status.preflightedReleaseIds.length} preflighted · highest accepted sequence #${status.highestReleaseSequence}`;
  if (!status.enabled) {
    detail.textContent =
      status.lastFailure ??
      "Renderer updates are disabled until the signed shell provisions at least one trusted Ed25519 release key.";
  } else if (status.lastFailure !== null) {
    detail.textContent = `${inventorySummary}. Last failure: ${status.lastFailure}`;
  } else {
    detail.textContent = `${inventorySummary}. Install, preflight, then activate. A failed readiness check returns to the last-known-good renderer.`;
  }
  syncRendererUpdateActionState(status);
}

const rendererUpdateSettlementPoller = new RendererUpdateSettlementPoller(() =>
  refreshRendererUpdateStatus(),
);

async function refreshRendererUpdateStatus(): Promise<void> {
  const button = requiredElement<HTMLButtonElement>("#renderer-update-refresh");
  button.disabled = true;
  try {
    const status = await window.sovereign.getRendererUpdateStatus();
    renderRendererUpdateStatus(status);
    rendererUpdateSettlementPoller.reconcile(status.pendingActivation !== null);
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not read renderer update status.",
      true,
    );
  } finally {
    button.disabled = false;
  }
}

function selectedRuntimeCandidateReleaseId(): string | null {
  const value = requiredElement<HTMLSelectElement>(
    "#runtime-candidate-release",
  ).value.trim();
  return value.length === 0 ? null : value;
}

function syncRuntimeCandidateActionState(
  status: RuntimeCandidateUpdateStatus,
): void {
  const releaseId = selectedRuntimeCandidateReleaseId();
  const unavailable = !status.enabled || status.busy || releaseId === null;
  const installed =
    releaseId !== null && status.installedReleaseIds.includes(releaseId);
  const inInbox =
    releaseId !== null && status.inboxReleaseIds.includes(releaseId);
  requiredElement<HTMLButtonElement>("#runtime-candidate-install").disabled =
    unavailable || installed || !inInbox;
  requiredElement<HTMLButtonElement>("#runtime-candidate-activate").disabled =
    unavailable || !installed || status.activeReleaseId === releaseId;
}

function renderRuntimeCandidateUpdateStatus(
  status: RuntimeCandidateUpdateStatus,
): void {
  currentRuntimeCandidateUpdateStatus = status;
  const meta = requiredElement<HTMLElement>("#runtime-candidate-meta");
  const active = requiredElement<HTMLElement>("#runtime-candidate-active");
  const trust = requiredElement<HTMLElement>("#runtime-candidate-trust");
  const detail = requiredElement<HTMLElement>("#runtime-candidate-detail");
  const select = requiredElement<HTMLSelectElement>(
    "#runtime-candidate-release",
  );
  const previousSelection = select.value;

  meta.textContent = status.busy
    ? "Operation in progress"
    : status.enabled
      ? "Ready"
      : "Disabled";
  meta.classList.toggle("is-on", status.enabled && !status.busy);
  active.textContent = status.activeReleaseId ?? "Built-in";
  trust.textContent = `${status.trustedKeyCount} trusted key${status.trustedKeyCount === 1 ? "" : "s"}`;

  const releaseIds = [
    ...new Set([...status.inboxReleaseIds, ...status.installedReleaseIds]),
  ].sort((left, right) => left.localeCompare(right));
  select.replaceChildren();
  if (releaseIds.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No Runtime candidate available";
    select.append(option);
  } else {
    for (const releaseId of releaseIds) {
      const option = document.createElement("option");
      option.value = releaseId;
      const installed = status.installedReleaseIds.includes(releaseId);
      const inInbox = status.inboxReleaseIds.includes(releaseId);
      const location =
        installed && inInbox
          ? "Installed · Inbox"
          : installed
            ? "Installed"
            : "Inbox";
      option.textContent = `${releaseId} · ${location}`;
      select.append(option);
    }
    select.value = releaseIds.includes(previousSelection)
      ? previousSelection
      : (status.inboxReleaseIds.find(
          (releaseId) => !status.installedReleaseIds.includes(releaseId),
        ) ??
        status.installedReleaseIds.find(
          (releaseId) => releaseId !== status.activeReleaseId,
        ) ??
        releaseIds[0]!);
  }

  const inventory = `${status.installedReleaseIds.length} installed · ${status.inboxReleaseIds.length} in inbox · highest accepted sequence #${status.highestReleaseSequence}`;
  if (!status.enabled) {
    detail.textContent =
      status.lastFailure ??
      "Runtime Host candidates are disabled until the signed Tauri shell provisions at least one trusted Ed25519 signing key.";
  } else if (status.lastFailure !== null) {
    detail.textContent = `${inventory}. Last failure: ${status.lastFailure}`;
  } else {
    detail.textContent = `${inventory}. Install a signed inbox release, then activate the verified immutable slot.`;
  }
  syncRuntimeCandidateActionState(status);
}

async function refreshRuntimeCandidateUpdateStatus(): Promise<void> {
  const button = requiredElement<HTMLButtonElement>(
    "#runtime-candidate-refresh",
  );
  button.disabled = true;
  try {
    renderRuntimeCandidateUpdateStatus(
      await window.sovereign.getRuntimeCandidateUpdateStatus(),
    );
  } catch (error) {
    requiredElement<HTMLElement>("#runtime-candidate-meta").textContent =
      "Unavailable";
    requiredElement<HTMLElement>("#runtime-candidate-detail").textContent =
      error instanceof Error
        ? error.message
        : "Could not read Runtime Host candidate status.";
  } finally {
    button.disabled = false;
  }
}

async function runRuntimeCandidateAction(
  buttonSelector: string,
  action: (releaseId: string) => Promise<unknown>,
  successMessage: string,
): Promise<void> {
  const button = requiredElement<HTMLButtonElement>(buttonSelector);
  const releaseId = selectedRuntimeCandidateReleaseId();
  if (releaseId === null) {
    showToast("Select a Runtime Host candidate release.", true);
    return;
  }
  button.disabled = true;
  try {
    await action(releaseId);
    await Promise.all([
      refreshRuntimeCandidateUpdateStatus(),
      refreshRuntimeRollingStatus(),
    ]);
    showToast(successMessage);
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Runtime Host candidate operation failed.",
      true,
    );
  } finally {
    if (currentRuntimeCandidateUpdateStatus !== null) {
      syncRuntimeCandidateActionState(currentRuntimeCandidateUpdateStatus);
    }
  }
}

async function installSelectedRuntimeCandidate(): Promise<void> {
  await runRuntimeCandidateAction(
    "#runtime-candidate-install",
    (releaseId) => window.sovereign.installRuntimeCandidateUpdate(releaseId),
    "Runtime Host candidate installed and reverified.",
  );
}

async function activateSelectedRuntimeCandidate(): Promise<void> {
  await runRuntimeCandidateAction(
    "#runtime-candidate-activate",
    (releaseId) => window.sovereign.activateRuntimeCandidateUpdate(releaseId),
    "Runtime Host cutover committed.",
  );
}

function renderRuntimeRollingStatus(status: DesktopRuntimeRollingStatus): void {
  const meta = requiredElement<HTMLElement>("#runtime-rolling-meta");
  const active = requiredElement<HTMLElement>("#runtime-rolling-active");
  const generation = requiredElement<HTMLElement>(
    "#runtime-rolling-generation",
  );
  const fence = requiredElement<HTMLElement>("#runtime-rolling-fence");
  const detail = requiredElement<HTMLElement>("#runtime-rolling-detail");

  meta.textContent = status.busy
    ? "Cutover in progress"
    : status.enabled
      ? "Ready"
      : "Not configured";
  meta.classList.toggle("is-on", status.enabled && !status.busy);
  active.textContent = `${status.active.active.releaseId} · ${status.active.active.instanceId}`;
  generation.textContent = `#${status.active.generation}`;
  fence.textContent =
    status.active.fencingTokenSha256 === null
      ? "None"
      : `${status.active.fencingTokenSha256.slice(0, 12)}…`;
  detail.textContent = status.enabled
    ? status.busy
      ? "A single-flight Runtime Host cutover is currently active. New cutovers are rejected until it finishes."
      : "Desktop and renderer-preflight calls share one authoritative Runtime endpoint router. Generation and fencing evidence update only after a verified candidate commits."
    : (status.disabledReason ??
      "Runtime Host rolling updates are disabled until the signed shell configures a verified candidate launcher.");
}

async function refreshRuntimeRollingStatus(): Promise<void> {
  const button = requiredElement<HTMLButtonElement>("#runtime-rolling-refresh");
  button.disabled = true;
  try {
    renderRuntimeRollingStatus(
      await window.sovereign.getRuntimeRollingStatus(),
    );
  } catch (error) {
    requiredElement<HTMLElement>("#runtime-rolling-meta").textContent =
      "Unavailable";
    requiredElement<HTMLElement>("#runtime-rolling-detail").textContent =
      error instanceof Error
        ? error.message
        : "Could not read Runtime Host rolling-update status.";
  } finally {
    button.disabled = false;
  }
}

async function runRendererUpdateAction(
  buttonSelector: string,
  action: (releaseId: string | null) => Promise<DesktopRendererUpdateStatus>,
  successMessage: string,
): Promise<void> {
  const button = requiredElement<HTMLButtonElement>(buttonSelector);
  const releaseId = selectedRendererReleaseId();
  button.disabled = true;
  try {
    const status = await action(releaseId);
    renderRendererUpdateStatus(status);
    showToast(successMessage);
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Renderer update operation failed.",
      true,
    );
  } finally {
    if (currentRendererUpdateStatus !== null) {
      syncRendererUpdateActionState(currentRendererUpdateStatus);
    }
  }
}

async function installSelectedRendererUpdate(): Promise<void> {
  await runRendererUpdateAction(
    "#renderer-update-install",
    async (releaseId) => {
      if (releaseId === null) {
        throw new Error("Select a renderer release to install.");
      }
      return await window.sovereign.installRendererUpdate(releaseId);
    },
    "Signed renderer installed into an immutable local slot.",
  );
}

async function preflightSelectedRendererUpdate(): Promise<void> {
  await runRendererUpdateAction(
    "#renderer-update-preflight",
    async (releaseId) => {
      if (releaseId === null) {
        throw new Error("Select an installed renderer release to preflight.");
      }
      return await window.sovereign.preflightRendererUpdate(releaseId);
    },
    "Renderer candidate passed its isolated read-only preflight.",
  );
}

async function activateSelectedRendererUpdate(): Promise<void> {
  await runRendererUpdateAction(
    "#renderer-update-activate",
    async (releaseId) => {
      if (releaseId === null) {
        throw new Error("Select a preflighted renderer release to activate.");
      }
      return await window.sovereign.activateRendererUpdate(
        releaseId,
        captureRendererHandoff(),
      );
    },
    "Renderer activation started.",
  );
}

async function rollbackRendererUpdate(): Promise<void> {
  await runRendererUpdateAction(
    "#renderer-update-rollback",
    async () =>
      await window.sovereign.rollbackRendererUpdate(captureRendererHandoff()),
    "Renderer rollback started.",
  );
}
async function refreshHostStartupState(): Promise<void> {
  try {
    currentHostStartup = await window.sovereign.getHostStartupState();
    lastHostStartupPollAt = Date.now();
    renderRemoteHostState();
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not read Windows login startup state.",
      true,
    );
  }
}

async function refreshResourceSnapshot(): Promise<void> {
  const button = requiredElement<HTMLButtonElement>("#resources-refresh");
  button.disabled = true;
  try {
    renderResourceSnapshot(await window.sovereign.getResourceSnapshot());
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not sample runtime resources.",
      true,
    );
  } finally {
    button.disabled = false;
  }
}

async function performRefreshAll(): Promise<void> {
  try {
    const [state, startup] = await Promise.all([
      window.sovereign.getState(),
      window.sovereign.getHostStartupState(),
    ]);
    currentHostStartup = startup;
    lastHostStartupPollAt = Date.now();
    renderState(state);
    const [manifest, receipts] = await Promise.all([
      window.sovereign.getManifest(),
      window.sovereign.getAuditReceipts(100),
    ]);
    renderManifest(manifest);
    renderAudit(receipts);
    await Promise.all([runsController.refresh(), tasksController.refresh()]);
    await refreshActiveWorkbench();
    consecutivePollFailures = 0;
  } catch (error) {
    consecutivePollFailures = Math.min(consecutivePollFailures + 1, 8);
    showToast(
      error instanceof Error
        ? error.message
        : "Could not refresh the desktop state.",
      true,
    );
  }
}

function refreshAll(): Promise<void> {
  return requestRefresh("full");
}

async function runStateAction(
  action: () => Promise<DesktopRuntimeState>,
  successMessage: string,
): Promise<void> {
  try {
    const state = await action();
    renderState(state);
    await refreshAll();
    showToast(successMessage);
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : "The operation failed.",
      true,
    );
  }
}

async function copyConnectionBundle(): Promise<void> {
  const button = requiredElement<HTMLButtonElement>("#copy-connection");
  button.disabled = true;
  try {
    const result = await window.sovereign.copyConnectionBundle();
    const targetLabel =
      result.target === "web-bridge" ? "ChatGPT Web bridge" : "local Gateway";
    showToast(
      `Connection bundle copied for ${targetLabel}. Clipboard clears at ${formatTimestamp(result.clipboardClearsAt)}.`,
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not copy the connection bundle.",
      true,
    );
  } finally {
    if (currentState !== null) {
      renderState(currentState);
    }
  }
}

async function rotateCredentials(): Promise<void> {
  const previousGeneration = currentState?.credentialGeneration ?? 0;
  try {
    const state = await window.sovereign.rotateCredentials();
    renderState(state);
    await refreshAll();
    showToast(
      state.credentialGeneration > previousGeneration
        ? "Gateway credential rotated. Copy a new connection bundle."
        : "Credential rotation cancelled.",
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not rotate the Gateway credential.",
      true,
    );
  }
}

async function updateAutoStart(enabled: boolean): Promise<void> {
  const toggle = requiredElement<HTMLInputElement>("#auto-start-runtime");
  toggle.disabled = true;
  try {
    const state = await window.sovereign.setAutoStart(enabled);
    renderState(state);
    showToast(
      enabled ? "Gateway auto-start enabled." : "Gateway auto-start disabled.",
    );
  } catch (error) {
    if (currentState !== null) {
      renderState(currentState);
    }
    showToast(
      error instanceof Error
        ? error.message
        : "Could not update the auto-start setting.",
      true,
    );
  } finally {
    toggle.disabled = false;
  }
}

async function updateUnattendedWorkspaceAccess(
  enabled: boolean,
): Promise<void> {
  const toggle = requiredElement<HTMLInputElement>(
    "#unattended-workspace-access",
  );
  toggle.disabled = true;
  try {
    const state = await window.sovereign.setUnattendedWorkspaceAccess(enabled);
    renderState(state);
    const permissionSummary =
      state.permissionProfile === "bypass"
        ? `confirmation bypass remains on · turn it off to return to ${permissionProfileDisplay(state.rememberedPermissionProfile)}`
        : `active permission remains ${permissionProfileDisplay(state.permissionProfile)}`;
    showToast(
      `Workspace restore ${enabled ? "enabled" : "disabled"} · ${permissionSummary}.`,
    );
  } catch (error) {
    if (currentState !== null) {
      renderState(currentState);
    }
    showToast(
      error instanceof Error
        ? error.message
        : "Could not update unattended access.",
      true,
    );
  } finally {
    renderRemoteHostState();
  }
}

async function updateLaunchAtLogin(enabled: boolean): Promise<void> {
  const toggle = requiredElement<HTMLInputElement>("#host-launch-at-login");
  toggle.disabled = true;
  try {
    currentHostStartup = await window.sovereign.setLaunchAtLogin(enabled);
    renderRemoteHostState();
    showToast(
      enabled
        ? "Sovereign will start after Windows sign-in."
        : "Windows login startup disabled.",
    );
  } catch (error) {
    renderRemoteHostState();
    showToast(
      error instanceof Error
        ? error.message
        : "Could not update Windows login startup.",
      true,
    );
  }
}

async function updateTunnelAutomation(): Promise<void> {
  const autoStartToggle =
    requiredElement<HTMLInputElement>("#tunnel-auto-start");
  const autoReconnectToggle = requiredElement<HTMLInputElement>(
    "#tunnel-auto-reconnect",
  );
  autoStartToggle.disabled = true;
  autoReconnectToggle.disabled = true;
  try {
    const state = await window.sovereign.setSecureTunnelAutomation({
      autoStart: autoStartToggle.checked,
      autoReconnect: autoReconnectToggle.checked,
    });
    renderState(state);
    showToast("Secure MCP Tunnel automation updated.");
  } catch (error) {
    if (currentState !== null) {
      renderState(currentState);
    }
    showToast(
      error instanceof Error
        ? error.message
        : "Could not update Tunnel automation.",
      true,
    );
  } finally {
    renderRemoteHostState();
  }
}

async function enableRemoteHostMode(): Promise<void> {
  const button = requiredElement<HTMLButtonElement>("#remote-host-enable");
  button.disabled = true;
  try {
    currentHostStartup = await window.sovereign.setLaunchAtLogin(true);
    let state = await window.sovereign.setAutoStart(true);
    if (
      state.workspaceRoot !== null &&
      state.phase !== "running" &&
      state.phase !== "starting"
    ) {
      state = await window.sovereign.start();
    }
    state = await window.sovereign.setUnattendedWorkspaceAccess(true);
    state = await window.sovereign.setSecureTunnelAutomation({
      autoStart: true,
      autoReconnect: true,
    });
    renderState(state);
    const startup = currentHostStartup;
    const readiness =
      startup === null ? null : remoteHostReadiness(state, startup);
    showToast(
      readiness?.connectionReady === true
        ? `Unattended host enabled for this workspace · ${permissionProfileDisplay(state.permissionProfile)} remains selected and will be restored after sign-in.`
        : "Startup automation enabled. Complete the remaining ChatGPT connection items.",
    );
  } catch (error) {
    await refreshAll().catch(() => undefined);
    showToast(
      error instanceof Error
        ? error.message
        : "Could not enable Remote Host Mode.",
      true,
    );
  } finally {
    renderRemoteHostState();
  }
}

async function updateWebBridgeUrl(value: string | null): Promise<void> {
  const save = requiredElement<HTMLButtonElement>("#web-save-bridge");
  const clear = requiredElement<HTMLButtonElement>("#web-clear-bridge");
  save.disabled = true;
  clear.disabled = true;
  try {
    const state = await window.sovereign.setWebBridgeUrl(value);
    renderState(state);
    showToast(
      state.webBridgeUrl === null
        ? "ChatGPT Web bridge cleared."
        : "ChatGPT Web bridge saved.",
    );
  } catch (error) {
    if (currentState !== null) {
      renderState(currentState);
    }
    showToast(
      error instanceof Error
        ? error.message
        : "Could not update the web bridge URL.",
      true,
    );
  } finally {
    save.disabled = false;
    clear.disabled = false;
  }
}

async function chooseSecureTunnelExecutable(): Promise<void> {
  try {
    const previousPath = currentState?.secureTunnel.executablePath ?? null;
    const state = await window.sovereign.chooseSecureTunnelExecutable();
    renderState(state);
    const nextPath = state.secureTunnel.executablePath;
    showToast(
      nextPath !== null && nextPath !== previousPath
        ? "Connector selected. Start the tunnel to review and trust its SHA-256."
        : "Connector selection cancelled.",
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not choose the tunnel connector.",
      true,
    );
  }
}

async function startSecureTunnel(): Promise<void> {
  const tunnelId =
    requiredElement<HTMLInputElement>("#secure-tunnel-id").value.trim();
  const apiKeyInput = requiredElement<HTMLInputElement>(
    "#secure-tunnel-api-key",
  );
  const runtimeApiKey = apiKeyInput.value.trim();
  const proxyInput = requiredElement<HTMLInputElement>("#secure-tunnel-proxy");
  const controlPlaneProxyUrl = proxyInput.value.trim();
  const backupProxyInput = requiredElement<HTMLInputElement>(
    "#secure-tunnel-backup-proxy",
  );
  const controlPlaneBackupProxyUrl = backupProxyInput.value.trim();
  const controlPlaneDirectFallbackEnabled = requiredElement<HTMLInputElement>(
    "#secure-tunnel-direct-fallback",
  ).checked;
  if (!/^tunnel_[a-f0-9]{32}$/u.test(tunnelId)) {
    showToast(
      "Paste the actual Tunnel ID from OpenAI Platform. The gray example text is not a configured tunnel.",
      true,
    );
    return;
  }
  if (
    runtimeApiKey.length === 0 &&
    currentState?.secureTunnel.hasRuntimeApiKey !== true
  ) {
    showToast(
      "Paste a Tunnel runtime API key before starting. Sovereign will protect it with your Windows account for reuse.",
      true,
    );
    return;
  }
  try {
    let state = await window.sovereign.configureSecureTunnel({
      tunnelId,
      ...(runtimeApiKey.length === 0 ? {} : { runtimeApiKey }),
      ...(controlPlaneProxyUrl.length === 0 ? {} : { controlPlaneProxyUrl }),
      ...(controlPlaneBackupProxyUrl.length === 0
        ? {}
        : { controlPlaneBackupProxyUrl }),
      controlPlaneDirectFallbackEnabled,
    });
    secureTunnelIdDraft = state.secureTunnel.tunnelId ?? "";
    secureTunnelIdDirty = false;
    renderState(state);
    state = await window.sovereign.startSecureTunnel();
    apiKeyInput.value = "";
    proxyInput.value = "";
    backupProxyInput.value = "";
    renderState(state);
    showToast(
      state.secureTunnel.phase === "ready"
        ? "Secure MCP Tunnel is ready for ChatGPT Web."
        : (state.secureTunnel.errorMessage ??
            "Secure MCP Tunnel started; readiness is still pending."),
      state.secureTunnel.phase === "error" ||
        state.secureTunnel.phase === "unavailable",
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not start Secure MCP Tunnel.",
      true,
    );
  }
}

async function stopSecureTunnel(): Promise<void> {
  try {
    const state = await window.sovereign.stopSecureTunnel();
    renderState(state);
    showToast("Secure MCP Tunnel stopped.");
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not stop Secure MCP Tunnel.",
      true,
    );
  }
}

async function refreshSecureTunnel(): Promise<void> {
  try {
    const state = await window.sovereign.refreshSecureTunnel();
    renderState(state);
    showToast(
      `Secure MCP Tunnel · ${secureTunnelPhaseLabels[state.secureTunnel.phase]}.`,
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not refresh Secure MCP Tunnel.",
      true,
    );
  }
}

async function clearSecureTunnelKey(): Promise<void> {
  try {
    const tunnelId = currentState?.secureTunnel.tunnelId ?? null;
    const state = await window.sovereign.configureSecureTunnel({
      tunnelId,
      clearRuntimeApiKey: true,
    });
    requiredElement<HTMLInputElement>("#secure-tunnel-api-key").value = "";
    renderState(state);
    showToast(
      "Tunnel runtime API key forgotten from Windows-protected storage and memory.",
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not clear the tunnel runtime key.",
      true,
    );
  }
}

function configuredTunnelIdDraft(): string | null {
  const tunnelIdDraft =
    requiredElement<HTMLInputElement>("#secure-tunnel-id").value.trim();
  if (tunnelIdDraft.length === 0) {
    return currentState?.secureTunnel.tunnelId ?? null;
  }
  return /^tunnel_[a-f0-9]{32}$/u.test(tunnelIdDraft) ? tunnelIdDraft : null;
}

async function saveSecureTunnelProxy(): Promise<void> {
  const input = requiredElement<HTMLInputElement>("#secure-tunnel-proxy");
  const value = input.value.trim();
  if (value.length === 0) {
    showToast(
      "Enter an HTTP or HTTPS control-plane proxy URL before saving.",
      true,
    );
    return;
  }
  const tunnelId = configuredTunnelIdDraft();
  if (tunnelId === null) {
    showToast("Fix the Tunnel ID before saving the control-plane proxy.", true);
    return;
  }
  try {
    const state = await window.sovereign.configureSecureTunnel({
      tunnelId,
      controlPlaneProxyUrl: value,
    });
    input.value = "";
    renderState(state);
    showToast(
      state.secureTunnel.controlPlaneProxyStorage === "windows-protected"
        ? "Control-plane proxy saved with Windows protection."
        : "Control-plane proxy is available for this session only.",
      state.secureTunnel.controlPlaneProxyStorage === "memory-only",
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not save the control-plane proxy.",
      true,
    );
  }
}

async function clearSecureTunnelProxy(): Promise<void> {
  const tunnelId = currentState?.secureTunnel.tunnelId ?? null;
  try {
    const state = await window.sovereign.configureSecureTunnel({
      tunnelId,
      clearControlPlaneProxy: true,
    });
    requiredElement<HTMLInputElement>("#secure-tunnel-proxy").value = "";
    renderState(state);
    showToast(
      "Control-plane proxy forgotten from Windows-protected storage and memory.",
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not clear the control-plane proxy.",
      true,
    );
  }
}

async function saveSecureTunnelBackupProxy(): Promise<void> {
  const input = requiredElement<HTMLInputElement>(
    "#secure-tunnel-backup-proxy",
  );
  const value = input.value.trim();
  if (value.length === 0) {
    showToast("Enter an HTTP or HTTPS backup proxy URL before saving.", true);
    return;
  }
  const tunnelId = configuredTunnelIdDraft();
  if (tunnelId === null) {
    showToast("Fix the Tunnel ID before saving the backup proxy.", true);
    return;
  }
  const primaryDraft = requiredElement<HTMLInputElement>(
    "#secure-tunnel-proxy",
  ).value.trim();
  if (
    primaryDraft.length === 0 &&
    currentState?.secureTunnel.controlPlaneProxyConfigured !== true
  ) {
    showToast(
      "Save the primary control-plane proxy before adding a backup.",
      true,
    );
    return;
  }
  try {
    const state = await window.sovereign.configureSecureTunnel({
      tunnelId,
      ...(primaryDraft.length === 0
        ? {}
        : { controlPlaneProxyUrl: primaryDraft }),
      controlPlaneBackupProxyUrl: value,
    });
    input.value = "";
    if (primaryDraft.length > 0) {
      requiredElement<HTMLInputElement>("#secure-tunnel-proxy").value = "";
    }
    renderState(state);
    showToast(
      state.secureTunnel.controlPlaneBackupProxyStorage === "windows-protected"
        ? "Backup control-plane proxy saved with Windows protection."
        : "Backup control-plane proxy is available for this session only.",
      state.secureTunnel.controlPlaneBackupProxyStorage === "memory-only",
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not save the backup proxy.",
      true,
    );
  }
}

async function clearSecureTunnelBackupProxy(): Promise<void> {
  const tunnelId = currentState?.secureTunnel.tunnelId ?? null;
  try {
    const state = await window.sovereign.configureSecureTunnel({
      tunnelId,
      clearControlPlaneBackupProxy: true,
    });
    requiredElement<HTMLInputElement>("#secure-tunnel-backup-proxy").value = "";
    renderState(state);
    showToast(
      "Backup control-plane proxy forgotten from Windows-protected storage and memory.",
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not clear the backup proxy.",
      true,
    );
  }
}

async function updateSecureTunnelDirectFallback(
  enabled: boolean,
): Promise<void> {
  const toggle = requiredElement<HTMLInputElement>(
    "#secure-tunnel-direct-fallback",
  );
  toggle.disabled = true;
  const tunnelId = configuredTunnelIdDraft();
  if (tunnelId === null) {
    if (currentState !== null) {
      renderState(currentState);
    }
    showToast("Fix the Tunnel ID before changing direct fallback.", true);
    return;
  }
  const primaryDraft = requiredElement<HTMLInputElement>(
    "#secure-tunnel-proxy",
  ).value.trim();
  if (
    enabled &&
    primaryDraft.length === 0 &&
    currentState?.secureTunnel.controlPlaneProxyConfigured !== true
  ) {
    if (currentState !== null) {
      renderState(currentState);
    }
    showToast("Direct fallback requires a configured primary proxy.", true);
    return;
  }
  try {
    const state = await window.sovereign.configureSecureTunnel({
      tunnelId,
      ...(primaryDraft.length === 0
        ? {}
        : { controlPlaneProxyUrl: primaryDraft }),
      controlPlaneDirectFallbackEnabled: enabled,
    });
    if (primaryDraft.length > 0) {
      requiredElement<HTMLInputElement>("#secure-tunnel-proxy").value = "";
    }
    renderState(state);
    showToast(
      enabled ? "Direct fallback enabled." : "Direct fallback disabled.",
    );
  } catch (error) {
    if (currentState !== null) {
      renderState(currentState);
    }
    showToast(
      error instanceof Error
        ? error.message
        : "Could not update direct fallback.",
      true,
    );
  }
}

async function updatePermissionProfile(
  profile: DesktopPermissionProfile,
): Promise<void> {
  try {
    const state = await window.sovereign.setPermissionProfile(profile);
    renderState(state);
    const applied = state.permissionProfile === profile;
    showToast(
      applied
        ? `${permissionProfileLabels[profile]} enabled for connected ChatGPT sessions.`
        : "Permission change cancelled.",
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Could not update ChatGPT permission.",
      true,
    );
  }
}

function activateView(view: ViewId): void {
  if (
    uiSettings.experienceMode === "simple" &&
    (view === "terminal" ||
      view === "python" ||
      view === "browser" ||
      view === "computer" ||
      view === "workflows")
  ) {
    view = "overview";
  }
  currentView = view;
  requiredElement<HTMLElement>(".content-scroll").scrollTop = 0;
  try {
    window.localStorage.setItem(LAST_VIEW_KEY, view);
  } catch {
    // Last-view persistence is best-effort.
  }
  for (const item of document.querySelectorAll<HTMLButtonElement>(
    ".navigation-item",
  )) {
    const active = item.dataset.view === view;
    item.classList.toggle("is-active", active);
    if (active) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  }
  for (const section of document.querySelectorAll<HTMLElement>(".view")) {
    section.classList.toggle("is-active", section.dataset.viewPanel === view);
  }

  const definition = getViewDefinition(view);
  requiredElement<HTMLElement>("#view-title").textContent = definition.title;
  requiredElement<HTMLElement>("#view-description").textContent =
    definition.description;
  const executeSection = requiredElement<HTMLElement>(
    ".navigation-execute-section",
  );
  executeSection.classList.toggle(
    "has-active-child",
    definition.navigationSection === "execute",
  );
  if (definition.navigationSection === "execute") {
    executeSection.classList.remove("is-collapsed");
    requiredElement<HTMLButtonElement>("#execute-group-toggle").setAttribute(
      "aria-expanded",
      "true",
    );
  }
  if (view === "python") {
    void pythonController.activate();
  } else if (view === "workflows") {
    void workflowController.activate();
  }
  if (
    "refreshOnActivate" in definition &&
    definition.refreshOnActivate === true
  ) {
    void refreshAll();
  }
}

function setSettingsTab(
  tab: SettingsTab,
  focus = false,
  refreshData = true,
): void {
  try {
    window.localStorage.setItem(LAST_SETTINGS_TAB_KEY, tab);
  } catch {
    // Navigation persistence is best-effort.
  }
  let activeButton: HTMLButtonElement | null = null;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-settings-tab]",
  )) {
    const active = button.dataset.settingsTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
    if (active) {
      activeButton = button;
    }
  }
  for (const pane of document.querySelectorAll<HTMLElement>(
    "[data-settings-pane]",
  )) {
    const active = pane.dataset.settingsPane === tab;
    pane.classList.toggle("is-active", active);
    pane.hidden = !active;
  }
  if (focus) {
    activeButton?.focus();
  }
  if (!refreshData) {
    return;
  }
  if (tab === "host") {
    void refreshHostStartupState();
  } else if (tab === "diagnostics") {
    void Promise.all([
      refreshResourceSnapshot(),
      refreshHostStartupState(),
      refreshRendererUpdateStatus(),
      refreshRuntimeCandidateUpdateStatus(),
      refreshRuntimeRollingStatus(),
    ]);
  }
}

function setRunsTab(tab: "runs" | "audit", focus = false): void {
  try {
    window.localStorage.setItem(LAST_RUNS_TAB_KEY, tab);
  } catch {
    // Navigation persistence is best-effort.
  }
  let activeButton: HTMLButtonElement | null = null;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '#view-runs [role="tab"][data-runs-tab]',
  )) {
    const active = button.dataset.runsTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
    if (active) {
      activeButton = button;
    }
  }
  for (const pane of document.querySelectorAll<HTMLElement>(
    "[data-runs-pane]",
  )) {
    const active = pane.dataset.runsPane === tab;
    pane.classList.toggle("is-active", active);
    pane.hidden = !active;
  }
  if (focus) {
    activeButton?.focus();
  }
}

function setRunOutputTab(tab: "stdout" | "stderr", focus = false): void {
  try {
    window.localStorage.setItem(LAST_RUN_OUTPUT_TAB_KEY, tab);
  } catch {
    // Navigation persistence is best-effort.
  }
  let activeButton: HTMLButtonElement | null = null;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-run-output-tab]",
  )) {
    const active = button.dataset.runOutputTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
    if (active) {
      activeButton = button;
    }
  }
  for (const pane of document.querySelectorAll<HTMLElement>(
    "[data-run-output-pane]",
  )) {
    const active = pane.dataset.runOutputPane === tab;
    pane.classList.toggle("is-active", active);
    pane.hidden = !active;
  }
  if (focus) {
    activeButton?.focus();
  }
}

function handleTablistKeydown(
  event: KeyboardEvent,
  activate: (button: HTMLButtonElement) => void,
): void {
  const origin = event.target;
  const target =
    origin instanceof Element
      ? origin.closest<HTMLButtonElement>('[role="tab"]')
      : null;
  if (target === null) {
    return;
  }
  const currentTarget = event.currentTarget;
  const tablist =
    currentTarget instanceof HTMLElement &&
    currentTarget.getAttribute("role") === "tablist"
      ? currentTarget
      : target.closest<HTMLElement>('[role="tablist"]');
  if (tablist === null) {
    return;
  }
  const buttons = Array.from(
    tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).filter(
    (button) =>
      !button.disabled && window.getComputedStyle(button).display !== "none",
  );
  const index = buttons.indexOf(target);
  if (index < 0 || buttons.length === 0) {
    return;
  }

  let nextIndex: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (index + 1) % buttons.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (index - 1 + buttons.length) % buttons.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = buttons.length - 1;
  }
  if (nextIndex === null) {
    return;
  }

  event.preventDefault();
  const nextButton = buttons[nextIndex];
  if (nextButton !== undefined) {
    activate(nextButton);
  }
}

for (const item of document.querySelectorAll<HTMLButtonElement>(
  ".navigation-item",
)) {
  item.addEventListener("click", () => {
    const requestedView = item.dataset.view;
    activateView(isViewId(requestedView) ? requestedView : DEFAULT_VIEW_ID);
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-open-view]",
)) {
  button.addEventListener("click", () => {
    const requestedView = button.dataset.openView;
    if (isViewId(requestedView)) {
      activateView(requestedView);
      if (requestedView === "tasks" && button.dataset.taskId !== undefined) {
        void tasksController.openTask(button.dataset.taskId);
      } else if (
        requestedView === "runs" &&
        button.dataset.runId !== undefined
      ) {
        setRunsTab("runs");
        runsController.openRun(button.dataset.runId);
      } else if (
        requestedView === "runs" &&
        button.dataset.runsTab === "audit"
      ) {
        setRunsTab("audit");
      }
    }
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-open-settings-tab]",
)) {
  button.addEventListener("click", () => {
    const tab = button.dataset.openSettingsTab;
    if (
      tab === "appearance" ||
      tab === "host" ||
      tab === "security" ||
      tab === "diagnostics"
    ) {
      activateView("settings");
      setSettingsTab(tab);
    }
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-status-view]",
)) {
  button.addEventListener("click", () => {
    const requestedView = button.dataset.statusView;
    if (isViewId(requestedView)) {
      activateView(requestedView);
      if (requestedView === "tasks" && button.dataset.taskId !== undefined) {
        void tasksController.openTask(button.dataset.taskId);
      }
    }
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-status-settings]",
)) {
  button.addEventListener("click", () => {
    if (button.id === "status-workspace-action" && currentState?.activeDesktopWorkspace) {
      activateView("tasks");
      tasksController.showProjects();
      void tasksController.selectProject(currentState.activeDesktopWorkspace.projectId);
      return;
    }
    const tab = button.dataset.statusSettings;
    if (
      tab === "appearance" ||
      tab === "host" ||
      tab === "security" ||
      tab === "diagnostics"
    ) {
      activateView("settings");
      setSettingsTab(tab);
    }
  });
}

requiredElement<HTMLButtonElement>("#execute-group-toggle").addEventListener(
  "click",
  () => {
    const section = requiredElement<HTMLElement>(".navigation-execute-section");
    const collapsed = !section.classList.contains("is-collapsed");
    section.classList.toggle("is-collapsed", collapsed);
    requiredElement<HTMLButtonElement>("#execute-group-toggle").setAttribute(
      "aria-expanded",
      collapsed ? "false" : "true",
    );
  },
);

const activateSettingsButton = (candidate: HTMLButtonElement): void => {
  const tab = candidate.dataset.settingsTab;
  if (
    tab === "appearance" ||
    tab === "host" ||
    tab === "security" ||
    tab === "diagnostics"
  ) {
    setSettingsTab(tab, true);
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-settings-tab]",
)) {
  button.addEventListener("click", () => activateSettingsButton(button));
}
const activateRunsButton = (candidate: HTMLButtonElement): void => {
  const tab = candidate.dataset.runsTab;
  if (tab === "runs" || tab === "audit") {
    setRunsTab(tab, true);
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>(
  '#view-runs [role="tab"][data-runs-tab]',
)) {
  button.addEventListener("click", () => activateRunsButton(button));
}

const activateOutputButton = (candidate: HTMLButtonElement): void => {
  const tab = candidate.dataset.runOutputTab;
  if (tab === "stdout" || tab === "stderr") {
    setRunOutputTab(tab, true);
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-run-output-tab]",
)) {
  button.addEventListener("click", () => activateOutputButton(button));
}

document.addEventListener(
  "keydown",
  (event) => {
    const origin = event.target;
    const button =
      origin instanceof Element
        ? origin.closest<HTMLButtonElement>('[role="tab"]')
        : null;
    if (button === null) {
      return;
    }
    if (button.dataset.settingsTab !== undefined) {
      handleTablistKeydown(event, activateSettingsButton);
    } else if (button.dataset.runsTab !== undefined) {
      handleTablistKeydown(event, activateRunsButton);
    } else if (button.dataset.runOutputTab !== undefined) {
      handleTablistKeydown(event, activateOutputButton);
    }
  },
  { capture: true },
);
requiredElement<HTMLInputElement>("#capability-search").addEventListener(
  "input",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) {
      capabilitySearchQuery = target.value;
      renderCapabilities(latestCapabilities);
    }
  },
);
requiredElement<HTMLSelectElement>("#capability-level-filter").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      const value = target.value;
      capabilityLevelFilter =
        value === "observe" ||
        value === "workspace" ||
        value === "consequential"
          ? value
          : "all";
      renderCapabilities(latestCapabilities);
    }
  },
);
requiredElement<HTMLInputElement>("#audit-search").addEventListener(
  "input",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) {
      auditSearchQuery = target.value;
      renderAudit(latestAuditReceipts);
    }
  },
);
requiredElement<HTMLSelectElement>("#audit-outcome-filter").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      auditOutcomeFilter = target.value;
      renderAudit(latestAuditReceipts);
    }
  },
);

requiredElement<HTMLButtonElement>("#sidebar-toggle").addEventListener(
  "click",
  () => {
    setSidebarCollapsed(!uiSettings.sidebarCollapsed);
  },
);
requiredElement<HTMLInputElement>(
  "#sidebar-collapsed-setting",
).addEventListener("change", (event) => {
  const target = event.currentTarget;
  if (target instanceof HTMLInputElement) {
    setSidebarCollapsed(target.checked);
  }
});
requiredElement<HTMLSelectElement>("#ui-language").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      const language: UiLanguage = target.value === "en" ? "en" : "zh-CN";
      uiSettings = { ...uiSettings, language };
      persistUiSettings();
      applyLanguage(language);
    }
  },
);
requiredElement<HTMLSelectElement>("#ui-experience-mode").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      const experienceMode: UiExperienceMode =
        target.value === "full" ? "full" : "simple";
      uiSettings = { ...uiSettings, experienceMode };
      persistUiSettings();
      applyExperienceMode(experienceMode);
      showToast(
        experienceMode === "simple"
          ? "Simple mode enabled. Advanced execution and diagnostics are hidden."
          : "Full mode enabled.",
      );
    }
  },
);
requiredElement<HTMLSelectElement>("#ui-startup-view").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      const startupView: UiStartupView =
        target.value === "tasks" ||
        target.value === "agent" ||
        target.value === "runs" ||
        target.value === "last"
          ? target.value
          : "overview";
      uiSettings = { ...uiSettings, startupView };
      persistUiSettings();
    }
  },
);
requiredElement<HTMLSelectElement>("#ui-refresh-interval").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      const value = Number(target.value);
      if (
        value === 1000 ||
        value === 3000 ||
        value === 5000 ||
        value === 10000
      ) {
        uiSettings = { ...uiSettings, refreshIntervalMs: value };
        persistUiSettings();
        schedulePolling();
      }
    }
  },
);
requiredElement<HTMLSelectElement>("#ui-scale").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      const value = Number(target.value);
      if (value === 1 || value === 1.1 || value === 1.25 || value === 1.5) {
        uiSettings = { ...uiSettings, uiScale: value };
        persistUiSettings();
        applyUiScale(value);
      }
    }
  },
);
requiredElement<HTMLSelectElement>("#ui-font-scale").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      const value = Number(target.value);
      if (value === 1 || value === 1.1 || value === 1.2 || value === 1.3) {
        uiSettings = { ...uiSettings, fontScale: value };
        persistUiSettings();
        applyFontScale(value);
      }
    }
  },
);
requiredElement<HTMLInputElement>("#ui-reduced-motion").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) {
      uiSettings = { ...uiSettings, reducedMotion: target.checked };
      persistUiSettings();
      applyReducedMotion(target.checked);
    }
  },
);
requiredElement<HTMLButtonElement>(
  "#reset-interface-settings",
).addEventListener("click", resetInterfaceSettings);
requiredElement<HTMLButtonElement>("#resources-refresh").addEventListener(
  "click",
  () => {
    void refreshResourceSnapshot();
  },
);
requiredElement<HTMLButtonElement>("#renderer-update-refresh").addEventListener(
  "click",
  () => {
    void refreshRendererUpdateStatus();
  },
);
requiredElement<HTMLButtonElement>(
  "#runtime-candidate-refresh",
).addEventListener("click", () => {
  void refreshRuntimeCandidateUpdateStatus();
});
requiredElement<HTMLSelectElement>(
  "#runtime-candidate-release",
).addEventListener("change", () => {
  if (currentRuntimeCandidateUpdateStatus !== null) {
    syncRuntimeCandidateActionState(currentRuntimeCandidateUpdateStatus);
  }
});
requiredElement<HTMLButtonElement>(
  "#runtime-candidate-install",
).addEventListener("click", () => {
  void installSelectedRuntimeCandidate();
});
requiredElement<HTMLButtonElement>(
  "#runtime-candidate-activate",
).addEventListener("click", () => {
  void activateSelectedRuntimeCandidate();
});
requiredElement<HTMLButtonElement>("#runtime-rolling-refresh").addEventListener(
  "click",
  () => {
    void refreshRuntimeRollingStatus();
  },
);
requiredElement<HTMLSelectElement>("#renderer-update-release").addEventListener(
  "change",
  () => {
    if (currentRendererUpdateStatus !== null) {
      syncRendererUpdateActionState(currentRendererUpdateStatus);
    }
  },
);
requiredElement<HTMLButtonElement>("#renderer-update-install").addEventListener(
  "click",
  () => {
    void installSelectedRendererUpdate();
  },
);
requiredElement<HTMLButtonElement>(
  "#renderer-update-preflight",
).addEventListener("click", () => {
  void preflightSelectedRendererUpdate();
});
requiredElement<HTMLButtonElement>(
  "#renderer-update-activate",
).addEventListener("click", () => {
  void activateSelectedRendererUpdate();
});
requiredElement<HTMLButtonElement>(
  "#renderer-update-rollback",
).addEventListener("click", () => {
  void rollbackRendererUpdate();
});

const chooseWorkspace = (): Promise<void> =>
  runStateAction(
    () => window.sovereign.chooseWorkspace(),
    "Workspace authorization updated.",
  );
requiredElement<HTMLButtonElement>("#choose-workspace").addEventListener(
  "click",
  () => void chooseWorkspace(),
);
requiredElement<HTMLButtonElement>("#setup-choose-workspace").addEventListener(
  "click",
  () => void chooseWorkspace(),
);
requiredElement<HTMLButtonElement>("#workspace-page-choose").addEventListener(
  "click",
  () => void chooseWorkspace(),
);
requiredElement<HTMLButtonElement>("#simple-overview-primary").addEventListener(
  "click",
  (event) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }
    const action = target.dataset.simpleOverviewAction as
      SimpleOverviewAction | undefined;
    if (action === "choose-workspace") {
      void chooseWorkspace();
    } else if (action === "start-runtime") {
      void runStateAction(
        () => window.sovereign.start(),
        "Local Gateway started.",
      );
    } else if (action === "enable-host") {
      void enableRemoteHostMode();
    } else if (action === "open-agent") {
      activateView("agent");
    } else if (action === "open-settings") {
      activateView("settings");
      setSettingsTab("host");
    }
  },
);
requiredElement<HTMLButtonElement>("#start-runtime").addEventListener(
  "click",
  () => {
    void runStateAction(
      () => window.sovereign.start(),
      "Local Gateway started.",
    );
  },
);
requiredElement<HTMLButtonElement>("#stop-runtime").addEventListener(
  "click",
  () => {
    void runStateAction(
      () => window.sovereign.stop(),
      "Local Gateway stopped.",
    );
  },
);
requiredElement<HTMLButtonElement>("#refresh-runtime").addEventListener(
  "click",
  () => void refreshAll(),
);
requiredElement<HTMLButtonElement>("#refresh-audit").addEventListener(
  "click",
  () => void refreshAll(),
);
requiredElement<HTMLButtonElement>("#copy-connection").addEventListener(
  "click",
  () => {
    void copyConnectionBundle();
  },
);
requiredElement<HTMLButtonElement>("#rotate-credentials").addEventListener(
  "click",
  () => {
    void rotateCredentials();
  },
);
requiredElement<HTMLButtonElement>("#remote-host-enable").addEventListener(
  "click",
  (event) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }
    if (target.dataset.remoteHostAction === "review") {
      activateView("agent");
      return;
    }
    if (target.dataset.remoteHostAction !== "ready") {
      void enableRemoteHostMode();
    }
  },
);
requiredElement<HTMLInputElement>("#host-launch-at-login").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) {
      void updateLaunchAtLogin(target.checked);
    }
  },
);
requiredElement<HTMLInputElement>("#auto-start-runtime").addEventListener(
  "change",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) {
      void updateAutoStart(target.checked);
    }
  },
);
requiredElement<HTMLInputElement>(
  "#unattended-workspace-access",
).addEventListener("change", (event) => {
  const target = event.currentTarget;
  if (target instanceof HTMLInputElement) {
    void updateUnattendedWorkspaceAccess(target.checked);
  }
});
for (const selector of [
  "#tunnel-auto-start",
  "#tunnel-auto-reconnect",
] as const) {
  requiredElement<HTMLInputElement>(selector).addEventListener("change", () => {
    void updateTunnelAutomation();
  });
}
requiredElement<HTMLButtonElement>("#web-copy-connection").addEventListener(
  "click",
  () => {
    void copyConnectionBundle();
  },
);
requiredElement<HTMLInputElement>("#secure-tunnel-id").addEventListener(
  "input",
  (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLInputElement) {
      secureTunnelIdDraft = target.value;
      secureTunnelIdDirty = true;
      updateTunnelStartAvailability();
    }
  },
);
requiredElement<HTMLButtonElement>("#secure-tunnel-choose").addEventListener(
  "click",
  () => {
    void chooseSecureTunnelExecutable();
  },
);
requiredElement<HTMLButtonElement>("#secure-tunnel-start").addEventListener(
  "click",
  () => {
    void startSecureTunnel();
  },
);
requiredElement<HTMLButtonElement>("#secure-tunnel-stop").addEventListener(
  "click",
  () => {
    void stopSecureTunnel();
  },
);
for (const selector of [
  "#secure-tunnel-refresh",
  "#secure-tunnel-retry",
] as const) {
  requiredElement<HTMLButtonElement>(selector).addEventListener("click", () => {
    void refreshSecureTunnel();
  });
}
requiredElement<HTMLButtonElement>("#secure-tunnel-clear-key").addEventListener(
  "click",
  () => {
    void clearSecureTunnelKey();
  },
);
requiredElement<HTMLInputElement>("#secure-tunnel-api-key").addEventListener(
  "input",
  () => {
    updateTunnelStartAvailability();
  },
);
requiredElement<HTMLInputElement>("#secure-tunnel-api-key").addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void startSecureTunnel();
    }
  },
);
requiredElement<HTMLButtonElement>(
  "#secure-tunnel-save-proxy",
).addEventListener("click", () => {
  void saveSecureTunnelProxy();
});
requiredElement<HTMLButtonElement>(
  "#secure-tunnel-clear-proxy",
).addEventListener("click", () => {
  void clearSecureTunnelProxy();
});
requiredElement<HTMLInputElement>("#secure-tunnel-proxy").addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveSecureTunnelProxy();
    }
  },
);
requiredElement<HTMLButtonElement>(
  "#secure-tunnel-save-backup-proxy",
).addEventListener("click", () => {
  void saveSecureTunnelBackupProxy();
});
requiredElement<HTMLButtonElement>(
  "#secure-tunnel-clear-backup-proxy",
).addEventListener("click", () => {
  void clearSecureTunnelBackupProxy();
});
requiredElement<HTMLInputElement>(
  "#secure-tunnel-backup-proxy",
).addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveSecureTunnelBackupProxy();
  }
});
requiredElement<HTMLInputElement>(
  "#secure-tunnel-direct-fallback",
).addEventListener("change", (event) => {
  const target = event.currentTarget;
  if (target instanceof HTMLInputElement) {
    void updateSecureTunnelDirectFallback(target.checked);
  }
});
requiredElement<HTMLButtonElement>("#web-save-bridge").addEventListener(
  "click",
  () => {
    const value =
      requiredElement<HTMLInputElement>("#web-bridge-url").value.trim();
    void updateWebBridgeUrl(value.length === 0 ? null : value);
  },
);
requiredElement<HTMLButtonElement>("#web-clear-bridge").addEventListener(
  "click",
  () => {
    void updateWebBridgeUrl(null);
  },
);
requiredElement<HTMLInputElement>("#web-bridge-url").addEventListener(
  "keydown",
  (event) => {
    const target = event.currentTarget;
    if (event.key === "Enter" && target instanceof HTMLInputElement) {
      event.preventDefault();
      const value = target.value.trim();
      void updateWebBridgeUrl(value.length === 0 ? null : value);
    }
  },
);
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-permission-profile]",
)) {
  button.addEventListener("click", () => {
    const profile = button.dataset.permissionProfile;
    if (
      profile === "observe" ||
      profile === "workspace" ||
      profile === "consequential"
    ) {
      void updatePermissionProfile(profile);
    }
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-bypass-toggle]",
)) {
  button.addEventListener("click", () => {
    void updatePermissionProfile(
      currentState?.permissionProfile === "bypass"
        ? currentState.rememberedPermissionProfile
        : "bypass",
    );
  });
}

const unsubscribe = window.sovereign.onStateChanged((state) => {
  // State events already contain the fresh runtime snapshot. Rendering them directly avoids
  // event-driven full IPC sweeps, stale-response races and refresh storms.
  renderState(state);
});
document.addEventListener("visibilitychange", handleVisibilityChange);
window.addEventListener(
  "beforeunload",
  () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    stopLocalizationObserver?.();
    rendererUpdateSettlementPoller.dispose();
    fontScaleObserver?.disconnect();
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
    }
  },
  { once: true },
);

syncInterfaceSettings();
const storedSettingsTab = readStoredChoice<SettingsTab>(
  LAST_SETTINGS_TAB_KEY,
  ["appearance", "host", "security", "diagnostics"],
  "appearance",
);
setSettingsTab(
  uiSettings.experienceMode === "simple" && storedSettingsTab === "diagnostics"
    ? "appearance"
    : storedSettingsTab,
  false,
  false,
);
setRunsTab(
  readStoredChoice(LAST_RUNS_TAB_KEY, ["runs", "audit"] as const, "runs"),
);
setRunOutputTab(
  readStoredChoice(
    LAST_RUN_OUTPUT_TAB_KEY,
    ["stdout", "stderr"] as const,
    "stdout",
  ),
);
stopLocalizationObserver = observeLocalization(
  appRoot,
  () => uiSettings.language,
);
applyFontScale(uiSettings.fontScale);
startFontScaleObserver();
if (uiSettings.uiScale !== DEFAULT_UI_SETTINGS.uiScale) {
  window.addEventListener(
    "load",
    () => {
      window.setTimeout(() => applyUiScale(uiSettings.uiScale), 0);
    },
    { once: true },
  );
}
const startupView = resolveStartupView();
activateView(startupView);
if (
  startupView === "settings" &&
  rendererHandoff?.settingsTab !== null &&
  rendererHandoff?.settingsTab !== undefined
) {
  setSettingsTab(rendererHandoff.settingsTab);
}
if (rendererHandoff !== null && rendererHandoff.scrollTop > 0) {
  window.requestAnimationFrame(() => {
    requiredElement<HTMLElement>(".content-scroll").scrollTop =
      rendererHandoff.scrollTop;
  });
}
void refreshAll();
schedulePolling();
