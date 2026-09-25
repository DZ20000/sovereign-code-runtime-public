import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneController } from "../../packages/control-plane/src/controller.js";
import {
  DEFAULT_CONTROL_PLANE_SETTINGS,
  writeControlPlaneSettings,
} from "../../packages/control-plane/src/settings.js";
import type {
  DesktopTaskDetail,
  DesktopTaskHeartbeatResult,
  DesktopTaskInbox,
  DesktopTaskSummary,
  SovereignConnectionBundle,
} from "../../packages/control-plane-contract/src/index.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

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

async function initializeMcpSession(
  endpoint: string,
  authorization: string,
): Promise<string> {
  const headers = {
    Authorization: authorization,
    Origin: new URL(endpoint).origin,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "desktop-task-agent-test", version: "1.0.0" },
      },
    }),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).not.toBeNull();
  const initialized = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": sessionId ?? "missing" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  expect([200, 202]).toContain(initialized.status);
  return sessionId ?? "missing";
}

async function callToolEnvelope(
  endpoint: string,
  authorization: string,
  sessionId: string,
  id: number,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): Promise<{
  readonly result?: {
    readonly isError?: boolean;
    readonly content?: readonly {
      readonly type?: string;
      readonly text?: string;
    }[];
    readonly structuredContent?: {
      readonly result?: unknown;
      readonly operatorInbox?: unknown;
    };
  };
}> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Origin: new URL(endpoint).origin,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: argumentsValue },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    readonly result?: {
      readonly isError?: boolean;
      readonly content?: readonly {
        readonly type?: string;
        readonly text?: string;
      }[];
      readonly structuredContent?: {
        readonly result?: unknown;
        readonly operatorInbox?: unknown;
      };
    };
  };
}

async function callTool<T>(
  endpoint: string,
  authorization: string,
  sessionId: string,
  id: number,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): Promise<T> {
  const body = await callToolEnvelope(
    endpoint,
    authorization,
    sessionId,
    id,
    name,
    argumentsValue,
  );
  expect(body.result?.isError).not.toBe(true);
  const text = body.result?.content?.find((item) => item.type === "text")?.text;
  expect(text).toEqual(expect.any(String));
  return JSON.parse(text ?? "null") as T;
}

