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

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function protectTestSecret(value: string): string {
  return `test-dpapi:${Buffer.from(value, "utf8").toString("base64")}`;
}

function restoreTestSecret(encoded: string): { readonly value: string; readonly encoded: string } | null {
  if (!encoded.startsWith("test-dpapi:")) {
    return null;
  }
  return {
    value: Buffer.from(encoded.slice("test-dpapi:".length), "base64").toString("utf8"),
    encoded,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

async function initializeMcpSession(
  endpoint: string,
  authorization: string,
): Promise<string> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Origin: new URL(endpoint).origin,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "desktop-activity-test", version: "1.0.0" },
      },
    }),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).not.toBeNull();
  const initialized = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Origin: new URL(endpoint).origin,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId ?? "missing",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  expect([200, 202]).toContain(initialized.status);
  return sessionId ?? "missing";
}

describe("desktop external activity lifecycle", () => {
  it("publishes a long direct tool call while running and removes it after audit completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-desktop-activity-lifecycle-"));
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeControlPlaneSettings(join(root, "settings.json"), {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: false,
    });

    const observedStates: string[][] = [];
    const controller = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      shell: {
        chooseWorkspace: async () => null,
        chooseSecureTunnelExecutable: async () => null,
        protectSecret: async (value) => protectTestSecret(value),
        restoreSecret: async (encoded) => restoreTestSecret(encoded),
        prompt: async () => 0,
      },
      approvalSurface: {
        present: async () => "deny",
      },
      onStateChanged: (state) => {
        observedStates.push(state.activeToolActivities.map((activity) => activity.toolName));
      },
    });

    try {
      await controller.initialize();
      await controller.setPermissionProfile("bypass");
      await controller.start();

      const connection = controller.connectionBundle();
      const bundle = JSON.parse(connection.serialized) as SovereignConnectionBundle;
      const authorization = bundle.transport.headers.Authorization;
      const sessionId = await initializeMcpSession(connection.endpoint, authorization);

      const callPromise = fetch(connection.endpoint, {
        method: "POST",
        headers: {
          Authorization: authorization,
          Origin: new URL(connection.endpoint).origin,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "terminal.exec",
            arguments: {
              workspaceId: "desktop-workspace",
              command: "Start-Sleep -Milliseconds 900; Write-Output 'activity-complete'",
              cwd: "",
              timeoutMs: 5_000,
            },
          },
        }),
      });

      const becameActive = await waitFor(() => controller.state().activeToolActivities.some(
        (activity) => activity.toolName === "terminal.exec",
      ));
      if (!becameActive) {
        const earlyResponse = await callPromise;
        throw new Error(JSON.stringify({
          responseStatus: earlyResponse.status,
          responseBody: await earlyResponse.clone().text(),
          state: controller.state(),
          observedStates,
        }));
      }
      const active = controller.state().activeToolActivities[0];
      expect(active).toMatchObject({
        toolName: "terminal.exec",
        title: "Run PowerShell command",
        category: "terminal",
        workspaceId: "desktop-workspace",
      });
      expect(JSON.stringify(active)).not.toContain("Start-Sleep");

      const response = await callPromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: 2,
        result: expect.any(Object),
      });
      expect(await waitFor(() => controller.state().activeToolActivities.length === 0)).toBe(true);

      expect(observedStates).toContainEqual(["terminal.exec"]);
      expect(observedStates.at(-1)).toEqual([]);
      expect(controller.auditReceipts(20)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          toolName: "terminal.exec",
          operation: "execute_powershell",
          outcome: "succeeded",
        }),
      ]));
    } finally {
      await controller.shutdown();
    }
  });
});
