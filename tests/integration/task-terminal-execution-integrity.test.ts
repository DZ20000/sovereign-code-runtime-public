import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
  createPrincipal,
} from "../../packages/runtime-core/src/index.js";
import { WindowsAdapter } from "../../packages/windows-adapter/src/index.js";

import { normalizeTaskBoundToolInput } from "../../packages/control-plane/src/task-gateway-integration.js";
import { TaskRegistry } from "../../packages/control-plane/src/task-registry.js";
import { createTaskTools } from "../../packages/control-plane/src/task-tools.js";
import {
  ToolCatalog,
  defineTool,
  objectSchema,
} from "../../packages/toolkit/src/index.js";
import { fixture } from "./task-registry-fixture.js";

const principalId = "chatgpt-web";
const agentId = "release-agent";
const sessionId = "release-session";

async function createBoundTask() {
  const value = await fixture();
  const projectRoot = resolve(value.workspace, "projects", "release");
  await mkdir(projectRoot, { recursive: true });
  const task = value.registry.createTask(
    {
      projectRoot,
      projectName: "Release",
      title: "Release candidate",
      status: "blocked",
      summary: "Release remains in progress.",
      agentId,
      agentName: "Release Agent",
    },
    principalId,
    value.workspace,
    "agent",
    sessionId,
  );
  return { ...value, projectRoot, task };
}

