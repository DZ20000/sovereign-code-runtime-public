import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ControlPlaneController,
  type ControlPlanePrompt,
  type ProtectedSecretRestore,
} from "../../packages/control-plane/src/controller.js";
import {
  CURRENT_PERMISSION_MODEL_VERSION,
  DEFAULT_CONTROL_PLANE_SETTINGS,
  writeControlPlaneSettings,
} from "../../packages/control-plane/src/settings.js";

const cleanupPaths: string[] = [];
const TEST_PROTECTED_PREFIX = "test-dpapi:";
const BYPASS_GRANT_SCHEMA_VERSION = "scr.permission-bypass-grant/v1";

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface ControllerFixtureOptions {
  readonly chooseWorkspace?: () => Promise<string | null>;
  readonly prompt?: (request: ControlPlanePrompt) => Promise<number>;
  readonly promptResponse?: number;
  readonly protectSecret?: (value: string) => Promise<string | null>;
  readonly restoreSecret?: (encoded: string) => Promise<ProtectedSecretRestore | null>;
}

function protectTestSecret(value: string): string {
  return `${TEST_PROTECTED_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
}

function restoreTestSecret(encoded: string): ProtectedSecretRestore | null {
  if (!encoded.startsWith(TEST_PROTECTED_PREFIX)) {
    return null;
  }
  try {
    return {
      value: Buffer.from(encoded.slice(TEST_PROTECTED_PREFIX.length), "base64").toString("utf8"),
      encoded,
    };
  } catch {
    return null;
  }
}

function bypassGrant(workspaceRoot: string): string {
  return JSON.stringify({
    schemaVersion: BYPASS_GRANT_SCHEMA_VERSION,
    workspaceRoot: resolve(workspaceRoot),
    permissionProfile: "bypass",
  });
}

function createController(
  userDataPath: string,
  options: ControllerFixtureOptions = {},
): ControlPlaneController {
  return new ControlPlaneController({
    userDataPath,
    nativeAgentPath: join(userDataPath, "SovereignNativeAgent.exe"),
    shell: {
      chooseWorkspace: options.chooseWorkspace ?? (async () => null),
      chooseSecureTunnelExecutable: async () => null,
      protectSecret: options.protectSecret ?? (async (value) => protectTestSecret(value)),
      restoreSecret: options.restoreSecret ?? (async (encoded) => restoreTestSecret(encoded)),
      prompt: options.prompt ?? (async () => options.promptResponse ?? 1),
    },
    approvalSurface: {
      present: async () => "deny",
    },
  });
}

async function readPersistedSettings(settingsPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
}

function legacySettings(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const settings = { ...DEFAULT_CONTROL_PLANE_SETTINGS } as Record<string, unknown>;
  delete settings.permissionModelVersion;
  return { ...settings, ...overrides };
}

describe("remembered workspace permission", () => {
  it("restores L1-L3 and does not overwrite the selection when unattended access changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-remembered-"));
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const settingsPath = join(root, "settings.json");
    await writeControlPlaneSettings(settingsPath, {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: false,
    });

    const first = createController(root);
    await first.initialize();
    expect(first.state().permissionProfile).toBe("observe");
    expect(first.state().rememberedPermissionProfile).toBe("observe");

    const selected = await first.setPermissionProfile("consequential");
    expect(selected.permissionProfile).toBe("consequential");
    expect(selected.rememberedPermissionProfile).toBe("consequential");
    expect(selected.unattendedWorkspaceAccess).toBe(false);
    await first.shutdown();

    const second = createController(root);
    await second.initialize();
    expect(second.state().permissionProfile).toBe("consequential");
    expect(second.state().rememberedPermissionProfile).toBe("consequential");
    expect(second.state().unattendedWorkspaceAccess).toBe(false);

    const enabled = await second.setUnattendedWorkspaceAccess(true);
    expect(enabled.unattendedWorkspaceAccess).toBe(true);
    expect(enabled.permissionProfile).toBe("consequential");
    expect(enabled.rememberedPermissionProfile).toBe("consequential");

    const disabled = await second.setUnattendedWorkspaceAccess(false);
    expect(disabled.unattendedWorkspaceAccess).toBe(false);
    expect(disabled.permissionProfile).toBe("consequential");
    expect(disabled.rememberedPermissionProfile).toBe("consequential");

    await second.setUnattendedWorkspaceAccess(true);
    await second.shutdown();

    const third = createController(root);
    await third.initialize();
    expect(third.state().unattendedWorkspaceAccess).toBe(true);
    expect(third.state().permissionProfile).toBe("consequential");
    expect(third.state().rememberedPermissionProfile).toBe("consequential");

    const explicitL1 = await third.setPermissionProfile("observe");
    expect(explicitL1.unattendedWorkspaceAccess).toBe(true);
    expect(explicitL1.permissionProfile).toBe("observe");
    expect(explicitL1.rememberedPermissionProfile).toBe("observe");
    const persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionModelVersion).toBe(CURRENT_PERMISSION_MODEL_VERSION);
    expect(persisted.unattendedWorkspaceRoot).toBe(resolve(workspaceRoot));
    expect(persisted.permissionProfile).toBe("observe");
    expect(persisted.rememberedPermissionProfile).toBe("observe");
    expect(persisted.permissionBypassGrantEncrypted).toBeNull();
    expect(persisted.permissionWorkspaceRoot).toBe(resolve(workspaceRoot));
    await third.shutdown();
  });

  it("keeps L1 active when workspace restore is enabled, disabled and restored after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-workspace-restore-l1-"));
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const settingsPath = join(root, "settings.json");
    await writeControlPlaneSettings(settingsPath, {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: false,
    });

    const first = createController(root);
    await first.initialize();
    const enabled = await first.setUnattendedWorkspaceAccess(true);
    expect(enabled.unattendedWorkspaceAccess).toBe(true);
    expect(enabled.permissionProfile).toBe("observe");
    expect(enabled.rememberedPermissionProfile).toBe("observe");
    let persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionModelVersion).toBe(CURRENT_PERMISSION_MODEL_VERSION);
    expect(persisted.permissionProfile).toBe("observe");
    expect(persisted.rememberedPermissionProfile).toBe("observe");
    expect(persisted.permissionWorkspaceRoot).toBe(resolve(workspaceRoot));
    expect(persisted.unattendedWorkspaceRoot).toBe(resolve(workspaceRoot));
    await first.shutdown();

    const second = createController(root);
    await second.initialize();
    expect(second.state().unattendedWorkspaceAccess).toBe(true);
    expect(second.state().permissionProfile).toBe("observe");
    expect(second.state().rememberedPermissionProfile).toBe("observe");

    const disabled = await second.setUnattendedWorkspaceAccess(false);
    expect(disabled.unattendedWorkspaceAccess).toBe(false);
    expect(disabled.permissionProfile).toBe("observe");
    expect(disabled.rememberedPermissionProfile).toBe("observe");
    persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionProfile).toBe("observe");
    expect(persisted.rememberedPermissionProfile).toBe("observe");
    expect(persisted.unattendedWorkspaceRoot).toBeNull();
    await second.shutdown();
  });

  it("persists an explicitly confirmed L4 selection and restores it without prompting again", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-bypass-persisted-"));
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const settingsPath = join(root, "settings.json");
    await writeControlPlaneSettings(settingsPath, {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: false,
    });

    const firstPrompts: ControlPlanePrompt[] = [];
    const first = createController(root, {
      prompt: async (request) => {
        firstPrompts.push(request);
        return 0;
      },
    });
    await first.initialize();
    await first.setPermissionProfile("consequential");
    const bypass = await first.setPermissionProfile("bypass");
    expect(bypass.permissionProfile).toBe("bypass");
    expect(bypass.rememberedPermissionProfile).toBe("consequential");
    expect(firstPrompts).toHaveLength(1);
    expect(firstPrompts[0]).toMatchObject({
      title: "Enable and remember L4 Bypass",
      defaultId: 1,
      cancelId: 1,
    });

    let persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionProfile).toBe("bypass");
    expect(persisted.rememberedPermissionProfile).toBe("consequential");
    expect(persisted.permissionWorkspaceRoot).toBe(resolve(workspaceRoot));
    expect(persisted.permissionBypassGrantEncrypted).toEqual(expect.stringMatching(/^test-dpapi:/u));
    await first.shutdown();

    const restartPrompts: ControlPlanePrompt[] = [];
    const second = createController(root, {
      prompt: async (request) => {
        restartPrompts.push(request);
        return 1;
      },
    });
    await second.initialize();
    expect(second.state().permissionProfile).toBe("bypass");
    expect(second.state().rememberedPermissionProfile).toBe("consequential");
    expect(restartPrompts).toEqual([]);

    const revoked = await second.setPermissionProfile(second.state().rememberedPermissionProfile);
    expect(revoked.permissionProfile).toBe("consequential");
    expect(revoked.rememberedPermissionProfile).toBe("consequential");
    persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionProfile).toBe("consequential");
    expect(persisted.rememberedPermissionProfile).toBe("consequential");
    expect(persisted.permissionBypassGrantEncrypted).toBeNull();
    await second.shutdown();

    const third = createController(root);
    await third.initialize();
    expect(third.state().permissionProfile).toBe("consequential");
    expect(third.state().rememberedPermissionProfile).toBe("consequential");
    await third.shutdown();
  });

  it("does not enable L4 when Windows protected storage cannot retain the grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-bypass-protection-failure-"));
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const settingsPath = join(root, "settings.json");
    await writeControlPlaneSettings(settingsPath, {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: false,
    });

    const controller = createController(root, {
      promptResponse: 0,
      protectSecret: async () => null,
    });
    await controller.initialize();
    await expect(controller.setPermissionProfile("bypass")).rejects.toThrow(
      "Windows protected storage is required to remember L4",
    );
    expect(controller.state().permissionProfile).toBe("observe");
    expect(controller.state().rememberedPermissionProfile).toBe("observe");
    const persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionProfile).toBe("observe");
    expect(persisted.permissionBypassGrantEncrypted).toBeNull();
    await controller.shutdown();
  });

  it("fails back to the remembered L1-L3 profile when a persisted L4 grant is missing or unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-invalid-bypass-"));
    cleanupPaths.push(root);
    const workspaceRoot = resolve(join(root, "workspace"));
    const settingsPath = join(root, "settings.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        ...DEFAULT_CONTROL_PLANE_SETTINGS,
        workspaceRoot,
        permissionWorkspaceRoot: workspaceRoot,
        permissionProfile: "bypass",
        rememberedPermissionProfile: "workspace",
        permissionBypassGrantEncrypted: "forged-or-corrupt",
        autoStart: false,
      }, null, 2)}\n`,
      "utf8",
    );

    const controller = createController(root);
    await controller.initialize();
    expect(controller.state().permissionProfile).toBe("workspace");
    expect(controller.state().rememberedPermissionProfile).toBe("workspace");
    const persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionProfile).toBe("workspace");
    expect(persisted.rememberedPermissionProfile).toBe("workspace");
    expect(persisted.permissionBypassGrantEncrypted).toBeNull();
    await controller.shutdown();
  });

  it("keeps L4 and its L1 fallback unchanged while workspace restore toggles", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-bypass-unattended-"));
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const settingsPath = join(root, "settings.json");
    await writeControlPlaneSettings(settingsPath, {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: false,
    });

    const first = createController(root, { promptResponse: 0 });
    await first.initialize();
    await first.setPermissionProfile("bypass");
    const enabled = await first.setUnattendedWorkspaceAccess(true);
    expect(enabled.permissionProfile).toBe("bypass");
    expect(enabled.rememberedPermissionProfile).toBe("observe");
    expect(enabled.unattendedWorkspaceAccess).toBe(true);

    const disabled = await first.setUnattendedWorkspaceAccess(false);
    expect(disabled.permissionProfile).toBe("bypass");
    expect(disabled.rememberedPermissionProfile).toBe("observe");
    expect(disabled.unattendedWorkspaceAccess).toBe(false);
    await first.setUnattendedWorkspaceAccess(true);
    await first.shutdown();

    const second = createController(root);
    await second.initialize();
    expect(second.state().permissionProfile).toBe("bypass");
    expect(second.state().rememberedPermissionProfile).toBe("observe");
    expect(second.state().unattendedWorkspaceAccess).toBe(true);
    const persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionModelVersion).toBe(CURRENT_PERMISSION_MODEL_VERSION);
    expect(persisted.permissionProfile).toBe("bypass");
    expect(persisted.rememberedPermissionProfile).toBe("observe");
    expect(persisted.unattendedWorkspaceRoot).toBe(resolve(workspaceRoot));
    expect(persisted.permissionBypassGrantEncrypted).toEqual(expect.stringMatching(/^test-dpapi:/u));
    await second.shutdown();
  });

  it("preserves L4 across a trusted local workspace change by rebinding its protected grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-bypass-workspace-change-"));
    cleanupPaths.push(root);
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const settingsPath = join(root, "settings.json");
    await writeControlPlaneSettings(settingsPath, {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot: workspaceA,
      autoStart: false,
    });

    const first = createController(root, {
      chooseWorkspace: async () => workspaceB,
      promptResponse: 0,
    });
    await first.initialize();
    await first.setPermissionProfile("consequential");
    await first.setPermissionProfile("bypass");
    await first.setUnattendedWorkspaceAccess(true);

    const changed = await first.chooseWorkspace();
    expect(changed.workspaceRoot).toBe(resolve(workspaceB));
    expect(changed.unattendedWorkspaceAccess).toBe(false);
    expect(changed.permissionProfile).toBe("bypass");
    expect(changed.rememberedPermissionProfile).toBe("consequential");

    const persisted = await readPersistedSettings(settingsPath);
    expect(persisted.workspaceRoot).toBe(resolve(workspaceB));
    expect(persisted.permissionWorkspaceRoot).toBe(resolve(workspaceB));
    expect(persisted.permissionProfile).toBe("bypass");
    expect(persisted.rememberedPermissionProfile).toBe("consequential");
    expect(persisted.unattendedWorkspaceRoot).toBeNull();
    const encryptedGrant = persisted.permissionBypassGrantEncrypted;
    expect(typeof encryptedGrant).toBe("string");
    const restored = restoreTestSecret(encryptedGrant as string);
    expect(restored).not.toBeNull();
    expect(JSON.parse(restored?.value ?? "null")).toMatchObject({
      workspaceRoot: resolve(workspaceB),
      permissionProfile: "bypass",
    });
    await first.shutdown();

    const second = createController(root);
    await second.initialize();
    expect(second.state().workspaceRoot).toBe(resolve(workspaceB));
    expect(second.state().permissionProfile).toBe("bypass");
    expect(second.state().rememberedPermissionProfile).toBe("consequential");
    await second.shutdown();
  });

  it("fails closed when a remembered permission or L4 grant is bound to another workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-mismatch-"));
    cleanupPaths.push(root);
    const settingsPath = join(root, "settings.json");
    const workspaceA = resolve(join(root, "workspace-a"));
    const workspaceB = resolve(join(root, "workspace-b"));
    await writeControlPlaneSettings(settingsPath, {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot: workspaceB,
      permissionWorkspaceRoot: workspaceA,
      permissionProfile: "bypass",
      rememberedPermissionProfile: "consequential",
      permissionBypassGrantEncrypted: protectTestSecret(bypassGrant(workspaceA)),
      unattendedWorkspaceRoot: workspaceA,
      autoStart: false,
    });

    const controller = createController(root);
    await controller.initialize();
    expect(controller.state().unattendedWorkspaceAccess).toBe(false);
    expect(controller.state().permissionProfile).toBe("observe");
    expect(controller.state().rememberedPermissionProfile).toBe("observe");
    const persisted = await readPersistedSettings(settingsPath);
    expect(persisted.unattendedWorkspaceRoot).toBeNull();
    expect(persisted.workspaceRoot).toBe(workspaceB);
    expect(persisted.permissionWorkspaceRoot).toBe(workspaceB);
    expect(persisted.permissionProfile).toBe("observe");
    expect(persisted.rememberedPermissionProfile).toBe("observe");
    expect(persisted.permissionBypassGrantEncrypted).toBeNull();
    await controller.shutdown();
  });

  it("migrates an old unattended binding to L1 without disabling workspace restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-legacy-"));
    cleanupPaths.push(root);
    const workspaceRoot = resolve(join(root, "workspace"));
    const settingsPath = join(root, "settings.json");
    const legacySettings = {
      workspaceRoot,
      unattendedWorkspaceRoot: workspaceRoot,
      autoStart: false,
      webBridgeUrl: null,
      secureTunnelId: null,
      secureTunnelExecutablePath: null,
      secureTunnelExecutableSha256: null,
      secureTunnelRuntimeKeyEncrypted: null,
      secureTunnelControlPlaneProxyEncrypted: null,
      secureTunnelControlPlaneBackupProxyEncrypted: null,
      secureTunnelControlPlaneDirectFallback: false,
      secureTunnelAutoStart: false,
      secureTunnelAutoReconnect: true,
    };
    await writeFile(settingsPath, `${JSON.stringify(legacySettings, null, 2)}\n`, "utf8");

    const controller = createController(root);
    await controller.initialize();
    expect(controller.state().unattendedWorkspaceAccess).toBe(true);
    expect(controller.state().permissionProfile).toBe("observe");
    expect(controller.state().rememberedPermissionProfile).toBe("observe");
    const persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionModelVersion).toBe(CURRENT_PERMISSION_MODEL_VERSION);
    expect(persisted.permissionProfile).toBe("observe");
    expect(persisted.rememberedPermissionProfile).toBe("observe");
    expect(persisted.permissionWorkspaceRoot).toBe(workspaceRoot);
    expect(persisted.unattendedWorkspaceRoot).toBe(workspaceRoot);
    expect(persisted.permissionBypassGrantEncrypted).toBeNull();
    await controller.shutdown();
  });

  it("preserves an unbound version-1 L2 because it may have been selected explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-legacy-l2-"));
    cleanupPaths.push(root);
    const workspaceRoot = resolve(join(root, "workspace"));
    const settingsPath = join(root, "settings.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify(legacySettings({
        workspaceRoot,
        permissionWorkspaceRoot: workspaceRoot,
        permissionProfile: "workspace",
        rememberedPermissionProfile: "workspace",
        unattendedWorkspaceRoot: null,
        autoStart: false,
      }), null, 2)}
