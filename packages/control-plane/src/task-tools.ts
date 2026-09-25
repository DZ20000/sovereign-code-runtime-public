import { z } from "zod";

import type {
  DesktopTaskCategory,
  DesktopTaskClaimInput,
  DesktopTaskCreateInput,
  DesktopTaskHeartbeatInput,
  DesktopTaskInboxInput,
  DesktopTaskMessageInput,
  DesktopTaskMessageListInput,
  DesktopTaskStatus,
  DesktopTaskStep,
  DesktopTaskUnassignInput,
  DesktopTaskUpdateInput,
} from "@sovereign/control-plane-contract";
import {
  defineTool,
  objectSchema,
  type RuntimeToolDefinition,
} from "@sovereign/toolkit";

import { TaskRegistry } from "./task-registry.js";

const taskCategory = z.enum([
  "development",
  "testing",
  "build",
  "research",
  "maintenance",
  "automation",
  "other",
]);
const taskStatus = z.enum([
  "queued",
  "planning",
  "running",
  "waiting-user",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
]);
const heartbeatStatus = z.enum([
  "planning",
  "running",
  "waiting-user",
  "blocked",
]);
const taskStepStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
const taskStep = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(240),
    status: taskStepStatus,
    updatedAt: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        "Step update timestamp must be an ISO date-time.",
      ),
  })
  .strict();
const nullableProgress = z
  .number()
  .int()
  .min(0)
  .max(1_000_000)
  .nullable()
  .optional();

function taskProperties(): Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> {
  return {
    projectRoot: { type: "string", minLength: 1, maxLength: 4_096 },
    projectName: { type: "string", minLength: 1, maxLength: 160 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    category: {
      type: "string",
      enum: [
        "development",
        "testing",
        "build",
        "research",
        "maintenance",
        "automation",
        "other",
      ],
    },
    summary: { type: "string", maxLength: 2_000 },
    status: {
      type: "string",
      enum: [
        "queued",
        "planning",
        "running",
        "waiting-user",
        "blocked",
        "succeeded",
        "failed",
        "cancelled",
      ],
    },
    currentStep: { type: "string", maxLength: 400 },
    progressCurrent: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 1_000_000,
    },
    progressTotal: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 1_000_000,
    },
    progressLabel: { type: ["string", "null"], maxLength: 240 },
    steps: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          title: { type: "string", minLength: 1, maxLength: 240 },
          status: {
            type: "string",
            enum: ["pending", "running", "succeeded", "failed", "skipped"],
          },
          updatedAt: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            format: "date-time",
          },
        },
        required: ["id", "title", "status", "updatedAt"],
      },
    },
    agentId: { type: "string", minLength: 1, maxLength: 128 },
    agentName: { type: "string", minLength: 1, maxLength: 160 },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
  };
}