describe("task-bound terminal execution integrity", () => {
  it.runIf(process.platform === "win32")(
    "normalizes project-bound dot to the canonical Task project before execution",
    async () => {
      const value = await createBoundTask();
      const policy = new PolicyEngine();
      const audit = new MemoryAuditStore();
      const adapter = new WindowsAdapter({
        workspaces: [{ id: "desktop-workspace", root: value.workspace }],
        policy,
        audit,
      });
      const principal = createPrincipal(principalId, CAPABILITIES, [
        "desktop-workspace",
      ]);
      try {
        await expect(
          adapter.runTerminalCommand(
            principal,
            "desktop-workspace",
            "Write-Output should-not-run",
            ".",
            30_000,
          ),
        ).rejects.toMatchObject({ code: "PATH_REJECTED" });

        const input = normalizeTaskBoundToolInput(
          value.registry,
          value.workspace,
          {
            principal,
            sessionId,
            toolName: "terminal.exec",
            input: {
              workspaceId: "desktop-workspace",
              command: "(Get-Location).Path",
              cwd: ".",
              timeoutMs: 30_000,
            },
          },
        );
        const expectedCwd = relative(value.workspace, value.projectRoot);
        expect(input.cwd).toBe(expectedCwd);

        const result = await adapter.runTerminalCommand(
          principal,
          "desktop-workspace",
          String(input.command),
          String(input.cwd),
          Number(input.timeoutMs),
        );
        expect(result).toMatchObject({
          exitCode: 0,
          relativeCwd: expectedCwd,
          receiptId: expect.any(String),
        });
        expect(resolve(result.stdout.trim())).toBe(value.projectRoot);
        expect(audit.list()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              toolName: "terminal.exec",
              outcome: "succeeded",
              relativePath: expectedCwd,
            }),
            expect.objectContaining({
              toolName: "terminal.exec",
              outcome: "failed",
              errorCode: "PATH_REJECTED",
              details: expect.objectContaining({ requestedPath: "." }),
            }),
          ]),
        );
      } finally {
        await adapter.shutdown();
        value.registry.close();
      }
    },
  );

  it("blocks succeeded, CAS, closeout and settlement state after PATH_REJECTED until a successful receipt exists", async () => {
    const value = await createBoundTask();
    const startedAt = new Date().toISOString();
    value.registry.attachActivity({
      activityId: "terminal-path-rejected",
      principalId,
      sessionId,
      toolName: "terminal.exec",
      title: "Move main and write closeout",
      category: "terminal",
      startedAt,
      projectRoot: value.workspace,
    });
    value.registry.completeActivity(
      value.task.id,
      "failed",
      new Date(Date.parse(startedAt) + 10).toISOString(),
      0,
      "Move main and write closeout",
      sessionId,
      {
        activityId: "terminal-path-rejected",
        toolName: "terminal.exec",
        outcome: "failed",
        receiptId: null,
        errorCode: "PATH_REJECTED",
      },
    );

    const taskCatalog = new ToolCatalog(
      createTaskTools(value.registry, value.workspace, "desktop-workspace"),
      new PolicyEngine(),
      "test",
    );
    await expect(
      taskCatalog.invoke(
        "tasks.update",
        {
          principal: createPrincipal(principalId, CAPABILITIES, [
            "desktop-workspace",
          ]),
          sessionId,
        },
        {
          taskId: value.task.id,
          agentId,
          status: "succeeded",
          summary: "main CAS, technical closeout and settlement completed.",
        },
      ),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
      details: expect.objectContaining({
        activityId: "terminal-path-rejected",
        outcome: "failed",
        receiptId: null,
        errorCode: "PATH_REJECTED",
      }),
    });
    expect(value.registry.requiredTask(value.task.id)).toMatchObject({
      status: "blocked",
      summary: "Release remains in progress.",
    });
    expect(
      value.registry
        .detail(value.task.id)
        .messages.some((message) => message.content.includes("to succeeded")),
    ).toBe(false);

    value.registry.close();
    const reopened = new TaskRegistry({ databasePath: value.databasePath });
    try {
      expect(() =>
        reopened.updateTask(
          { taskId: value.task.id, agentId, status: "succeeded" },
          principalId,
          sessionId,
        ),
      ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));

      const successfulAt = new Date(Date.parse(startedAt) + 20).toISOString();
      reopened.attachActivity({
        activityId: "terminal-success",
        principalId,
        sessionId,
        toolName: "terminal.exec",
        title: "Verify main and closeout",
        category: "terminal",
        startedAt: successfulAt,
        projectRoot: value.workspace,
      });
      reopened.completeActivity(
        value.task.id,
        "succeeded",
        new Date(Date.parse(successfulAt) + 10).toISOString(),
        0,
        "Verify main and closeout",
        sessionId,
        {
          activityId: "terminal-success",
          toolName: "terminal.exec",
          outcome: "succeeded",
          receiptId: "terminal-receipt-success",
          errorCode: null,
        },
      );
      expect(
        reopened.updateTask(
          { taskId: value.task.id, agentId, status: "succeeded" },
          principalId,
          sessionId,
        ).status,
      ).toBe("succeeded");
    } finally {
      reopened.close();
    }
  });
  it("keeps the latest terminal result authoritative across out-of-order completion", async () => {
    const value = await fixture();
    const firstAt = new Date().toISOString();
    const secondAt = new Date(Date.parse(firstAt) + 10).toISOString();
    try {
      const inferred = value.registry.attachActivity({
        activityId: "terminal-first",
        principalId,
        sessionId: "unbound-session",
        toolName: "terminal.exec",
        title: "First terminal",
        category: "terminal",
        startedAt: firstAt,
        projectRoot: value.workspace,
      });
      value.registry.attachActivity({
        activityId: "terminal-latest",
        principalId,
        sessionId: "unbound-session",
        toolName: "terminal.exec",
        title: "Latest terminal",
        category: "terminal",
        startedAt: secondAt,
        projectRoot: value.workspace,
      });
      value.registry.completeActivity(
        inferred.id,
        "failed",
        new Date(Date.parse(secondAt) + 10).toISOString(),
        1,
        "Latest terminal",
        "unbound-session",
        {
          activityId: "terminal-latest",
          toolName: "terminal.exec",
          outcome: "failed",
          receiptId: null,
          errorCode: "PATH_REJECTED",
        },
      );
      const completed = value.registry.completeActivity(
        inferred.id,
        "succeeded",
        new Date(Date.parse(secondAt) + 20).toISOString(),
        0,
        "First terminal",
        "unbound-session",
        {
          activityId: "terminal-first",
          toolName: "terminal.exec",
          outcome: "succeeded",
          receiptId: "stale-success-receipt",
          errorCode: null,
        },
      );
      expect(completed.status).toBe("failed");
    } finally {
      value.registry.close();
    }
  });
  it("fails an inferred terminal activity when the completion lacks a receipt", async () => {
    const value = await fixture();
    const startedAt = new Date().toISOString();
    try {
      const inferred = value.registry.attachActivity({
        activityId: "terminal-missing-receipt",
        principalId,
        sessionId: "unbound-session",
        toolName: "terminal.exec",
        title: "Unverified terminal result",
        category: "terminal",
        startedAt,
        projectRoot: value.workspace,
      });
      const completed = value.registry.completeActivity(
        inferred.id,
        "succeeded",
        new Date(Date.parse(startedAt) + 10).toISOString(),
        0,
        "Unverified terminal result",
        "unbound-session",
        {
          activityId: "terminal-missing-receipt",
          toolName: "terminal.exec",
          outcome: "succeeded",
          receiptId: null,
          errorCode: null,
        },
      );
      expect(completed.status).toBe("failed");
    } finally {
      value.registry.close();
    }
  });

  it("persists terminal evidence on a completed inferred Task without renaming its owner", async () => {
    const value = await fixture();
    const activationSessionId = "installed-activation-session";
    const ownerName = "GPT-5.6 Pro";
    const idempotencyKey = `inferred:${principalId}`;
    const existing = value.registry.createTask(
      {
        title: "Installed activation",
        status: "failed",
        agentId: principalId,
        agentName: ownerName,
        idempotencyKey,
      },
      principalId,
      value.workspace,
      "inferred",
      activationSessionId,
    );
    let executed = false;
    let activityTaskId: string | null = null;
    const definition = defineTool(
      {
        name: "terminal.exec",
        version: "1.0.0",
        title: "Activate installed release",
        description: "Exercise Task-bound terminal evidence persistence.",
        category: "terminal",
        requiredCapabilities: [],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema({}, []),
      },
      {},
      () => {
        executed = true;
        return { exitCode: 0, receiptId: "activation-receipt" };
      },
    );
    const catalog = new ToolCatalog(
      [definition],
      new PolicyEngine(),
      "test",
      undefined,
      undefined,
      (event) => {
        if (event.phase === "started") {
          const task = value.registry.attachActivity({
            activityId: event.id,
            principalId: event.principalId,
            sessionId: event.sessionId,
            toolName: event.toolName,
            title: event.title,
            category: event.category,
            startedAt: event.startedAt,
            projectRoot: value.workspace,
          });
          activityTaskId = task.id;
          return;
        }
        if (activityTaskId === null) {
          throw new Error("Terminal activity did not attach to a Task.");
        }
        value.registry.completeActivity(
          activityTaskId,
          event.outcome === "failed" ? "failed" : "succeeded",
          event.completedAt ?? new Date().toISOString(),
          0,
          event.title,
          event.sessionId,
          {
            activityId: event.id,
            toolName: event.toolName,
            outcome: event.outcome === "failed" ? "failed" : "succeeded",
            receiptId: event.receiptId,
            errorCode: event.errorCode,
          },
        );
      },
    );

    try {
      await expect(
        catalog.invoke(
          "terminal.exec",
          {
            principal: createPrincipal(principalId, CAPABILITIES, [
              "desktop-workspace",
            ]),
            sessionId: activationSessionId,
          },
          {},
        ),
      ).resolves.toMatchObject({
        exitCode: 0,
        receiptId: "activation-receipt",
      });
      expect(executed).toBe(true);
      expect(activityTaskId).toBe(existing.id);
      expect(value.registry.requiredTask(existing.id)).toMatchObject({
        status: "succeeded",
        lastActivityLabel: "Activate installed release",
        agent: {
          id: principalId,
          name: ownerName,
          principalId,
        },
      });

      expect(() =>
        value.registry.createTask(
          {
            title: "Rename replay",
            status: "running",
            agentId: principalId,
            agentName: "Renamed Agent",
            idempotencyKey,
          },
          principalId,
          value.workspace,
          "inferred",
        ),
      ).toThrowError(
        expect.objectContaining({
          message: "Task creation replay cannot rename the current Task Agent owner.",
        }),
      );
      expect(() =>
        value.registry.createTask(
          {
            title: "Takeover replay",
            status: "running",
            agentId: "different-agent",
            agentName: ownerName,
            idempotencyKey,
          },
          principalId,
          value.workspace,
          "inferred",
        ),
      ).toThrowError(
        expect.objectContaining({
          message:
            "Task creation replay does not match the Task's current Agent owner.",
        }),
      );
    } finally {
      value.registry.close();
    }
  });
});
