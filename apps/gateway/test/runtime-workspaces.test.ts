import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defineTool, objectSchema } from "@sovereign/toolkit";
import {
  ConPtySessionManager,
  ManagedBrowserManager,
  type BrowserSessionSummary,
  type TerminalSessionRecord,
} from "@sovereign/windows-adapter";
import { describe, expect, it, vi } from "vitest";
import {
  startGatewayRuntime,
  type GatewayRuntimeHandle,
  type GatewayRuntimeOptions,
} from "../src/runtime.js";

async function fixture(options: Partial<GatewayRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "scr-multiple-workspaces-"));
  const a = join(root, "a");
  const b = join(root, "b");
  await Promise.all([mkdir(a), mkdir(b)]);
  await Promise.all([
    writeFile(join(a, "identity.txt"), "project A"),
    writeFile(join(b, "identity.txt"), "project B"),
  ]);
  const token = randomBytes(32).toString("base64url");
  const runtime = await startGatewayRuntime({
    bearerToken: token,
    workspaceId: "a",
    workspaceRoot: a,
    port: 0,
    auditPath: join(root, "audit.sqlite"),
    watchToolPacks: false,
    runCompletionNotificationsEnabled: false,
    ...options,
  });
  return {
    root,
    a,
    b,
    token,
    runtime,
    close: async () => {
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function connect(runtime: GatewayRuntimeHandle, token: string) {
  const client = new Client({
    name: "workspace-binding-test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(runtime.endpoint),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
  await client.connect(transport as unknown as Transport);
  return client;
}

function result(value: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return (value.structuredContent as { result: unknown } | undefined)?.result;
}

describe("retained Gateway workspaces", () => {
  it("switches desktop roots while existing and newly initialized MCP sessions retain the original root and profile", async () => {
    const current = await fixture({
      externalPermissionProfile: "bypass",
      additionalToolDefinitionsFactory: ({ workspaceId, workspaceRoot }) => [
        defineTool(
          {
            name: "test.context",
            version: "1.0.0",
            title: "Context",
            description: "Read the context captured by this tool.",
            category: "system",
            requiredCapabilities: ["system.read"],
            sideEffect: "read",
            destructive: false,
            permissionLevel: "observe",
            approvalMode: "none",
            inputSchema: objectSchema({}, []),
          },
          {},
          () => ({ workspaceId, workspaceRoot }),
        ),
      ],
    });
    const { runtime, token, a, b } = current;
    const first = await connect(runtime, token);
    let second: Client | undefined;
    try {
      const sessionCount = runtime.sessionCount();
      await runtime.registerWorkspace({ id: "b", root: b });
      runtime.selectWorkspace("b");
      expect(runtime.activeWorkspaceId).toBe("b");
      expect(runtime.workspaceRoot).toBe(b);
      expect(runtime.sessionCount()).toBe(sessionCount);
      expect(
        runtime.manifest.tools.find((tool) => tool.name === "files.read")
          ?.inputSchema.properties,
      ).toMatchObject({ workspaceId: { default: "a" } });
      expect(
        runtime
          .manifestForWorkspace()
          .tools.find((tool) => tool.name === "files.read")?.inputSchema
          .properties,
      ).toMatchObject({ workspaceId: { default: "b" } });
      expect(runtime.externalPermissionProfile()).toBe("observe");
      expect(runtime.externalPermissionProfile("a")).toBe("bypass");
      await expect(
        runtime.invokeTool("files.read", { path: "identity.txt" }),
      ).resolves.toMatchObject({ workspaceId: "b", content: "project B" });
      await expect(
        runtime.invokeTool("files.read", {
          workspaceId: "a",
          path: "identity.txt",
        }),
      ).resolves.toMatchObject({ workspaceId: "a", content: "project A" });
      await expect(runtime.invokeTool("test.context", {})).resolves.toEqual({
        workspaceId: "b",
        workspaceRoot: b,
      });
      const approvedWorkspace = runtime.resolveToolWorkspaceId(
        "test.context",
        {},
      );
      runtime.selectWorkspace("a");
      await expect(
        runtime.invokeTool("test.context", {}, approvedWorkspace),
      ).resolves.toEqual({ workspaceId: "b", workspaceRoot: b });
      runtime.selectWorkspace("b");

      second = await connect(runtime, token);
      for (const client of [first, second]) {
        expect(result(await client.callTool({
          name: "capabilities.describe", arguments: { toolName: "terminal.exec" },
        }))).toMatchObject({
          approvalMode: "single-use",
          runtimeAuthorization: {
            workspaceId: "a", permissionProfile: "bypass", localApproval: "not-required",
          },
        });
        const read = await client.callTool({
          name: "files.read",
          arguments: { workspaceId: "b", path: "identity.txt" },
        });
        expect(read.isError).not.toBe(true);
        expect(result(read)).toMatchObject({
          workspaceId: "a",
          content: "project A",
        });
        expect(
          result(
            await client.callTool({ name: "test.context", arguments: {} }),
          ),
        ).toEqual({ workspaceId: "a", workspaceRoot: a });
      }
      runtime.setExternalPermissionProfile("observe", "a");
      runtime.setExternalPermissionProfile("bypass", "b");
      const denied = await first.callTool({
        name: "files.create",
        arguments: { path: "must-not-exist.txt", content: "denied" },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("POLICY_DENIED");
      expect(result(await first.callTool({
        name: "capabilities.describe", arguments: { toolName: "files.create" },
      }))).toMatchObject({ runtimeAuthorization: {
        workspaceId: "a", permissionProfile: "observe", profileAllowsTool: false,
        localApproval: "blocked",
      } });
      expect(runtime.externalPermissionProfile("a")).toBe("observe");
    } finally {
      await second?.close();
      await first.close();
      await current.close();
    }
  });

  it("reaches an authorized second directory and answers to that directory's own level", async () => {
    const current = await fixture({ reachableWorkspaceIds: ["b"], externalPermissionProfile: "bypass" });
    const { runtime, a, b, token } = current;
    await runtime.registerWorkspace({ id: "b", root: b, label: "b", externalPermissionProfile: "bypass" });
    const client = await connect(runtime, token);
    try {
      // The default stays the bound directory when the client names none.
      expect(result(await client.callTool({ name: "files.read", arguments: { path: "identity.txt" } })))
        .toMatchObject({ content: "project A" });
      // Naming an authorized directory reaches it.
      expect(result(await client.callTool({
        name: "files.read", arguments: { workspaceId: "b", path: "identity.txt" },
      }))).toMatchObject({ content: "project B" });

      // The second directory's own level decides, not the level of the
      // catalog that served the tool.
      runtime.setExternalPermissionProfile("observe", "b");
      const denied = await client.callTool({
        name: "files.create", arguments: { workspaceId: "b", path: "must-not-exist.txt", content: "denied" },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("POLICY_DENIED");
      expect(JSON.stringify(denied)).toContain("sovereign.permission-profile");
      // The bound directory is untouched by that demotion.
      const allowed = await client.callTool({
        name: "files.create", arguments: { path: "allowed.txt", content: "allowed" },
      });
      expect(allowed.isError).not.toBe(true);
      await expect(readFile(join(a, "allowed.txt"), "utf8")).resolves.toBe("allowed");

      // A directory the operator never authorized is not addressable: the id
      // is ignored and the call lands on the bound directory instead.
      expect(result(await client.callTool({
        name: "files.read", arguments: { workspaceId: "unknown-workspace", path: "identity.txt" },
      }))).toMatchObject({ content: "project A" });
    } finally {
      await client.close();
      await current.close();
    }
  });

  it("describes remaining approval without prompting or executing the target", async () => {
    const authorize = vi.fn(() => false);
    const current = await fixture({ authorizeExternalTool: authorize });
    const client = await connect(current.runtime, current.token);
    try {
      for (const [profile, toolName, localApproval] of [
        ["observe", "terminal.exec", "blocked"],
        ["workspace", "files.create", "not-required"],
        ["consequential", "terminal.exec", "broker-required"],
        ["bypass", "terminal.exec", "not-required"],
      ] as const) {
        current.runtime.setExternalPermissionProfile(profile, "a");
        expect(result(await client.callTool({
          name: "capabilities.describe", arguments: { toolName },
        }))).toMatchObject({ runtimeAuthorization: {
          workspaceId: "a", permissionProfile: profile,
          profileAllowsTool: profile !== "observe", policyDenial: null, localApproval,
          clientApproval: "independent", taskScope: "not-inferred",
        } });
      }
      expect(authorize).not.toHaveBeenCalled();
      expect(current.runtime.listRuns()).toEqual([]);
      await expect(current.runtime.invokeTool("capabilities.describe", {
        toolName: "terminal.exec",
      })).resolves.toMatchObject({ runtimeAuthorization: null });

      current.runtime.setExternalPermissionProfile("consequential", "a");
      const rejected = await client.callTool({
        name: "terminal.exec", arguments: { command: "Write-Output approval-test", timeoutMs: 1000 },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toContain("approval-not-granted");
      expect(JSON.stringify(rejected)).toContain("sovereign.local-approval");
      expect(JSON.stringify(rejected)).not.toContain("The local operator denied");
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(current.runtime.listRuns()).toEqual([]);
    } finally {
      await client.close();
      await current.close();
    }
  });

  it("reports an unavailable broker and missing capability without granting access", async () => {
    const current = await fixture({
      externalPermissionProfile: "consequential", capabilities: ["system.read", "terminal.run"],
    });
    const client = await connect(current.runtime, current.token);
    try {
      expect(result(await client.callTool({
        name: "capabilities.describe", arguments: { toolName: "terminal.exec" },
      }))).toMatchObject({ runtimeAuthorization: {
        profileAllowsTool: true, policyDenial: null, localApproval: "unavailable",
      } });
      const brokerRejected = await client.callTool({
        name: "terminal.exec", arguments: { command: "Write-Output approval-test", timeoutMs: 1000 },
      });
      expect(brokerRejected.isError).toBe(true);
      expect(JSON.stringify(brokerRejected)).toContain("broker-unavailable");
      expect(result(await client.callTool({
        name: "capabilities.describe", arguments: { toolName: "files.create" },
      }))).toMatchObject({ runtimeAuthorization: {
        profileAllowsTool: true, localApproval: "blocked",
        policyDenial: { code: "POLICY_DENIED", details: { capability: "files.write" } },
      } });
      const capabilityRejected = await client.callTool({
        name: "files.create", arguments: { path: "must-not-exist.txt", content: "denied" },
      });
      expect(capabilityRejected.isError).toBe(true);
      expect(JSON.stringify(capabilityRejected)).toContain("files.write");
    } finally {
      await client.close();
      await current.close();
    }
  });

  it("retains running processes and reads or cancels them in their original workspace", async () => {
    const current = await fixture();
    const { runtime, b } = current;
    try {
      const run = (await runtime.invokeTool("terminal.start", {
        command: "Start-Sleep -Seconds 20",
        timeoutMs: 30_000,
      })) as { id: string };
      expect(runtime.getRun(run.id)).toMatchObject({
        state: "running",
        workspaceId: "a",
        cancelRequested: false,
      });
      const processes = runtime.listOwnedProcesses();
      expect(processes.some((process) => process.role === "managed-run")).toBe(
        true,
      );
      await runtime.registerWorkspace({ id: "b", root: b });
      runtime.selectWorkspace("b");
      expect(runtime.listOwnedProcesses()).toEqual(processes);
      expect(runtime.listRuns()).toHaveLength(0);
      await runtime.invokeTool("terminal.start", {
        command: "Write-Output 'project B'",
        timeoutMs: 10_000,
      });
      expect(runtime.listRuns(1)).toEqual([
        expect.objectContaining({ workspaceId: "b" }),
      ]);
      expect(runtime.listRuns(1, "a")).toEqual([
        expect.objectContaining({ id: run.id }),
      ]);
      await expect(
        runtime.invokeTool("runs.get", { runId: run.id }),
      ).resolves.toMatchObject({
        state: "running",
        workspaceId: "a",
        cancelRequested: false,
      });
      await expect(
        runtime.invokeTool("runs.get", { runId: run.id, workspaceId: "b" }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(runtime.cancelRun(run.id)).toMatchObject({
        id: run.id,
        workspaceId: "a",
        cancelRequested: true,
      });
    } finally {
      await current.close();
    }
  });

  it("retains terminal and browser owners and refuses cross-workspace browser access", async () => {
    const terminals = new Map<string, TerminalSessionRecord>();
    vi.spyOn(ConPtySessionManager.prototype, "start").mockImplementation(
      (input) => {
        const session: TerminalSessionRecord = {
          id: "terminal-a",
          workspaceId: input.workspaceId,
          relativeCwd: input.relativeCwd,
          state: "running",
          createdAt: new Date().toISOString(),
          completedAt: null,
          processId: null,
          exitCode: null,
          columns: input.columns,
          rows: input.rows,
          output: "original terminal",
          outputTruncated: false,
          error: null,
        };
        terminals.set(session.id, session);
        return session;
      },
    );
    vi.spyOn(ConPtySessionManager.prototype, "get").mockImplementation(
      (id) => terminals.get(id) ?? null,
    );
    vi.spyOn(ConPtySessionManager.prototype, "write").mockImplementation((id) =>
      terminals.get(id)!,
    );
    const terminalShutdown = vi.spyOn(
      ConPtySessionManager.prototype,
      "shutdown",
    );
    const browsers: BrowserSessionSummary[] = [];
    vi.spyOn(ManagedBrowserManager.prototype, "create").mockImplementation(
      async (allowedDomains) => {
        const session: BrowserSessionSummary = {
          id: `browser-${browsers.length}`,
          state: "ready",
          createdAt: new Date().toISOString(),
          processId: null,
          url: "about:blank",
          title: "",
          allowedDomains,
          blockedRequestCount: 0,
          error: null,
        };
        browsers.push(session);
        return session;
      },
    );
    vi.spyOn(ManagedBrowserManager.prototype, "list").mockImplementation(
      () => browsers,
    );
    vi.spyOn(ManagedBrowserManager.prototype, "observe").mockImplementation(
      async (id) => ({
        ...browsers.find((entry) => entry.id === id)!,
        revision: "revision",
        text: "original browser",
        accessibility: [],
        elements: [],
      }),
    );
    const browserShutdown = vi.spyOn(
      ManagedBrowserManager.prototype,
      "shutdown",
    );
    const current = await fixture();
    const { runtime, b, token } = current;
    const client = await connect(runtime, token);
    try {
      const terminal = (await runtime.invokeTool(
        "terminal.session.create",
        {},
      )) as { id: string };
      const browser = (await runtime.invokeTool("browser.session.create", {
        allowedDomains: ["example.com"],
      })) as { id: string };
      await runtime.registerWorkspace({ id: "b", root: b });
      runtime.selectWorkspace("b");
      expect(terminalShutdown).not.toHaveBeenCalled();
      expect(browserShutdown).not.toHaveBeenCalled();
      await expect(
        runtime.invokeTool("terminal.session.read", { sessionId: terminal.id }),
      ).resolves.toMatchObject({
        workspaceId: "a",
        output: "original terminal",
      });
      await expect(
        runtime.invokeTool("terminal.session.write", {
          sessionId: terminal.id,
          data: "read-original",
        }),
      ).resolves.toMatchObject({ workspaceId: "a" });
      await expect(
        runtime.invokeTool("browser.observe", { sessionId: browser.id }),
      ).resolves.toMatchObject({ id: browser.id, text: "original browser" });
      await expect(
        runtime.invokeTool("browser.observe", {
          workspaceId: "b",
          sessionId: browser.id,
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        runtime.invokeTool("browser.session.list", {}),
      ).resolves.toEqual([]);
      const browserB = (await runtime.invokeTool("browser.session.create", {
        allowedDomains: ["example.com"],
      })) as { id: string };
      const denied = await client.callTool({
        name: "browser.observe",
        arguments: { sessionId: browserB.id },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("RUN_NOT_FOUND");
      expect(
        result(
          await client.callTool({
            name: "browser.session.list",
            arguments: {},
          }),
        ),
      ).toEqual([expect.objectContaining({ id: browser.id })]);
    } finally {
      await client.close();
      await current.close();
    }
  });

  it("registers approved roots without rebinding ids or admitting unknown roots", async () => {
    const current = await fixture();
    const { runtime, a, b, root } = current;
    try {
      await Promise.all([
        runtime.registerWorkspace({ id: "b", root: b }),
        runtime.registerWorkspace({ id: "b", root: b }),
      ]);
      await runtime.registerWorkspace({ id: "a-project", root: a });
      expect(runtime.workspaces().map((workspace) => workspace.id)).toEqual([
        "a",
        "b",
        "a-project",
      ]);
      await expect(
        runtime.registerWorkspace({ id: "b", root: a }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        runtime.registerWorkspace({
          id: "missing",
          root: join(root, "absent"),
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => runtime.selectWorkspace("missing")).toThrow(
        "Unknown workspace",
      );
      await expect(
        runtime.invokeTool("files.read", {
          workspaceId: "unknown",
          path: "identity.txt",
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
      expect(runtime.activeWorkspaceId).toBe("a");
      runtime.selectWorkspace("b");
      await expect(
        runtime.invokeTool("files.read", { path: "identity.txt" }),
      ).resolves.toMatchObject({ content: "project B" });
    } finally {
      await current.close();
    }
  });

  it("keeps semantic provider processes and trusted-root configuration separate", async () => {
    const current = await fixture({
      serenaExecutablePath: process.execPath,
      serenaServerArguments: [
        fileURLToPath(
          new URL("./fixtures/fake-serena-server.mjs", import.meta.url),
        ),
      ],
    });
    const { runtime, a, b, root } = current;
    try {
      await runtime.configureToolPacks([
        "developer-essentials",
        "semantic-code",
      ]);
      const original = (await runtime.invokeTool(
        "code.semantic.status",
        {},
      )) as { processId: number; workspaceFingerprint: string; state: string };
      expect(original).toMatchObject({
        state: "ready",
        processId: expect.any(Number),
      });
      const configPath = join(
        root,
        "semantic-code",
        ".serena",
        "serena_config.yml",
      );
      const config = await readFile(configPath, "utf8");
      expect(config).toContain(JSON.stringify(a.replaceAll("\\", "/")));
      await runtime.registerWorkspace({ id: "b", root: b });
      runtime.selectWorkspace("b");
      expect(runtime.toolPacks().enabled).toEqual(["developer-essentials"]);
      await runtime.configureToolPacks([
        "developer-essentials",
        "semantic-code",
      ]);
      const selected = (await runtime.invokeTool(
        "code.semantic.status",
        {},
      )) as typeof original;
      expect(selected).toMatchObject({
        state: "ready",
        processId: expect.any(Number),
      });
      expect(selected.processId).not.toBe(original.processId);
      expect(selected.workspaceFingerprint).not.toBe(
        original.workspaceFingerprint,
      );
      await expect(readFile(configPath, "utf8")).resolves.toBe(config);
      await expect(
        runtime.invokeTool("code.semantic.status", {}, "a"),
      ).resolves.toMatchObject(original);
      await runtime.configureToolPacks(["developer-essentials"]);
      await expect(
        runtime.invokeTool("code.semantic.status", {}, "a"),
      ).resolves.toMatchObject({
        state: "ready",
        processId: original.processId,
      });
    } finally {
      await current.close();
    }
  });
});
