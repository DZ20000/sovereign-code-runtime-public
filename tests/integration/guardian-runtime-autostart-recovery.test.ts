import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneController } from "../../packages/control-plane/src/controller.js";
import {
  DEFAULT_CONTROL_PLANE_SETTINGS,
  writeControlPlaneSettings,
} from "../../packages/control-plane/src/settings.js";

const cleanupPaths: string[] = [];

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function createController(userDataPath: string): ControlPlaneController {
  return new ControlPlaneController({
    userDataPath,
    nativeAgentPath: join(userDataPath, "SovereignNativeAgent.exe"),
    runCompletionNotificationsEnabled: false,
    shell: {
      chooseWorkspace: async () => null,
      chooseSecureTunnelExecutable: async () => null,
      protectSecret: async () => null,
      restoreSecret: async () => null,
      prompt: async () => 1,
    },
    approvalSurface: {
      present: async () => "deny",
    },
  });
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Guardian Runtime auto-start recovery", () => {
  it("reconstructs a running Runtime after the Guardian relaunches the Shell", async () => {
    const guardian = source(
      "apps/desktop-tauri/src-tauri/src/host_guardian.rs",
    );
    const startup = source("apps/desktop-tauri/src-tauri/src/startup.rs");
    const desktop = source("apps/desktop-tauri/src-tauri/src/lib.rs");
    const runtimeHost = source("apps/runtime-host/src/main.ts");

    expect(guardian).toContain('.arg("--restart-arg")');
    expect(guardian).toContain('.arg("--guardian-restart")');
    expect(startup).toContain(
      "argument == AUTOSTART_ARGUMENT || argument == GUARDIAN_RESTART_ARGUMENT",
    );
    expect(desktop).toContain(
      "RuntimeHostSupervisor::start(app.handle().clone())",
    );
    expect(runtimeHost).toContain("await active.initialize();");

    const root = await mkdtemp(join(tmpdir(), "scr-guardian-autostart-"));
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeControlPlaneSettings(join(root, "settings.json"), {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: true,
      secureTunnelAutoStart: true,
      secureTunnelAutoReconnect: true,
    });

    const beforeRestart = createController(root);
    try {
      await beforeRestart.initialize();
      expect(beforeRestart.state()).toMatchObject({
        phase: "running",
        workspaceRoot: resolve(workspaceRoot),
        autoStart: true,
        secureTunnel: {
          autoStart: true,
          autoReconnect: true,
        },
      });
      expect(beforeRestart.state().endpoint).not.toBeNull();
    } finally {
      await beforeRestart.shutdown();
    }

    const afterGuardianRestart = createController(root);
    try {
      await afterGuardianRestart.initialize();
      expect(afterGuardianRestart.state()).toMatchObject({
        phase: "running",
        workspaceRoot: resolve(workspaceRoot),
        autoStart: true,
      });
      expect(afterGuardianRestart.state().endpoint).not.toBeNull();
      expect(afterGuardianRestart.state().toolCount).toBeGreaterThan(0);
    } finally {
      await afterGuardianRestart.shutdown();
    }
  });
});
