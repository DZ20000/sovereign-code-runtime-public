import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { startGatewayRuntime } from "../src/runtime.js";

const fakeSerenaServerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-serena-server.mjs",
);

function parseToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): unknown {
  const parsed = result as {
    readonly content: unknown;
    readonly isError?: boolean;
  };
  const content = parsed.content as readonly {
    readonly type: string;
    readonly text?: string;
  }[];
  const text = content.find((item) => item.type === "text")?.text;
  if (parsed.isError === true) {
    throw new Error(typeof text === "string" ? text : "MCP tool failed.");
  }
  return typeof text === "string" ? (JSON.parse(text) as unknown) : parsed;
}

async function callJson(
  client: Client,
  name: string,
  input: Readonly<Record<string, unknown>> = {},
): Promise<unknown> {
  return parseToolResult(await client.callTool({ name, arguments: input }));
}

async function connect(endpoint: string, token: string): Promise<Client> {
  const client = new Client({
    name: "capability-runtime-test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  await client.connect(transport as unknown as Transport);
  return client;
}

describe("stable capability facade over MCP", () => {
  it("searches, describes, compares, and executes bounded read-only targets", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "scr-capability-runtime-"),
    );
    const profileRoot = await mkdtemp(
      join(tmpdir(), "scr-capability-profile-"),
    );
    const token = randomBytes(32).toString("base64url");
    const runtime = await startGatewayRuntime({
      bearerToken: token,
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      auditPath: join(profileRoot, "audit.sqlite"),
      toolPackConfigPath: join(profileRoot, "tool-packs.json"),
      watchToolPacks: false,
    });
    const client = await connect(runtime.endpoint, token);

    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "capabilities.search",
          "capabilities.describe",
          "capabilities.execute",
          "capabilities.snapshot",
          "client.catalog_status",
        ]),
      );

      await expect(
        callJson(client, "capabilities.snapshot"),
      ).resolves.toMatchObject({
        schemaVersion: "scr.capabilities/snapshot/v1",
        manifest: {
          digest: runtime.manifest.digest,
          toolCount: runtime.manifest.tools.length,
        },
        stableFacadeNames: expect.arrayContaining([
          "capabilities.search",
          "capabilities.execute",
          "client.catalog_status",
        ]),
      });
      const workspaceSearch = (await callJson(client, "capabilities.search", {
        query: "workspace context",
        executableOnly: true,
        limit: 10,
      })) as {
        readonly totalMatched: number;
        readonly entries: readonly {
          readonly name: string;
          readonly facadeExecutable: boolean;
          readonly pack: { readonly id: string } | null;
        }[];
      };
      expect(workspaceSearch.totalMatched).toBe(1);
      expect(workspaceSearch.entries).toHaveLength(1);
      expect(workspaceSearch.entries[0]).toMatchObject({
        name: "workspace.context",
        facadeExecutable: true,
        pack: { id: "developer-essentials" },
      });
      await expect(
        callJson(client, "capabilities.describe", {
          toolName: "terminal.start",
        }),
      ).resolves.toMatchObject({
        name: "terminal.start",
        permissionLevel: "consequential",
        facadeExecutable: false,
      });
      await expect(
        callJson(client, "capabilities.execute", {
          toolName: "system.info",
          input: {},
        }),
      ).resolves.toMatchObject({
        schemaVersion: "scr.capabilities/execution/v1",
        targetToolName: "system.info",
        result: { platform: process.platform },
      });

      const denied = await client.callTool({
        name: "capabilities.execute",
        arguments: {
          toolName: "terminal.start",
          input: { command: "Write-Output forbidden" },
        },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        schemaVersion: "scr.mcp-tool-result/v2",
        result: { error: { code: "POLICY_DENIED" } },
      });
      expect(denied.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringMatching(/POLICY_DENIED/u),
          }),
        ]),
      );

      await expect(
        callJson(client, "client.catalog_status", {
          clientManifestDigest: runtime.manifest.digest,
          clientToolCount: runtime.manifest.tools.length,
          clientPackGeneration: runtime.toolPacks().generation,
        }),
      ).resolves.toMatchObject({
        comparable: true,
        inSync: true,
        mismatches: [],
        recommendedAction: "none",
      });
      await expect(
        callJson(client, "client.catalog_status", {
          clientManifestDigest: "f".repeat(64),
          clientToolCount: 1,
        }),
      ).resolves.toMatchObject({
        inSync: false,
        mismatches: ["manifestDigest", "toolCount"],
        recommendedAction: "refresh-actions-or-relist",
      });

      expect(runtime.listAuditReceipts(20)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolName: "capabilities.execute",
            operation: "capability_dispatch",
            outcome: "succeeded",
            details: expect.objectContaining({
              targetToolName: "system.info",
              inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            }),
          }),
        ]),
      );
    } finally {
      await client.close().catch(() => undefined);
      await runtime.stop();
      await Promise.all([
        rm(workspaceRoot, { recursive: true, force: true }),
        rm(profileRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("discovers and executes a hot-enabled semantic capability", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "scr-capability-semantic-"),
    );
    const profileRoot = await mkdtemp(
      join(tmpdir(), "scr-capability-semantic-profile-"),
    );
    await writeFile(
      join(workspaceRoot, "source.ts"),
      "export class CapabilityExample { value = 1; }\n",
      "utf8",
    );
    const token = randomBytes(32).toString("base64url");
    const runtime = await startGatewayRuntime({
      bearerToken: token,
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      auditPath: join(profileRoot, "audit.sqlite"),
      toolPackConfigPath: join(profileRoot, "tool-packs.json"),
      watchToolPacks: false,
      serenaProfilePath: join(profileRoot, "semantic-code"),
      serenaExecutablePath: process.execPath,
      serenaServerArguments: [fakeSerenaServerPath],
    });
    const client = await connect(runtime.endpoint, token);

    try {
      const oldSnapshot = {
        clientManifestDigest: runtime.manifest.digest,
        clientToolCount: runtime.manifest.tools.length,
        clientPackGeneration: runtime.toolPacks().generation,
      };
      await runtime.configureToolPacks([
        "developer-essentials",
        "semantic-code",
      ]);

      const semanticSearch = (await callJson(client, "capabilities.search", {
        query: "symbol",
        packId: "semantic-code",
        executableOnly: true,
        limit: 20,
      })) as {
        readonly entries: readonly {
          readonly name: string;
          readonly facadeExecutable: boolean;
          readonly pack: { readonly id: string } | null;
        }[];
      };
      expect(
        semanticSearch.entries.some(
          (entry) =>
            entry.name === "code.symbol.find" &&
            entry.facadeExecutable === true &&
            entry.pack?.id === "semantic-code",
        ),
      ).toBe(true);
      await expect(
        callJson(client, "capabilities.execute", {
          toolName: "code.symbol.find",
          input: {
            namePathPattern: "CapabilityExample",
            path: "source.ts",
            maxMatches: 5,
          },
        }),
      ).resolves.toMatchObject({
        targetToolName: "code.symbol.find",
        result: {
          provider: "serena",
          toolName: "find_symbol",
          result: {
            name: "find_symbol",
            input: {
              name_path_pattern: "CapabilityExample",
              relative_path: "source.ts",
            },
          },
        },
      });
      await expect(
        callJson(client, "client.catalog_status", oldSnapshot),
      ).resolves.toMatchObject({
        inSync: false,
        mismatches: ["manifestDigest", "toolCount", "packGeneration"],
      });
      expect(existsSync(join(workspaceRoot, ".serena"))).toBe(false);

      await runtime.configureToolPacks(["developer-essentials"]);
      const removed = await client.callTool({
        name: "capabilities.execute",
        arguments: {
          toolName: "code.symbol.find",
          input: {
            namePathPattern: "CapabilityExample",
            path: "source.ts",
          },
        },
      });
      expect(removed.isError).toBe(true);
      expect(removed.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringMatching(/TOOL_NOT_FOUND/u),
          }),
        ]),
      );
    } finally {
      await client.close().catch(() => undefined);
      await runtime.stop();
      await Promise.all([
        rm(workspaceRoot, { recursive: true, force: true }),
        rm(profileRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
