import type { DesktopTaskProjectSummary } from "../shared.js";
import { taskHasCurrentAgentSession } from "./task-board-model.js";
import { groupTaskProjects, readTaskProjectGroups } from "./task-project-groups.js";

export interface TaskProjectFilterOption {
  readonly projectId: string | null;
  readonly label: string;
  readonly root: string | null;
  readonly hasActiveAgentSession: boolean;
  readonly activeAgentNames: readonly string[];
}

function activeAgentSnapshot(
  projects: readonly DesktopTaskProjectSummary[],
): Pick<TaskProjectFilterOption, "hasActiveAgentSession" | "activeAgentNames"> {
  let hasActiveAgentSession = false;
  const names = new Set<string>();
  for (const task of projects.flatMap((project) => project.tasks)) {
    if (!taskHasCurrentAgentSession(task)) continue;
    hasActiveAgentSession = true;
    const name = task.agent.name?.trim();
    if (name) names.add(name);
  }
  return {
    hasActiveAgentSession,
    activeAgentNames: [...names].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

export function buildTaskProjectFilterOptions(
  projects: readonly DesktopTaskProjectSummary[],
): readonly TaskProjectFilterOption[] {
  return [
    {
      projectId: null,
      label: "All projects",
      root: null,
      ...activeAgentSnapshot(projects),
    },
    ...groupTaskProjects(projects).map((project) => ({
      projectId: project.id,
      label: project.name,
      root: project.root,
      ...activeAgentSnapshot([project]),
    })),
  ];
}

export function normalizeTaskProjectFilterSelection(
  projects: readonly DesktopTaskProjectSummary[],
  selectedProjectId: string | null,
): string | null {
  if (selectedProjectId === null ||
      !projects.some((project) => project.id === selectedProjectId)) return null;
  const group = readTaskProjectGroups().find((candidate) =>
    candidate.projectIds.includes(selectedProjectId) &&
    candidate.projectIds.every((id) => projects.some((project) => project.id === id)));
  return group?.id ?? selectedProjectId;
}

export function filterTaskProjects(
  projects: readonly DesktopTaskProjectSummary[],
  selectedProjectId: string | null,
): readonly DesktopTaskProjectSummary[] {
  const grouped = groupTaskProjects(projects);
  const selection = normalizeTaskProjectFilterSelection(projects, selectedProjectId);
  return selection === null ? grouped : grouped.filter((project) => project.id === selection);
}

export function renderTaskProjectFilter(options: {
  readonly container: HTMLElement;
  readonly projects: readonly DesktopTaskProjectSummary[];
  readonly selectedProjectId: string | null;
  readonly onSelect: (projectId: string | null) => void;
}): void {
  let select = options.container.querySelector<HTMLSelectElement>("select");
  if (select === null) {
    select = document.createElement("select");
    select.id = "task-project-select";
    select.className = "settings-select";
    options.container.replaceChildren(select);
  }
  const choices = buildTaskProjectFilterOptions(options.projects);
  const signature = JSON.stringify(choices);
  if (select.dataset.optionsSignature !== signature) {
    select.replaceChildren(...choices.map(
    (option) => {
      const element = document.createElement("option");
      element.value = option.projectId ?? "";
      element.textContent = option.label;
      element.title = option.root ?? "All projects";
      if (option.projectId !== null) element.dataset.noI18n = "";
      return element;
    },
    ));
    select.dataset.optionsSignature = signature;
  }
  select.value = options.selectedProjectId ?? "";
  select.onchange = () => options.onSelect(select.value || null);
}
