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
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  startGatewayRuntime,
  type ToolExecutionActivityEvent,
} from "../src/runtime.js";

const fakeSerenaServerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-serena-server.mjs",
);

describe("embedded Gateway runtime", () => {
  it("binds to loopback on an ephemeral port and exposes the authenticated manifest", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "scr-desktop-runtime-"));
    const token = randomBytes(32).toString("base64url");
    const runtime = await startGatewayRuntime({
      bearerToken: token,
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      auditPath: join(workspaceRoot, "audit.sqlite"),
    });

    try {
      expect(runtime.manifest.runtimeVersion).toBe("0.1.5");
      expect(runtime.host).toBe("127.0.0.1");
      expect(runtime.port).toBeGreaterThan(0);
      expect(runtime.endpoint).toBe(`http://127.0.0.1:${runtime.port}/mcp`);
      await expect(runtime.invokeTool("workspace.list", {})).resolves.toEqual(
        expect.any(Array),
      );
      await expect(
        runtime.invokeTool("workspace.list", {
          workspaceId: "wrong-workspace",
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
      const workspaceTool = runtime.manifest.tools.find(
        (tool) => tool.name === "workspace.list",
      );
      expect(workspaceTool?.inputSchema).toMatchObject({
        properties: {
          workspaceId: { default: "default" },
        },
      });
      expect(
        (workspaceTool?.inputSchema.required as
          readonly string[] | undefined) ?? [],
      ).not.toContain("workspaceId");

      const health = await fetch(`http://127.0.0.1:${runtime.port}/healthz`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        status: "ok",
        transport: "streamable-http",
      });

      const manifest = await fetch(
        `http://127.0.0.1:${runtime.port}/v1/manifest`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );
      expect(manifest.status).toBe(200);
      await expect(manifest.json()).resolves.toMatchObject({
        schemaVersion: "scr.tools/v1",
        runtimeVersion: "0.1.5",
        digest: runtime.manifest.digest,
      });

      await runtime.stop();
      await expect(runtime.stop()).resolves.toBeUndefined();
    } finally {
      await runtime.stop();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("enforces an explicit embedded Gateway session policy", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "scr-session-policy-runtime-"),
    );
    const token = randomBytes(32).toString("base64url");
    const gatewaySessionPolicy = {
      maxSessions: 1,
      capacityReclaimIdleMs: 60_000,
      sessionIdleTimeoutMs: 60_000,
      sessionSweepIntervalMs: 30_000,
    } as const;
    const runtime = await startGatewayRuntime({
      bearerToken: token,
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      auditPath: join(workspaceRoot, "audit.sqlite"),
      gatewaySessionPolicy,
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: `http://127.0.0.1:${runtime.port}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "session-policy-test", version: "1.0.0" },
      },
    });

    try {
      expect(runtime.gatewaySessionPolicy).toEqual(gatewaySessionPolicy);
      const first = await fetch(runtime.endpoint, {
        method: "POST",
        headers,
        body,
      });
      expect(first.status).toBe(200);
      const second = await fetch(runtime.endpoint, {
        method: "POST",
        headers,
        body,
      });
      expect(second.status).toBe(429);
      const retryAfterSeconds = Number(second.headers.get("retry-after"));
      expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(retryAfterSeconds).toBeLessThanOrEqual(60);
      await expect(second.json()).resolves.toMatchObject({
        error: {
          code: "POLICY_DENIED",
          details: { maxSessions: 1, retryAfterSeconds },
        },
      });
    } finally {
      await runtime.stop();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects an invalid explicit Gateway session policy before startup", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "scr-invalid-session-policy-runtime-"),
    );
    const token = randomBytes(32).toString("base64url");

    try {
      await expect(
        startGatewayRuntime({
          bearerToken: token,
          workspaceRoot,
          host: "127.0.0.1",
          port: 0,
          auditPath: join(workspaceRoot, "audit.sqlite"),
          gatewaySessionPolicy: {
            maxSessions: 1,
            capacityReclaimIdleMs: 500,
            sessionIdleTimeoutMs: 1_000,
            sessionSweepIntervalMs: 2_000,
          },
        }),
      ).rejects.toThrow("sessionSweepIntervalMs may not exceed");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reports external tool lifecycle events through the embedded runtime", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "scr-desktop-runtime-activity-"),
    );
    const token = randomBytes(32).toString("base64url");
    const events: ToolExecutionActivityEvent[] = [];
    const runtime = await startGatewayRuntime({
      bearerToken: token,
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      auditPath: join(workspaceRoot, "audit.sqlite"),
      onExternalToolActivity: (event) => {
        events.push(event);
      },
    });

    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: `http://127.0.0.1:${runtime.port}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };

    try {
      const initialize = await fetch(runtime.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "activity-test", version: "1.0.0" },
          },
        }),
      });
      expect(initialize.status).toBe(200);
      await expect(initialize.clone().json()).resolves.toMatchObject({
        result: {
          serverInfo: {
            name: "sovereign-code-runtime",
            version: "0.1.5",
          },
        },
      });
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).not.toBeNull();

      const listed = await fetch(runtime.endpoint, {
        method: "POST",
        headers: {
          ...headers,
          "Mcp-Session-Id": sessionId ?? "missing",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as {
        readonly result: {
          readonly tools: readonly {
            readonly name: string;
            readonly outputSchema?: unknown;
          }[];
        };
      };
      expect(
        listedBody.result.tools.find((tool) => tool.name === "system.info")
          ?.outputSchema,
      ).toMatchObject({
        type: "object",
        properties: {
          schemaVersion: { const: "scr.mcp-tool-result/v2" },
          result: {},
        },
        required: ["schemaVersion", "result"],
      });

      const call = await fetch(runtime.endpoint, {
        method: "POST",
        headers: {
          ...headers,
          "Mcp-Session-Id": sessionId ?? "missing",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "system.info",
            arguments: {},
          },
        }),
      });
      expect(call.status).toBe(200);
      const callBody = (await call.json()) as {
        readonly jsonrpc: string;
        readonly id: number;
        readonly result: {
          readonly content: readonly {
            readonly type: string;
            readonly text?: string;
          }[];
          readonly structuredContent?: {
            readonly schemaVersion?: string;
            readonly result?: unknown;
          };
        };
      };
      expect(callBody).toMatchObject({
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [{ type: "text", text: expect.any(String) }],
          structuredContent: {
            schemaVersion: "scr.mcp-tool-result/v2",
            result: expect.any(Object),
          },
        },
      });
      const textResult = callBody.result.content.find(
        (entry) => entry.type === "text",
      )?.text;
      expect(JSON.parse(textResult ?? "null")).toEqual(
        callBody.result.structuredContent?.result,
      );

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        phase: "started",
        principalId: "local-owner",
        toolName: "system.info",
        title: "System information",
        category: "system",
        workspaceId: null,
        completedAt: null,
        outcome: null,
      });
      expect(events[1]).toMatchObject({
        id: events[0]?.id,
        phase: "completed",
        toolName: "system.info",
        outcome: "succeeded",
        errorCode: null,
      });
    } finally {
      await runtime.stop();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("hot-reloads installed tools and notifies an existing MCP session", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "scr-hot-tools-"));
    const token = randomBytes(32).toString("base64url");
    const toolPackConfigPath = join(workspaceRoot, "tool-packs.json");
    const runtime = await startGatewayRuntime({
      bearerToken: token,
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      auditPath: join(workspaceRoot, "audit.sqlite"),
      toolPackConfigPath,
      watchToolPacks: false,
      principalId: "chatgpt-web",
      externalPermissionProfile: "workspace",
    });
    let resolveChanged!: (tools: Tool[]) => void;
    let rejectChanged!: (error: Error) => void;
    const changedTools = new Promise<Tool[]>((resolveChange, rejectChange) => {
      resolveChanged = resolveChange;
      rejectChanged = rejectChange;
    });
    const client = new Client(
      { name: "sovereign-hot-reload-test", version: "1.0.0" },
      {
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged(error, tools): void {
              if (error !== null) {
                rejectChanged(error);
                return;
              }
              if (tools === null) {
                rejectChanged(
                  new Error(
                    "Tool-list notification did not refresh the catalog.",
                  ),
                );
                return;
              }
              resolveChanged(tools);
            },
          },
        },
      },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(runtime.endpoint),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    );

    try {
      await client.connect(transport as unknown as Transport);
      const initial = await client.listTools();
      expect(initial.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "system.tool_packs",
          "system.tool_packs.reload",
          "system.tool_packs.configure",
          "system.capabilities",
          "runs.follow",
          "files.read_lines",
          "workspace.context",
          "workspace.snapshot",
          "git.summary",
          "git.show",
          "git.blame",
          "git.branches",
          "git.tags",
          "git.worktrees",
          "git.files",
          "validation.verify",
          "validation.release_check",
        ]),
      );
      expect(runtime.toolPacks()).toMatchObject({
        enabled: ["developer-essentials"],
        generation: 1,
      });
      const initialDigest = runtime.manifest.digest;

      const configured = await client.callTool({
        name: "system.tool_packs.configure",
        arguments: { enabled: [] },
      });
      expect(configured.isError).not.toBe(true);
      const reloaded = runtime.toolPacks();
      const notified = await Promise.race([
        changedTools,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(new Error("Timed out waiting for tools/list_changed.")),
            5_000,
          );
        }),
      ]);

      expect(reloaded).toMatchObject({
        enabled: [],
        generation: 2,
      });
      expect(runtime.listAuditReceipts(20)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            principalId: "chatgpt-web",
            toolName: "system.tool_packs",
            operation: "tool_pack_reload",
            outcome: "succeeded",
          }),
        ]),
      );
      expect(runtime.manifest.digest).not.toBe(initialDigest);
      expect(notified.some((tool) => tool.name === "system.capabilities")).toBe(
        false,
      );
      expect(notified.some((tool) => tool.name === "system.tool_packs")).toBe(
        true,
      );
      await expect(client.listTools()).resolves.toMatchObject({
        tools: expect.not.arrayContaining([
          expect.objectContaining({ name: "system.capabilities" }),
        ]),
      });
      const removedCall = await client.callTool({
        name: "system.capabilities",
        arguments: {},
      });
      expect(removedCall.isError).toBe(true);
      expect(removedCall.content).toEqual(
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
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("hot-enables the isolated semantic code pack without workspace metadata", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "scr-semantic-runtime-"),
    );
    const profileRoot = await mkdtemp(join(tmpdir(), "scr-semantic-profile-"));
    await writeFile(
      join(workspaceRoot, "source.ts"),
      "export class Example { value = 1; }\n",
      "utf8",
    );
    const runtime = await startGatewayRuntime({
      bearerToken: randomBytes(32).toString("base64url"),
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

    try {
      const initialCount = runtime.manifest.tools.length;
      expect(
        runtime.manifest.tools.some((tool) => tool.name === "code.symbol.find"),
      ).toBe(false);

      const configured = await runtime.configureToolPacks([
        "developer-essentials",
        "semantic-code",
      ]);
      expect(configured.enabled).toEqual([
        "developer-essentials",
        "semantic-code",
      ]);
      expect(runtime.manifest.tools.length).toBe(initialCount + 7);
      expect(
        runtime.manifest.tools.some((tool) => tool.name === "code.symbol.find"),
      ).toBe(true);

      await expect(
        runtime.invokeTool("code.semantic.status", {}),
      ).resolves.toMatchObject({
        state: "ready",
        allowedTools: expect.arrayContaining([
          "get_symbols_overview",
          "find_symbol",
          "find_referencing_symbols",
          "find_implementations",
          "find_declaration",
          "get_diagnostics_for_file",
        ]),
      });
      await expect(
        runtime.invokeTool("code.symbol.find", {
          namePathPattern: "Example",
          path: "source.ts",
          maxMatches: 5,
        }),
      ).resolves.toMatchObject({
        provider: "serena",
        toolName: "find_symbol",
        result: {
          name: "find_symbol",
          input: {
            name_path_pattern: "Example",
            relative_path: "source.ts",
            max_answer_chars: 50_000,
          },
        },
      });
      expect(existsSync(join(workspaceRoot, ".serena"))).toBe(false);

      await runtime.configureToolPacks(["developer-essentials"]);
      await expect(
        runtime.invokeTool("code.symbol.find", {
          namePathPattern: "Example",
          path: "source.ts",
        }),
      ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
    } finally {
      await runtime.stop();
      await Promise.all([
        rm(workspaceRoot, { recursive: true, force: true }),
        rm(profileRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
