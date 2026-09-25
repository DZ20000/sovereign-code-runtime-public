import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DesktopTaskSummary } from "../../packages/control-plane-contract/src/index.js";
import { TaskRegistry } from "../../packages/control-plane/src/task-registry.js";

const cleanupRoots: string[] = [];
const openRegistries: TaskRegistry[] = [];
const openDatabases: DatabaseSync[] = [];
const BASE_TIME = "2026-08-29T12:00:00.000Z";

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly databasePath: string;
  readonly registry: TaskRegistry;
}

interface AgentTaskOptions {
  readonly title: string;
  readonly agentId: string;
  readonly principalId?: string;
  readonly status?:
    | "queued"
    | "planning"
    | "running"
    | "waiting-user"
    | "blocked"
    | "succeeded"
    | "failed"
    | "cancelled";
  readonly projectRoot?: string;
  readonly source?: "agent" | "inferred" | "user";
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // Best-effort failure-path cleanup.
    }
  }
  for (const registry of openRegistries.splice(0)) {
    try {
      registry.close();
    } catch {
      // Best-effort failure-path cleanup.
    }
  }
  await Promise.all(
    cleanupRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 6,
        retryDelay: 50,
      }),
    ),
  );
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "scr-task-coordination-v2-"));
  cleanupRoots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const databasePath = join(root, "tasks.sqlite");
  const registry = new TaskRegistry({ databasePath });
  openRegistries.push(registry);
  return { root, workspace, databasePath, registry };
}

function agentName(agentId: string): string {
  return `${agentId} name`;
}

function createAgentTask(
  value: Fixture,
  options: AgentTaskOptions,
): DesktopTaskSummary {
  return value.registry.createTask(
    {
      projectRoot: options.projectRoot ?? value.workspace,
      title: options.title,
      status: options.status ?? "running",
      agentId: options.agentId,
      agentName: agentName(options.agentId),
    },
    options.principalId ?? "principal-shared",
    value.workspace,
    options.source ?? "agent",
    `transport-${options.agentId}`,
  );
}

function context(
  value: Fixture,
  principalId = "principal-shared",
  now = BASE_TIME,
  transportSessionId = `transport-${principalId}`,
) {
  return {
    principalId,
    workspaceRoot: value.workspace,
    sessionId: transportSessionId,
    now,
  };
}

function sendInput(
  sender: DesktopTaskSummary,
  recipient: DesktopTaskSummary,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    sourceTaskId: sender.id,
    sourceSessionId: "sender-session-1",
    sourceAgentId: sender.agent.id!,
    targetTaskId: recipient.id,
    kind: "request" as const,
    content: "Please coordinate this work without changing either Task owner.",
    requiresAcknowledgement: true,
    idempotencyKey: "send-1",
    ...overrides,
  };
}

function directDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  openDatabases.push(database);
  return database;
}

