import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneController } from "../src/controller.js";
import {
  DEFAULT_CONTROL_PLANE_SETTINGS,
  readControlPlaneSettings,
  writeControlPlaneSettings,
} from "../src/settings.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("control-plane settings recovery", () => {
  it("accepts one leading UTF-8 BOM without changing settings semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-settings-bom-"));
    cleanupPaths.push(root);
    const settingsPath = join(root, "settings.json");
    const tunnelId = `tunnel_${"a".repeat(32)}`;
    const settings = {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot: root,
      autoStart: false,
      secureTunnelId: tunnelId,
    };
    const json = `${JSON.stringify(settings, null, 2)}\n`;
    await writeFile(
      settingsPath,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf8")]),
    );

    const restored = await readControlPlaneSettings(settingsPath);

    expect(restored.workspaceRoot).toBe(resolve(root));
    expect(restored.autoStart).toBe(false);
    expect(restored.secureTunnelId).toBe(tunnelId);
  });

  it("still rejects malformed JSON after stripping a leading BOM", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-settings-malformed-"));
    cleanupPaths.push(root);
    const settingsPath = join(root, "settings.json");
    await writeFile(
      settingsPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('{"workspaceRoot":', "utf8"),
      ]),
    );

    await expect(readControlPlaneSettings(settingsPath)).rejects.toThrow();
  });

  it("writes UTF-8 settings without a BOM", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-settings-write-"));
    cleanupPaths.push(root);
    const settingsPath = join(root, "settings.json");
    await writeControlPlaneSettings(settingsPath, DEFAULT_CONTROL_PLANE_SETTINGS);

    const bytes = await readFile(settingsPath);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes[0]).toBe(0x7b);
  });

  it("does not overwrite unreadable settings with in-memory defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-settings-preserve-"));
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const settingsPath = join(root, "settings.json");
    const malformed = '{"secureTunnelId":';
    await writeFile(settingsPath, malformed, "utf8");

    const controller = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell: {
        chooseWorkspace: async () => workspaceRoot,
        chooseSecureTunnelExecutable: async () => null,
        protectSecret: async (value) => value,
        restoreSecret: async (encoded) => ({ value: encoded, encoded }),
        prompt: async () => 1,
      },
      approvalSurface: { present: async () => "deny" },
    });

    try {
      await controller.initialize();
      expect(controller.state().phase).toBe("error");
      await expect(controller.chooseWorkspace()).rejects.toThrow(
        /settings are unavailable; refusing to overwrite settings\.json/i,
      );
      expect(await readFile(settingsPath, "utf8")).toBe(malformed);
    } finally {
      await controller.shutdown();
    }
  });
});