describe("desktop task and Agent lifecycle", () => {
  it("lets an Agent register work, receive queued user messages and publish progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-desktop-task-agent-"));
    cleanupPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const projectRoot = join(workspaceRoot, "packages", "agent-hub");
    await mkdir(projectRoot, { recursive: true });
    await writeControlPlaneSettings(join(root, "settings.json"), {
      ...DEFAULT_CONTROL_PLANE_SETTINGS,
      workspaceRoot,
      autoStart: false,
    });

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
      approvalSurface: { present: async () => "deny" },
    });

    try {
      await controller.initialize();
      await controller.start();

      expect(
        controller
          .manifest()
          ?.tools.filter((tool) => tool.name.startsWith("tasks."))
          .map((tool) => tool.name)
          .sort(),
      ).toEqual([
        "tasks.claim",
        "tasks.coordination.acknowledge",
        "tasks.coordination.acknowledgeThrough",
        "tasks.coordination.broadcast",
        "tasks.coordination.cancel",
        "tasks.coordination.directory",
        "tasks.coordination.inbox",
        "tasks.coordination.outbox",
        "tasks.coordination.pending",
        "tasks.coordination.reply",
        "tasks.coordination.send",
        "tasks.coordination.thread",
        "tasks.create",
        "tasks.get",
        "tasks.heartbeat",
        "tasks.inbox",
        "tasks.list",
        "tasks.message.send",
        "tasks.messages.list",
        "tasks.unassign",
        "tasks.update",
      ]);

      const connection = controller.connectionBundle();
      const bundle = JSON.parse(
        connection.serialized,
      ) as SovereignConnectionBundle;
      const authorization = bundle.transport.headers.Authorization;
      const sessionId = await initializeMcpSession(
        connection.endpoint,
        authorization,
      );

      const observeSnapshot = await callTool<{
        readonly schemaVersion: string;
        readonly projects: readonly unknown[];
      }>(connection.endpoint, authorization, sessionId, 2, "tasks.list", {});
      expect(observeSnapshot).toMatchObject({
        schemaVersion: "scr.task-workspace/v1",
        projects: [],
      });
      const deniedCreate = await callToolEnvelope(
        connection.endpoint,
        authorization,
        sessionId,
        3,
        "tasks.create",
        {
          projectRoot,
          title: "Must not be created at L1",
        },
      );
      expect(deniedCreate.result?.isError).toBe(true);
      expect(
        deniedCreate.result?.content?.map((item) => item.text ?? "").join(" "),
      ).toMatch(/capability|permission|denied|tasks\.write/iu);
      expect(controller.taskWorkspaceSnapshot().projects).toEqual([]);

      await controller.setPermissionProfile("bypass");

      const created = await callTool<DesktopTaskSummary>(
        connection.endpoint,
        authorization,
        sessionId,
        4,
        "tasks.create",
        {
          projectRoot,
          projectName: "Agent Hub",
          title: "Build project task panel",
          category: "development",
          summary:
            "Show projects as large blocks with task detail and Agent conversation.",
          status: "running",
          currentStep: "Create the persistent task model",
          progressCurrent: 2,
          progressTotal: 6,
          progressLabel: "Core model",
          agentId: "agent-task-hub",
          agentName: "Task Hub Agent",
          idempotencyKey: "task-hub-main",
          steps: [
            {
              id: "model",
              title: "Create task model",
              status: "running",
              updatedAt: new Date().toISOString(),
            },
          ],
        },
      );
      expect(created).toMatchObject({
        projectName: "Agent Hub",
        title: "Build project task panel",
        status: "running",
        source: "agent",
        agent: {
          id: "agent-task-hub",
          name: "Task Hub Agent",
          principalId: "chatgpt-web",
          presence: "online",
        },
      });

      const snapshot = controller.taskWorkspaceSnapshot();
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.projects[0]).toMatchObject({
        name: "Agent Hub",
        activeTaskCount: 1,
        onlineAgentCount: 1,
      });

      const afterUserMessage = controller.addTaskUserMessage(
        created.id,
        "Keep each project in a large block and continue without asking me to operate anything.",
      );
      const userMessage = afterUserMessage.messages.at(-1);
      expect(userMessage).toMatchObject({ role: "user", acknowledgedAt: null });

      const unrelatedToolEnvelope = await callToolEnvelope(
        connection.endpoint,
        authorization,
        sessionId,
        5,
        "system.info",
        {},
      );
      expect(unrelatedToolEnvelope.result?.isError).not.toBe(true);
      const unrelatedContent = unrelatedToolEnvelope.result?.content ?? [];
      expect(unrelatedContent[0]?.text).toEqual(expect.any(String));
      expect(() =>
        JSON.parse(unrelatedContent[0]?.text ?? "null"),
      ).not.toThrow();
      const deliveredNotice = unrelatedContent
        .slice(1)
        .map((item) => item.text ?? "")
        .join("\n");
      expect(deliveredNotice).toContain("SOVEREIGN_TASK_INBOX");
      expect(deliveredNotice).toContain("Keep each project in a large block");
      expect(deliveredNotice).toContain(created.id);
      expect(unrelatedToolEnvelope.result?.structuredContent?.result).toEqual(
        JSON.parse(unrelatedContent[0]?.text ?? "null"),
      );
      expect(
        unrelatedToolEnvelope.result?.structuredContent?.operatorInbox,
      ).toMatchObject({
        totalPendingUserMessageCount: 1,
        entries: [
          expect.objectContaining({
            task: expect.objectContaining({ id: created.id }),
          }),
        ],
      });

      const inbox = await callTool<DesktopTaskInbox>(
        connection.endpoint,
        authorization,
        sessionId,
        6,
        "tasks.inbox",
        {},
      );
      expect(inbox).toMatchObject({
        schemaVersion: "scr.task-inbox/v1",
        totalPendingUserMessageCount: 1,
        totalTaskCount: 1,
        truncated: false,
      });
      expect(inbox.entries).toEqual([
        expect.objectContaining({
          projectName: "Agent Hub",
          task: expect.objectContaining({
            id: created.id,
            unreadUserMessageCount: 1,
          }),
          pendingUserMessages: [
            expect.objectContaining({
              sequence: userMessage?.sequence,
              role: "user",
              content: expect.stringContaining("large block"),
            }),
          ],
        }),
      ]);

      const heartbeat = await callTool<DesktopTaskHeartbeatResult>(
        connection.endpoint,
        authorization,
        sessionId,
        7,
        "tasks.heartbeat",
        {
          taskId: created.id,
          agentId: "agent-task-hub",
          agentName: "Task Hub Agent",
          status: "running",
          currentStep: "Build the large project cards and conversation pane",
          progressCurrent: 4,
          progressTotal: 6,
          progressLabel: "Desktop experience",
        },
      );
      expect(heartbeat.task).toMatchObject({
        currentStep: "Build the large project cards and conversation pane",
        progress: { current: 4, total: 6, label: "Desktop experience" },
      });
      expect(heartbeat.pendingUserMessages).toEqual([
        expect.objectContaining({
          sequence: userMessage?.sequence,
          role: "user",
          content: expect.stringContaining("large block"),
        }),
      ]);

      const acknowledged = await callTool<DesktopTaskHeartbeatResult>(
        connection.endpoint,
        authorization,
        sessionId,
        8,
        "tasks.heartbeat",
        {
          taskId: created.id,
          agentId: "agent-task-hub",
          acknowledgeThroughSequence: userMessage!.sequence,
        },
      );
      expect(acknowledged.pendingUserMessages).toEqual([]);
      expect(acknowledged.task.unreadUserMessageCount).toBe(0);

      const afterAcknowledgementEnvelope = await callToolEnvelope(
        connection.endpoint,
        authorization,
        sessionId,
        9,
        "system.info",
        {},
      );
      expect(afterAcknowledgementEnvelope.result?.isError).not.toBe(true);
      expect(
        afterAcknowledgementEnvelope.result?.content
          ?.slice(1)
          .map((item) => item.text ?? "")
          .join("\n"),
      ).not.toContain("SOVEREIGN_TASK_INBOX");
      expect(
        controller
          .taskDetail(created.id)
          .messages.find((message) => message.id === userMessage?.id)
          ?.acknowledgedAt,
      ).toEqual(expect.any(String));

      const conversation = await callTool<DesktopTaskDetail>(
        connection.endpoint,
        authorization,
        sessionId,
        10,
        "tasks.message.send",
        {
          taskId: created.id,
          content:
            "Acknowledged. Project cards, details and the Agent conversation are now connected.",
          agentId: "agent-task-hub",
          agentName: "Task Hub Agent",
        },
      );
      expect(conversation.messages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
      ]);

      const completed = await callTool<DesktopTaskSummary>(
        connection.endpoint,
        authorization,
        sessionId,
        11,
        "tasks.update",
        {
          taskId: created.id,
          agentId: "agent-task-hub",
          status: "succeeded",
          currentStep: "Task panel validation complete",
          progressCurrent: 6,
          progressTotal: 6,
          progressLabel: "Complete",
        },
      );
      expect(completed).toMatchObject({
        status: "succeeded",
        completedAt: expect.any(String),
        progress: { current: 6, total: 6, label: "Complete" },
      });
      expect(controller.taskDetail(created.id).messages.at(-1)).toMatchObject({
        role: "system",
        content: "Status changed from running to succeeded.",
      });
    } finally {
      await controller.shutdown();
    }
  });
});
