import type { DesktopTaskProjectSummary, DesktopTaskWorkspaceSnapshot } from "../shared.js";
import { groupTaskProjects } from "./task-project-groups.js";

export function taskProjectForTask(
  snapshot: DesktopTaskWorkspaceSnapshot | null,
  taskId: string | null,
): DesktopTaskProjectSummary | null {
  if (taskId === null) return null;
  for (const project of groupTaskProjects(snapshot?.projects ?? [])) {
    const task = project.tasks.find((candidate) => candidate.id === taskId);
    if (task !== undefined)
      return task.source === "inferred" ? null : project;
  }
  return null;
}
