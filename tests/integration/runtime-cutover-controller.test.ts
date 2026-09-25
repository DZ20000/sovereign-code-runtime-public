import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneController } from "../../packages/control-plane/src/controller.js";
import {
  DEFAULT_CONTROL_PLANE_SETTINGS,
  writeControlPlaneSettings,
} from "../../packages/control-plane/src/settings.js";
import type { SovereignConnectionBundle } from "../../packages/control-plane-contract/src/connection.js";

const cleanupPaths: string[] = [];

function shellPort() {
  return {
    chooseWorkspace: async () => null,
    chooseSecureTunnelExecutable: async () => null,
    protectSecret: async () => null,
    restoreSecret: async () => null,
    prompt: async () => 1,
  };
}

function authorization(controller: ControlPlaneController): string {
  const connection = controller.connectionBundle();
  const bundle = JSON.parse(connection.serialized) as SovereignConnectionBundle;
  return bundle.transport.headers.Authorization;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ControlPlaneController Runtime cutover identity", () => {
  it("preserves a supervisor-supplied Gateway bearer credential across local Gateway restarts", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "scr-runtime-cutover-controller-"),
    );
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeControlPlaneSettings(join(root, "settings.json"), {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: false,
    });
    const gatewayBearerToken = "A".repeat(43);
    const controller = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      gatewayBearerToken,
      shell: shellPort(),
      approvalSurface: {
        present: async () => "deny",
      },
    });

    try {
      await controller.initialize();
      await controller.start();
      expect(authorization(controller)).toBe(`Bearer ${gatewayBearerToken}`);

      await controller.stop();
      await controller.start();
      expect(authorization(controller)).toBe(`Bearer ${gatewayBearerToken}`);
    } finally {
      await controller.shutdown();
    }
  });

  it("rejects malformed supervisor-supplied Gateway credentials before starting a listener", () => {
    expect(
      () =>
        new ControlPlaneController({
          userDataPath: join(tmpdir(), "scr-runtime-cutover-invalid-token"),
          nativeAgentPath: join(tmpdir(), "SovereignNativeAgent.exe"),
          gatewayBearerToken: "not-a-256-bit-token",
          shell: shellPort(),
          approvalSurface: {
            present: async () => "deny",
          },
        }),
    ).toThrow(/canonical 256-bit base64url/u);
  });
});
