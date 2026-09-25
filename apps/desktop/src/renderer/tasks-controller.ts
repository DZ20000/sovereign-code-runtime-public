import "./task-board.css";
import "./task-coordination-inbox.css";

import type {
  DesktopTaskCategory,
  DesktopTaskDetail,
  DesktopTaskListItem,
  DesktopTaskMessage,
  DesktopTaskProjectStatus,
  DesktopTaskProjectSummary,
  DesktopTaskStatus,
  DesktopTaskSummary,
  DesktopTaskWorkspaceSnapshot,
  SovereignDesktopApi,
} from "../shared.js";
import {
  readTaskHubSessionState,
  writeTaskHubSessionState,
  type TaskHubCategoryFilter,
  type TaskHubLaneFilter,
} from "./task-hub-session.js";
import {
  compareTaskBoardTasks,
  taskBoardAgentPresence,
  taskBoardLane,
  taskBoardState,
  taskBoardStateDetail,
  taskBoardStateLabel,
  taskBoardCounts,
  taskHasLiveAgent,
  taskMatchesBoardLane,
  taskCoordinationPendingLabel,
  taskWaitingMessageLabel,
  type TaskBoardCounts,
  type TaskBoardLane,
} from "./task-board-model.js";
import { BOARD_LANE_CONTENT } from "./task-board-content.js";
import { TaskCardNavigation } from "./task-card-navigation.js";
import { TaskFilterControls } from "./task-filter-controls.js";
import { TASK_BOARD_LANES, TaskLaneControls } from "./task-lane-controls.js";
import { TaskListScrollAnchor } from "./task-list-scroll-anchor.js";
import {
  assertTaskDetailIntegrity,
  isTaskDetailIntegrityError,
} from "./task-detail-integrity.js";
import { bindTaskDetailKeyboardNavigation } from "./task-detail-navigation.js";
import { setTaskDetailLoading } from "./task-detail-loading.js";
import {
  isTaskMessageSubmitShortcut,
  TaskMessageSendFeedback,
  taskMessageContent,
} from "./task-message-composer.js";
import { reconcileTaskMessageList } from "./task-message-list.js";
import { renderTaskConversationDelivery } from "./task-conversation-delivery.js";
import { TaskMessageHistory } from "./task-message-history.js";
import { TaskCoordinationInboxController } from "./task-coordination-controller.js";
import {
  taskDetailFailureDisposition,
  taskRefreshFailureDisposition,
  type TaskRefreshOrigin,
} from "./task-refresh-failure-policy.js";
import { TaskRefreshFeedback } from "./task-refresh-feedback.js";
import {
  taskProgressIsIndeterminate,
  taskProgressLabel,
  taskProgressNote,
  taskProgressPercent,
  taskProgressValue,
} from "./task-progress-model.js";
import { applyTaskProgressAccessibility } from "./task-progress-accessibility.js";
import { taskProjectAccessibilityIds } from "./task-project-accessibility.js";
import { taskProjectVisibleMetrics } from "./task-project-metrics.js";
import { compareTaskProjectFallback } from "./task-project-order.js";
import { renderTaskSessionContinuity } from "./task-session-continuity-view.js";
import { validateTaskStepList } from "./task-step-integrity.js";
import { reconcileTaskStepList } from "./task-step-list.js";
import { TaskWorkspaceSnapshotAssembler } from "./task-workspace-pagination.js";
import { taskWorkspaceLoadPresentation } from "./task-workspace-load-presentation.js";
import {
  filterTaskProjects,
  normalizeTaskProjectFilterSelection,
  renderTaskProjectFilter,
} from "./task-project-filter.js";
import { renderTaskProjectGroupManager } from "./task-project-groups.js";
import { mountTaskWorkbenchLayout, setTaskWorkbenchSelection } from "./task-workbench-layout.js";

interface TasksControllerOptions {
  readonly api: SovereignDesktopApi;
  readonly notify: (message: string, isError?: boolean) => void;
  readonly onSnapshotChanged?: (snapshot: DesktopTaskWorkspaceSnapshot) => void;
  readonly onProjectSelected?: (projectId: string | null) => Promise<void> | void;
}

type LaneFilter = TaskHubLaneFilter;
type CategoryFilter = TaskHubCategoryFilter;

const ACTIVE_STATUSES = new Set<DesktopTaskStatus>([
  "queued",
  "planning",
  "running",
]);

function taskHubSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const STATUS_LABELS: Readonly<Record<DesktopTaskStatus, string>> = {
  queued: "Queued",
  planning: "Planning",
  running: "Running",
  "waiting-user": "Waiting for you",
  blocked: "Blocked",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const CATEGORY_LABELS: Readonly<Record<DesktopTaskCategory, string>> = {
  development: "Development",
  testing: "Testing",
  build: "Build and release",
  research: "Research",
  maintenance: "Maintenance",
  automation: "Automation",
  other: "Other",
};

const SOURCE_LABELS = {
  agent: "Agent registered",
  inferred: "Inferred from activity",
  user: "Created by you",
} as const;

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required task UI element is missing: ${selector}`);
  }
  return element;
}

function preserveSourceText<T extends HTMLElement>(element: T): T {
  element.setAttribute("data-no-i18n", "");
  return element;
}

function setTextContent(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function setClassName(element: HTMLElement, value: string): void {
  if (element.className !== value) element.className = value;
}

function stableSignature(value: unknown): string {
  return JSON.stringify(value);
}

function timestamp(value: string | null, includeSeconds = true): string {
  if (value === null) return "None";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(
    document.documentElement.lang === "zh-CN" ? "zh-CN" : "en-US",
    {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(includeSeconds ? { second: "2-digit" as const } : {}),
    },
  ).format(date);
}

function elapsedLabel(value: string | null): string {
  if (value === null) return "Never";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1_000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

type PresenceTask =
  | Pick<DesktopTaskListItem, "source" | "status" | "agent">
  | Pick<DesktopTaskSummary, "source" | "status" | "agent">;

const AGENT_PRESENCE_LABELS = {
  online: "online",
  stale: "heartbeat stale",
  offline: "offline",
  unknown: "not checked in",
} as const;

function isInferredTask(task: Pick<PresenceTask, "source">): boolean {
  return task.source === "inferred";
}

function taskConnectionLabel(task: PresenceTask): string {
  if (isInferredTask(task)) {
    return ACTIVE_STATUSES.has(task.status)
      ? "Activity detected · no task Agent"
      : "Unbound automatic activity";
  }
  if (task.agent.id === null) return "No Agent assigned";
  return `${task.agent.name ?? "Agent"} · ${AGENT_PRESENCE_LABELS[taskBoardAgentPresence(task)]}`;
}

function taskPresenceLabel(task: PresenceTask): string {
  if (isInferredTask(task)) {
    return ACTIVE_STATUSES.has(task.status)
      ? "Activity detected"
      : "Unbound activity";
  }
  if (task.agent.id === null) return "Agent unassigned";
  const presence = taskBoardAgentPresence(task);
  if (presence === "online") return "Agent online";
  if (presence === "stale") return "Agent heartbeat stale";
  if (presence === "offline") return "Agent offline";
  return "No Agent heartbeat yet";
}

function taskAgentDetail(task: PresenceTask): string {
  if (isInferredTask(task)) return "Unassigned · inferred from tool activity";
  return task.agent.name ?? "Unassigned";
}

function listTaskCurrentWork(task: DesktopTaskListItem): string {
  if (task.currentStep.length > 0) return task.currentStep;
  if (task.lastActivityLabel !== null) return task.lastActivityLabel;
  if (task.summaryPreview.length > 0) return task.summaryPreview;
  if (task.source === "inferred" && ACTIVE_STATUSES.has(task.status)) {
    return "Activity detected from tool calls";
  }
  return "No current step reported.";
}

function detailTaskCurrentWork(task: DesktopTaskSummary): string {
  if (task.currentStep.length > 0) return task.currentStep;
  if (task.lastActivityLabel !== null) return task.lastActivityLabel;
  if (task.source === "inferred" && ACTIVE_STATUSES.has(task.status)) {
    return "Activity detected from tool calls";
  }
  return "No current step";
}

function messageAuthor(message: DesktopTaskMessage): string {
  if (message.role === "user") return "You";
  if (message.role === "system") return "Sovereign";
  return message.agentName ?? "Agent";
}

function userMessageDeliveryLabel(
  message: DesktopTaskMessage,
  task: DesktopTaskSummary,
): {
  readonly label: string;
  readonly tone: "acknowledged" | "pending" | "stored";
  readonly title: string;
} {
  if (message.acknowledgedAt !== null) {
    return {
      label: "Agent received",
      tone: "acknowledged",
      title: `Agent acknowledged this message at ${timestamp(message.acknowledgedAt)}.`,
    };
  }
  if (isInferredTask(task) || task.agent.id === null) {
    return {
      label: "Stored locally",
      tone: "stored",
      title: "This task has no Agent owner yet.",
    };
  }
  return {
    label: "Waiting for Agent",
    tone: "pending",
    title:
      "Sovereign will surface this message with the Agent's next tool result and through Tasks Inbox.",
  };
}

export class TasksController {
  readonly #api: SovereignDesktopApi;
  readonly #notify: TasksControllerOptions["notify"];
  readonly #onSnapshotChanged: TasksControllerOptions["onSnapshotChanged"];
  readonly #onProjectSelected: TasksControllerOptions["onProjectSelected"];
  #snapshot: DesktopTaskWorkspaceSnapshot | null = null;
  #workspaceLoadError: string | null = null;
  #selectedProjectFilterId: string | null = null;
  #selectedTaskId: string | null = null;
  #lastOpenedTaskId: string | null = null;
  #pendingListFocusTaskId: string | null = null;
  #selectedTaskIsInferred = false;
  #searchQuery = "";
  #laneFilter: LaneFilter = "current";
  #categoryFilter: CategoryFilter = "all";
  #refreshInFlight: Promise<void> | null = null;
  #refreshFeedback: TaskRefreshFeedback | null = null;
  #filterControls: TaskFilterControls | null = null;
  #cardNavigation: TaskCardNavigation | null = null;
  #laneControls: TaskLaneControls | null = null;
  #listScrollAnchor: TaskListScrollAnchor | null = null;
  #messageSendFeedback: TaskMessageSendFeedback | null = null;
  #manualRefreshRequested = false;
  #messageSending = false;
  #detailRequestGeneration = 0;
  #projectsRenderSignature = "";
  #renderedDetailTaskId: string | null = null;
  #renderedStepsSignature = "";
  #renderedMessagesSignature = "";
  #restoreSelectedTaskOnRefresh = false;
  #lastRenderedDetail: DesktopTaskDetail | null = null;
  #coordinationInbox: TaskCoordinationInboxController | null = null;
  #messageHistory: TaskMessageHistory | null = null;
  readonly #sessionStorage: Storage | null;
  readonly #messageDrafts = new Map<string, string>();

  constructor(options: TasksControllerOptions) {
    this.#api = options.api;
    this.#notify = options.notify;
    this.#onSnapshotChanged = options.onSnapshotChanged;
    this.#onProjectSelected = options.onProjectSelected;
    this.#sessionStorage = taskHubSessionStorage();
    const session = readTaskHubSessionState(this.#sessionStorage);
    this.#selectedTaskId = session.selectedTaskId;
    this.#lastOpenedTaskId = session.selectedTaskId;
    this.#restoreSelectedTaskOnRefresh = session.selectedTaskId !== null;
    this.#searchQuery = session.searchQuery;
    this.#laneFilter = session.laneFilter;
    this.#categoryFilter = session.categoryFilter;
    for (const [taskId, draft] of Object.entries(session.messageDrafts)) {
      this.#messageDrafts.set(taskId, draft);
    }
  }

  #persistSessionState(): void {
    writeTaskHubSessionState(this.#sessionStorage, {
      selectedTaskId: this.#selectedTaskId,
      searchQuery: this.#searchQuery,
      laneFilter: this.#laneFilter,
      categoryFilter: this.#categoryFilter,
      messageDrafts: Object.fromEntries(this.#messageDrafts),
    });
  }
  get snapshot(): DesktopTaskWorkspaceSnapshot | null {
    return this.#snapshot;
  }
  get selectedTaskId(): string | null {
    return this.#selectedTaskId;
  }
  rerenderSelectedDetail(): void {
    if (
      this.#lastRenderedDetail !== null &&
      this.#lastRenderedDetail.task.id === this.#selectedTaskId &&
      !requiredElement<HTMLElement>("#task-detail-pane").hidden
    ) {
      this.#renderDetail(this.#lastRenderedDetail);
      this.#coordinationInbox?.rerender();
    }
  }
  mount(): void {
    mountTaskWorkbenchLayout();
    this.#messageHistory = new TaskMessageHistory(this.#api, {
      button: requiredElement<HTMLButtonElement>("#task-message-load-older"),
      status: requiredElement<HTMLElement>("#task-message-history-status"),
      render: (messages, task, truncated) => this.#renderMessages(messages, task, truncated),
    });
    this.#coordinationInbox = new TaskCoordinationInboxController(
      this.#api,
      {
        container: requiredElement<HTMLElement>("#task-coordination-list"),
        pendingCount: requiredElement<HTMLElement>("#task-coordination-count"),
        unreadCount: requiredElement<HTMLElement>(
          "#task-coordination-unread-count",
        ),
        snapshotStatus: requiredElement<HTMLElement>(
          "#task-coordination-snapshot-status",
        ),
        loadOlderButton: requiredElement<HTMLButtonElement>(
          "#task-coordination-load-older",
        ),
        loadOlderStatus: requiredElement<HTMLElement>(
          "#task-coordination-history-status",
        ),
      },
      timestamp,
      requiredElement<HTMLButtonElement>("#task-coordination-refresh"),
    );
    const refreshButton =
      requiredElement<HTMLButtonElement>("#task-hub-refresh");
    this.#refreshFeedback = new TaskRefreshFeedback({
      button: refreshButton,
      busyRegion: requiredElement<HTMLElement>("#task-hub-list-pane"),
      status: requiredElement<HTMLElement>("#task-hub-refresh-status"),
      syncStatus: requiredElement<HTMLElement>("#task-board-sync-state"),
    });
    refreshButton.addEventListener("click", () => {
      void this.refresh("manual").catch(() => undefined);
    });
    const searchInput = requiredElement<HTMLInputElement>("#task-hub-search");
    const categoryFilter = requiredElement<HTMLSelectElement>(
      "#task-hub-category-filter",
    );
    this.#filterControls = new TaskFilterControls({
      searchInput,
      categorySelect: categoryFilter,
      clearButton: requiredElement<HTMLButtonElement>(
        "#task-hub-clear-filters",
      ),
      initialState: {
        searchQuery: this.#searchQuery,
        category: this.#categoryFilter,
      },
      onChange: ({ searchQuery, category }) => {
        this.#searchQuery = searchQuery;
        this.#categoryFilter = category as CategoryFilter;
        this.#persistSessionState();
        this.#renderProjects();
      },
    });
    this.#filterControls.mount();
    this.#cardNavigation = new TaskCardNavigation({
      container: requiredElement<HTMLElement>("#task-project-grid"),
      fallbackFocus: searchInput,
    });
    this.#cardNavigation.mount();
    this.#listScrollAnchor = new TaskListScrollAnchor({
      container: requiredElement<HTMLElement>("#task-project-grid"),
      scroller: requiredElement<HTMLElement>("#task-project-grid"),
    });
    this.#laneControls = new TaskLaneControls({
      buttons: [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".task-board-lane[data-lane]",
        ),
      ],
      initialLane: this.#laneFilter,
      onChange: (lane) => {
        this.#laneFilter = lane;
        this.#persistSessionState();
        this.#projectsRenderSignature = "";
        if (lane === "all")
          requiredElement<HTMLElement>("#task-project-grid").scrollTop = 0;
        if (this.#selectedTaskId !== null) this.showProjects();
        else this.#renderProjects();
      },
    });
    this.#laneControls.mount();
    requiredElement<HTMLButtonElement>("#task-detail-back").addEventListener(
      "click",
      () => {
        this.showProjects();
      },
    );
    bindTaskDetailKeyboardNavigation(
      requiredElement<HTMLElement>("#task-detail-pane"),
      () => this.showProjects(),
    );
    const messageForm = requiredElement<HTMLFormElement>("#task-message-form");
    const messageInput = requiredElement<HTMLTextAreaElement>(
      "#task-message-input",
    );
    const messageButton =
      requiredElement<HTMLButtonElement>("#task-message-send");
    this.#messageSendFeedback = new TaskMessageSendFeedback({
      form: messageForm,
      input: messageInput,
      button: messageButton,
      status: requiredElement<HTMLElement>("#task-message-submit-status"),
      counter: requiredElement<HTMLElement>("#task-message-character-count"),
    });
    messageForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#sendMessage();
    });
    messageInput.addEventListener("input", () => {
      const taskId = this.#selectedTaskId;
      if (taskId === null) return;
      if (messageInput.value.length === 0) {
        this.#messageDrafts.delete(taskId);
      } else {
        this.#messageDrafts.set(taskId, messageInput.value);
      }
      this.#persistSessionState();
      this.#messageSendFeedback?.syncDraft();
    });
    messageInput.addEventListener("keydown", (event) => {
      if (!isTaskMessageSubmitShortcut(event)) return;
      event.preventDefault();
      void this.#sendMessage();
    });
  }
  async refresh(origin: TaskRefreshOrigin = "background"): Promise<void> {
    if (origin === "manual") {
      this.#manualRefreshRequested = true;
      this.#refreshFeedback?.begin();
    }
    if (this.#refreshInFlight !== null) return await this.#refreshInFlight;
    this.#refreshInFlight = (async () => {
      try {
        const previousRevision = this.#snapshot?.revision ?? null;
        if (this.#snapshot === null) {
          this.#workspaceLoadError = null;
          this.#renderProjects();
        }
        const nextSnapshot = await this.#readCompleteWorkspace();
        this.#snapshot = nextSnapshot;
        this.#workspaceLoadError = null;
        this.#refreshFeedback?.markAvailable();
        if (nextSnapshot.revision !== previousRevision) {
          this.#onSnapshotChanged?.(nextSnapshot);
        }

        const listPane = requiredElement<HTMLElement>("#task-hub-list-pane");
        if (!listPane.hidden) this.#renderProjects();

        if (this.#selectedTaskId !== null) {
          const exists = nextSnapshot.projects.some((project) =>
            project.tasks.some((task) => task.id === this.#selectedTaskId),
          );
          if (exists) {
            const restoreSelection = this.#restoreSelectedTaskOnRefresh;
            this.#restoreSelectedTaskOnRefresh = false;
            await this.#loadDetail(
              this.#selectedTaskId,
              restoreSelection,
              false,
              origin,
            );
          } else {
            this.#restoreSelectedTaskOnRefresh = false;
            this.showProjects();
          }
        }
        if (this.#manualRefreshRequested) {
          this.#refreshFeedback?.succeed(previousRevision, nextSnapshot);
        }
      } catch (error) {
        if (this.#selectedTaskId !== null && this.#lastRenderedDetail?.task.id === this.#selectedTaskId) {
          setTaskDetailLoading(document, "unavailable");
        }
        const hasSnapshot = this.#snapshot !== null;
        const message =
          error instanceof Error ? error.message : "Could not load tasks.";
        if (this.#snapshot === null) {
          this.#workspaceLoadError = message;
          this.#renderProjects();
        }
        if (this.#manualRefreshRequested) {
          this.#refreshFeedback?.manualFail(hasSnapshot);
        } else {
          this.#refreshFeedback?.backgroundFail(hasSnapshot);
        }
        const failure = taskRefreshFailureDisposition(
          origin,
          this.#manualRefreshRequested,
        );
        if (failure.notify) {
          this.#notify(message, true);
        }
        if (failure.propagate) throw error;
      }
    })().finally(() => {
      if (this.#manualRefreshRequested) {
        this.#manualRefreshRequested = false;
        this.#refreshFeedback?.end();
      }
      this.#refreshInFlight = null;
    });
    return await this.#refreshInFlight;
  }
  async #readCompleteWorkspace(): Promise<DesktopTaskWorkspaceSnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const assembler = new TaskWorkspaceSnapshotAssembler();
      let offset = 0;
      let retryRequested = false;
      for (let pageIndex = 0; pageIndex < 64; pageIndex += 1) {
        const result = assembler.addPage(
          await this.#api.getTaskWorkspace(offset, 64),
        );
        if (result.kind === "retry") {
          retryRequested = true;
          break;
        }
        if (result.kind === "complete") return result.snapshot;
        offset = result.nextOffset;
      }
      if (!retryRequested) {
        throw new Error(
          "Task workspace pagination exceeded its bounded page count.",
        );
      }
    }
    throw new Error(
      "Tasks changed repeatedly while the workspace snapshot was loading.",
    );
  }
  async openTask(taskId: string): Promise<void> {
    await this.#loadDetail(taskId, true);
  }

  showProjects(): void {
    this.#messageHistory?.select(null);
    this.#coordinationInbox?.clear();
    this.#storeCurrentDraft();
    this.#detailRequestGeneration += 1;
    const focusTaskId = this.#lastOpenedTaskId;
    this.#selectedTaskId = null;
    this.#restoreSelectedTaskOnRefresh = false;
    this.#selectedTaskIsInferred = false;
    this.#persistSessionState();
    this.#renderedDetailTaskId = null;
    this.#renderedStepsSignature = "";
    this.#renderedMessagesSignature = "";
    this.#detailRequestGeneration += 1;
    const detailPane = requiredElement<HTMLElement>("#task-detail-pane");
    setTaskDetailLoading(document, "ready");
    detailPane.hidden = true;
    requiredElement<HTMLElement>("#task-hub-list-pane").hidden = false;
    setTaskWorkbenchSelection(null);
    this.#projectsRenderSignature = "";
    this.#pendingListFocusTaskId = focusTaskId;
    this.#renderProjects();
  }

  #restoreListFocus(taskId = this.#pendingListFocusTaskId): void {
    if (
      taskId === null ||
      requiredElement<HTMLElement>("#task-hub-list-pane").hidden
    ) {
      return;
    }
    this.#pendingListFocusTaskId = null;
    this.#cardNavigation?.focus(taskId, true);
  }

  async selectProject(projectId: string | null): Promise<void> {
    this.#selectedProjectFilterId = normalizeTaskProjectFilterSelection(this.#snapshot?.projects ?? [], projectId);
    if (this.#selectedTaskId !== null && !filterTaskProjects(this.#snapshot?.projects ?? [], this.#selectedProjectFilterId).some((project) => project.tasks.some((task) => task.id === this.#selectedTaskId))) this.showProjects();
    this.#projectsRenderSignature = "";
    this.#renderProjects();
    await this.#onProjectSelected?.(this.#selectedProjectFilterId);
  }

  #renderProjectFilter(projects: readonly DesktopTaskProjectSummary[]) {
    renderTaskProjectGroupManager({
      container: requiredElement<HTMLElement>("#task-project-group-manager"),
      projects,
      onChange: () => {
        this.#projectsRenderSignature = "";
        this.#renderProjects();
      },
    });
    const section = requiredElement<HTMLElement>("#task-project-filter");
    const container = requiredElement<HTMLElement>("#task-project-filter-options");
    section.hidden = projects.length === 0;
    const previousSelection = this.#selectedProjectFilterId;
    this.#selectedProjectFilterId = normalizeTaskProjectFilterSelection(
      projects,
      this.#selectedProjectFilterId,
    );
    if (previousSelection !== this.#selectedProjectFilterId) this.#onProjectSelected?.(this.#selectedProjectFilterId);
    setTextContent(
      requiredElement<HTMLElement>("#task-project-filter-mode"),
      this.#selectedProjectFilterId === null
        ? "All projects"
        : "Single project",
    );
    if (section.hidden) {
      container.replaceChildren();
      return;
    }
    renderTaskProjectFilter({
      container,
      projects,
      selectedProjectId: this.#selectedProjectFilterId,
      onSelect: (projectId) => {
        if (projectId === this.#selectedProjectFilterId) return;
        void this.selectProject(projectId);
        requiredElement<HTMLElement>("#task-project-grid").scrollTop = 0;
      },
    });
  }
  #filteredProjects(): readonly DesktopTaskProjectSummary[] {
    if (this.#snapshot === null) return [];
    return filterTaskProjects(
      this.#snapshot.projects,
      this.#selectedProjectFilterId,
    )
      .map((project) => {
        const tasks = project.tasks
          .filter((task) => {
            const categoryMatches =
              this.#categoryFilter === "all" ||
              task.category === this.#categoryFilter;
            const haystack = [
              project.name,
              project.root,
              task.title,
              task.summaryPreview,
              task.currentStep,
              task.agent.name ?? "",
              task.lastActivityLabel ?? "",
              SOURCE_LABELS[task.source],
              taskConnectionLabel(task),
              taskBoardStateLabel(task),
            ]
              .join(" ")
              .toLowerCase();
            const searchMatches =
              this.#searchQuery.length === 0 ||
              haystack.includes(this.#searchQuery);
            return (
              categoryMatches &&
              searchMatches &&
              taskMatchesBoardLane(task, this.#laneFilter)
            );
          })
          .sort(compareTaskBoardTasks);
        const counts = taskBoardCounts(tasks);
        const onlineAgentCount = new Set(
          tasks.filter(taskHasLiveAgent).map((task) => task.agent.id),
        ).size;
        const allTerminal = tasks.every(
          (task) => task.status === "succeeded" || task.status === "cancelled",
        );
        const status: DesktopTaskProjectStatus =
          counts.attention > 0
            ? "attention"
            : counts.current > 0
              ? "active"
              : allTerminal
                ? "completed"
                : "idle";
        return {
          ...project,
          status,
          tasks,
          taskCount: tasks.length,
          activeTaskCount: counts.current,
          attentionTaskCount: counts.attention,
          onlineAgentCount,
        };
      })
      .filter((project) => project.tasks.length > 0)
      .sort((left, right) => {
        const leftTask = left.tasks[0];
        const rightTask = right.tasks[0];
        if (leftTask !== undefined && rightTask !== undefined) {
          const taskDifference = compareTaskBoardTasks(leftTask, rightTask);
          if (taskDifference !== 0) return taskDifference;
        }
        return compareTaskProjectFallback(left, right);
      });
  }

  #renderProjects(): void {
    const container = requiredElement<HTMLElement>("#task-project-grid");
    const summary = requiredElement<HTMLElement>("#task-hub-summary");
    const scrollAnchor =
      container.getClientRects().length > 0
        ? (this.#listScrollAnchor?.capture() ?? null)
        : null;
    const restoreScrollAnchor = (): void => {
      if (scrollAnchor !== null) this.#listScrollAnchor?.restore(scrollAnchor);
    };
    const focusedTaskId = this.#pendingListFocusTaskId ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.taskId ?? null
        : null);
    if (this.#snapshot === null) {
      this.#renderProjectFilter([]);
      this.#projectsRenderSignature = "";
      container.replaceChildren();
      const presentation = taskWorkspaceLoadPresentation(
        this.#workspaceLoadError,
      );
      const loading = presentation.kind === "loading";
      const unavailable = presentation.kind === "unavailable";
      setTextContent(summary, presentation.summary);
      this.#renderWorkspaceOverview([], 0, loading, unavailable);
      const empty = document.createElement("div");
      empty.className = "task-hub-empty";
      empty.setAttribute("role", presentation.liveRole);
      const title = document.createElement("strong");
      title.textContent = presentation.title;
      const detail = document.createElement("span");
      detail.textContent = presentation.detail;
      empty.append(title, detail);
      if (presentation.retry !== null) {
        const retry = document.createElement("span");
        retry.textContent = presentation.retry;
        empty.append(retry);
      }
      container.append(empty);
      restoreScrollAnchor();
      if (focusedTaskId !== null)
        setTimeout(() => this.#restoreListFocus(focusedTaskId), 0);
      return;
    }

    this.#renderProjectFilter(this.#snapshot.projects);
    container.dataset.projectScope = this.#selectedProjectFilterId === null ? "all" : "single";
    const allTasks = filterTaskProjects(
      this.#snapshot.projects,
      this.#selectedProjectFilterId,
    ).flatMap((project) => project.tasks);
    const counts = taskBoardCounts(allTasks);
    const projects = this.#filteredProjects();
    const visibleTaskCount = projects.reduce(
      (count, project) => count + project.tasks.length,
      0,
    );
    const renderSignature = stableSignature({
      query: this.#searchQuery,
      lane: this.#laneFilter,
      category: this.#categoryFilter,
      projectFilterId: this.#selectedProjectFilterId,
      minute: Math.floor(Date.now() / 60_000),
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        root: project.root,
        status: project.status,
        taskCount: project.taskCount,
        activeTaskCount: project.activeTaskCount,
        attentionTaskCount: project.attentionTaskCount,
        onlineAgentCount: project.onlineAgentCount,
        tasks: project.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          category: task.category,
          status: task.status,
          source: task.source,
          summaryPreview: task.summaryPreview,
          currentStep: task.currentStep,
          progress: task.progress,
          agent: {
            id: task.agent.id,
            name: task.agent.name,
            presence: task.agent.presence,
          },
          lastActivityLabel: task.lastActivityLabel,
          activityMinute: Math.floor(
            Date.parse(task.lastActivityAt ?? task.updatedAt) / 60_000,
          ),
          unreadUserMessageCount: task.unreadUserMessageCount,
          coordinationPendingCount: task.coordinationPendingCount,
          messageCount: task.messageCount,
        })),
      })),
    });
    setTextContent(
      summary,
      `${counts.current} current · ${counts.attention} need action · ${counts.history} history`,
    );
    this.#renderWorkspaceOverview(allTasks, visibleTaskCount, false);
    if (renderSignature === this.#projectsRenderSignature) {
      if (this.#pendingListFocusTaskId !== null) {
        setTimeout(() => this.#restoreListFocus(), 0);
      }
      return;
    }
    this.#projectsRenderSignature = renderSignature;
    container.replaceChildren();
    if (projects.length === 0) {
      const empty = document.createElement("div");
      empty.className = "task-hub-empty";
      const laneContent = BOARD_LANE_CONTENT[this.#laneFilter];
      const title = document.createElement("strong");
      title.textContent =
        this.#snapshot.projects.length === 0
          ? "No task records"
          : this.#searchQuery.length === 0 && this.#categoryFilter === "all"
            ? laneContent.emptyTitle
            : "No tasks match these filters";
      const detail = document.createElement("span");
      detail.textContent =
        this.#snapshot.projects.length === 0
          ? BOARD_LANE_CONTENT.all.emptyDetail
          : this.#searchQuery.length === 0 && this.#categoryFilter === "all"
            ? laneContent.emptyDetail
            : "Clear a filter or search for another project, task or Agent.";
      empty.append(title, detail);
      container.append(empty);
      restoreScrollAnchor();
      if (focusedTaskId !== null)
        setTimeout(() => this.#restoreListFocus(focusedTaskId), 0);
      return;
    }
    for (const project of projects)
      container.append(this.#projectCard(project));
    restoreScrollAnchor();
    this.#cardNavigation?.sync(focusedTaskId);
    if (focusedTaskId !== null)
      setTimeout(() => this.#restoreListFocus(focusedTaskId), 0);
  }

  #renderWorkspaceOverview(
    tasks: readonly DesktopTaskListItem[],
    visibleTaskCount: number,
    loading: boolean,
    unavailable = false,
  ): void {
    const counts: TaskBoardCounts = taskBoardCounts(tasks);
    const pendingSnapshot = loading || unavailable;
    for (const lane of TASK_BOARD_LANES) {
      const value = pendingSnapshot ? "—" : String(counts[lane]);
      requiredElement<HTMLElement>(`#task-board-${lane}-count`).textContent =
        value;
    }
    this.#laneControls?.setActiveLane(this.#laneFilter);
    requiredElement<HTMLElement>("#task-hub-visible-count").textContent =
      pendingSnapshot ? "—" : String(visibleTaskCount);

    const laneContent = BOARD_LANE_CONTENT[this.#laneFilter];
    setTextContent(
      requiredElement<HTMLElement>("#task-board-view-title"),
      laneContent.title,
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-board-view-description"),
      laneContent.description,
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-hub-visible-label"),
      laneContent.visibleLabel,
    );
    this.#refreshFeedback?.sync(
      loading
        ? "Loading snapshot…"
        : unavailable || this.#snapshot === null
          ? "Snapshot unavailable"
          : `${counts.all} records · refreshed ${elapsedLabel(this.#snapshot.generatedAt)}`,
    );

    const missingProgress = tasks.filter(
      (task) =>
        taskHasLiveAgent(task) && taskProgressPercent(task) === null,
    );
    const advisory = requiredElement<HTMLElement>(
      "#task-hub-progress-advisory",
    );
    advisory.hidden =
      pendingSnapshot ||
      this.#laneFilter !== "current" ||
      missingProgress.length === 0;
    requiredElement<HTMLElement>(
      "#task-hub-progress-missing-count",
    ).textContent = String(missingProgress.length);
    requiredElement<HTMLElement>(
      "#task-hub-progress-advisory-detail",
    ).textContent =
      "These live Agent tasks have not reported a numeric total yet.";
  }

  #projectCard(project: DesktopTaskProjectSummary): HTMLElement {
    const article = document.createElement("article");
    article.className = `task-project-card task-project-${project.status}`;
    article.dataset.projectId = project.id;
    const accessibility = taskProjectAccessibilityIds(project.id);
    article.setAttribute("aria-labelledby", accessibility.titleId);
    article.setAttribute(
      "aria-describedby",
      `${accessibility.rootId} ${accessibility.metricsId}`,
    );

    const header = document.createElement("header");
    header.className = "task-project-card-header";
    const identity = document.createElement("div");
    const title = preserveSourceText(document.createElement("h3"));
    title.id = accessibility.titleId;
    title.textContent = project.name;
    const root = preserveSourceText(document.createElement("code"));
    root.id = accessibility.rootId;
    root.textContent = project.root;
    root.title = project.root;
    identity.append(title, root);
    const state = document.createElement("span");
    state.className = `task-project-state task-project-state-${project.status}`;
    state.textContent = BOARD_LANE_CONTENT[this.#laneFilter].title;
    header.append(identity, state);

    const visibleMetrics = taskProjectVisibleMetrics(project.tasks);
    const metrics = document.createElement("div");
    metrics.className = "task-project-metrics sr-only";
    metrics.id = accessibility.metricsId;
    metrics.setAttribute("aria-label", "Project task summary");
    for (const [label, value] of [
      ["Shown", visibleMetrics.shown],
      ["Current", visibleMetrics.current],
      ["Needs action", visibleMetrics.attention],
      ["Waiting messages", visibleMetrics.waitingMessages],
    ] as const) {
      const metric = document.createElement("div");
      const number = document.createElement("strong");
      number.textContent = String(value);
      const text = document.createElement("span");
      text.textContent = label;
      metric.append(number, text);
      metrics.append(metric);
    }

    const tasks = document.createElement("div");
    tasks.className = "task-project-task-list";
    tasks.id = accessibility.tasksId;
    tasks.setAttribute("role", "group");
    tasks.setAttribute("aria-labelledby", accessibility.titleId);
    for (const task of project.tasks) tasks.append(this.#taskButton(task));
    article.append(header, metrics, tasks);
    return article;
  }

  #taskButton(task: DesktopTaskListItem): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    const boardLane = taskBoardLane(task);
    const boardState = taskBoardState(task);
    const compactSuccess =
      task.status === "succeeded" && boardLane === "history";
    const coordinationPendingLabel = taskCoordinationPendingLabel(task);
    const currentWork = listTaskCurrentWork(task);
    button.className = `task-summary-card task-board-state-${boardState} task-recorded-status-${task.status}`;
    button.classList.toggle("task-source-inferred", isInferredTask(task));
    button.dataset.taskId = task.id;
    button.dataset.boardLane = boardLane;
    if (task.id === this.#selectedTaskId) button.setAttribute("aria-current", "true");
    button.setAttribute(
      "aria-label",
      `${task.title}. ${taskBoardStateLabel(task)}. ${taskConnectionLabel(task)}. ${taskBoardStateDetail(task)} ${currentWork}. ${taskProgressValue(task)}.${coordinationPendingLabel === null ? "" : ` ${coordinationPendingLabel}.`}`,
    );
    button.addEventListener("click", () => void this.openTask(task.id));

    const header = document.createElement("div");
    header.className = "task-summary-header";
    const identity = document.createElement("div");
    const title = preserveSourceText(document.createElement("strong"));
    title.textContent = task.title;
    const category = document.createElement("span");
    category.textContent = CATEGORY_LABELS[task.category];
    identity.append(title);
    if (!compactSuccess) identity.append(category);
    const status = document.createElement("span");
    status.className = `task-chip task-chip-${boardState}`;
    status.textContent = taskBoardStateLabel(task);
    header.append(identity, status);
    if (compactSuccess) {
      button.classList.add("task-summary-card-compact-success");
      const completed = document.createElement("time");
      completed.className = "task-summary-completed";
      completed.dateTime = task.updatedAt;
      completed.textContent = `Completed ${timestamp(task.updatedAt, false)}`;
      button.append(header, completed);
      return button;
    }

    const current = preserveSourceText(document.createElement("p"));
    current.className = "task-summary-current";
    current.textContent = currentWork;
    current.title = currentWork;
    const reliability = document.createElement("p");
    reliability.className = `task-summary-reliability task-summary-reliability-${boardState}`;
    reliability.textContent = taskBoardStateDetail(task);

    const progress = document.createElement("div");
    progress.className = "task-summary-progress";
    const track = document.createElement("span");
    track.className = "task-summary-progress-track";
    const fill = document.createElement("i");
    const percent = taskProgressPercent(task);
    const indeterminate = taskProgressIsIndeterminate(task);
    track.hidden = percent === null;
    track.classList.toggle("is-indeterminate", indeterminate);
    applyTaskProgressAccessibility(track, {
      label: taskProgressLabel(task),
      percent,
      valueText: taskProgressValue(task),
    });
    fill.style.width = percent === null ? "0" : `${percent}%`;
    track.append(fill);
    const value = document.createElement("small");
    value.textContent = percent === null ? "Progress not reported" : `${task.progress.current} / ${task.progress.total}`;
    value.title = taskProgressValue(task);
    progress.append(track, value);

    const footer = document.createElement("div");
    footer.className = "task-summary-footer";
    const source = document.createElement("span");
    source.className = `task-summary-source task-summary-source-${task.source}`;
    source.textContent = SOURCE_LABELS[task.source];
    const agent = document.createElement("span");
    agent.className = isInferredTask(task)
      ? "task-agent-presence task-agent-activity"
      : `task-agent-presence task-agent-${taskBoardAgentPresence(task)}`;
    agent.textContent = taskConnectionLabel(task);
    const updated = document.createElement("span");
    updated.textContent = `Updated ${elapsedLabel(task.lastActivityAt ?? task.updatedAt)}`;
    footer.append(source, agent, updated);
    const waitingMessageLabel = taskWaitingMessageLabel(task);
    if (waitingMessageLabel !== null) {
      const unread = document.createElement("span");
      unread.className = "task-unread-count";
      unread.textContent = waitingMessageLabel;
      footer.append(unread);
    }
    if (coordinationPendingLabel !== null) {
      const coordination = document.createElement("span");
      coordination.className = "task-coordination-card-count";
      coordination.textContent = coordinationPendingLabel;
      footer.append(coordination);
    }

    button.append(header, current, reliability, progress, footer);
    return button;
  }

  async #loadDetail(
    taskId: string,
    reveal: boolean,
    focusOnReveal = true,
    refreshOrigin: TaskRefreshOrigin | null = null,
  ): Promise<void> {
    if (reveal) {
      this.#messageHistory?.select(taskId);
      this.#storeCurrentDraft();
      this.#selectedTaskId = taskId;
      this.#lastOpenedTaskId = taskId;
      this.#restoreSelectedTaskOnRefresh = false;
      this.#persistSessionState();
      this.#renderedDetailTaskId = null;
      this.#renderedStepsSignature = "";
      this.#renderedMessagesSignature = "";
      this.#coordinationInbox?.select(taskId);
      requiredElement<HTMLElement>("#task-hub-list-pane").hidden = false;
      setTaskWorkbenchSelection(taskId);
      const detailPane = requiredElement<HTMLElement>("#task-detail-pane");
      detailPane.hidden = false;
      setTaskDetailLoading(document, "loading");
      requiredElement<HTMLTextAreaElement>("#task-message-input").value =
        this.#messageDrafts.get(taskId) ?? "";
      this.#messageSendFeedback?.syncDraft();
    }
    void this.#coordinationInbox?.refresh(taskId);
    const generation = ++this.#detailRequestGeneration;
    try {
      const detail = await this.#api.getTaskDetail(taskId, 300);
      if (
        generation !== this.#detailRequestGeneration ||
        this.#selectedTaskId !== taskId
      )
        return;
      assertTaskDetailIntegrity(taskId, detail);
      this.#renderDetail(detail);
      setTaskDetailLoading(document, "ready");
      if (reveal && focusOnReveal) {
        const back = requiredElement<HTMLButtonElement>("#task-detail-back");
        (back.getClientRects().length > 0 ? back : requiredElement<HTMLElement>("#task-detail-title")).focus({ preventScroll: true });
      }
    } catch (error) {
      if (
        generation !== this.#detailRequestGeneration ||
        this.#selectedTaskId !== taskId
      )
        return;
      setTaskDetailLoading(document, "unavailable");
      if (reveal) this.showProjects();
      const failure = taskDetailFailureDisposition(refreshOrigin, reveal);
      if (failure.notify) {
        this.#notify(
          error instanceof Error
            ? error.message
            : "Could not load task detail.",
          true,
        );
      }
      if (failure.propagate) throw error;
    }
  }

  #storeCurrentDraft(): void {
    const taskId = this.#selectedTaskId;
    if (taskId === null) return;
    const value = requiredElement<HTMLTextAreaElement>(
      "#task-message-input",
    ).value;
    if (value.length === 0) {
      this.#messageDrafts.delete(taskId);
    } else {
      this.#messageDrafts.set(taskId, value);
    }
    this.#persistSessionState();
  }

  #renderDetail(detail: DesktopTaskDetail): void {
    this.#lastRenderedDetail = detail;
    const task = detail.task;
    this.#coordinationInbox?.updatePendingCount(
      task.id,
      task.coordinationPendingCount,
    );
    if (this.#renderedDetailTaskId !== task.id) {
      this.#renderedDetailTaskId = task.id;
      this.#renderedStepsSignature = "";
      this.#renderedMessagesSignature = "";
    }

    const projectName = preserveSourceText(
      requiredElement<HTMLElement>("#task-detail-project"),
    );
    const taskTitle = preserveSourceText(
      requiredElement<HTMLElement>("#task-detail-title"),
    );
    const taskSummary = preserveSourceText(
      requiredElement<HTMLElement>("#task-detail-summary"),
    );
    setTextContent(projectName, task.projectName);
    setTextContent(taskTitle, task.title);
    setTextContent(
      taskSummary,
      task.summary || "No task summary was provided.",
    );

    const boardState = taskBoardState(task);
    const status = requiredElement<HTMLElement>("#task-detail-status");
    setClassName(status, `task-chip task-chip-${boardState}`);
    setTextContent(status, taskBoardStateLabel(task));
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-trust"),
      taskBoardStateDetail(task),
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-board-state"),
      taskBoardStateLabel(task),
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-recorded-status"),
      STATUS_LABELS[task.status],
    );
    this.#selectedTaskIsInferred = isInferredTask(task);

    const presence = requiredElement<HTMLElement>(
      "#task-detail-agent-presence",
    );
    setClassName(
      presence,
      isInferredTask(task)
        ? "task-chip task-agent-activity"
        : `task-chip task-agent-${taskBoardAgentPresence(task)}`,
    );
    setTextContent(presence, taskPresenceLabel(task));
    setTextContent(
      preserveSourceText(
        requiredElement<HTMLElement>("#task-detail-current-step"),
      ),
      detailTaskCurrentWork(task),
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-updated"),
      `Updated ${elapsedLabel(task.updatedAt)}`,
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-category"),
      CATEGORY_LABELS[task.category],
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-source"),
      SOURCE_LABELS[task.source],
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-agent"),
      taskAgentDetail(task),
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-heartbeat-label"),
      isInferredTask(task) ? "Latest activity signal" : "Last heartbeat",
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-heartbeat"),
      task.agent.lastHeartbeatAt === null
        ? "None"
        : `${timestamp(task.agent.lastHeartbeatAt, false)} · ${elapsedLabel(task.agent.lastHeartbeatAt)}`,
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-last-activity"),
      task.lastActivityLabel === null
        ? task.source === "inferred"
          ? `Activity inferred from tool calls · ${elapsedLabel(task.updatedAt)}`
          : "None"
        : `${task.lastActivityLabel} · ${elapsedLabel(task.lastActivityAt)}`,
    );

    const root = requiredElement<HTMLElement>("#task-detail-project-root");
    setTextContent(root, task.projectRoot);
    if (root.title !== task.projectRoot) root.title = task.projectRoot;
    setTextContent(
      requiredElement<HTMLElement>("#task-conversation-title"),
      isInferredTask(task)
        ? "Leave a note for a future Agent"
        : "Talk to the Agent",
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-message-label"),
      isInferredTask(task) ? "Message for a future Agent" : "Message the Agent",
    );

    const percent = taskProgressPercent(task);
    const progressTrack = requiredElement<HTMLElement>(
      "#task-detail-progress-track",
    );
    const indeterminate = taskProgressIsIndeterminate(task);
    progressTrack.classList.toggle("is-indeterminate", indeterminate);
    const progressBar = requiredElement<HTMLElement>(
      "#task-detail-progress-bar",
    );
    const progressWidth = percent === null ? "0px" : `${percent}%`;
    if (progressBar.style.width !== progressWidth)
      progressBar.style.width = progressWidth;
    const renderedProgressLabel = taskProgressLabel(task);
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-progress-label"),
      renderedProgressLabel,
    );
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-progress-value"),
      percent === null
        ? indeterminate
          ? "Live"
          : "—"
        : `${task.progress.current} / ${task.progress.total} · ${percent}%`,
    );
    const note = requiredElement<HTMLElement>("#task-detail-progress-note");
    const renderedProgressNote = taskProgressNote(task);
    const noteHidden = renderedProgressNote === null;
    if (note.hidden !== noteHidden) note.hidden = noteHidden;
    setTextContent(note, renderedProgressNote ?? "");
    applyTaskProgressAccessibility(progressTrack, {
      label: renderedProgressLabel,
      percent,
      valueText:
        percent === null
          ? renderedProgressLabel
          : `${renderedProgressLabel}: ${percent}%`,
    });

    renderTaskSessionContinuity(detail);
    this.#renderSteps(task);
    this.#messageHistory?.update(detail);
  }

  #renderSteps(task: DesktopTaskSummary): void {
    const container = requiredElement<HTMLElement>("#task-detail-steps");
    setTextContent(
      requiredElement<HTMLElement>("#task-detail-step-count"),
      `${task.steps.filter((step) => step.status === "succeeded").length} / ${task.steps.length}`,
    );
    validateTaskStepList(task.steps);
    const signature = stableSignature({
      taskId: task.id,
      inferred: isInferredTask(task),
      minute: Math.floor(Date.now() / 60_000),
      steps: task.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        updatedMinute: Math.floor(Date.parse(step.updatedAt) / 60_000),
      })),
    });
    if (signature === this.#renderedStepsSignature) return;
    this.#renderedStepsSignature = signature;
    reconcileTaskStepList({
      container,
      steps: task.steps,
      inferred: isInferredTask(task),
      elapsedLabel,
    });
  }

  #renderMessages(
    messages: readonly DesktopTaskMessage[],
    task: DesktopTaskSummary,
    messagesTruncated: boolean,
  ): void {
    const container = requiredElement<HTMLElement>("#task-message-list");
    const signature = stableSignature({
      taskId: task.id,
      source: task.source,
      agentId: task.agent.id,
      messagesTruncated,
      messageCount: task.messageCount,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        acknowledgedAt: message.acknowledgedAt,
        agentName: message.agentName,
      })),
    });

    if (signature !== this.#renderedMessagesSignature) {
      reconcileTaskMessageList({
        container,
        messages,
        task,
        messagesTruncated,
        authorLabel: messageAuthor,
        timestampLabel: timestamp,
        userDelivery: userMessageDeliveryLabel,
      });
      this.#renderedMessagesSignature = signature;
    }

    renderTaskConversationDelivery(messages, task, timestamp,
      requiredElement<HTMLElement>("#task-conversation-delivery"),
      requiredElement<HTMLElement>("#task-message-help"));
  }

  async #sendMessage(): Promise<void> {
    if (this.#messageSending || this.#selectedTaskId === null) return;
    const taskId = this.#selectedTaskId;
    const taskWasInferred = this.#selectedTaskIsInferred;
    const input = requiredElement<HTMLTextAreaElement>("#task-message-input");
    let content: string | null;
    try {
      content = taskMessageContent(input.value);
    } catch (error) {
      this.#notify(
        error instanceof Error ? error.message : "The task message is invalid.",
        true,
      );
      input.focus({ preventScroll: true });
      return;
    }
    if (content === null) {
      input.focus({ preventScroll: true });
      return;
    }

    const button = requiredElement<HTMLButtonElement>("#task-message-send");
    const activeElement = document.activeElement;
    const focusTarget =
      activeElement === input
        ? "input"
        : activeElement === button
          ? "button"
          : null;
    this.#messageSending = true;
    this.#messageSendFeedback?.begin(focusTarget);
    try {
      const detail = await this.#api.sendTaskUserMessage(taskId, content);
      assertTaskDetailIntegrity(taskId, detail);
      this.#messageDrafts.delete(taskId);
      this.#persistSessionState();
      const taskStillOpen = this.#selectedTaskId === taskId;
      this.#messageSendFeedback?.succeed(taskStillOpen);
      if (taskStillOpen) this.#renderDetail(detail);
      this.#notify(
        taskWasInferred
          ? "Message stored locally. It will enter Tasks Inbox when an Agent claims this task."
          : "Message saved. Sovereign will surface it to the Agent on the next tool call.",
      );
      await this.refresh().catch(() => undefined);
    } catch (error) {
      const taskStillOpen = this.#selectedTaskId === taskId;
      const deliveryUncertain = isTaskDetailIntegrityError(error);
      this.#messageSendFeedback?.fail(taskStillOpen, deliveryUncertain);
      if (deliveryUncertain) {
        if (taskStillOpen) setTaskDetailLoading(document, "unavailable");
        this.#notify(
          "Message may have been saved, but the returned snapshot failed integrity checks. Draft preserved; refresh before retrying.",
          true,
        );
      } else {
        this.#notify(
          error instanceof Error
            ? error.message
            : "Could not send the task message.",
          true,
        );
      }
    } finally {
      this.#messageSending = false;
      const currentActiveElement = document.activeElement;
      const focusWasDisplacedByDisabledControl =
        currentActiveElement === null ||
        currentActiveElement === document.body ||
        currentActiveElement === input ||
        currentActiveElement === button;
      this.#messageSendFeedback?.end(
        this.#selectedTaskId === taskId && focusWasDisplacedByDisabledControl,
      );
    }
  }
}
