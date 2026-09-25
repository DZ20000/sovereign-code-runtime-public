import type { DesktopTaskProjectSummary } from "../shared.js";

export interface TaskProjectGroup {
  readonly id: string;
  readonly name: string;
  readonly projectIds: readonly string[];
}

const STORAGE_KEY = "sovereign.task-project-groups.v1";
type GroupStorage = Pick<Storage, "getItem" | "setItem">;

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validatedGroups(value: unknown): readonly TaskProjectGroup[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const members = new Set<string>();
  const groups: TaskProjectGroup[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const group = entry as Record<string, unknown>;
    if (!validText(group.id, 160) || !validText(group.name, 160) ||
        !Array.isArray(group.projectIds) || group.projectIds.length < 2 ||
        group.projectIds.length > 50 || !group.projectIds.includes(group.id)) return null;
    const projectIds: string[] = [];
    for (const id of group.projectIds) {
      if (!validText(id, 160) || id !== id.trim() || members.has(id)) return null;
      members.add(id);
      projectIds.push(id);
    }
    if (members.size > 50) return null;
    groups.push({ id: group.id, name: group.name.trim(), projectIds });
  }
  return groups;
}

function loadGroups(storage?: GroupStorage): {
  readonly groups: readonly TaskProjectGroup[];
  readonly error: string | null;
} {
  try {
    const raw = (storage ?? window.localStorage).getItem(STORAGE_KEY);
    if (raw === null) return { groups: [], error: null };
    const groups = raw.length <= 32_768 ? validatedGroups(JSON.parse(raw)) : null;
    if (groups !== null) return { groups, error: null };
  } catch {
    // A display preference must never prevent access to the original projects.
  }
  return { groups: [], error: "Saved project groups could not be read. Projects are shown separately." };
}

export function readTaskProjectGroups(storage?: GroupStorage): readonly TaskProjectGroup[] {
  return loadGroups(storage).groups;
}

export function writeTaskProjectGroups(
  value: readonly TaskProjectGroup[],
  projects: readonly DesktopTaskProjectSummary[],
  storage?: GroupStorage,
): void {
  const groups = validatedGroups(value);
  const knownIds = new Set(projects.map((project) => project.id));
  if (groups === null || groups.some((group) => group.projectIds.some((id) => !knownIds.has(id)))) {
    throw new Error("Choose at least two available projects, a group name, and no overlapping groups.");
  }
  (storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(groups));
}

export function groupTaskProjects(
  projects: readonly DesktopTaskProjectSummary[],
  value: readonly TaskProjectGroup[] = readTaskProjectGroups(),
): readonly DesktopTaskProjectSummary[] {
  const groups = validatedGroups(value);
  if (groups === null || groups.length === 0) return projects;
  const byId = new Map(projects.map((project) => [project.id, project]));
  const grouped = new Map<string, DesktopTaskProjectSummary>();
  for (const group of groups) {
    if (group.projectIds.some((id) => !byId.has(id))) continue;
    const members = group.projectIds.map((id) => byId.get(id)!);
    const tasks = members.flatMap((project) => project.tasks);
    const sum = (key: "taskCount" | "activeTaskCount" | "attentionTaskCount") =>
      members.reduce((total, project) => total + project[key], 0);
    const activeTaskCount = sum("activeTaskCount");
    const attentionTaskCount = sum("attentionTaskCount");
    const merged: DesktopTaskProjectSummary = {
      ...byId.get(group.id)!,
      name: group.name,
      taskCount: sum("taskCount"),
      activeTaskCount,
      attentionTaskCount,
      onlineAgentCount: new Set(tasks.filter((task) => task.agent.presence === "online" &&
        task.agent.id !== null).map((task) => task.agent.id)).size,
      status: attentionTaskCount > 0 ? "attention" : activeTaskCount > 0 ? "active" :
        members.every((project) => project.status === "completed") ? "completed" : "idle",
      updatedAt: members.reduce((latest, project) => project.updatedAt > latest ? project.updatedAt : latest, ""),
      tasks,
    };
    for (const id of group.projectIds) grouped.set(id, merged);
  }
  const emitted = new Set<string>();
  return projects.flatMap((project) => {
    const display = grouped.get(project.id) ?? project;
    if (emitted.has(display.id)) return [];
    emitted.add(display.id);
    return [display];
  });
}

interface GroupManagerOptions {
  readonly container: HTMLElement;
  readonly projects: readonly DesktopTaskProjectSummary[];
  readonly onChange: () => void;
}

interface GroupManagerState {
  readonly details: HTMLDetailsElement;
  readonly summary: HTMLElement;
  readonly status: HTMLParagraphElement;
  readonly signature: string;
  projects: readonly DesktopTaskProjectSummary[];
  onChange: () => void;
}

const managers = new WeakMap<HTMLElement, GroupManagerState>();

