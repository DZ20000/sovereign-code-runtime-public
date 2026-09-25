import type { DesktopTaskCategory } from "../shared.js";
import type { TaskBoardLane } from "./task-board-model.js";

export type TaskHubLaneFilter = TaskBoardLane;
export type TaskHubCategoryFilter = "all" | DesktopTaskCategory;

export interface TaskHubSessionState {
  readonly selectedTaskId: string | null;
  readonly searchQuery: string;
  readonly laneFilter: TaskHubLaneFilter;
  readonly categoryFilter: TaskHubCategoryFilter;
  readonly messageDrafts: Readonly<Record<string, string>>;
}

export interface TaskHubStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const TASK_HUB_SESSION_KEY = "sovereign.ui.task-hub-session.v1";

const LANE_FILTERS = new Set<TaskHubLaneFilter>([
  "current",
  "attention",
  "history",
  "activity",
  "all",
]);
const LEGACY_STATUS_TO_LANE: Readonly<Record<string, TaskHubLaneFilter>> = {
  active: "current",
  attention: "attention",
  completed: "history",
  all: "current",
};
const CATEGORY_FILTERS = new Set<TaskHubCategoryFilter>([
  "all",
  "development",
  "testing",
  "build",
  "research",
  "maintenance",
  "automation",
  "other",
]);
const MAX_DRAFTS = 32;
const MAX_DRAFT_LENGTH = 8_000;
const MAX_DRAFT_TOTAL_LENGTH = 128_000;
const MAX_TASK_ID_LENGTH = 128;
export const TASK_HUB_SESSION_MAX_SEARCH_LENGTH = 256;
const UNSAFE_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function emptyState(): TaskHubSessionState {
  return {
    selectedTaskId: null,
    searchQuery: "",
    laneFilter: "current",
    categoryFilter: "all",
    messageDrafts: {},
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximumLength: number): string | null {
  return typeof value === "string" && value.length <= maximumLength
    ? value
    : null;
}

function readLaneFilter(value: Record<string, unknown>): TaskHubLaneFilter {
  if (
    typeof value.laneFilter === "string" &&
    LANE_FILTERS.has(value.laneFilter as TaskHubLaneFilter)
  ) {
    return value.laneFilter as TaskHubLaneFilter;
  }
  if (typeof value.statusFilter === "string") {
    return LEGACY_STATUS_TO_LANE[value.statusFilter] ?? "current";
  }
  return "current";
}

function readDrafts(value: unknown): Readonly<Record<string, string>> {
  const source = objectValue(value);
  if (source === null) return {};
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let accepted = 0;
  let totalLength = 0;
  for (const [taskId, draft] of Object.entries(source)) {
    if (accepted >= MAX_DRAFTS) break;
    if (
      taskId.length === 0 ||
      taskId.length > MAX_TASK_ID_LENGTH ||
      UNSAFE_RECORD_KEYS.has(taskId)
    ) {
      continue;
    }
    const content = boundedString(draft, MAX_DRAFT_LENGTH);
    if (
      content === null ||
      content.length === 0 ||
      totalLength + content.length > MAX_DRAFT_TOTAL_LENGTH
    ) {
      continue;
    }
    result[taskId] = content;
    accepted += 1;
    totalLength += content.length;
  }
  return result;
}

export function readTaskHubSessionState(
  storage: TaskHubStorage | null,
): TaskHubSessionState {
  if (storage === null) return emptyState();
  try {
    const raw = storage.getItem(TASK_HUB_SESSION_KEY);
    if (raw === null) return emptyState();
    const parsed = objectValue(JSON.parse(raw));
    if (parsed === null) return emptyState();
    const selectedTaskId = boundedString(
      parsed.selectedTaskId,
      MAX_TASK_ID_LENGTH,
    );
    const searchQuery =
      boundedString(parsed.searchQuery, TASK_HUB_SESSION_MAX_SEARCH_LENGTH) ??
      "";
    const categoryFilter =
      typeof parsed.categoryFilter === "string" &&
      CATEGORY_FILTERS.has(parsed.categoryFilter as TaskHubCategoryFilter)
        ? (parsed.categoryFilter as TaskHubCategoryFilter)
        : "all";
    return {
      selectedTaskId: selectedTaskId === "" ? null : selectedTaskId,
      searchQuery,
      laneFilter: readLaneFilter(parsed),
      categoryFilter,
      messageDrafts: readDrafts(parsed.messageDrafts),
    };
  } catch {
    return emptyState();
  }
}

export function writeTaskHubSessionState(
  storage: TaskHubStorage | null,
  state: TaskHubSessionState,
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      TASK_HUB_SESSION_KEY,
      JSON.stringify({
        selectedTaskId: boundedString(state.selectedTaskId, MAX_TASK_ID_LENGTH),
        searchQuery: state.searchQuery.slice(
          0,
          TASK_HUB_SESSION_MAX_SEARCH_LENGTH,
        ),
        laneFilter: LANE_FILTERS.has(state.laneFilter)
          ? state.laneFilter
          : "current",
        categoryFilter: CATEGORY_FILTERS.has(state.categoryFilter)
          ? state.categoryFilter
          : "all",
        messageDrafts: readDrafts(state.messageDrafts),
      }),
    );
  } catch {
    // Renderer-session UI state is best-effort and must never block durable Task operations.
  }
}
