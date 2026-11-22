import { DEFAULT_VIEW_ID, isViewId, normalizeViewId, type ViewId } from "./view-registry.js";
export type StartupViewPreference = "overview" | "tasks" | "approvals" | "agent" | "runs" | "last";
export type ExperienceMode = "simple" | "full";
export interface InitialViewInput {
  readonly lastView: ViewId | null;
  readonly startupView: StartupViewPreference;
  readonly experienceMode: ExperienceMode;
  readonly isReload: boolean;
}
export function isAdvancedView(view: ViewId): boolean {
  return ["terminal", "python", "browser", "computer", "workflows"].includes(view);
}
export function normalizePersistedView(value: string | null, mode: ExperienceMode): ViewId | null {
  if (value === null || !isViewId(value)) return null;
  return mode === "simple" ? DEFAULT_VIEW_ID : normalizeViewId(value);
}
export function resolveInitialView(input: InitialViewInput): ViewId {
  if (input.experienceMode === "simple") return DEFAULT_VIEW_ID;
  if (input.lastView !== null && (input.isReload || input.startupView === "last")) return normalizeViewId(input.lastView);
  return input.startupView === "last" ? DEFAULT_VIEW_ID : normalizeViewId(input.startupView);
}
