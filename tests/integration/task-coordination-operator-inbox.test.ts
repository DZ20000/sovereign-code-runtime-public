import { DatabaseSync } from "node:sqlite";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  validateTaskCoordinationMessageCausality,
  type TaskCoordinationOperatorInbox,
} from "../../packages/control-plane-contract/src/index.js";
import {
  MAX_RESPONSE_BYTES,
  MESSAGE_TABLE,
  SESSION_TABLE,
  CURSOR_TABLE,
} from "../../packages/control-plane/src/task-coordination-store-core.js";
import { fixture } from "./task-registry-fixture.js";

function persistedCoordination(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      tasks: database.prepare("SELECT * FROM tasks ORDER BY id").all(),
      conversation: database
        .prepare("SELECT * FROM task_messages ORDER BY task_id, sequence")
        .all(),
      sessions: database.prepare(`SELECT * FROM ${SESSION_TABLE}`).all(),
      cursors: database.prepare(`SELECT * FROM ${CURSOR_TABLE}`).all(),
      messages: database
        .prepare(
          `
          SELECT * FROM ${MESSAGE_TABLE}
          ORDER BY recipient_sequence ASC
        `,
        )
        .all(),
      leases: database
        .prepare(
          `
          SELECT * FROM task_agent_session_leases_v1
          ORDER BY task_id, session_id
        `,
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

function validatedInbox<T extends TaskCoordinationOperatorInbox>(page: T): T {
  for (const message of page.messages) {
    validateTaskCoordinationMessageCausality(message, page.generatedAt);
  }
  return page;
}

async function coordinationFixture() {
  const value = await fixture();
  const sender = value.registry.createTask(
    {
      title: "Coordination sender",
      status: "running",
      agentId: "sender-agent",
      agentName: "Sender Agent",
    },
    "principal",
    value.workspace,
    "agent",
    "transport-sender",
  );
  const recipient = value.registry.createTask(
    {
      title: "Coordination recipient",
      status: "running",
      agentId: "recipient-agent",
      agentName: "Recipient Agent",
    },
    "principal",
    value.workspace,
    "agent",
    "transport-recipient",
  );
  const store = value.registry.coordinationStore();
  const context = {
    principalId: "principal",
    workspaceRoot: value.workspace,
    sessionId: "transport-sender",
  };
  return { ...value, sender, recipient, store, context };
}

describe("operator coordination inbox", () => {
  it("preserves the registry API and positional defaults at the canonical operator boundary", async () => {
    const value = await coordinationFixture();
    const taskId = value.recipient.id;
    const before = persistedCoordination(value.databasePath);
    const read = vi.spyOn(value.store, "operatorInbox");

    expectTypeOf(value.registry.coordinationInbox).toEqualTypeOf<
      (
        taskId: string,
        beforeSequence?: number,
        limit?: number,
      ) => TaskCoordinationOperatorInbox
    >();

    const page = value.registry.coordinationInbox(taskId);
    expect(read).toHaveBeenLastCalledWith({ taskId, limit: 50 });
    expect(page).toBe(read.mock.results.at(-1)?.value);

    value.registry.coordinationInbox(taskId, undefined, undefined);
    expect(read).toHaveBeenLastCalledWith({ taskId, limit: 50 });

    value.registry.coordinationInbox(taskId, undefined, 2);
    expect(read).toHaveBeenLastCalledWith({ taskId, limit: 2 });

    value.registry.coordinationInbox(taskId, 3);
    expect(read).toHaveBeenLastCalledWith({
      taskId,
      beforeSequence: 3,
      limit: 50,
    });

    value.registry.coordinationInbox(taskId, 3, 2);
    expect(read).toHaveBeenLastCalledWith({
      taskId,
      beforeSequence: 3,
      limit: 2,
    });

    const failure = new Error("Operator projection unavailable");
    read.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => value.registry.coordinationInbox(taskId)).toThrow(failure);
    expect(persistedCoordination(value.databasePath)).toEqual(before);
  });

  it("surfaces pending coordination without mutating Agent receipts, leases, ownership or Task conversation", async () => {
    const value = await coordinationFixture();
    const sent = value.store.send(
      {
        sourceTaskId: value.sender.id,
        sourceSessionId: "sender-mailbox",
        sourceAgentId: "sender-agent",
        targetTaskId: value.recipient.id,
        kind: "request",
        content: "Please verify the renderer state.",
        requiresAcknowledgement: true,
        idempotencyKey: "operator-inbox-one",
      },
      value.context,
    );
    const beforeTask = value.registry.requiredTask(value.recipient.id);
    const beforeDetail = value.registry.detail(value.recipient.id);
    const beforePersistence = persistedCoordination(value.databasePath);

    expect(beforeTask.coordinationPendingCount).toBe(1);
    expect(beforeTask.unreadUserMessageCount).toBe(0);
    expect(
      beforeDetail.messages.map((message) => message.content),
    ).not.toContain(sent.message.content);
    const listItem = value.registry
      .snapshotForWorkspace(value.workspace)
      .projects.flatMap((project) => project.tasks)
      .find((task) => task.id === value.recipient.id);
    expect(listItem?.coordinationPendingCount).toBe(1);

    const operatorInbox = validatedInbox(
      value.registry.coordinationInbox(value.recipient.id),
    );
    expect(operatorInbox).toMatchObject({
      schemaVersion: "scr.task-coordination-operator-inbox/v1",
      taskId: value.recipient.id,
      unreadCount: 1,
      pendingCount: 1,
      truncated: false,
      messages: [
        {
          id: sent.message.id,
          deliveryState: "queued",
          content: "Please verify the renderer state.",
        },
      ],
    });
    expect(persistedCoordination(value.databasePath)).toEqual(
      beforePersistence,
    );
    expect(value.registry.requiredTask(value.recipient.id)).toMatchObject({
      status: beforeTask.status,
      agent: beforeTask.agent,
      unreadUserMessageCount: 0,
      coordinationPendingCount: 1,
      messageCount: beforeTask.messageCount,
    });

    const recipientContext = {
      principalId: "principal",
      workspaceRoot: value.workspace,
      sessionId: "transport-recipient",
    };
    value.store.inbox(
      {
        taskId: value.recipient.id,
        sessionId: "recipient-mailbox",
        agentId: "recipient-agent",
      },
      recipientContext,
    );
    expect(
      value.registry.requiredTask(value.recipient.id).coordinationPendingCount,
    ).toBe(1);
    expect(value.registry.coordinationInbox(value.recipient.id)).toMatchObject({
      unreadCount: 0,
      pendingCount: 1,
    });
    value.store.acknowledge(
      {
        messageId: sent.message.id,
        taskId: value.recipient.id,
        sessionId: "recipient-mailbox",
        agentId: "recipient-agent",
      },
      recipientContext,
    );
    expect(
      value.registry.requiredTask(value.recipient.id).coordinationPendingCount,
    ).toBe(0);
    expect(
      value.registry.coordinationInbox(value.recipient.id).messages[0],
    ).toMatchObject({ deliveryState: "acknowledged" });
  });

  it("paginates the newest messages backwards without writing read state", async () => {
    const value = await coordinationFixture();
    for (let index = 1; index <= 3; index += 1) {
      value.store.send(
        {
          sourceTaskId: value.sender.id,
          sourceSessionId: "sender-mailbox",
          sourceAgentId: "sender-agent",
          targetTaskId: value.recipient.id,
          kind: "notice",
          content: `Coordination ${index}`,
          requiresAcknowledgement: false,
          idempotencyKey: `operator-page-${index}`,
        },
        value.context,
      );
    }
    const before = persistedCoordination(value.databasePath);
    const newest = validatedInbox(
      value.registry.coordinationInbox(value.recipient.id, undefined, 2),
    );
    expect(newest.messages.map((message) => message.recipientSequence)).toEqual(
      [2, 3],
    );
    expect(newest).toMatchObject({
      firstSequence: 2,
      lastSequence: 3,
      nextBeforeSequence: 2,
      truncated: true,
      pendingCount: 3,
    });
    const older = validatedInbox(
      value.registry.coordinationInbox(
        value.recipient.id,
        newest.nextBeforeSequence ?? undefined,
        2,
      ),
    );
    expect(older.messages.map((message) => message.recipientSequence)).toEqual([
      1,
    ]);
    expect(older.nextBeforeSequence).toBeNull();
    expect(newest.unreadCount).toBe(3);
    expect(older).toMatchObject({ unreadCount: 3, pendingCount: 3 });
    expect(persistedCoordination(value.databasePath)).toEqual(before);
    value.store.inbox(
      {
        taskId: value.recipient.id,
        sessionId: "recipient-mailbox",
        agentId: "recipient-agent",
      },
      {
        principalId: "principal",
        workspaceRoot: value.workspace,
        sessionId: "transport-recipient",
      },
    );
    expect(value.registry.coordinationInbox(value.recipient.id)).toMatchObject({
      unreadCount: 0,
      pendingCount: 0,
    });
  });

  it("returns an explicit empty page and leaves failed cursor or limit reads side-effect free", async () => {
    const value = await coordinationFixture();
    const before = persistedCoordination(value.databasePath);
    expect(value.registry.coordinationInbox(value.recipient.id)).toMatchObject({
      messages: [],
      unreadCount: 0,
      pendingCount: 0,
      firstSequence: null,
      lastSequence: null,
      nextBeforeSequence: null,
      truncated: false,
    });
    for (const cursor of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => value.registry.coordinationInbox(value.recipient.id, cursor)).toThrow();
    }
    for (const limit of [0, -1, 101, 1.5]) {
      expect(() => value.registry.coordinationInbox(value.recipient.id, undefined, limit)).toThrow();
    }
    expect(value.registry.coordinationInbox(value.recipient.id).messages).toEqual([]);
    expect(persistedCoordination(value.databasePath)).toEqual(before);
  });

  it("counts only live unread or unacknowledged work and retains resolved history", async () => {
    const value = await coordinationFixture();
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      ids.push(value.store.send({
        sourceTaskId: value.sender.id,
        sourceSessionId: "sender-mailbox",
        sourceAgentId: "sender-agent",
        targetTaskId: value.recipient.id,
        content: `State fixture ${index}`,
        requiresAcknowledgement: index !== 6,
        idempotencyKey: `operator-state-${index}`,
      }, value.context).message.id);
    }
    // Seed historical states only in this disposable fixture database. The
    // operator projection must not repair or advance any of these records.
    const database = new DatabaseSync(value.databasePath);
    const now = new Date().toISOString();
    try {
      const markRead = database.prepare(`
        UPDATE ${MESSAGE_TABLE}
        SET delivered_at = ?, delivered_session_id = ?, delivered_agent_id = ?,
          delivered_agent_name = ?, read_at = ?
        WHERE id = ?
      `);
      markRead.run(now, "recipient-mailbox", "recipient-agent", "Recipient Agent", now, ids[1]!);
      database.prepare(`
        UPDATE ${MESSAGE_TABLE}
        SET delivered_at = ?, delivered_session_id = ?, delivered_agent_id = ?,
          delivered_agent_name = ?, read_at = ?, acknowledged_at = ?
        WHERE id = ?
      `).run(now, "recipient-mailbox", "recipient-agent", "Recipient Agent", now, now, ids[2]!);
      database.prepare(`
        UPDATE ${MESSAGE_TABLE}
        SET delivered_at = ?, delivered_session_id = ?, delivered_agent_id = ?,
          delivered_agent_name = ?, read_at = ?, acknowledged_at = ?, replied_at = ?
        WHERE id = ?
      `).run(now, "recipient-mailbox", "recipient-agent", "Recipient Agent", now, now, now, ids[3]!);
      database.prepare(`UPDATE ${MESSAGE_TABLE} SET cancelled_at = ? WHERE id = ?`)
        .run(now, ids[4]!);
      database.prepare(`UPDATE ${MESSAGE_TABLE} SET created_at = ?, expires_at = ? WHERE id = ?`)
        .run("2026-08-30T00:00:00.000Z", "2026-08-30T00:00:01.000Z", ids[5]!);
      markRead.run(now, "recipient-mailbox", "recipient-agent", "Recipient Agent", now, ids[6]!);
    } finally {
      database.close();
    }
    const before = persistedCoordination(value.databasePath);
    const changeCount = value.changes.length;
    const page = validatedInbox(
      value.registry.coordinationInbox(value.recipient.id),
    );
    expect(page).toMatchObject({ unreadCount: 1, pendingCount: 2 });
    expect(page.messages.map(message => message.deliveryState)).toEqual([
      "queued", "read", "acknowledged", "replied", "cancelled", "expired", "read",
    ]);
    expect(value.registry.requiredTask(value.recipient.id).coordinationPendingCount).toBe(2);
    expect(value.changes).toHaveLength(changeCount);
    expect(persistedCoordination(value.databasePath)).toEqual(before);
  });

  it("keeps historical recipients visible without assigning a previous principal's pending work to its successor", async () => {
    const value = await coordinationFixture();
    value.store.send({
      sourceTaskId: value.sender.id,
      sourceSessionId: "sender-mailbox",
      sourceAgentId: "sender-agent",
      targetTaskId: value.recipient.id,
      content: "Immutable recipient provenance",
      requiresAcknowledgement: true,
      idempotencyKey: "operator-principal-history",
    }, value.context);
    // Model a historical owner transfer in the disposable database, not via
    // operator-inbox reads and not by changing production ownership semantics.
    const database = new DatabaseSync(value.databasePath);
    try {
      database.prepare("UPDATE tasks SET agent_id = ?, agent_name = ? WHERE id = ?")
        .run("successor-agent", "Successor Agent", value.recipient.id);
      const samePrincipal = validatedInbox(
        value.registry.coordinationInbox(value.recipient.id),
      );
      expect(samePrincipal).toMatchObject({ unreadCount: 1, pendingCount: 1 });
      expect(samePrincipal.messages[0]?.recipient).toMatchObject({
        intendedAgentId: "recipient-agent",
        ownershipCurrent: false,
        principalCurrent: true,
      });
      database.prepare(
        "UPDATE tasks SET principal_id = ?, status = 'succeeded', completed_at = ? WHERE id = ?",
      ).run("successor-principal", new Date().toISOString(), value.recipient.id);
    } finally {
      database.close();
    }
    const before = persistedCoordination(value.databasePath);
    const page = validatedInbox(
      value.registry.coordinationInbox(value.recipient.id),
    );
    expect(page).toMatchObject({ unreadCount: 0, pendingCount: 0 });
    expect(page.messages[0]).toMatchObject({
      deliveryState: "recipient-changed",
      recipient: { intendedAgentId: "recipient-agent", principalCurrent: false },
      deliveredAt: null,
      readAt: null,
      acknowledgedAt: null,
    });
    expect(value.registry.requiredTask(value.recipient.id).coordinationPendingCount).toBe(0);
    expect(persistedCoordination(value.databasePath)).toEqual(before);
  });

  it("enforces the UTF-8 response budget while retaining full counts and gap-free backwards pagination", async () => {
    const value = await coordinationFixture();
    for (let index = 0; index < 24; index += 1) {
      value.store.send({
        sourceTaskId: value.sender.id,
        sourceSessionId: "sender-mailbox",
        sourceAgentId: "sender-agent",
        targetTaskId: value.recipient.id,
        content: "测".repeat(8_000),
        requiresAcknowledgement: true,
        idempotencyKey: `operator-byte-bound-${index}`,
      }, value.context);
    }
    const before = persistedCoordination(value.databasePath);
    const sequences: number[] = [];
    let beforeSequence: number | undefined;
    for (let pageIndex = 0; pageIndex < 24; pageIndex += 1) {
      const page = validatedInbox(
        value.registry.coordinationInbox(
          value.recipient.id,
          beforeSequence,
          100,
        ),
      );
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      expect(page).toMatchObject({ unreadCount: 24, pendingCount: 24 });
      if (pageIndex === 0) expect(page.truncated).toBe(true);
      sequences.push(...page.messages.map(message => message.recipientSequence));
      if (page.nextBeforeSequence === null) break;
      beforeSequence = page.nextBeforeSequence;
    }
    expect(sequences.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(persistedCoordination(value.databasePath)).toEqual(before);
  });
});
