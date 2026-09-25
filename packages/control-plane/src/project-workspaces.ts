import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
  DesktopPermissionLevel,
  DesktopPermissionProfile,
  DesktopProjectWorkspace,
  DesktopProjectWorkspaces,
  DesktopRuntimeState,
} from "@sovereign/control-plane-contract";
import type { GatewayRuntimeHandle } from "@sovereign/gateway/runtime";
import { RuntimeError, type ToolSpec } from "@sovereign/runtime-core";
import type { ControlPlaneShellPort } from "./controller.js";
import type { ControlPlaneSettings } from "./settings.js";
import { existingDirectoryRoot, requiredText } from "./task-registry-model.js";

interface SavedWorkspace extends DesktopProjectWorkspace {
  readonly permissionBypassGrantEncrypted: string | null;
}
interface ProjectWorkspaceLink {
  readonly projectId: string;
  readonly workspaceIds: readonly string[];
  readonly selectedWorkspaceId: string | null;
}
export interface ProjectWorkspaceSettings {
  readonly workspaces: readonly SavedWorkspace[];
  readonly projects: readonly ProjectWorkspaceLink[];
  readonly active: { readonly projectId: string; readonly workspaceId: string } | null;
}
export const EMPTY_PROJECT_WORKSPACES: ProjectWorkspaceSettings = {
  workspaces: [], projects: [], active: null,
};

