import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import type {
  BroadcastTaskCoordinationMessageResult,
  DesktopTaskSummary,
  SendTaskCoordinationMessageInput,
  TaskCoordinationMessage,
} from "../../packages/control-plane-contract/src/index.js";
import {
  BROADCAST_TABLE,
  CURSOR_TABLE,
  MAX_BROADCAST_TARGETS,
  MAX_PENDING_MESSAGES_PER_TASK,
  MAX_SESSIONS_PER_TASK,
  MESSAGE_TABLE,
  SESSION_TABLE,
  requestHash,
  type TaskCoordinationContext,
} from "../../packages/control-plane/src/task-coordination-store-core.js";
import { createTaskCoordinationTools } from "../../packages/control-plane/src/task-coordination-tools.js";
import { TaskRegistry } from "../../packages/control-plane/src/task-registry.js";
import { fixture } from "./task-registry-fixture.js";

type Operation = "send" | "broadcast";
type Body = Omit<SendTaskCoordinationMessageInput, "targetTaskId">;
type EndpointState = "succeeded" | "failed" | "cancelled" | "unassigned";
const START = Date.parse("2026-08-30T04:00:00.000Z");
const PRINCIPAL = "replay-principal";

function submit(
  operation: Operation,
  registry: TaskRegistry,
  body: Body,
  targets: readonly string[],
  context: TaskCoordinationContext,
) {
  const store = registry.coordinationStore();
  if (operation === "broadcast") {
    return store.broadcast({ ...body, targetTaskIds: targets }, context);
  }
  const sent = store.send({ ...body, targetTaskId: targets[0]! }, context);
  return {
    correlationId: sent.message.correlationId,
    createdCount: sent.created ? 1 : 0,
    replayedCount: sent.created ? 0 : 1,
    messages: [sent.message],
  };
}

async function replayFixture(operation: Operation) {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const value = await fixture();
  const make = (agentId: string) =>
    value.registry.createTask(
      { title: agentId, status: "running", agentId, agentName: agentId },
      PRINCIPAL,
      value.workspace,
      "agent",
      `transport-${agentId}`,
    );
  const source = make("source");
  const recipients = [
    make("target"),
    ...(operation === "broadcast" ? [make("other")] : []),
  ];
  const spares = [make("spare-one"), make("spare-two")];
  const targets = recipients.map((task) => task.id);
  const body: Body = {
    sourceTaskId: source.id,
    sourceSessionId: "source-mailbox",
    sourceAgentId: "source",
    content: "Persisted coordination request.\nKeep its original provenance.",
    idempotencyKey: "original-operation",
    expiresAt: new Date(START + 60_000).toISOString(),
  };
  const context: TaskCoordinationContext = {
    principalId: PRINCIPAL,
    workspaceRoot: value.workspace,
    sessionId: "transport-source",
  };
  const first = submit(operation, value.registry, body, targets, context);
  const retryBody: Body = {
    ...body,
    kind: "message",
    requiresAcknowledgement: true,
    expiresAt: body.expiresAt!.replace("Z", "+00:00"),
    sourceSessionId: "reconnected-mailbox",
  };
  const retryContext = { ...context, sessionId: "reconnected-transport" };
  return {
    ...value,
    make,
    source,
    recipients,
    spares,
    targets,
    body,
    context,
    first,
    retryBody,
    retryContext,
  };
}

function persisted(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return JSON.stringify([
      ...[
        "tasks",
        "task_projects",
        "task_messages",
        "task_agent_session_leases_v1",
        SESSION_TABLE,
        CURSOR_TABLE,
        MESSAGE_TABLE,
        BROADCAST_TABLE,
      ].map((table) =>
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
      database.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
    ]);
  } finally {
    database.close();
  }
}

