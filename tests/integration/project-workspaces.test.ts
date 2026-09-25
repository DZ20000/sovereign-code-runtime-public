import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConPtySessionManager, type TerminalSessionRecord } from "../../packages/windows-adapter/dist/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneController, type ControlPlanePrompt } from "../../packages/control-plane/src/controller.js";
import { DEFAULT_CONTROL_PLANE_SETTINGS, writeControlPlaneSettings } from "../../packages/control-plane/src/settings.js";
import { defaultTaskDatabasePath, TaskRegistry } from "../../packages/control-plane/src/task-registry.js";
import { normalizeProjectWorkspaceSettings } from "../../packages/control-plane/src/project-workspaces.js";

const cleanup: string[] = [];
const controllers = new Set<ControlPlaneController>();
afterEach(async () => {
  for (const controller of controllers) await controller.shutdown();
  controllers.clear();
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-project-workspaces-"));
  cleanup.push(root);
  const a = join(root, "a");
  const b = join(root, "b");
  await Promise.all([mkdir(a), mkdir(b)]);
  const registry = new TaskRegistry({ databasePath: defaultTaskDatabasePath(root) });
  const task = registry.createTask({ projectRoot: a, title: "Project workspace" }, "chatgpt-web", a);
  const otherTask = registry.createTask({ projectRoot: b, title: "Other project" }, "other-agent", b);
  registry.close();
  await writeControlPlaneSettings(join(root, "settings.json"), {
    ...DEFAULT_CONTROL_PLANE_SETTINGS, workspaceRoot: a, autoStart: false,
  });
  const picker = vi.fn<() => Promise<string | null>>(async () => null);
  const prompt = vi.fn<(request: ControlPlanePrompt) => Promise<number>>(async () => 0);
  const create = async () => {
    const controller = new ControlPlaneController({
      userDataPath: root, nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell: {
        chooseWorkspace: picker, chooseSecureTunnelExecutable: async () => null, prompt,
        protectSecret: async (value) => `test:${Buffer.from(value).toString("base64")}`,
        restoreSecret: async (encoded) => encoded.startsWith("test:")
          ? { value: Buffer.from(encoded.slice(5), "base64").toString(), encoded } : null,
      },
      approvalSurface: { present: async () => "deny" },
    });
    controllers.add(controller);
    await controller.initialize();
    return controller;
  };
  const close = async (controller: ControlPlaneController) => {
    await controller.shutdown();
    controllers.delete(controller);
  };
  return { root, a, b, projectId: task.projectId, otherProjectId: otherTask.projectId, picker, prompt, create, close };
}

function terminalFixture() {
  const sessions = new Map<string, TerminalSessionRecord>();
  const start = vi.spyOn(ConPtySessionManager.prototype, "start").mockImplementation((input) => {
    const session: TerminalSessionRecord = {
      id: `session-${sessions.size}`, workspaceId: input.workspaceId, relativeCwd: input.relativeCwd,
      state: "running", createdAt: new Date().toISOString(), completedAt: null, processId: null,
      exitCode: null, columns: input.columns, rows: input.rows, output: "retained output",
      outputTruncated: false, error: null,
    };
    sessions.set(session.id, session);
    return session;
  });
  vi.spyOn(ConPtySessionManager.prototype, "get").mockImplementation((id) => sessions.get(id) ?? null);
  vi.spyOn(ConPtySessionManager.prototype, "list").mockImplementation((workspaceId) =>
    [...sessions.values()].filter((session) => workspaceId === undefined || session.workspaceId === workspaceId));
  const write = vi.spyOn(ConPtySessionManager.prototype, "write").mockImplementation((id) => sessions.get(id)!);
  const shutdown = vi.spyOn(ConPtySessionManager.prototype, "shutdown");
  return { start, write, shutdown };
}

describe("desktop project workspaces", () => {
  it("remembers each selected directory and its permission without changing the connected Agent workspace", async () => {
    const f = await fixture();
    const first = await f.create();
    await first.setPermissionProfile("bypass");
    await first.setUnattendedWorkspaceAccess(true);
    await first.start();
    const connection = first.connectionBundle().serialized;
    const generation = first.state().credentialGeneration;
    const initial = await first.readProjectWorkspaces(f.projectId);
    const aId = initial.workspaces[0]!.id;
    expect(initial.workspaces[0]).toMatchObject({ root: f.a, permissionProfile: "bypass", unattendedWorkspaceAccess: true });
    expect(JSON.stringify(initial)).not.toContain("permissionBypassGrantEncrypted");
    await first.selectProjectWorkspace(f.projectId, aId);
    f.picker.mockResolvedValueOnce(f.b);
    const added = await first.chooseProjectWorkspace(f.projectId);
    const bId = added.selectedWorkspaceId!;
    expect(added.workspaces).toHaveLength(2);
    expect(added.workspaces.find((entry) => entry.id === bId)).toMatchObject({ root: f.b, permissionProfile: "observe", unattendedWorkspaceAccess: false });
    await first.setPermissionProfile("consequential", bId);
    await first.setPermissionProfile("bypass", bId);
    await first.setUnattendedWorkspaceAccess(true, bId);
    expect(first.state()).toMatchObject({
      workspaceRoot: f.a, permissionProfile: "bypass", credentialGeneration: generation,
      activeDesktopWorkspace: { id: bId, root: f.b, permissionProfile: "bypass", rememberedPermissionProfile: "consequential" },
    });
    expect(first.connectionBundle().serialized).toBe(connection);
    await first.setPermissionProfile("observe");
    expect(first.state().activeDesktopWorkspace?.permissionProfile).toBe("bypass");
    await first.selectProjectWorkspace(f.projectId, aId);
    await first.selectProjectWorkspace(f.projectId, bId);
    expect(first.state().credentialGeneration).toBe(generation);
    await f.close(first);

    const second = await f.create();
    expect((await second.readProjectWorkspaces(f.projectId)).selectedWorkspaceId).toBe(bId);
    await second.start();
    expect(second.state()).toMatchObject({
      workspaceRoot: f.a, permissionProfile: "observe",
      activeDesktopWorkspace: { id: bId, root: f.b, permissionProfile: "bypass", unattendedWorkspaceAccess: true },
    });
    const restored = await second.readProjectWorkspaces(f.projectId);
    expect(restored.workspaces.find((entry) => entry.id === aId)?.permissionProfile).toBe("bypass");
    await second.selectProjectWorkspace(f.projectId, aId);
    expect(second.state().activeDesktopWorkspace?.permissionProfile).toBe("bypass");
  });

  it("uses the terminal owner's permission after switching and captures the chosen root before approval", async () => {
    const terminal = terminalFixture();
    const f = await fixture();
    const controller = await f.create();
    await controller.start();
    const aId = (await controller.readProjectWorkspaces(f.projectId)).selectedWorkspaceId!;
    await controller.selectProjectWorkspace(f.projectId, aId);
    const aTerminal = await controller.invokeTool("terminal.session.create", { workspaceId: f.b }) as TerminalSessionRecord;
    expect(aTerminal.workspaceId).toBe(aId);
    f.picker.mockResolvedValueOnce(f.b);
    const bId = (await controller.chooseProjectWorkspace(f.projectId)).selectedWorkspaceId!;
    await controller.setPermissionProfile("bypass", bId);
    expect(terminal.shutdown).not.toHaveBeenCalled();
    await expect(controller.invokeTool("terminal.session.read", { sessionId: aTerminal.id, workspaceId: bId }))
      .resolves.toMatchObject({ workspaceId: aId, output: "retained output" });
    f.prompt.mockClear();
    f.prompt.mockResolvedValueOnce(1);
    await expect(controller.invokeTool("terminal.session.write", { sessionId: aTerminal.id, data: "whoami", workspaceId: bId }))
      .rejects.toThrow("denied");
    expect(f.prompt.mock.calls[0]![0].detail).toContain(f.a);
    expect(terminal.write).not.toHaveBeenCalled();
    await controller.invokeTool("terminal.session.create", {});
    expect(f.prompt).toHaveBeenCalledTimes(1);

    await controller.setPermissionProfile("observe", bId);
    let allow: ((value: number) => void) | undefined;
    f.prompt.mockImplementationOnce(async () => await new Promise<number>((resolve) => { allow = resolve; }));
    const pending = controller.invokeTool("terminal.session.create", {});
    await vi.waitFor(() => expect(allow).toBeTypeOf("function"));
    await controller.selectProjectWorkspace(f.projectId, aId);
    allow!(0);
    await expect(pending).resolves.toMatchObject({ workspaceId: bId });
    expect(terminal.start.mock.calls.at(-1)?.[0].absoluteCwd).toBe(f.b);
  });

  it("accepts only registered project and workspace ids and keeps selection when the picker is cancelled", async () => {
    const f = await fixture();
    const controller = await f.create();
    await expect(controller.chooseProjectWorkspace("unknown-project")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(f.picker).not.toHaveBeenCalled();
    await expect(controller.readProjectWorkspaces(f.otherProjectId)).resolves.toMatchObject({ workspaces: [] });
    const initial = await controller.readProjectWorkspaces(f.projectId);
    await expect(controller.selectProjectWorkspace(f.projectId, f.b)).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(controller.selectProjectWorkspace(f.otherProjectId, initial.selectedWorkspaceId!)).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(controller.setPermissionProfile("bypass", f.b)).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    const before = await readFile(join(f.root, "settings.json"), "utf8");
    expect(await controller.chooseProjectWorkspace(f.projectId)).toEqual(initial);
    expect(await readFile(join(f.root, "settings.json"), "utf8")).toBe(before);
  });

  it("keeps the base runtime available when a saved project directory is missing on restart", async () => {
    const f = await fixture();
    const first = await f.create();
    f.picker.mockResolvedValueOnce(f.b);
    const selected = await first.chooseProjectWorkspace(f.projectId);
    await f.close(first);
    await rename(f.b, join(f.root, "b-moved"));
    const second = await f.create();
    await second.start();
    expect(second.state()).toMatchObject({ phase: "running", workspaceRoot: f.a, activeDesktopWorkspace: null });
    expect(second.state().errorMessage).toContain("saved project workspace could not be selected");
    await expect(second.selectProjectWorkspace(f.projectId, selected.selectedWorkspaceId!)).rejects.toThrow();
    expect(second.state().activeDesktopWorkspace).toBeNull();
    expect(second.connectionBundle().endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/u);
  });

  it("rejects an L4 grant copied from another directory and preserves the remembered lower level", async () => {
    const f = await fixture();
    const first = await f.create();
    await first.setPermissionProfile("bypass");
    const initial = await first.readProjectWorkspaces(f.projectId);
    f.picker.mockResolvedValueOnce(f.b);
    const bId = (await first.chooseProjectWorkspace(f.projectId)).selectedWorkspaceId!;
    await first.setPermissionProfile("consequential", bId);
    await f.close(first);
    const settingsPath = join(f.root, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const source = settings.projectWorkspaces.workspaces.find((entry: { id: string }) => entry.id === initial.selectedWorkspaceId);
    const target = settings.projectWorkspaces.workspaces.find((entry: { id: string }) => entry.id === bId);
    target.permissionProfile = "bypass";
    target.permissionBypassGrantEncrypted = source.permissionBypassGrantEncrypted;
    await writeControlPlaneSettings(settingsPath, settings);
    const second = await f.create();
    expect((await second.readProjectWorkspaces(f.projectId)).workspaces.find((entry) => entry.id === bId)?.permissionProfile).toBe("consequential");
    target.permissionBypassGrantEncrypted = null;
    expect(normalizeProjectWorkspaceSettings(settings.projectWorkspaces).workspaces.find((entry) => entry.id === bId)?.permissionProfile).toBe("consequential");
  });
});