export function renderTaskProjectGroupManager(options: GroupManagerOptions): void {
  const { container } = options;
  const loaded = loadGroups();
  const signature = JSON.stringify([
    options.projects.map(({ id, name, root }) => [id, name, root]).sort((left, right) => left[0]!.localeCompare(right[0]!)),
    loaded,
  ]);
  const previous = managers.get(container);
  if (previous !== undefined && container.contains(previous.details)) {
    previous.projects = options.projects;
    previous.onChange = options.onChange;
    if (previous.details.open || previous.signature === signature) return;
  }
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = container.ownerDocument.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const details = element("details");
  details.className = "task-project-group-manager";
  const summary = element("summary", "Organize projects");
  const help = element("p", "Group project directories in this view. Tasks and directory access stay the same.");
  const status = element("p");
  status.className = "task-project-group-status";
  status.setAttribute("role", "status");
  const state: GroupManagerState = { details, summary, status, signature, projects: options.projects, onChange: options.onChange };
  managers.set(container, state);
  if (loaded.error !== null) {
    status.setAttribute("role", "alert");
    status.textContent = loaded.error;
  }
  const form = element("form");
  form.className = "task-project-group-editor";
  const nameLabel = element("label", "Group name");
  const name = element("input");
  name.className = "filter-input";
  name.type = "text";
  name.required = true;
  name.maxLength = 160;
  name.dataset.taskProjectGroupName = "";
  nameLabel.append(name);
  const choices = element("fieldset");
  choices.className = "task-project-group-choices";
  const inputs = new Map<string, HTMLInputElement>();
  let editingId: string | null = null;
  const renderChoices = (selected: readonly string[] = []) => {
    choices.replaceChildren(element("legend", "Projects to group"));
    inputs.clear();
    const groups = readTaskProjectGroups();
    const sorted = [...state.projects].sort((left, right) =>
      left.root.localeCompare(right.root) || left.id.localeCompare(right.id));
    for (const project of sorted) {
      const label = element("label");
      label.className = "task-project-group-choice";
      const input = element("input");
      input.type = "checkbox";
      input.value = project.id;
      input.checked = selected.includes(project.id);
      input.disabled = groups.some((group) => group.id !== editingId && group.projectIds.includes(project.id));
      input.dataset.taskProjectGroupMember = project.id;
      inputs.set(project.id, input);
      const identity = element("span");
      identity.dataset.noI18n = "";
      identity.append(element("strong", project.name), element("small", project.root));
      label.append(input, identity);
      choices.append(label);
    }
  };
  const reset = () => {
    editingId = null;
    name.value = "";
    status.textContent = "";
    renderChoices();
  };
  const redraw = (message: string) => {
    managers.delete(container);
    renderTaskProjectGroupManager({ container, projects: state.projects, onChange: state.onChange });
    const next = managers.get(container)!;
    next.details.open = true;
    next.status.textContent = message;
    next.status.setAttribute("role", "status");
    state.onChange();
    next.summary.focus();
  };
  const save = (groups: readonly TaskProjectGroup[], message: string) => {
    try {
      writeTaskProjectGroups(groups, state.projects);
    } catch (error) {
      status.setAttribute("role", "alert");
      status.textContent = error instanceof Error && error.message.startsWith("Choose at least")
        ? error.message : "Could not save project groups. Your project list is unchanged.";
      return;
    }
    redraw(message);
  };
  const saved = element("div");
  saved.className = "task-project-group-saved";
  for (const group of loaded.groups) {
    const row = element("div");
    const label = element("strong", group.name);
    label.dataset.noI18n = "";
    const edit = element("button", "Edit group");
    edit.className = "button button-ghost";
    edit.type = "button";
    edit.dataset.taskProjectGroupEdit = group.id;
    edit.addEventListener("click", () => {
      editingId = group.id;
      name.value = group.name;
      status.textContent = "";
      renderChoices(group.projectIds);
      name.focus();
    });
    const remove = element("button", "Ungroup");
    remove.className = "button button-ghost";
    remove.type = "button";
    remove.dataset.taskProjectGroupRemove = group.id;
    remove.addEventListener("click", () => save(
      readTaskProjectGroups().filter((current) => current.id !== group.id), "Project group removed."));
    row.append(label, edit, remove);
    saved.append(row);
  }
  const actions = element("div");
  actions.className = "task-project-group-actions";
  const submit = element("button", "Save group");
  submit.className = "button button-primary";
  submit.type = "submit";
  const cancel = element("button", "Cancel edit");
  cancel.className = "button button-ghost";
  cancel.type = "button";
  cancel.addEventListener("click", reset);
  actions.append(submit, cancel);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectIds = [...inputs].filter(([, input]) => input.checked).map(([id]) => id);
    const id = editingId !== null && projectIds.includes(editingId) ? editingId : projectIds[0] ?? "";
    save([...readTaskProjectGroups().filter((group) => group.id !== editingId),
      { id, name: name.value.trim(), projectIds }], "Project group saved.");
  });
  renderChoices();
  form.append(nameLabel, choices, actions);
  details.append(summary, help, saved, form, status);
  container.replaceChildren(details);
}