describe("Task coordination channel v2", () => {
  it("keeps sender identity separate from recipient ownership and operator conversation", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Sender Task",
      agentId: "sender-agent",
    });
    const recipient = createAgentTask(value, {
      title: "Recipient Task",
      agentId: "recipient-agent",
    });
    const before = value.registry.requiredTask(recipient.id);

    const sent = value.registry
      .coordinationStore()
      .send(sendInput(sender, recipient), context(value));

    expect(sent.created).toBe(true);
    expect(sent.message.deliveryState).toBe("queued");
    const after = value.registry.requiredTask(recipient.id);
    expect(after.agent).toEqual(before.agent);
    expect(after.messageCount).toBe(before.messageCount);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(() =>
      value.registry.addAgentMessage(
        recipient.id,
        "This must not hijack the recipient.",
        "assistant",
        "sender-agent",
        agentName("sender-agent"),
        "principal-shared",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() =>
      value.registry.heartbeat(
        { taskId: recipient.id, agentId: "sender-agent" },
        "principal-shared",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() =>
      value.registry.updateTask(
        {
          taskId: recipient.id,
          agentId: "sender-agent",
          status: "blocked",
        },
        "principal-shared",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(value.registry.requiredTask(recipient.id).agent.id).toBe(
      "recipient-agent",
    );
  });

  it("requires explicit unassign and compare-and-swap claim instead of implicit takeover", async () => {
    const value = await fixture();
    const task = createAgentTask(value, {
      title: "Owned Task",
      agentId: "agent-old",
    });

    expect(() =>
      value.registry.claimTask(
        {
          taskId: task.id,
          agentId: "agent-new",
          agentName: agentName("agent-new"),
          expectedCurrentAgentId: "agent-old",
        },
        "principal-shared",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() =>
      value.registry.unassignTask(
        { taskId: task.id, agentId: "agent-other" },
        "principal-shared",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));

    const unassigned = value.registry.unassignTask(
      { taskId: task.id, agentId: "agent-old" },
      "principal-shared",
    );
    expect(unassigned.agent).toMatchObject({
      id: null,
      name: null,
      presence: "unknown",
    });
    expect(() =>
      value.registry.claimTask(
        {
          taskId: task.id,
          agentId: "agent-new",
          agentName: agentName("agent-new"),
          expectedCurrentAgentId: "agent-old",
        },
        "principal-shared",
      ),
    ).toThrowError(expect.objectContaining({ status: 409 }));

    const claimed = value.registry.claimTask(
      {
        taskId: task.id,
        agentId: "agent-new",
        agentName: agentName("agent-new"),
        expectedCurrentAgentId: null,
      },
      "principal-shared",
    );
    expect(claimed.agent).toMatchObject({
      id: "agent-new",
      name: agentName("agent-new"),
      presence: "online",
    });
    expect(() =>
      value.registry.updateTask(
        { taskId: task.id, agentId: "agent-old", status: "blocked" },
        "principal-shared",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(
      value.registry.updateTask(
        { taskId: task.id, agentId: "agent-new", status: "blocked" },
        "principal-shared",
      ).status,
    ).toBe("blocked");
  });

  it("tracks queued, read and acknowledged states without hiding pending work", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Question Sender",
      agentId: "agent-a",
      principalId: "principal-a",
    });
    const recipient = createAgentTask(value, {
      title: "Question Recipient",
      agentId: "agent-b",
      principalId: "principal-b",
    });
    const store = value.registry.coordinationStore();
    const sent = store.send(
      sendInput(sender, recipient),
      context(value, "principal-a"),
    );

    expect(
      store.pending({ agentId: "agent-b" }, context(value, "principal-b")),
    ).toMatchObject({
      totalPendingMessageCount: 1,
      totalTaskCount: 1,
      entries: [
        {
          taskId: recipient.id,
          pendingCount: 1,
          messages: [{ id: sent.message.id, deliveryState: "queued" }],
        },
      ],
    });
    expect(() =>
      store.acknowledge(
        {
          messageId: sent.message.id,
          taskId: recipient.id,
          sessionId: "recipient-session",
          agentId: "agent-b",
        },
        context(value, "principal-b"),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const inbox = store.inbox(
      {
        taskId: recipient.id,
        sessionId: "recipient-session",
        agentId: "agent-b",
      },
      context(value, "principal-b"),
    );
    expect(inbox).toMatchObject({
      pendingCount: 1,
      firstSequence: 1,
      lastSequence: 1,
      truncated: false,
      messages: [
        {
          id: sent.message.id,
          deliveryState: "read",
          recipient: {
            deliveredSessionId: "recipient-session",
            deliveredAgentId: "agent-b",
          },
        },
      ],
    });
    const acknowledged = store.acknowledge(
      {
        messageId: sent.message.id,
        taskId: recipient.id,
        sessionId: "recipient-session",
        agentId: "agent-b",
      },
      context(value, "principal-b"),
    );
    expect(acknowledged).toMatchObject({
      changed: true,
      message: { deliveryState: "acknowledged" },
    });
    expect(
      store.acknowledge(
        {
          messageId: sent.message.id,
          taskId: recipient.id,
          sessionId: "recipient-session",
          agentId: "agent-b",
        },
        context(value, "principal-b"),
      ).changed,
    ).toBe(false);
    expect(
      store.outbox(
        {
          taskId: sender.id,
          sessionId: "sender-session-2",
          agentId: "agent-a",
        },
        context(value, "principal-a"),
      ),
    ).toMatchObject({
      pendingDeliveryOrAcknowledgementCount: 0,
      messages: [{ id: sent.message.id, deliveryState: "acknowledged" }],
    });
  });

  it("settles no-ack notices on read and rejects meaningless acknowledgement", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Notice Sender",
      agentId: "notice-a",
    });
    const recipient = createAgentTask(value, {
      title: "Notice Recipient",
      agentId: "notice-b",
    });
    const store = value.registry.coordinationStore();
    const sent = store.send(
      sendInput(sender, recipient, {
        kind: "notice",
        requiresAcknowledgement: false,
        idempotencyKey: "notice-1",
      }),
      context(value),
    );

    expect(
      store.pending({ agentId: "notice-b" }, context(value)),
    ).toMatchObject({
      totalPendingMessageCount: 1,
    });
    const inbox = store.inbox(
      {
        taskId: recipient.id,
        sessionId: "notice-session",
        agentId: "notice-b",
      },
      context(value),
    );
    expect(inbox).toMatchObject({
      pendingCount: 0,
      messages: [{ deliveryState: "read" }],
    });
    expect(() =>
      store.acknowledge(
        {
          messageId: sent.message.id,
          taskId: recipient.id,
          sessionId: "notice-session",
          agentId: "notice-b",
        },
        context(value),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("replays idempotently across sender sessions and rejects key reuse", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Reconnect Sender",
      agentId: "reconnect-a",
    });
    const recipient = createAgentTask(value, {
      title: "Reconnect Recipient",
      agentId: "reconnect-b",
    });
    const store = value.registry.coordinationStore();
    const first = store.send(
      sendInput(sender, recipient, {
        sourceSessionId: "session-before-limit",
        idempotencyKey: "reconnect-key",
      }),
      context(value),
    );
    const replay = store.send(
      sendInput(sender, recipient, {
        sourceSessionId: "session-after-limit",
        idempotencyKey: "reconnect-key",
      }),
      context(value),
    );

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.message.id).toBe(first.message.id);
    expect(replay.message.sender.sessionId).toBe("session-before-limit");
    expect(() =>
      store.send(
        sendInput(sender, recipient, {
          sourceSessionId: "session-after-limit",
          idempotencyKey: "reconnect-key",
          content: "A different request must not reuse this key.",
        }),
        context(value),
      ),
    ).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it("broadcasts atomically and replays target-order-independent requests", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Broadcast Sender",
      agentId: "broadcast-a",
    });
    const first = createAgentTask(value, {
      title: "Broadcast Target A",
      agentId: "broadcast-b",
    });
    const second = createAgentTask(value, {
      title: "Broadcast Target B",
      agentId: "broadcast-c",
    });
    const terminal = createAgentTask(value, {
      title: "Terminal Target",
      agentId: "broadcast-d",
      status: "succeeded",
    });
    const store = value.registry.coordinationStore();
    const original = store.broadcast(
      {
        sourceTaskId: sender.id,
        sourceSessionId: "broadcast-session-1",
        sourceAgentId: "broadcast-a",
        targetTaskIds: [second.id, first.id],
        kind: "freeze",
        content: "Pause update operations until the coordinating Task replies.",
        requiresAcknowledgement: true,
        idempotencyKey: "broadcast-1",
      },
      context(value),
    );
    const replay = store.broadcast(
      {
        sourceTaskId: sender.id,
        sourceSessionId: "broadcast-session-2",
        sourceAgentId: "broadcast-a",
        targetTaskIds: [first.id, second.id],
        kind: "freeze",
        content: "Pause update operations until the coordinating Task replies.",
        requiresAcknowledgement: true,
        idempotencyKey: "broadcast-1",
      },
      context(value),
    );

    expect(original).toMatchObject({ createdCount: 2, replayedCount: 0 });
    expect(
      new Set(original.messages.map((message) => message.correlationId)),
    ).toEqual(new Set([original.correlationId]));
    expect(replay).toMatchObject({
      correlationId: original.correlationId,
      createdCount: 0,
      replayedCount: 2,
    });
    const beforeFailure = store.outbox(
      {
        taskId: sender.id,
        sessionId: "broadcast-outbox",
        agentId: "broadcast-a",
      },
      context(value),
    ).messages.length;
    expect(() =>
      store.broadcast(
        {
          sourceTaskId: sender.id,
          sourceSessionId: "broadcast-session-3",
          sourceAgentId: "broadcast-a",
          targetTaskIds: [first.id, terminal.id],
          content: "This broadcast must roll back entirely.",
          idempotencyKey: "broadcast-terminal",
        },
        context(value),
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(
      store.outbox(
        {
          taskId: sender.id,
          sessionId: "broadcast-outbox",
          agentId: "broadcast-a",
        },
        context(value),
      ).messages,
    ).toHaveLength(beforeFailure);
  });

  it("supports one correlated reply and keeps broadcast branches private", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Thread Sender",
      agentId: "thread-a",
      principalId: "principal-a",
    });
    const recipient = createAgentTask(value, {
      title: "Thread Recipient",
      agentId: "thread-b",
      principalId: "principal-b",
    });
    const store = value.registry.coordinationStore();
    const original = store.send(
      sendInput(sender, recipient, {
        kind: "question",
        idempotencyKey: "question-1",
      }),
      context(value, "principal-a"),
    );
    store.inbox(
      {
        taskId: recipient.id,
        sessionId: "thread-recipient",
        agentId: "thread-b",
      },
      context(value, "principal-b"),
    );
    const reply = store.reply(
      {
        sourceTaskId: recipient.id,
        sourceSessionId: "thread-recipient",
        sourceAgentId: "thread-b",
        replyToMessageId: original.message.id,
        kind: "decision",
        content:
          "Confirmed. The release remains frozen until verification completes.",
        requiresAcknowledgement: false,
        idempotencyKey: "reply-1",
      },
      context(value, "principal-b"),
    );

    expect(reply).toMatchObject({
      created: true,
      message: {
        correlationId: original.message.correlationId,
        replyToMessageId: original.message.id,
      },
    });
    expect(
      store.outbox(
        {
          taskId: sender.id,
          sessionId: "thread-sender-outbox",
          agentId: "thread-a",
        },
        context(value, "principal-a"),
      ).messages[0],
    ).toMatchObject({
      deliveryState: "replied",
      repliedAt: expect.any(String),
    });
    const senderThread = store.thread(
      {
        taskId: sender.id,
        sessionId: "thread-sender",
        agentId: "thread-a",
        correlationId: original.message.correlationId,
      },
      context(value, "principal-a"),
    );
    const recipientThread = store.thread(
      {
        taskId: recipient.id,
        sessionId: "thread-recipient",
        agentId: "thread-b",
        correlationId: original.message.correlationId,
      },
      context(value, "principal-b"),
    );
    expect(senderThread.messages.map((message) => message.id)).toEqual([
      original.message.id,
      reply.message.id,
    ]);
    expect(recipientThread.messages.map((message) => message.id)).toEqual([
      original.message.id,
      reply.message.id,
    ]);
    expect(() =>
      store.reply(
        {
          sourceTaskId: recipient.id,
          sourceSessionId: "thread-recipient",
          sourceAgentId: "thread-b",
          replyToMessageId: original.message.id,
          content: "A second independent reply must be rejected.",
          idempotencyKey: "reply-2",
        },
        context(value, "principal-b"),
      ),
    ).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it("delivers queued messages across same-principal Agent handoff without reusing a session", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Handoff Sender",
      agentId: "handoff-a",
    });
    const recipient = createAgentTask(value, {
      title: "Handoff Recipient",
      agentId: "handoff-old",
    });
    const store = value.registry.coordinationStore();
    store.outbox(
      {
        taskId: recipient.id,
        sessionId: "old-recipient-session",
        agentId: "handoff-old",
      },
      context(value),
    );
    const sent = store.send(
      sendInput(sender, recipient, { idempotencyKey: "handoff-message" }),
      context(value),
    );
    value.registry.unassignTask(
      { taskId: recipient.id, agentId: "handoff-old" },
      "principal-shared",
    );
    value.registry.claimTask(
      {
        taskId: recipient.id,
        agentId: "handoff-new",
        agentName: agentName("handoff-new"),
        expectedCurrentAgentId: null,
      },
      "principal-shared",
    );

    expect(() =>
      store.inbox(
        {
          taskId: recipient.id,
          sessionId: "old-recipient-session",
          agentId: "handoff-new",
        },
        context(
          value,
          "principal-shared",
          BASE_TIME,
          "transport-handoff-new",
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(
      store.pending({ agentId: "handoff-new" }, context(value)),
    ).toMatchObject({
      totalPendingMessageCount: 1,
    });
    const inbox = store.inbox(
      {
        taskId: recipient.id,
        sessionId: "new-recipient-session",
        agentId: "handoff-new",
      },
      context(
        value,
        "principal-shared",
        BASE_TIME,
        "transport-handoff-new",
      ),
    );
    expect(inbox.messages[0]).toMatchObject({
      id: sent.message.id,
      deliveryState: "read",
      recipient: {
        intendedAgentId: "handoff-old",
        deliveredSessionId: "new-recipient-session",
        deliveredAgentId: "handoff-new",
        ownershipCurrent: false,
        principalCurrent: true,
      },
    });
  });

  it("fails closed across principal ownership changes without leaking queued messages", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Principal Sender",
      agentId: "principal-a-agent",
      principalId: "principal-a",
    });
    const recipient = createAgentTask(value, {
      title: "Principal Recipient",
      agentId: "principal-b-agent",
      principalId: "principal-b",
    });
    const store = value.registry.coordinationStore();
    const sent = store.send(
      sendInput(sender, recipient, { idempotencyKey: "principal-change" }),
      context(value, "principal-a"),
    );
    const database = directDatabase(value.databasePath);
    database
      .prepare(
        "UPDATE tasks SET principal_id = ?, agent_id = ?, agent_name = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        "principal-c",
        "principal-c-agent",
        agentName("principal-c-agent"),
        BASE_TIME,
        recipient.id,
      );

    expect(
      store.pending(
        { agentId: "principal-c-agent" },
        context(value, "principal-c"),
      ),
    ).toMatchObject({ totalPendingMessageCount: 0, totalTaskCount: 0 });
    expect(
      store.inbox(
        {
          taskId: recipient.id,
          sessionId: "principal-c-session",
          agentId: "principal-c-agent",
        },
        context(value, "principal-c"),
      ).messages,
    ).toEqual([]);
    expect(() =>
      store.inbox(
        {
          taskId: recipient.id,
          sessionId: "principal-b-session",
          agentId: "principal-b-agent",
        },
        context(value, "principal-b"),
      ),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_FOUND" }));
    expect(
      store.outbox(
        {
          taskId: sender.id,
          sessionId: "principal-a-session",
          agentId: "principal-a-agent",
        },
        context(value, "principal-a"),
      ).messages[0],
    ).toMatchObject({
      id: sent.message.id,
      deliveryState: "recipient-changed",
      recipient: { principalCurrent: false },
    });
  });

  it("supports cancellation and expiry without manufacturing read receipts", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Lifecycle Sender",
      agentId: "lifecycle-a",
    });
    const recipient = createAgentTask(value, {
      title: "Lifecycle Recipient",
      agentId: "lifecycle-b",
    });
    const store = value.registry.coordinationStore();
    const cancellable = store.send(
      sendInput(sender, recipient, { idempotencyKey: "cancel-me" }),
      context(value),
    );
    const cancelled = store.cancel(
      {
        sourceTaskId: sender.id,
        sourceSessionId: "sender-session-1",
        sourceAgentId: "lifecycle-a",
        messageId: cancellable.message.id,
      },
      context(value),
    );
    expect(cancelled).toMatchObject({
      changed: true,
      message: { deliveryState: "cancelled", readAt: null },
    });
    expect(
      store.cancel(
        {
          sourceTaskId: sender.id,
          sourceSessionId: "sender-session-2",
          sourceAgentId: "lifecycle-a",
          messageId: cancellable.message.id,
        },
        context(value),
      ).changed,
    ).toBe(false);
    expect(
      store.pending({ agentId: "lifecycle-b" }, context(value)),
    ).toMatchObject({
      totalPendingMessageCount: 0,
    });

    const expiresAt = "2026-08-29T12:01:00.000Z";
    const expired = store.send(
      sendInput(sender, recipient, {
        idempotencyKey: "expire-me",
        expiresAt,
      }),
      context(value),
    );
    const afterExpiry = context(
      value,
      "principal-shared",
      "2026-08-29T12:02:00.000Z",
    );
    expect(
      store.pending({ agentId: "lifecycle-b" }, afterExpiry),
    ).toMatchObject({
      totalPendingMessageCount: 0,
    });
    const inbox = store.inbox(
      {
        taskId: recipient.id,
        sessionId: "lifecycle-recipient",
        agentId: "lifecycle-b",
      },
      afterExpiry,
    );
    expect(
      inbox.messages.find((message) => message.id === expired.message.id),
    ).toMatchObject({
      deliveryState: "expired",
      expiredAt: expiresAt,
      readAt: null,
    });
    expect(() =>
      store.reply(
        {
          sourceTaskId: recipient.id,
          sourceSessionId: "lifecycle-recipient",
          sourceAgentId: "lifecycle-b",
          replyToMessageId: expired.message.id,
          content: "This reply is too late.",
          idempotencyKey: "late-reply",
        },
        afterExpiry,
      ),
    ).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it("paginates inbox and outbox with independent monotonic cursors", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Paging Sender",
      agentId: "paging-a",
    });
    const recipient = createAgentTask(value, {
      title: "Paging Recipient",
      agentId: "paging-b",
    });
    const store = value.registry.coordinationStore();
    for (let index = 0; index < 5; index += 1) {
      store.send(
        sendInput(sender, recipient, {
          kind: "notice",
          content: `Notice ${index + 1}`,
          requiresAcknowledgement: false,
          idempotencyKey: `page-${index + 1}`,
        }),
        context(value),
      );
    }

    const first = store.inbox(
      {
        taskId: recipient.id,
        sessionId: "paging-recipient",
        agentId: "paging-b",
        limit: 2,
      },
      context(value),
    );
    const second = store.inbox(
      {
        taskId: recipient.id,
        sessionId: "paging-recipient",
        agentId: "paging-b",
        afterSequence: first.nextAfterSequence!,
        limit: 2,
      },
      context(value),
    );
    const third = store.inbox(
      {
        taskId: recipient.id,
        sessionId: "paging-recipient",
        agentId: "paging-b",
        afterSequence: second.nextAfterSequence!,
        limit: 2,
      },
      context(value),
    );
    expect(first.messages.map((message) => message.recipientSequence)).toEqual([
      1, 2,
    ]);
    expect(second.messages.map((message) => message.recipientSequence)).toEqual(
      [3, 4],
    );
    expect(third.messages.map((message) => message.recipientSequence)).toEqual([
      5,
    ]);
    expect(first.truncated).toBe(true);
    expect(second.truncated).toBe(true);
    expect(third.nextAfterSequence).toBeNull();
    const outbox = store.outbox(
      {
        taskId: sender.id,
        sessionId: "paging-sender",
        agentId: "paging-a",
        limit: 3,
      },
      context(value),
    );
    expect(outbox.messages.map((message) => message.senderSequence)).toEqual([
      1, 2, 3,
    ]);
    expect(outbox.nextAfterSequence).toBe(3);
  });

  it("reports unavailable directory endpoints and skips pending messages under missing roots", async () => {
    const value = await fixture();
    const missingRoot = join(value.workspace, "missing-project");
    await mkdir(missingRoot, { recursive: true });
    const sender = createAgentTask(value, {
      title: "Directory Sender",
      agentId: "directory-sender",
      projectRoot: missingRoot,
    });
    const available = createAgentTask(value, {
      title: "Available Endpoint",
      agentId: "directory-available",
    });
    const unassigned = createAgentTask(value, {
      title: "Unassigned Endpoint",
      agentId: "directory-unassigned",
    });
    value.registry.unassignTask(
      { taskId: unassigned.id, agentId: "directory-unassigned" },
      "principal-shared",
    );
    const terminal = createAgentTask(value, {
      title: "Terminal Endpoint",
      agentId: "directory-terminal",
      status: "succeeded",
    });
    const inferred = createAgentTask(value, {
      title: "Inferred Endpoint",
      agentId: "directory-inferred",
      source: "inferred",
    });
    const missing = createAgentTask(value, {
      title: "Missing Root Endpoint",
      agentId: "directory-missing",
      projectRoot: missingRoot,
    });
    const store = value.registry.coordinationStore();
    store.send(
      sendInput(sender, missing, { idempotencyKey: "missing-root-message" }),
      context(value),
    );
    await rm(missingRoot, { recursive: true, force: true });

    const directory = store.directory({}, context(value));
    const byId = new Map(directory.tasks.map((task) => [task.taskId, task]));
    expect(byId.get(available.id)).toMatchObject({
      availability: "available",
      acceptsCoordination: true,
    });
    expect(byId.get(unassigned.id)).toMatchObject({
      availability: "unassigned",
      acceptsCoordination: false,
    });
    expect(byId.get(terminal.id)).toMatchObject({
      availability: "terminal",
      acceptsCoordination: false,
    });
    expect(byId.get(inferred.id)).toMatchObject({
      availability: "inferred",
      acceptsCoordination: false,
    });
    expect(byId.get(missing.id)).toMatchObject({
      availability: "missing-root",
      acceptsCoordination: false,
    });
    expect(
      store.pending({ agentId: "directory-missing" }, context(value)),
    ).toMatchObject({
      totalPendingMessageCount: 0,
      totalTaskCount: 0,
      skippedTaskCount: 1,
    });
  });

  it("persists coordination and task-scoped idempotency across registry restarts", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Restart Sender",
      agentId: "restart-a",
    });
    const recipient = createAgentTask(value, {
      title: "Restart Recipient",
      agentId: "restart-b",
    });
    const first = value.registry.coordinationStore().send(
      sendInput(sender, recipient, {
        sourceSessionId: "before-restart",
        idempotencyKey: "restart-key",
      }),
      context(value),
    );
    value.registry.close();

    const legacy = directDatabase(value.databasePath);
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS task_coordination_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT OR REPLACE INTO task_coordination_metadata (key, value)
      VALUES ('schemaVersion', 'scr.task-coordination-store/v1');
    `);
    legacy.close();

    const reopened = new TaskRegistry({ databasePath: value.databasePath });
    openRegistries.push(reopened);
    const replay = reopened.coordinationStore().send(
      sendInput(sender, recipient, {
        sourceSessionId: "after-restart",
        idempotencyKey: "restart-key",
      }),
      context(value),
    );
    expect(replay).toMatchObject({
      created: false,
      message: { id: first.message.id },
    });
    expect(
      reopened.coordinationStore().inbox(
        {
          taskId: recipient.id,
          sessionId: "after-restart-recipient",
          agentId: "restart-b",
        },
        context(value),
      ).messages,
    ).toEqual([expect.objectContaining({ id: first.message.id })]);
  });

  it("acknowledges only read messages through a recipient cursor", async () => {
    const value = await fixture();
    const sender = createAgentTask(value, {
      title: "Batch Ack Sender",
      agentId: "batch-a",
    });
    const recipient = createAgentTask(value, {
      title: "Batch Ack Recipient",
      agentId: "batch-b",
    });
    const store = value.registry.coordinationStore();
    for (let index = 0; index < 3; index += 1) {
      store.send(
        sendInput(sender, recipient, {
          content: `Ack request ${index + 1}`,
          idempotencyKey: `ack-${index + 1}`,
        }),
        context(value),
      );
    }
    const firstPage = store.inbox(
      {
        taskId: recipient.id,
        sessionId: "batch-recipient",
        agentId: "batch-b",
        limit: 2,
      },
      context(value),
    );
    const acknowledged = store.acknowledgeThrough(
      {
        taskId: recipient.id,
        sessionId: "batch-recipient",
        agentId: "batch-b",
        throughSequence: 3,
      },
      context(value),
    );
    expect(acknowledged).toMatchObject({
      changedCount: 2,
      throughSequence: 3,
      pendingCount: 1,
    });
    expect(firstPage.messages).toHaveLength(2);
    expect(
      store.pending({ agentId: "batch-b" }, context(value)).entries[0]
        ?.messages,
    ).toEqual([expect.objectContaining({ recipientSequence: 3 })]);
  });
});
