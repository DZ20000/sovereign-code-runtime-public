import { z } from "zod";

import type {
  AcknowledgeTaskCoordinationMessageInput,
  AcknowledgeTaskCoordinationThroughInput,
  BroadcastTaskCoordinationMessageInput,
  CancelTaskCoordinationMessageInput,
  ReplyTaskCoordinationMessageInput,
  SendTaskCoordinationMessageInput,
  TaskCoordinationDirectoryInput,
  TaskCoordinationInboxInput,
  TaskCoordinationOutboxInput,
  TaskCoordinationPendingInput,
  TaskCoordinationThreadInput,
} from "@sovereign/control-plane-contract";
import {
  defineTool,
  objectSchema,
  type RuntimeToolDefinition,
} from "@sovereign/toolkit";

import { TaskCoordinationStore } from "./task-coordination-store.js";

const identifier = z.string().min(1).max(128);
const content = z.string().min(1).max(8_000);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const messageLimit = z.number().int().min(1).max(100).optional();
const coordinationKind = z.enum([
  "message",
  "question",
  "request",
  "handoff",
  "decision",
  "notice",
  "freeze",
  "release-request",
  "release-result",
]);
const expiresAt = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Expiry must be an ISO date-time.",
  )
  .nullable()
  .optional();

function sourceProperties(): Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> {
  return {
    sourceTaskId: { type: "string", minLength: 1, maxLength: 128 },
    sourceSessionId: { type: "string", minLength: 1, maxLength: 128 },
    sourceAgentId: { type: "string", minLength: 1, maxLength: 128 },
  };
}

function messageProperties(): Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> {
  return {
    kind: {
      type: "string",
      enum: [
        "message",
        "question",
        "request",
        "handoff",
        "decision",
        "notice",
        "freeze",
        "release-request",
        "release-result",
      ],
    },
    content: { type: "string", minLength: 1, maxLength: 8_000 },
    requiresAcknowledgement: { type: "boolean" },
    expiresAt: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: 64,
      format: "date-time",
    },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
  };
}

function sourceValidation() {
  return {
    sourceTaskId: identifier,
    sourceSessionId: identifier,
    sourceAgentId: identifier,
  };
}

function messageValidation() {
  return {
    kind: coordinationKind.optional(),
    content,
    requiresAcknowledgement: z.boolean().optional(),
    expiresAt,
    idempotencyKey: identifier,
  };
}

