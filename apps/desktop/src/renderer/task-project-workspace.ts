import type {
  DesktopPermissionProfile,
  DesktopProjectWorkspaces,
  SovereignDesktopApi,
} from "../shared.js";

interface ProjectWorkspaceOptions {
  readonly api: SovereignDesktopApi;
  readonly onChanged: () => Promise<void>;
}

export class TaskProjectWorkspaceController {
  readonly #api: SovereignDesktopApi;
  readonly #onChanged: () => Promise<void>;
  #projectId: string | null = null;
  #snapshot: DesktopProjectWorkspaces | null = null;
  #generation = 0;
  #busy = false;
  #error: string | null = null;

  constructor(options: ProjectWorkspaceOptions) {
    this.#api = options.api;
    this.#onChanged = options.onChanged;
  }

  get activeWorkspaceId(): string | null {
    return !this.#busy && this.#error === null && this.#snapshot?.selectedWorkspaceId === this.#snapshot?.activeWorkspaceId
      ? this.#snapshot?.activeWorkspaceId ?? null : null;
  }

  #element<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`Missing project workspace control: ${id}`);
    return element as T;
  }

  mount(): void {
    this.#element("task-project-workspace-choose").addEventListener("click", () => {
      void this.#change((projectId) => this.#api.chooseProjectWorkspace(projectId));
    });
    this.#element<HTMLSelectElement>("task-project-workspace-select").addEventListener("change", (event) => {
      const workspaceId = (event.currentTarget as HTMLSelectElement).value;
      if (workspaceId) void this.#change((projectId) =>
        this.#api.selectProjectWorkspace(projectId, workspaceId));
    });
    this.#element("task-project-workspace-retry").addEventListener("click", () => {
      void this.selectProject(this.#projectId);
    });
    this.#element<HTMLSelectElement>("task-project-workspace-permission").addEventListener("change", (event) => {
      const profile = (event.currentTarget as HTMLSelectElement).value as DesktopPermissionProfile;
      const workspaceId = this.#snapshot?.selectedWorkspaceId;
      if (workspaceId) void this.#change(async (projectId) => {
        await this.#api.setPermissionProfile(profile, workspaceId);
        return await this.#api.readProjectWorkspaces(projectId);
      });
    });
    this.#render();
  }

  async selectProject(projectId: string | null): Promise<void> {
    this.#projectId = projectId;
    this.#snapshot = null;
    this.#error = null;
    const generation = ++this.#generation;
    this.#busy = projectId !== null;
    this.#render();
    if (projectId === null) return;
    try {
      let snapshot = await this.#api.readProjectWorkspaces(projectId);
      if (generation !== this.#generation) return;
      this.#snapshot = snapshot;
      if (snapshot.selectedWorkspaceId !== null) {
        snapshot = await this.#api.selectProjectWorkspace(projectId, snapshot.selectedWorkspaceId);
        await this.#onChanged();
      }
      if (generation !== this.#generation) return;
      this.#snapshot = snapshot;
    } catch (error) {
      if (generation === this.#generation) this.#error = this.#errorMessage(error);
    } finally {
      if (generation === this.#generation) {
        this.#busy = false;
        this.#render();
      }
    }
  }

  async #change(operation: (projectId: string) => Promise<DesktopProjectWorkspaces>): Promise<void> {
    if (this.#busy || this.#projectId === null) return;
    const generation = ++this.#generation;
    const projectId = this.#projectId;
    this.#busy = true;
    this.#error = null;
    this.#render();
    try {
      const snapshot = await operation(projectId);
      await this.#onChanged();
      if (generation === this.#generation) this.#snapshot = snapshot;
    } catch (error) {
      if (generation === this.#generation) this.#error = this.#errorMessage(error);
    } finally {
      if (generation === this.#generation) {
        this.#busy = false;
        this.#render();
      }
    }
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Project workspaces could not be loaded. Try again.";
  }

  #render(): void {
    const section = this.#element("task-project-workspace");
    section.hidden = this.#projectId === null;
    section.setAttribute("aria-busy", String(this.#busy));
    const select = this.#element<HTMLSelectElement>("task-project-workspace-select");
    const workspaces = this.#snapshot?.workspaces ?? [];
    const signature = JSON.stringify(workspaces.map((workspace) => [workspace.id, workspace.root]));
    if (select.dataset.optionsSignature !== signature) {
      const options = workspaces.map((workspace) => {
        const option = document.createElement("option");
        option.value = workspace.id;
        option.textContent = workspace.root;
        option.dataset.noI18n = "";
        return option;
      });
      if (options.length === 0) {
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "No working directory selected";
        options.push(empty);
      }
      select.replaceChildren(...options);
      select.dataset.optionsSignature = signature;
    }
    select.value = this.#snapshot?.selectedWorkspaceId ?? "";
    select.disabled = this.#busy || workspaces.length === 0;
    this.#element<HTMLButtonElement>("task-project-workspace-choose").disabled = this.#busy;
    const retry = this.#element<HTMLButtonElement>("task-project-workspace-retry");
    retry.hidden = this.#error === null;
    retry.disabled = this.#busy;
    const selected = workspaces.find((workspace) => workspace.id === this.#snapshot?.selectedWorkspaceId);
    const permissions = this.#element<HTMLSelectElement>("task-project-workspace-permission");
    permissions.value = selected?.permissionProfile ?? "observe";
    permissions.disabled = this.#busy || selected === undefined;
    this.#element("task-project-workspace-access").hidden = selected === undefined;
    const status = this.#element("task-project-workspace-status");
    status.hidden = this.#error === null && !this.#busy && selected !== undefined && selected.id === this.#snapshot?.activeWorkspaceId;
    status.setAttribute("role", this.#error === null ? "status" : "alert");
    const text = this.#error ?? (this.#busy ? "Loading project workspace…" :
      selected === undefined ? "Choose a working directory for this project." :
      selected.id === this.#snapshot?.activeWorkspaceId ?
        "New desktop operations use this directory. Existing sessions keep their original directory." :
        "This project's saved directory is not active.");
    if (status.textContent !== text) status.textContent = text;
  }
}
