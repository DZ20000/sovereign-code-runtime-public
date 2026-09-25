import {
  DEFAULT_VIEW_ID,
  isViewId,
  type ViewId,
} from "./view-registry.js";

export type StartupViewPreference = "overview" | "tasks" | "agent" | "runs" | "last";
export type ExperienceMode = "simple" | "full";

export interface InitialViewInput {
  readonly lastView: ViewId | null;
  readonly startupView: StartupViewPreference;
  readonly experienceMode: ExperienceMode;
  readonly isReload: boolean;
}

export function isAdvancedView(view: ViewId): boolean {
  return view === "terminal" ||
    view === "python" ||
    view === "browser" ||
    view === "computer" ||
    view === "workflows";
}

export function normalizePersistedView(
  value: string | null,
  experienceMode: ExperienceMode,
): ViewId | null {
  if (value === null || !isViewId(value)) {
    return null;
  }
  return experienceMode === "simple" && isAdvancedView(value)
    ? DEFAULT_VIEW_ID
    : value;
}

export function resolveInitialView(input: InitialViewInput): ViewId {
  // Reload continues the current workflow. Cold launch still respects the user's startup preference.
  if (input.lastView !== null && (input.isReload || input.startupView === "last")) {
    return input.experienceMode === "simple" && isAdvancedView(input.lastView)
      ? DEFAULT_VIEW_ID
      : input.lastView;
  }
  if (input.startupView === "tasks") {
    return "tasks";
  }
  if (input.startupView === "agent") {
    return "agent";
  }
  if (input.startupView === "runs") {
    return "runs";
  }
  return DEFAULT_VIEW_ID;
}