function identity(message: TaskCoordinationMessage) {
  return {
    id: message.id,
    ordinal: message.ordinal,
    senderSequence: message.senderSequence,
    recipientSequence: message.recipientSequence,
    correlationId: message.correlationId,
    replyToMessageId: message.replyToMessageId,
    sender: message.sender,
    recipient: {
      taskId: message.recipient.taskId,
      taskTitle: message.recipient.taskTitle,
      taskStatus: message.recipient.taskStatus,
      intendedAgentId: message.recipient.intendedAgentId,
      intendedAgentName: message.recipient.intendedAgentName,
    },
    content: message.content,
    kind: message.kind,
    requiresAcknowledgement: message.requiresAcknowledgement,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
  };
}

function assertReplay(
  first: ReturnType<typeof submit>,
  replay: ReturnType<typeof submit>,
): void {
  expect(replay).toMatchObject({
    correlationId: first.correlationId,
    createdCount: 0,
    replayedCount: first.messages.length,
  });
  expect(replay.messages.map(identity)).toEqual(first.messages.map(identity));
}

function transition(
  registry: TaskRegistry,
  task: DesktopTaskSummary,
  state: EndpointState,
) {
  if (state === "unassigned") {
    registry.unassignTask(
      { taskId: task.id, agentId: task.agent.id! },
      PRINCIPAL,
    );
  } else {
    registry.updateTask(
      { taskId: task.id, agentId: task.agent.id!, status: state },
      PRINCIPAL,
      `transport-${task.agent.id}`,
    );
  }
}