export function createTaskTools(
  registry: TaskRegistry,
  defaultProjectRoot: string,
  defaultWorkspaceId: string,
): readonly RuntimeToolDefinition[] {
  const workspace = (): string => defaultWorkspaceId;
  return [
    defineTool(
      {
        name: "tasks.list",
        version: "1.0.0",
        title: "List projects and tasks",
        description:
          "List one bounded page of project cards and compact task summaries across this principal's projects, independent of the current workspace. Includes status, progress, Agent presence and unread user messages. Follow nextOffset until null.",
        category: "tasks",
        requiredCapabilities: ["tasks.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            offset: { type: "integer", minimum: 0, maximum: 500 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          [],
        ),
      },
      {
        offset: z.number().int().min(0).max(500).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      ({ principal }, input) =>
        registry.snapshotForPrincipal(
          principal.id,
          input.offset ?? 0,
          input.limit ?? 64,
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.inbox",
        version: "1.0.0",
        title: "Read operator message inbox",
        description:
          "Read pending operator messages from the local Tasks panel across every task owned by this Agent principal. Call this before starting work, after long-running operations, and before a final response. Process messages in sequence order, then acknowledge each task through tasks.heartbeat.",
        category: "tasks",
        requiredCapabilities: ["tasks.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskLimit: { type: "integer", minimum: 1, maximum: 50 },
            messageLimit: { type: "integer", minimum: 1, maximum: 50 },
          },
          [],
        ),
      },
      {
        taskLimit: z.number().int().min(1).max(50).optional(),
        messageLimit: z.number().int().min(1).max(50).optional(),
      },
      ({ principal }, input) =>
        registry.inboxForPrincipal(
          principal.id,
          (input as DesktopTaskInboxInput).taskLimit,
          (input as DesktopTaskInboxInput).messageLimit,
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.get",
        version: "1.0.0",
        title: "Read task detail",
        description:
          "Read one task owned by this principal, independent of the current workspace, with progress, steps, Agent heartbeat state and a byte-bounded latest conversation window. Use tasks.messages.list for older messages when messagesTruncated is true.",
        category: "tasks",
        requiredCapabilities: ["tasks.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            messageLimit: { type: "integer", minimum: 1, maximum: 500 },
          },
          ["taskId"],
        ),
      },
      {
        taskId: z.string().min(1).max(128),
        messageLimit: z.number().int().min(1).max(500).optional(),
      },
      ({ principal }, input) =>
        registry.detailForPrincipal(
          input.taskId,
          principal.id,
          input.messageLimit ?? 200,
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.create",
        version: "1.0.0",
        title: "Create or claim task",
        description:
          "Create a project task for the executing Agent. Use an idempotency key to claim the same task safely after reconnecting.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(taskProperties(), ["title"]),
      },
      {
        projectRoot: z.string().min(1).max(4_096).optional(),
        projectName: z.string().min(1).max(160).optional(),
        title: z.string().min(1).max(200),
        category: taskCategory.optional(),
        summary: z.string().max(2_000).optional(),
        status: taskStatus.optional(),
        currentStep: z.string().max(400).optional(),
        progressCurrent: nullableProgress,
        progressTotal: nullableProgress,
        progressLabel: z.string().max(240).nullable().optional(),
        steps: z.array(taskStep).max(100).optional(),
        agentId: z.string().min(1).max(128).optional(),
        agentName: z.string().min(1).max(160).optional(),
        idempotencyKey: z.string().min(1).max(256).optional(),
      },
      ({ principal, sessionId }, input) =>
        registry.createTask(
          input as DesktopTaskCreateInput,
          principal.id,
          defaultProjectRoot,
          "agent",
          sessionId,
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.claim",
        version: "1.0.0",
        title: "Explicitly claim an inactive Task",
        description:
          "Explicitly claim an unassigned, stale or offline non-terminal Task with compare-and-swap protection. An online Agent cannot be replaced. Use expectedCurrentAgentId to prevent racing another recovery session.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            agentName: { type: "string", minLength: 1, maxLength: 160 },
            expectedCurrentAgentId: {
              type: ["string", "null"],
              minLength: 1,
              maxLength: 128,
            },
          },
          ["taskId", "agentId", "agentName"],
        ),
      },
      {
        taskId: z.string().min(1).max(128),
        agentId: z.string().min(1).max(128),
        agentName: z.string().min(1).max(160),
        expectedCurrentAgentId: z
          .string()
          .min(1)
          .max(128)
          .nullable()
          .optional(),
      },
      ({ principal, sessionId }, input) => {
        registry.taskForPrincipalWorkspace(
          input.taskId,
          defaultProjectRoot,
          principal.id,
        );
        return registry.claimTask(
          input as DesktopTaskClaimInput,
          principal.id,
          sessionId,
        );
      },
      workspace,
    ),
    defineTool(
      {
        name: "tasks.update",
        version: "1.0.0",
        title: "Update task",
        description:
          "Update a Task owned by the current Agent. agentId is required and must match the current owner. This tool cannot transfer or unassign ownership.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            title: { type: "string", minLength: 1, maxLength: 200 },
            category: {
              type: "string",
              enum: [
                "development",
                "testing",
                "build",
                "research",
                "maintenance",
                "automation",
                "other",
              ],
            },
            status: {
              type: "string",
              enum: [
                "queued",
                "planning",
                "running",
                "waiting-user",
                "blocked",
                "succeeded",
                "failed",
                "cancelled",
              ],
            },
            summary: { type: "string", maxLength: 2_000 },
            currentStep: { type: "string", maxLength: 400 },
            progressCurrent: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: 1_000_000,
            },
            progressTotal: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: 1_000_000,
            },
            progressLabel: { type: ["string", "null"], maxLength: 240 },
            steps: taskProperties().steps!,
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            agentName: {
              type: "string",
              minLength: 1,
              maxLength: 160,
            },
          },
          ["taskId", "agentId"],
        ),
      },
      {
        taskId: z.string().min(1).max(128),
        title: z.string().min(1).max(200).optional(),
        category: taskCategory.optional(),
        status: taskStatus.optional(),
        summary: z.string().max(2_000).optional(),
        currentStep: z.string().max(400).optional(),
        progressCurrent: nullableProgress,
        progressTotal: nullableProgress,
        progressLabel: z.string().max(240).nullable().optional(),
        steps: z.array(taskStep).max(100).optional(),
        agentId: z.string().min(1).max(128),
        agentName: z.string().min(1).max(160).optional(),
      },
      ({ principal, sessionId }, input) => {
        registry.taskForPrincipalWorkspace(
          input.taskId,
          defaultProjectRoot,
          principal.id,
        );
        return registry.updateTask(
          input as DesktopTaskUpdateInput,
          principal.id,
          sessionId,
        );
      },
      workspace,
    ),
    defineTool(
      {
        name: "tasks.unassign",
        version: "1.0.0",
        title: "Explicitly unassign a Task",
        description:
          "Explicitly remove the current Agent owner from a non-terminal formal Task. agentId must match the current owner; later ownership requires tasks.claim.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            agentName: { type: "string", minLength: 1, maxLength: 160 },
          },
          ["taskId", "agentId"],
        ),
      },
      {
        taskId: z.string().min(1).max(128),
        agentId: z.string().min(1).max(128),
        agentName: z.string().min(1).max(160).optional(),
      },
      ({ principal }, input) => {
        registry.taskForPrincipalWorkspace(
          input.taskId,
          defaultProjectRoot,
          principal.id,
        );
        return registry.unassignTask(
          input as DesktopTaskUnassignInput,
          principal.id,
        );
      },
      workspace,
    ),
    defineTool(
      {
        name: "tasks.heartbeat",
        version: "1.0.0",
        title: "Update Agent heartbeat",
        description:
          "Refresh Agent presence and task progress. The byte-bounded response includes the next user messages not yet acknowledged by the Agent; acknowledge the last delivered sequence and repeat until none remain.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            agentName: { type: "string", minLength: 1, maxLength: 160 },
            status: {
              type: "string",
              enum: ["planning", "running", "waiting-user", "blocked"],
            },
            currentStep: { type: "string", maxLength: 400 },
            progressCurrent: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: 1_000_000,
            },
            progressTotal: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: 1_000_000,
            },
            progressLabel: { type: ["string", "null"], maxLength: 240 },
            acknowledgeThroughSequence: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
          ["taskId", "agentId"],
        ),
      },
      {
        taskId: z.string().min(1).max(128),
        agentId: z.string().min(1).max(128),
        agentName: z.string().min(1).max(160).optional(),
        status: heartbeatStatus.optional(),
        currentStep: z.string().max(400).optional(),
        progressCurrent: nullableProgress,
        progressTotal: nullableProgress,
        progressLabel: z.string().max(240).nullable().optional(),
        acknowledgeThroughSequence: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      },
      ({ principal, sessionId }, input) => {
        registry.taskForPrincipalWorkspace(
          input.taskId,
          defaultProjectRoot,
          principal.id,
        );
        return registry.heartbeat(
          input as DesktopTaskHeartbeatInput,
          principal.id,
          sessionId,
        );
      },
      workspace,
    ),
    defineTool(
      {
        name: "tasks.messages.list",
        version: "1.0.0",
        title: "Read task messages",
        description:
          "Read a byte-bounded conversation page for a task owned by this principal, independent of the current workspace. Continue from the last returned sequence when fewer messages than requested are returned.",
        category: "tasks",
        requiredCapabilities: ["tasks.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            afterSequence: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          ["taskId"],
        ),
      },
      {
        taskId: z.string().min(1).max(128),
        afterSequence: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      ({ principal }, input) => {
        registry.taskForPrincipal(input.taskId, principal.id);
        return registry.listMessages(input as DesktopTaskMessageListInput);
      },
      workspace,
    ),
    defineTool(
      {
        name: "tasks.message.send",
        version: "1.0.0",
        title: "Send task message",
        description:
          "Send an assistant message into this Task's operator-visible conversation. agentId must match the current Task owner. This is not an inter-Task channel; use tasks.coordination.send for Agent-to-Agent coordination.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            content: { type: "string", minLength: 1, maxLength: 8_000 },
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            agentName: { type: "string", minLength: 1, maxLength: 160 },
          },
          ["taskId", "content", "agentId"],
        ),
      },
      {
        taskId: z.string().min(1).max(128),
        content: z.string().min(1).max(8_000),
        agentId: z.string().min(1).max(128),
        agentName: z.string().min(1).max(160).optional(),
      },
      ({ principal, sessionId }, input) => {
        registry.taskForPrincipalWorkspace(
          input.taskId,
          defaultProjectRoot,
          principal.id,
        );
        return registry.addAgentMessage(
          input.taskId,
          input.content,
          "assistant",
          input.agentId,
          input.agentName,
          principal.id,
          sessionId,
        );
      },
      workspace,
    ),
  ];
}

export const TASK_TOOL_CATEGORIES: readonly DesktopTaskCategory[] = [
  "development",
  "testing",
  "build",
  "research",
  "maintenance",
  "automation",
  "other",
];
export const TASK_TOOL_STATUSES: readonly DesktopTaskStatus[] = [
  "queued",
  "planning",
  "running",
  "waiting-user",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
];
export type TaskToolMessageInput = DesktopTaskMessageInput;
export type TaskToolStep = DesktopTaskStep;