`,
      "utf8",
    );

    const first = createController(root);
    await first.initialize();
    expect(first.state().permissionProfile).toBe("workspace");
    expect(first.state().rememberedPermissionProfile).toBe("workspace");
    expect(first.state().unattendedWorkspaceAccess).toBe(false);
    const persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionModelVersion).toBe(CURRENT_PERMISSION_MODEL_VERSION);
    expect(persisted.permissionProfile).toBe("workspace");
    expect(persisted.rememberedPermissionProfile).toBe("workspace");
    expect(persisted.unattendedWorkspaceRoot).toBeNull();
    await first.shutdown();
  });

  it("preserves a valid legacy L4 grant but migrates its implicit L2 fallback to L1", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-legacy-l4-fallback-"));
    cleanupPaths.push(root);
    const workspaceRoot = resolve(join(root, "workspace"));
    const settingsPath = join(root, "settings.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify(legacySettings({
        workspaceRoot,
        permissionWorkspaceRoot: workspaceRoot,
        permissionProfile: "bypass",
        rememberedPermissionProfile: "workspace",
        permissionBypassGrantEncrypted: protectTestSecret(bypassGrant(workspaceRoot)),
        unattendedWorkspaceRoot: workspaceRoot,
        autoStart: false,
      }), null, 2)}
`,
      "utf8",
    );

    const first = createController(root);
    await first.initialize();
    expect(first.state().permissionProfile).toBe("bypass");
    expect(first.state().rememberedPermissionProfile).toBe("observe");
    expect(first.state().unattendedWorkspaceAccess).toBe(true);
    let persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionModelVersion).toBe(CURRENT_PERMISSION_MODEL_VERSION);
    expect(persisted.permissionProfile).toBe("bypass");
    expect(persisted.rememberedPermissionProfile).toBe("observe");
    expect(persisted.unattendedWorkspaceRoot).toBe(workspaceRoot);
    expect(persisted.permissionBypassGrantEncrypted).toEqual(expect.stringMatching(/^test-dpapi:/u));
    await first.shutdown();

    const second = createController(root);
    await second.initialize();
    expect(second.state().permissionProfile).toBe("bypass");
    expect(second.state().rememberedPermissionProfile).toBe("observe");
    expect(second.state().unattendedWorkspaceAccess).toBe(true);
    persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionModelVersion).toBe(CURRENT_PERMISSION_MODEL_VERSION);
    await second.shutdown();
  });

  it("does not restore an unbound profile when no workspace is authorized", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-permission-no-workspace-"));
    cleanupPaths.push(root);
    const settingsPath = join(root, "settings.json");
    await writeControlPlaneSettings(settingsPath, {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot: null,
      permissionWorkspaceRoot: null,
      permissionProfile: "bypass",
      rememberedPermissionProfile: "consequential",
      permissionBypassGrantEncrypted: protectTestSecret(bypassGrant(join(root, "workspace"))),
      autoStart: false,
    });

    const controller = createController(root);
    await controller.initialize();
    expect(controller.state().workspaceRoot).toBeNull();
    expect(controller.state().permissionProfile).toBe("observe");
    expect(controller.state().rememberedPermissionProfile).toBe("observe");
    const persisted = await readPersistedSettings(settingsPath);
    expect(persisted.permissionWorkspaceRoot).toBeNull();
    expect(persisted.permissionProfile).toBe("observe");
    expect(persisted.rememberedPermissionProfile).toBe("observe");
    expect(persisted.permissionBypassGrantEncrypted).toBeNull();
    await controller.shutdown();
  });
});
