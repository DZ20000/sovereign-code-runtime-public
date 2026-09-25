export interface TaskWorkspaceLoadPresentation {
  readonly kind: "loading" | "unavailable";
  readonly summary: string;
  readonly title: string;
  readonly detail: string;
  readonly retry: string | null;
  readonly liveRole: "alert" | "status";
}

export function taskWorkspaceLoadPresentation(
  errorMessage: string | null,
): TaskWorkspaceLoadPresentation {
  if (errorMessage === null) {
    return {
      kind: "loading",
      summary: "Loading tasks…",
      title: "Loading task records",
      detail: "Loading projects and tasks…",
      retry: null,
      liveRole: "status",
    };
  }
  const normalized = errorMessage.trim();
  return {
    kind: "unavailable",
    summary: "Tasks unavailable",
    title: "Tasks unavailable",
    detail: normalized.length > 0 ? normalized : "Could not load tasks.",
    retry: "Refresh to try again.",
    liveRole: "alert",
  };
}
