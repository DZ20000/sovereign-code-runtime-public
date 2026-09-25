import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { ControlPlaneController } from "../../packages/control-plane/src/controller.js";
import {
  SBX_REVIEWED_VERSION,
  type SandboxProcessResult,
  type SandboxProcessRunner,
} from "../../packages/control-plane/src/sandbox-manager.js";
import {
  DEFAULT_CONTROL_PLANE_SETTINGS,
  writeControlPlaneSettings,
} from "../../packages/control-plane/src/settings.js";
import type { SovereignConnectionBundle } from "../../packages/control-plane-contract/src/index.js";

const cleanupPaths: string[] = [];

function protectTestSecret(value: string): string {
  return `test-dpapi:${Buffer.from(value, "utf8").toString("base64")}`;
}

function restoreTestSecret(
  encoded: string,
): { readonly value: string; readonly encoded: string } | null {
  if (!encoded.startsWith("test-dpapi:")) return null;
  return {
    value: Buffer.from(encoded.slice("test-dpapi:".length), "base64").toString(
      "utf8",
    ),
    encoded,
  };
}

function result(stdout = "", stderr = "", exitCode = 0): SandboxProcessResult {
  return {
    commandLabel: "fake sbx",
    exitCode,
    signal: null,
    durationMs: 1,
    stdout,
    stderr,
    outputTruncated: false,
    timedOut: false,
  };
}

function toolResult(value: unknown): unknown {
  const response = value as {
    readonly isError?: boolean;
    readonly content?: readonly {
      readonly type?: string;
      readonly text?: string;
    }[];
  };
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (response.isError === true) {
    throw new Error(text ?? "Tool returned an error.");
  }
  return JSON.parse(text ?? "null") as unknown;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    ),
  );
});

describe("desktop secure execution pack lifecycle", () => {
  it("hot-enables metadata-only credential references and trusted sandbox capabilities", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "scr-secure-execution-lifecycle-"),
    );
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const executableRoot = join(root, "trusted-bin");
    await Promise.all([
      mkdir(join(workspaceRoot, ".git"), { recursive: true }),
      mkdir(executableRoot, { recursive: true }),
    ]);
    const executablePath = join(executableRoot, "sbx.exe");
    const executableBytes = Buffer.from(
      "secure execution integration sbx",
      "utf8",
    );
    await writeFile(executablePath, executableBytes);
    const executableSha256 = createHash("sha256")
      .update(executableBytes)
      .digest("hex");
    const runner: SandboxProcessRunner = async (_command, args) => {
      if (args[0] === "version") {
        return result(`sbx version: v${SBX_REVIEWED_VERSION} deadbeef\n`);
      }
      if (args[0] === "ls") {
        return result("[]");
      }
      return result();
    };
    await writeControlPlaneSettings(join(root, "settings.json"), {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: false,
    });

    const controller = new ControlPlaneController({
      userDataPath: root,
      nativeAgentPath: join(root, "SovereignNativeAgent.exe"),
      sandboxExecutablePath: executablePath,
      sandboxExpectedVersion: SBX_REVIEWED_VERSION,
      sandboxExpectedExecutableSha256: executableSha256,
      sandboxRunner: runner,
      shell: {
        chooseWorkspace: async () => null,
        chooseSecureTunnelExecutable: async () => null,
        protectSecret: async (value) => protectTestSecret(value),
        restoreSecret: async (encoded) => restoreTestSecret(encoded),
        prompt: async () => 0,
      },
      approvalSurface: { present: async () => "deny" },
    });
    let client: Client | null = null;

    try {
      await controller.initialize();
      await controller.start();
      expect(
        controller
          .manifest()
          ?.tools.some((tool) => tool.name === "sandbox.capabilities"),
      ).toBe(false);
      await controller.setPermissionProfile("bypass");

      const connection = controller.connectionBundle();
      const bundle = JSON.parse(
        connection.serialized,
      ) as SovereignConnectionBundle;
      client = new Client({
        name: "secure-execution-integration",
        version: "1.0.0",
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(connection.endpoint),
        {
          requestInit: {
            headers: { Authorization: bundle.transport.headers.Authorization },
          },
        },
      );
      await client.connect(transport as unknown as Transport);

      const configured = toolResult(
        await client.callTool({
          name: "system.tool_packs.configure",
          arguments: {
            enabled: ["developer-essentials", "secure-execution"],
          },
        }),
      ) as {
        readonly enabled: readonly string[];
        readonly toolCount: number;
      };
      expect(configured.enabled).toEqual([
        "developer-essentials",
        "secure-execution",
      ]);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "secrets.refs.list",
          "secrets.refs.register",
          "secrets.refs.remove",
          "sandbox.capabilities",
          "sandbox.list",
          "sandbox.create",
          "sandbox.exec",
          "sandbox.collect",
          "sandbox.stop",
          "sandbox.remove",
        ]),
      );

      const registered = toolResult(
        await client.callTool({
          name: "secrets.refs.register",
          arguments: {
            id: "openai-build",
            label: "OpenAI build key",
            service: "openai",
            source: {
              kind: "onepassword",
              reference: "op://Engineering/OpenAI-API-Key/credential",
            },
          },
        }),
      );
      expect(registered).toMatchObject({
        id: "openai-build",
        sourceKind: "onepassword",
        sourceDisplay: "1Password reference",
      });
      expect(JSON.stringify(registered)).not.toContain("op://");

      const listed = toolResult(
        await client.callTool({
          name: "secrets.refs.list",
          arguments: {},
        }),
      );
      expect(listed).toMatchObject({
        count: 1,
        entries: [expect.objectContaining({ id: "openai-build" })],
      });

      const capabilities = toolResult(
        await client.callTool({
          name: "sandbox.capabilities",
          arguments: {},
        }),
      );
      expect(capabilities).toMatchObject({
        available: true,
        trusted: true,
        compatible: true,
        authenticated: true,
        version: SBX_REVIEWED_VERSION,
        executableSha256,
        guarantees: {
          microVm: true,
          privateClone: true,
          hostRepositoryReadOnly: true,
          network: "deny-all",
        },
      });

      const registry = await readFile(
        join(root, "security", "credential-refs.json"),
        "utf8",
      );
      expect(registry).toContain("test-dpapi:");
      expect(registry).not.toContain("op://");
      expect(registry).not.toContain("OpenAI-API-Key");

      const receipts = toolResult(
        await client.callTool({
          name: "system.audit_receipts",
          arguments: { limit: 20 },
        }),
      );
      expect(receipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            principalId: "chatgpt-web",
            toolName: "secrets.refs.register",
            operation: "register_credential_reference",
            outcome: "succeeded",
            details: expect.objectContaining({
              credentialId: "openai-build",
              sourceKind: "onepassword",
            }),
          }),
        ]),
      );
      expect(JSON.stringify(receipts)).not.toContain("op://");
      expect(JSON.stringify(receipts)).not.toContain("OpenAI-API-Key");

      await client.callTool({
        name: "system.tool_packs.configure",
        arguments: { enabled: ["developer-essentials"] },
      });
      expect(
        (await client.listTools()).tools.some(
          (tool) => tool.name === "sandbox.capabilities",
        ),
      ).toBe(false);
    } finally {
      await client?.close().catch(() => undefined);
      await controller.shutdown();
    }
  });
});