export function sameWorkspaceRoot(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function permissionLevel(value: unknown): DesktopPermissionLevel {
  return value === "workspace" || value === "consequential" ? value : "observe";
}

export function normalizeProjectWorkspaceSettings(value: unknown): ProjectWorkspaceSettings {
  if (!record(value) || !Array.isArray(value.workspaces) || !Array.isArray(value.projects) ||
      value.workspaces.length > 50 || value.projects.length > 50) return EMPTY_PROJECT_WORKSPACES;
  const workspaces: SavedWorkspace[] = [];
  const projects: ProjectWorkspaceLink[] = [];
  for (const entry of value.workspaces) {
    if (!record(entry) || !identifier(entry.id) || typeof entry.root !== "string" ||
        entry.root.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(entry.root) || !isAbsolute(entry.root) ||
        workspaces.some((current) => current.id === entry.id || sameWorkspaceRoot(current.root, entry.root as string))) {
      return EMPTY_PROJECT_WORKSPACES;
    }
    const rememberedPermissionProfile = permissionLevel(entry.rememberedPermissionProfile);
    const encrypted = typeof entry.permissionBypassGrantEncrypted === "string" &&
      entry.permissionBypassGrantEncrypted.length > 0 && entry.permissionBypassGrantEncrypted.length <= 16_384
      ? entry.permissionBypassGrantEncrypted : null;
    workspaces.push({
      id: entry.id, root: resolve(entry.root), rememberedPermissionProfile,
      permissionProfile: entry.permissionProfile === "bypass"
        ? encrypted === null ? rememberedPermissionProfile : "bypass" : permissionLevel(entry.permissionProfile),
      permissionBypassGrantEncrypted: encrypted,
      unattendedWorkspaceAccess: entry.unattendedWorkspaceAccess === true,
    });
  }
  for (const entry of value.projects) {
    if (!record(entry) || !identifier(entry.projectId) || projects.some((current) => current.projectId === entry.projectId) ||
        !Array.isArray(entry.workspaceIds) || entry.workspaceIds.length > 50 ||
        entry.workspaceIds.some((id) => !identifier(id) || !workspaces.some((workspace) => workspace.id === id)) ||
        new Set(entry.workspaceIds).size !== entry.workspaceIds.length ||
        (entry.selectedWorkspaceId !== null && !entry.workspaceIds.includes(entry.selectedWorkspaceId))) {
      return EMPTY_PROJECT_WORKSPACES;
    }
    projects.push({ projectId: entry.projectId, workspaceIds: entry.workspaceIds as string[],
      selectedWorkspaceId: entry.selectedWorkspaceId as string | null });
  }
  const active = value.active;
  if (active !== null && (!record(active) || !identifier(active.projectId) || !identifier(active.workspaceId) ||
      !projects.some((project) => project.projectId === active.projectId && project.workspaceIds.includes(active.workspaceId as string)))) {
    return EMPTY_PROJECT_WORKSPACES;
  }
  return { workspaces, projects, active: active as ProjectWorkspaceSettings["active"] };
}

export async function protectPermissionBypassGrant(shell: ControlPlaneShellPort, workspaceRoot: string): Promise<string> {
  const encoded = await shell.protectSecret(JSON.stringify({
    schemaVersion: "scr.permission-bypass-grant/v1", workspaceRoot: resolve(workspaceRoot), permissionProfile: "bypass",
  }));
  if (encoded === null) throw new Error("Windows protected storage is required to remember L4 for this workspace.");
  return encoded;
}

export async function restorePermissionBypassGrant(
  shell: ControlPlaneShellPort, workspaceRoot: string, encoded: string | null,
): Promise<string | null> {
  if (encoded === null) return null;
  const restored = await shell.restoreSecret(encoded);
  if (restored === null) return null;
  try {
    const grant: unknown = JSON.parse(restored.value);
    return record(grant) && grant.schemaVersion === "scr.permission-bypass-grant/v1" &&
      grant.permissionProfile === "bypass" && typeof grant.workspaceRoot === "string" &&
      sameWorkspaceRoot(grant.workspaceRoot, workspaceRoot) ? restored.encoded : null;
  } catch { return null; }
}

interface ProjectWorkspaceOptions {
  readonly settings: () => ControlPlaneSettings;
  readonly save: (settings: ControlPlaneSettings) => Promise<void>;
  readonly projectIdentity: (projectId: string) => { readonly id: string; readonly root: string };
  readonly runtime: () => GatewayRuntimeHandle | null;
  readonly shell: ControlPlaneShellPort;
}

export class ProjectWorkspaces {
  constructor(readonly options: ProjectWorkspaceOptions) {}

  #data(): ProjectWorkspaceSettings { return this.options.settings().projectWorkspaces; }
  async #save(data: ProjectWorkspaceSettings): Promise<void> {
    await this.options.save({ ...this.options.settings(), projectWorkspaces: data });
  }
  #workspace(workspaceId: string): SavedWorkspace {
    const id = requiredText(workspaceId, "Project workspace id", 128);
    const workspace = this.#data().workspaces.find((entry) => entry.id === id);
    if (workspace === undefined) throw new RuntimeError("WORKSPACE_NOT_FOUND", "Project workspace is not registered.", 404);
    return workspace;
  }
  #view(workspace: SavedWorkspace): DesktopProjectWorkspace {
    return { id: workspace.id, root: workspace.root, permissionProfile: workspace.permissionProfile,
      rememberedPermissionProfile: workspace.rememberedPermissionProfile,
      unattendedWorkspaceAccess: workspace.unattendedWorkspaceAccess };
  }
  #snapshot(projectId: string): DesktopProjectWorkspaces {
    const data = this.#data();
    const project = data.projects.find((entry) => entry.projectId === projectId);
    return { projectId, selectedWorkspaceId: project?.selectedWorkspaceId ?? null,
      activeWorkspaceId: this.options.runtime()?.activeWorkspaceId ?? null,
      workspaces: (project?.workspaceIds ?? []).map((id) => this.#view(this.#workspace(id))) };
  }
  active(): DesktopRuntimeState["activeDesktopWorkspace"] {
    const active = this.#data().active;
    if (active === null || this.options.runtime()?.activeWorkspaceId !== active.workspaceId) return null;
    return { ...this.#view(this.#workspace(active.workspaceId)), projectId: active.projectId };
  }
  permission(workspaceId: string): DesktopProjectWorkspace { return this.#view(this.#workspace(workspaceId)); }

  async initialize(): Promise<void> {
    const data = this.#data();
    let changed = false;
    const workspaces: SavedWorkspace[] = [];
    for (const workspace of data.workspaces) {
      const grant = workspace.permissionProfile === "bypass"
        ? await restorePermissionBypassGrant(this.options.shell, workspace.root, workspace.permissionBypassGrantEncrypted) : null;
      const restored = { ...workspace, permissionBypassGrantEncrypted: grant,
        permissionProfile: workspace.permissionProfile === "bypass" && grant === null
          ? workspace.rememberedPermissionProfile : workspace.permissionProfile };
      changed ||= restored.permissionProfile !== workspace.permissionProfile || grant !== workspace.permissionBypassGrantEncrypted;
      workspaces.push(restored);
    }
    if (changed) await this.#save({ ...data, workspaces });
  }

  async read(projectId: string): Promise<DesktopProjectWorkspaces> {
    const project = this.options.projectIdentity(projectId);
    const settings = this.options.settings();
    if (!this.#data().projects.some((entry) => entry.projectId === project.id) &&
        sameWorkspaceRoot(project.root, settings.workspaceRoot)) {
      await this.#remember(project.id, settings.workspaceRoot as string, false);
    }
    return this.#snapshot(project.id);
  }
  async choose(projectId: string): Promise<DesktopProjectWorkspaces> {
    const project = this.options.projectIdentity(projectId);
    const selected = await this.options.shell.chooseWorkspace();
    if (selected === null) return this.read(project.id);
    const root = existingDirectoryRoot(selected, "Selected project workspace").root;
    await this.#remember(project.id, root, true);
    return this.#snapshot(project.id);
  }
  async select(projectId: string, workspaceId: string): Promise<DesktopProjectWorkspaces> {
    const project = this.options.projectIdentity(projectId);
    const data = this.#data();
    const link = data.projects.find((entry) => entry.projectId === project.id);
    if (!link?.workspaceIds.includes(workspaceId)) {
      throw new RuntimeError("PATH_ESCAPE", "This workspace is not authorized for the selected project.", 403);
    }
    await this.#activate(this.#workspace(workspaceId), project.id, data);
    return this.#snapshot(project.id);
  }

  async #remember(projectId: string, root: string, activate: boolean): Promise<void> {
    const settings = this.options.settings();
    const data = this.#data();
    let workspace = data.workspaces.find((entry) => sameWorkspaceRoot(entry.root, root));
    if (workspace === undefined) {
      if (data.workspaces.length >= 50) throw new RuntimeError("POLICY_DENIED", "At most 50 project workspaces may be saved.", 409);
      const fromExistingAuthorization = sameWorkspaceRoot(root, settings.workspaceRoot);
      workspace = { id: `project-workspace-${randomUUID()}`, root,
        permissionProfile: fromExistingAuthorization ? settings.permissionProfile : "observe",
        rememberedPermissionProfile: fromExistingAuthorization ? settings.rememberedPermissionProfile : "observe",
        permissionBypassGrantEncrypted: fromExistingAuthorization ? settings.permissionBypassGrantEncrypted : null,
        unattendedWorkspaceAccess: fromExistingAuthorization && sameWorkspaceRoot(root, settings.unattendedWorkspaceRoot) };
    }
    const existing = data.projects.find((entry) => entry.projectId === projectId);
    if (existing === undefined && data.projects.length >= 50) {
      throw new RuntimeError("POLICY_DENIED", "At most 50 project workspace selections may be saved.", 409);
    }
    const link: ProjectWorkspaceLink = { projectId, selectedWorkspaceId: workspace.id,
      workspaceIds: [...new Set([...(existing?.workspaceIds ?? []), workspace.id])] };
    const next: ProjectWorkspaceSettings = { ...data,
      workspaces: data.workspaces.some((entry) => entry.id === workspace.id) ? data.workspaces : [...data.workspaces, workspace],
      projects: [...data.projects.filter((entry) => entry.projectId !== projectId), link] };
    if (activate) await this.#activate(workspace, projectId, next);
    else await this.#save(next);
  }
  async #register(runtime: GatewayRuntimeHandle, workspace: SavedWorkspace): Promise<void> {
    const root = existingDirectoryRoot(workspace.root, "Saved project workspace").root;
    if (!sameWorkspaceRoot(root, workspace.root)) {
      throw new RuntimeError("PATH_ESCAPE", "The saved workspace now resolves to a different directory. Choose it again to authorize that directory.", 403);
    }
    await runtime.registerWorkspace({ id: workspace.id, root, label: root, externalPermissionProfile: workspace.permissionProfile });
  }
  async #activate(workspace: SavedWorkspace, projectId: string, data: ProjectWorkspaceSettings): Promise<void> {
    const runtime = this.options.runtime();
    if (runtime !== null) await this.#register(runtime, workspace);
    else if (!sameWorkspaceRoot(existingDirectoryRoot(workspace.root, "Saved project workspace").root, workspace.root)) {
      throw new RuntimeError("PATH_ESCAPE", "The saved workspace now resolves to a different directory. Choose it again to authorize that directory.", 403);
    }
    await this.#save({ ...data, active: { projectId, workspaceId: workspace.id },
      projects: data.projects.map((entry) => entry.projectId === projectId ? { ...entry, selectedWorkspaceId: workspace.id } : entry) });
    runtime?.selectWorkspace(workspace.id);
  }
  async restoreRuntimeSelection(runtime: GatewayRuntimeHandle): Promise<string | null> {
    const active = this.#data().active;
    if (active === null) return null;
    try {
      this.options.projectIdentity(active.projectId);
      await this.#register(runtime, this.#workspace(active.workspaceId));
      runtime.selectWorkspace(active.workspaceId);
      return null;
    } catch (error) {
      return `The saved project workspace could not be selected: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async setPermissionProfile(workspaceId: string, profile: DesktopPermissionProfile): Promise<void> {
    const workspace = this.#workspace(workspaceId);
    if (!["observe", "workspace", "consequential", "bypass"].includes(profile)) {
      throw new RuntimeError("INVALID_INPUT", "Unknown permission profile.", 400);
    }
    if (workspace.permissionProfile === profile) return;
    let encrypted: string | null = null;
    if (profile === "bypass") {
      const response = await this.options.shell.prompt({ type: "warning", title: "Enable L4 for this project directory",
        message: "Give desktop tools full Sovereign runtime authority for this directory?",
        detail: `${workspace.root}\n\nL4 skips Sovereign approval prompts for desktop tools in this directory. Windows permissions and audit records remain enabled. Other directory permissions and connected agents are unchanged.`,
        buttons: ["Enable L4", "Cancel"], defaultId: 1, cancelId: 1 });
      if (response !== 0) return;
      encrypted = await protectPermissionBypassGrant(this.options.shell, workspace.root);
    }
    await this.#update({ ...workspace, permissionProfile: profile, permissionBypassGrantEncrypted: encrypted,
      rememberedPermissionProfile: profile === "bypass" ? workspace.rememberedPermissionProfile : profile });
  }
  async setUnattendedWorkspaceAccess(workspaceId: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new RuntimeError("INVALID_INPUT", "Workspace restore must be boolean.", 400);
    await this.#update({ ...this.#workspace(workspaceId), unattendedWorkspaceAccess: enabled });
  }
  async #update(workspace: SavedWorkspace): Promise<void> {
    const data = this.#data();
    await this.#save({ ...data, workspaces: data.workspaces.map((entry) => entry.id === workspace.id ? workspace : entry) });
    const runtime = this.options.runtime();
    if (runtime?.workspaces().some((entry) => entry.id === workspace.id)) {
      runtime.setExternalPermissionProfile(workspace.permissionProfile, workspace.id);
    }
  }
}

export async function authorizeDirectWorkspaceTool(options: {
  readonly spec: ToolSpec;
  readonly input: Readonly<Record<string, unknown>>;
  readonly workspace: { readonly id: string; readonly root: string; readonly permissionProfile: DesktopPermissionProfile };
  readonly sessionApprovals: Set<string>;
  readonly shell: ControlPlaneShellPort;
}): Promise<boolean> {
  const { spec, workspace, sessionApprovals, shell } = options;
  if (workspace.permissionProfile === "bypass" || spec.approvalMode === "none") return true;
  if (spec.approvalMode === "session" && sessionApprovals.has(workspace.id)) return true;
  const sessionApproval = spec.approvalMode === "session";
  const buttons = sessionApproval ? ["Allow for session", "Allow once", "Deny"] : ["Allow once", "Deny"];
  const label = spec.permissionLevel === "consequential" ? "L3 Consequential" : spec.permissionLevel === "workspace" ? "L2 Workspace" : "L1 Observe";
  const response = await shell.prompt({ type: spec.permissionLevel === "consequential" ? "warning" : "question",
    title: `${label} permission`, message: `Allow ${spec.name}?`,
    detail: `${spec.description}\n\nDirectory: ${workspace.root}\n\nApproval: ${spec.approvalMode}\n\n${JSON.stringify(options.input, null, 2).slice(0, 2_000)}`,
    buttons, defaultId: 0, cancelId: buttons.length - 1 });
  if (sessionApproval && response === 0) { sessionApprovals.add(workspace.id); return true; }
  return sessionApproval ? response === 1 : response === 0;
}