function cloneMessage(
  database: DatabaseSync,
  messageId: string,
  overrides: Readonly<Record<string, SQLInputValue>>,
): void {
  const stored = database
    .prepare(`SELECT * FROM ${MESSAGE_TABLE} WHERE id = ?`)
    .get(messageId) as Record<string, SQLInputValue>;
  const row = { ...stored, ...overrides };
  const columns = Object.keys(row).filter((column) => column !== "ordinal");
  database
    .prepare(
      `INSERT INTO ${MESSAGE_TABLE} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...columns.map((column) => row[column]!));
}

for (const operation of ["send", "broadcast"] as const) {
  describe(`${operation} persisted idempotency replay`, () => {
    for (const endpoint of ["sender", "recipient"] as const) {
      it.each<EndpointState>([
        "succeeded",
        "failed",
        "cancelled",
        "unassigned",
      ])(
        `replays after the ${endpoint} becomes %s without allowing new work`,
        async (state) => {
          const value = await replayFixture(operation);
          vi.setSystemTime(START + 1_000);
          for (const task of endpoint === "sender"
            ? [value.source]
            : value.recipients) {
            transition(value.registry, task, state);
          }
          const before = persisted(value.databasePath);
          const changeCount = value.changes.length;
          vi.setSystemTime(START + 2_000);

          const replay = submit(
            operation,
            value.registry,
            value.retryBody,
            [...value.targets].reverse(),
            value.retryContext,
          );

          assertReplay(value.first, replay);
          expect(value.changes).toHaveLength(changeCount);
          expect(persisted(value.databasePath)).toBe(before);
          expect(() =>
            submit(
              operation,
              value.registry,
              { ...value.retryBody, idempotencyKey: "new-operation" },
              value.targets,
              value.context,
            ),
          ).toThrowError(expect.objectContaining({ status: 403 }));
          expect(persisted(value.databasePath)).toBe(before);
        },
      );
    }

    it.each(["acknowledged", "cancelled", "expired", "replied"] as const)(
      "returns the current %s state instead of inserting another envelope",
      async (state) => {
        const value = await replayFixture(operation);
        const store = value.registry.coordinationStore();
        vi.setSystemTime(START + 1_000);
        for (const message of value.first.messages) {
          const recipient = value.recipients.find(
            (task) => task.id === message.recipient.taskId,
          )!;
          const mailbox = {
            taskId: recipient.id,
            agentId: recipient.agent.id!,
            sessionId: `mailbox-${recipient.agent.id}`,
          };
          const context = {
            ...value.context,
            sessionId: `transport-${recipient.agent.id}`,
          };
          if (state === "acknowledged") {
            store.inbox(mailbox, context);
            store.acknowledge({ ...mailbox, messageId: message.id }, context);
          } else if (state === "cancelled") {
            store.cancel(
              { ...value.body, messageId: message.id },
              value.context,
            );
          } else if (state === "replied") {
            store.reply(
              {
                sourceTaskId: recipient.id,
                sourceAgentId: recipient.agent.id!,
                sourceSessionId: mailbox.sessionId,
                replyToMessageId: message.id,
                content: "Persisted reply.",
                idempotencyKey: `reply-${recipient.agent.id}`,
              },
              context,
            );
          }
        }
        transition(value.registry, value.source, "succeeded");
        for (const recipient of value.recipients)
          transition(value.registry, recipient, "unassigned");
        vi.setSystemTime(START + (state === "expired" ? 60_000 : 2_000));
        const before = persisted(value.databasePath);

        const replay = submit(
          operation,
          value.registry,
          value.retryBody,
          [...value.targets].reverse(),
          value.retryContext,
        );

        assertReplay(value.first, replay);
        expect(replay.messages.map((message) => message.deliveryState)).toEqual(
          value.targets.map(() => state),
        );
        for (const message of replay.messages) {
          expect(
            state === "expired" ? message.expiredAt : message[`${state}At`],
          ).not.toBeNull();
        }
        expect(persisted(value.databasePath)).toBe(before);
      },
    );

    it("preserves normalized replay across registry restart and unassignment", async () => {
      const value = await replayFixture(operation);
      vi.setSystemTime(START + 1_000);
      transition(value.registry, value.source, "unassigned");
      for (const recipient of value.recipients)
        transition(value.registry, recipient, "cancelled");
      value.registry.close();
      const reopened = new TaskRegistry({ databasePath: value.databasePath });
      try {
        const before = persisted(value.databasePath);
        vi.setSystemTime(START + 60_000);
        const replay = submit(
          operation,
          reopened,
          value.retryBody,
          [...value.targets].reverse(),
          value.retryContext,
        );
        assertReplay(value.first, replay);
        expect(
          replay.messages.every(
            (message) => message.deliveryState === "expired",
          ),
        ).toBe(true);
        expect(persisted(value.databasePath)).toBe(before);
      } finally {
        reopened.close();
      }
    });

    it("rejects changed bodies, targets, operation kinds and new keys without sequence gaps", async () => {
      const value = await replayFixture(operation);
      vi.setSystemTime(START + 1_000);
      for (const recipient of value.recipients)
        transition(value.registry, recipient, "succeeded");
      const before = persisted(value.databasePath);
      for (const changed of [
        { content: "Different body." },
        { kind: "notice" as const },
        { requiresAcknowledgement: false },
        { expiresAt: new Date(START + 90_000).toISOString() },
      ]) {
        expect(() =>
          submit(
            operation,
            value.registry,
            { ...value.body, ...changed },
            value.targets,
            value.context,
          ),
        ).toThrowError(expect.objectContaining({ status: 409 }));
      }
      const differentTargets = [value.spares[0]!.id, ...value.targets.slice(1)];
      expect(() =>
        submit(
          operation,
          value.registry,
          value.body,
          differentTargets,
          value.context,
        ),
      ).toThrowError(expect.objectContaining({ status: 409 }));
      expect(() =>
        submit(
          operation === "send" ? "broadcast" : "send",
          value.registry,
          value.body,
          value.targets,
          value.context,
        ),
      ).toThrowError(expect.objectContaining({ status: 409 }));
      expect(() =>
        submit(
          operation,
          value.registry,
          { ...value.body, idempotencyKey: "new-key" },
          value.targets,
          value.context,
        ),
      ).toThrowError(expect.objectContaining({ status: 403 }));
      expect(persisted(value.databasePath)).toBe(before);

      assertReplay(
        value.first,
        submit(
          operation,
          value.registry,
          value.retryBody,
          [...value.targets].reverse(),
          value.retryContext,
        ),
      );
      expect(persisted(value.databasePath)).toBe(before);
      const nextTargets = value.spares
        .slice(0, value.targets.length)
        .map((task) => task.id);
      const next = submit(
        operation,
        value.registry,
        { ...value.body, idempotencyKey: "genuinely-new-key" },
        nextTargets,
        value.context,
      );
      expect(next.messages.map((message) => message.senderSequence)).toEqual(
        nextTargets.map((_, index) => value.first.messages.length + index + 1),
      );
      expect(
        next.messages.every((message) => message.recipientSequence === 1),
      ).toBe(true);
    });

    it("validates expiry windows only for new operations", async () => {
      const value = await replayFixture(operation);
      vi.setSystemTime(START + 60_000);
      const before = persisted(value.databasePath);
      assertReplay(
        value.first,
        submit(
          operation,
          value.registry,
          value.retryBody,
          [...value.targets].reverse(),
          value.retryContext,
        ),
      );
      for (const expiresAt of [
        value.body.expiresAt!,
        new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString(),
      ]) {
        expect(() =>
          submit(
            operation,
            value.registry,
            { ...value.body, idempotencyKey: "new-expiry", expiresAt },
            value.targets,
            value.context,
          ),
        ).toThrowError(expect.objectContaining({ status: 400 }));
      }
      expect(() =>
        submit(
          operation,
          value.registry,
          { ...value.body, expiresAt: new Date(START - 1_000).toISOString() },
          value.targets,
          value.context,
        ),
      ).toThrowError(expect.objectContaining({ status: 409 }));
      expect(persisted(value.databasePath)).toBe(before);
    });

    it("keeps persisted Agent, current principal, source Task and workspace authentication", async () => {
      const value = await replayFixture(operation);
      const elsewhere = join(value.root, "other-authorized-workspace");
      await mkdir(elsewhere);
      vi.setSystemTime(START + 1_000);
      transition(value.registry, value.source, "unassigned");
      const before = persisted(value.databasePath);
      expect(() =>
        submit(
          operation,
          value.registry,
          { ...value.body, sourceAgentId: "another-agent" },
          value.targets,
          value.context,
        ),
      ).toThrowError(expect.objectContaining({ status: 403 }));
      expect(() =>
        submit(operation, value.registry, value.body, value.targets, {
          ...value.context,
          principalId: "another-principal",
        }),
      ).toThrowError(expect.objectContaining({ status: 404 }));
      expect(() =>
        submit(operation, value.registry, value.body, value.targets, {
          ...value.context,
          workspaceRoot: elsewhere,
        }),
      ).toThrowError(expect.objectContaining({ status: 404 }));
      expect(() =>
        submit(
          operation,
          value.registry,
          { ...value.body, sourceTaskId: value.spares[0]!.id },
          value.targets,
          value.context,
        ),
      ).toThrowError(expect.objectContaining({ status: 403 }));
      expect(persisted(value.databasePath)).toBe(before);

      const database = new DatabaseSync(value.databasePath);
      try {
        database
          .prepare("UPDATE tasks SET principal_id = ? WHERE id = ?")
          .run("new-principal", value.source.id);
      } finally {
        database.close();
      }
      const afterTransfer = persisted(value.databasePath);
      for (const principalId of [PRINCIPAL, "new-principal"]) {
        expect(() =>
          submit(operation, value.registry, value.body, value.targets, {
            ...value.context,
            principalId,
          }),
        ).toThrowError(expect.objectContaining({ status: 404 }));
      }
      expect(persisted(value.databasePath)).toBe(afterTransfer);
    });

    it.each(["mailbox", "session", "sequence"] as const)(
      "does not reapply exhausted %s capacity to an existing operation",
      async (capacity) => {
        const value = await replayFixture(operation);
        const database = new DatabaseSync(value.databasePath);
        try {
          if (capacity === "mailbox") {
            database.exec("BEGIN IMMEDIATE");
            for (
              let index = 1;
              index < MAX_PENDING_MESSAGES_PER_TASK;
              index += 1
            ) {
              cloneMessage(database, value.first.messages[0]!.id, {
                id: `filler-${index}`,
                idempotency_key: `filler-key-${index}`,
                correlation_id: `filler-correlation-${index}`,
                recipient_sequence: index + 1,
                sender_sequence: value.first.messages.length + index,
              });
            }
            database
              .prepare(
                `UPDATE ${CURSOR_TABLE} SET next_outbox_sequence = ? WHERE task_id = ?`,
              )
              .run(
                value.first.messages.length + MAX_PENDING_MESSAGES_PER_TASK,
                value.source.id,
              );
            database
              .prepare(
                `UPDATE ${CURSOR_TABLE} SET next_inbox_sequence = ? WHERE task_id = ?`,
              )
              .run(
                MAX_PENDING_MESSAGES_PER_TASK + 1,
                value.first.messages[0]!.recipient.taskId,
              );
            database.exec("COMMIT");
          } else if (capacity === "session") {
            const insert = database.prepare(`INSERT INTO ${SESSION_TABLE}
              (task_id, session_id, agent_id, principal_id, created_at, last_seen_at)
              VALUES (?, ?, 'source', ?, ?, ?)`);
            for (let index = 1; index < MAX_SESSIONS_PER_TASK; index += 1) {
              insert.run(
                value.source.id,
                `filler-session-${index}`,
                PRINCIPAL,
                new Date(START).toISOString(),
                new Date(START).toISOString(),
              );
            }
          } else {
            database
              .prepare(
                `UPDATE ${CURSOR_TABLE} SET next_outbox_sequence = ? WHERE task_id = ?`,
              )
              .run(Number.MAX_SAFE_INTEGER, value.source.id);
          }
        } finally {
          database.close();
        }
        vi.setSystemTime(START + 1_000);
        const before = persisted(value.databasePath);
        const replay = submit(
          operation,
          value.registry,
          value.retryBody,
          [...value.targets].reverse(),
          value.retryContext,
        );
        assertReplay(value.first, replay);
        expect(persisted(value.databasePath)).toBe(before);
        expect(() =>
          submit(
            operation,
            value.registry,
            { ...value.retryBody, idempotencyKey: "new-at-capacity" },
            value.targets,
            value.retryContext,
          ),
        ).toThrowError(expect.objectContaining({ status: 409 }));
        expect(persisted(value.databasePath)).toBe(before);
      },
    );
  });
}

describe("broadcast replay record boundaries", () => {
  it("applies the current target limit only to new batches", async () => {
    const value = await replayFixture("broadcast");
    const extra = Array.from(
      { length: MAX_BROADCAST_TARGETS + 1 - value.targets.length },
      (_, index) => value.make(`historical-target-${index}`),
    );
    const targets = [...value.targets, ...extra.map((task) => task.id)].sort();
    const before = persisted(value.databasePath);
    expect(() =>
      submit("broadcast", value.registry, value.body, targets, value.context),
    ).toThrowError(expect.objectContaining({ status: 409 }));
    expect(() =>
      submit(
        "broadcast",
        value.registry,
        { ...value.body, idempotencyKey: "new-oversized" },
        targets,
        value.context,
      ),
    ).toThrowError(expect.objectContaining({ status: 400 }));
    expect(persisted(value.databasePath)).toBe(before);

    // Model a retained batch accepted under a higher historical target limit.
    const database = new DatabaseSync(value.databasePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      for (const [index, recipient] of extra.entries()) {
        cloneMessage(database, value.first.messages[0]!.id, {
          id: `historical-message-${index}`,
          recipient_task_id: recipient.id,
          recipient_task_title: recipient.title,
          intended_agent_id: recipient.agent.id!,
          intended_agent_name: recipient.agent.name!,
          recipient_sequence: 1,
          sender_sequence: value.first.messages.length + index + 1,
          request_hash: requestHash({
            senderTaskId: value.source.id,
            recipientTaskId: recipient.id,
            kind: "message",
            content: value.body.content,
            requiresAcknowledgement: true,
            expiresAt: value.body.expiresAt,
            replyToMessageId: null,
          }),
        });
        database
          .prepare(
            `INSERT INTO ${CURSOR_TABLE}
          (task_id, next_inbox_sequence, next_outbox_sequence) VALUES (?, 2, 1)`,
          )
          .run(recipient.id);
      }
      database
        .prepare(
          `UPDATE ${CURSOR_TABLE} SET next_outbox_sequence = ? WHERE task_id = ?`,
        )
        .run(targets.length + 1, value.source.id);
      database
        .prepare(
          `UPDATE ${BROADCAST_TABLE} SET request_hash = ?
        WHERE sender_task_id = ? AND idempotency_key = ?`,
        )
        .run(
          requestHash({
            sourceTaskId: value.source.id,
            targetTaskIds: targets,
            kind: "message",
            content: value.body.content,
            requiresAcknowledgement: true,
            expiresAt: value.body.expiresAt,
          }),
          value.source.id,
          value.body.idempotencyKey,
        );
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const messages = value.registry.coordinationStore().outbox(
      {
        taskId: value.source.id,
        agentId: "source",
        sessionId: "source-mailbox",
        limit: 100,
      },
      value.context,
    ).messages;
    const persistedBatch = {
      ...value.first,
      messages: [...messages].sort((left, right) =>
        left.recipient.taskId.localeCompare(right.recipient.taskId),
      ),
    };
    const beforeReplay = persisted(value.databasePath);
    const replay = submit(
      "broadcast",
      value.registry,
      value.retryBody,
      [...targets].reverse(),
      value.retryContext,
    );
    assertReplay(persistedBatch, replay);
    expect(replay.replayedCount).toBe(MAX_BROADCAST_TARGETS + 1);
    expect(persisted(value.databasePath)).toBe(beforeReplay);

    const tool = createTaskCoordinationTools(
      value.registry.coordinationStore(),
      value.workspace,
      "desktop-workspace",
    ).find(
      (definition) => definition.spec.name === "tasks.coordination.broadcast",
    )!;
    const toolContext = {
      principal: { id: PRINCIPAL },
      sessionId: "reconnected-tool-transport",
    } as never;
    const toolInput = {
      ...value.retryBody,
      targetTaskIds: [...targets].reverse(),
    };
    const toolReplay = (await tool.execute(
      toolContext,
      tool.parse(toolInput),
    )) as BroadcastTaskCoordinationMessageResult;
    assertReplay(persistedBatch, toolReplay);
    await expect(
      tool.execute(
        toolContext,
        tool.parse({
          ...toolInput,
          idempotencyKey: "new-oversized-tool-operation",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(persisted(value.databasePath)).toBe(beforeReplay);
  });

  it("rejects incomplete persisted batches without recreating missing deliveries", async () => {
    const value = await replayFixture("broadcast");
    const database = new DatabaseSync(value.databasePath);
    try {
      database
        .prepare(`DELETE FROM ${MESSAGE_TABLE} WHERE id = ?`)
        .run(value.first.messages[0]!.id);
    } finally {
      database.close();
    }
    const before = persisted(value.databasePath);
    expect(() =>
      submit(
        "broadcast",
        value.registry,
        value.retryBody,
        value.targets,
        value.retryContext,
      ),
    ).toThrow(/incomplete or inconsistent/u);
    expect(persisted(value.databasePath)).toBe(before);
  });
});