export function createTaskCoordinationTools(
  store: TaskCoordinationStore,
  defaultProjectRoot: string,
  defaultWorkspaceId: string,
): readonly RuntimeToolDefinition[] {
  const workspace = (): string => defaultWorkspaceId;
  const context = (principalId: string, sessionId?: string | null) => ({
    principalId,
    workspaceRoot: defaultProjectRoot,
    sessionId: sessionId ?? null,
  });
  return [
    defineTool(
      {
        name: "tasks.coordination.directory",
        version: "2.0.0",
        title: "List coordination endpoints",
        description:
          "List formal Task endpoints in this workspace without changing task ownership. Missing roots and terminal or unassigned Tasks are reported as unavailable.",
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
        offset: sequence.max(500).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      ({ principal, sessionId }, input) =>
        store.directory(
          input as TaskCoordinationDirectoryInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.pending",
        version: "2.0.0",
        title: "Discover pending Task coordination",
        description:
          "Read pending coordination addressed to formal Tasks currently owned by this Agent identity. This does not mark messages read; call inbox for each Task before acting.",
        category: "tasks",
        requiredCapabilities: ["tasks.read"],
        sideEffect: "read",
        destructive: false,
        permissionLevel: "observe",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            taskLimit: { type: "integer", minimum: 1, maximum: 50 },
            messageLimit: { type: "integer", minimum: 1, maximum: 50 },
          },
          ["agentId"],
        ),
      },
      {
        agentId: identifier,
        taskLimit: z.number().int().min(1).max(50).optional(),
        messageLimit: z.number().int().min(1).max(50).optional(),
      },
      ({ principal, sessionId }, input) =>
        store.pending(
          input as TaskCoordinationPendingInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.send",
        version: "2.0.0",
        title: "Send Task coordination",
        description:
          "Send one idempotent coordination envelope from a Task owned by the calling Agent to another formal Task. Sender identity is verified and never becomes the target Task owner. This is advisory only and does not grant build, publish, install, activation, rollback or restart authority.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            ...sourceProperties(),
            targetTaskId: { type: "string", minLength: 1, maxLength: 128 },
            ...messageProperties(),
          },
          [
            "sourceTaskId",
            "sourceSessionId",
            "sourceAgentId",
            "targetTaskId",
            "content",
            "idempotencyKey",
          ],
        ),
      },
      {
        ...sourceValidation(),
        targetTaskId: identifier,
        ...messageValidation(),
      },
      ({ principal, sessionId }, input) =>
        store.send(
          input as SendTaskCoordinationMessageInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.broadcast",
        version: "2.0.0",
        title: "Broadcast Task coordination",
        description:
          "Create a new atomic broadcast to 1-32 explicit Task IDs, or replay an existing batch with its original target set and sending identity. Replay does not reapply new-batch limits or depend on current endpoint assignment. A broadcast is advisory and grants no operational authority.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            ...sourceProperties(),
            targetTaskIds: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
            ...messageProperties(),
          },
          [
            "sourceTaskId",
            "sourceSessionId",
            "sourceAgentId",
            "targetTaskIds",
            "content",
            "idempotencyKey",
          ],
        ),
      },
      {
        ...sourceValidation(),
        // The store applies the target limit only after persisted replay lookup.
        targetTaskIds: z.array(identifier).min(1),
        ...messageValidation(),
      },
      ({ principal, sessionId }, input) =>
        store.broadcast(
          input as BroadcastTaskCoordinationMessageInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.inbox",
        version: "2.0.0",
        title: "Read Task coordination inbox",
        description:
          "Read one Task inbox in recipient-sequence order. Returned live messages are durably marked delivered and read for this Agent/session; acknowledgement remains explicit when required.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            sessionId: { type: "string", minLength: 1, maxLength: 128 },
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            afterSequence: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            pendingOnly: { type: "boolean" },
          },
          ["taskId", "sessionId", "agentId"],
        ),
      },
      {
        taskId: identifier,
        sessionId: identifier,
        agentId: identifier,
        afterSequence: sequence.optional(),
        limit: messageLimit,
        pendingOnly: z.boolean().optional(),
      },
      ({ principal, sessionId }, input) =>
        store.inbox(
          input as TaskCoordinationInboxInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.outbox",
        version: "2.0.0",
        title: "Read Task coordination outbox",
        description:
          "Read coordination sent by one currently owned Task, including queued, read, acknowledged, replied, cancelled, expired and recipient-changed states. A new principal cannot read a previous owner's outbox.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            sessionId: { type: "string", minLength: 1, maxLength: 128 },
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            afterSequence: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          ["taskId", "sessionId", "agentId"],
        ),
      },
      {
        taskId: identifier,
        sessionId: identifier,
        agentId: identifier,
        afterSequence: sequence.optional(),
        limit: messageLimit,
      },
      ({ principal, sessionId }, input) =>
        store.outbox(
          input as TaskCoordinationOutboxInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.thread",
        version: "2.0.0",
        title: "Read Task coordination thread",
        description:
          "Read one correlation thread visible to the current Task principal. Incoming returned messages are marked read. Task ownership changes never expose a previous principal's thread.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            sessionId: { type: "string", minLength: 1, maxLength: 128 },
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            correlationId: { type: "string", minLength: 1, maxLength: 128 },
            afterOrdinal: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          ["taskId", "sessionId", "agentId", "correlationId"],
        ),
      },
      {
        taskId: identifier,
        sessionId: identifier,
        agentId: identifier,
        correlationId: identifier,
        afterOrdinal: sequence.optional(),
        limit: messageLimit,
      },
      ({ principal, sessionId }, input) =>
        store.thread(
          input as TaskCoordinationThreadInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.acknowledge",
        version: "2.0.0",
        title: "Acknowledge Task coordination",
        description:
          "Explicitly acknowledge one coordination envelope after it has been read by the current Task owner.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            messageId: { type: "string", minLength: 1, maxLength: 128 },
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            sessionId: { type: "string", minLength: 1, maxLength: 128 },
            agentId: { type: "string", minLength: 1, maxLength: 128 },
          },
          ["messageId", "taskId", "sessionId", "agentId"],
        ),
      },
      {
        messageId: identifier,
        taskId: identifier,
        sessionId: identifier,
        agentId: identifier,
      },
      ({ principal, sessionId }, input) =>
        store.acknowledge(
          input as AcknowledgeTaskCoordinationMessageInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.acknowledgeThrough",
        version: "1.0.0",
        title: "Acknowledge Task coordination through cursor",
        description:
          "Acknowledge every read, acknowledgement-required message in one Task inbox through a recipient sequence cursor. Cancelled, expired and unread messages are not changed.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            taskId: { type: "string", minLength: 1, maxLength: 128 },
            sessionId: { type: "string", minLength: 1, maxLength: 128 },
            agentId: { type: "string", minLength: 1, maxLength: 128 },
            throughSequence: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
          ["taskId", "sessionId", "agentId", "throughSequence"],
        ),
      },
      {
        taskId: identifier,
        sessionId: identifier,
        agentId: identifier,
        throughSequence: sequence,
      },
      ({ principal, sessionId }, input) =>
        store.acknowledgeThrough(
          input as AcknowledgeTaskCoordinationThroughInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.reply",
        version: "2.0.0",
        title: "Reply to Task coordination",
        description:
          "Reply from the current recipient Task into the original correlation thread. Replying also acknowledges the parent. Principal changes fail closed; same-principal Agent handoff remains deliverable.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            ...sourceProperties(),
            replyToMessageId: { type: "string", minLength: 1, maxLength: 128 },
            ...messageProperties(),
          },
          [
            "sourceTaskId",
            "sourceSessionId",
            "sourceAgentId",
            "replyToMessageId",
            "content",
            "idempotencyKey",
          ],
        ),
      },
      {
        ...sourceValidation(),
        replyToMessageId: identifier,
        ...messageValidation(),
      },
      ({ principal, sessionId }, input) =>
        store.reply(
          input as ReplyTaskCoordinationMessageInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
    defineTool(
      {
        name: "tasks.coordination.cancel",
        version: "1.0.0",
        title: "Cancel sent Task coordination",
        description:
          "Cancel an unacknowledged, unreplied coordination envelope sent by the current Task owner. Cancellation is idempotent and does not alter either Task owner.",
        category: "tasks",
        requiredCapabilities: ["tasks.write"],
        sideEffect: "write",
        destructive: false,
        permissionLevel: "workspace",
        approvalMode: "none",
        inputSchema: objectSchema(
          {
            ...sourceProperties(),
            messageId: { type: "string", minLength: 1, maxLength: 128 },
          },
          ["sourceTaskId", "sourceSessionId", "sourceAgentId", "messageId"],
        ),
      },
      {
        ...sourceValidation(),
        messageId: identifier,
      },
      ({ principal, sessionId }, input) =>
        store.cancel(
          input as CancelTaskCoordinationMessageInput,
          context(principal.id, sessionId),
        ),
      workspace,
    ),
  ];
}
