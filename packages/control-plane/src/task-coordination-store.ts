import { TaskCoordinationOperatorView } from "./task-coordination-operator-view.js";
import { randomUUID } from "node:crypto";

import {
  TASK_COORDINATION_INBOX_SCHEMA_VERSION,
  TASK_COORDINATION_OUTBOX_SCHEMA_VERSION,
  TASK_COORDINATION_THREAD_SCHEMA_VERSION,
  type AcknowledgeTaskCoordinationMessageInput,
  type AcknowledgeTaskCoordinationMessageResult,
  type AcknowledgeTaskCoordinationThroughInput,
  type AcknowledgeTaskCoordinationThroughResult,
  type BroadcastTaskCoordinationMessageInput,
  type BroadcastTaskCoordinationMessageResult,
  type CancelTaskCoordinationMessageInput,
  type CancelTaskCoordinationMessageResult,
  type ReplyTaskCoordinationMessageInput,
  type SendTaskCoordinationMessageInput,
  type SendTaskCoordinationMessageResult,
  type TaskCoordinationInbox,
  type TaskCoordinationInboxInput,
  type TaskCoordinationMessage,
  type TaskCoordinationOutbox,
  type TaskCoordinationOutboxInput,
  type TaskCoordinationThread,
  type TaskCoordinationThreadInput,
} from "@sovereign/control-plane-contract";

import {
  BROADCAST_TABLE,
  DEFAULT_MAILBOX_LIMIT,
  MAX_BROADCAST_TARGETS,
  MAX_MAILBOX_LIMIT,
  MAX_RESPONSE_BYTES,
  MESSAGE_TABLE,
  boundedLimit,
  conflict,
  deliveryState,
  denied,
  invalid,
  isoTimestamp,
  messageRequestHash,
  normalizeMessageBody,
  optionalExpiry,
  pendingSql,
  requestHash,
  requiredIdentifier,
  requiredSequence,
  responseBytes,
  taskNotFound,
  type BroadcastRow,
  type CoordinationRow,
  type TaskCoordinationContext,
  type TaskIdentityRow,
} from "./task-coordination-store-core.js";

export type {
  TaskCoordinationContext,
  TaskCoordinationStoreOptions,
} from "./task-coordination-store-core.js";

export class TaskCoordinationStore extends TaskCoordinationOperatorView {
  #boundedRows(
    rows: readonly CoordinationRow[],
    limit: number,
    timestamp: string,
  ): {
    readonly rows: readonly CoordinationRow[];
    readonly messages: readonly TaskCoordinationMessage[];
    readonly truncated: boolean;
  } {
    const truncatedByCount = rows.length > limit;
    let visible = truncatedByCount ? rows.slice(0, limit) : [...rows];
    while (
      visible.length > 1 &&
      responseBytes(visible.map((row) => this.mapMessage(row, timestamp))) >
        MAX_RESPONSE_BYTES - 4_096
    ) {
      visible = visible.slice(0, Math.max(1, Math.floor(visible.length / 2)));
    }
    if (
      visible.length === 1 &&
      responseBytes(this.mapMessage(visible[0]!, timestamp)) >
        MAX_RESPONSE_BYTES - 4_096
    ) {
      conflict("One coordination message exceeds the bounded response size.");
    }
    return {
      rows: visible,
      messages: visible.map((row) => this.mapMessage(row, timestamp)),
      truncated:
        truncatedByCount || visible.length < Math.min(rows.length, limit),
    };
  }

  #pendingCount(
    taskId: string,
    principalId: string,
    timestamp: string,
  ): number {
    const row = this.database
      .prepare(
        `
        SELECT COUNT(*) AS value
        FROM ${MESSAGE_TABLE}
        WHERE recipient_task_id = ?
          AND recipient_principal_id = ?
          AND ${pendingSql()}
      `,
      )
      .get(taskId, principalId, timestamp) as { readonly value: number };
    return row.value;
  }

  #markRead(
    rows: readonly CoordinationRow[],
    task: TaskIdentityRow,
    sessionId: string,
    timestamp: string,
  ): boolean {
    let changed = false;
    for (const row of rows) {
      if (row.recipient_principal_id !== task.principal_id) continue;
      const update = this.database
        .prepare(
          `
          UPDATE ${MESSAGE_TABLE}
          SET
            delivered_at = COALESCE(delivered_at, ?),
            delivered_session_id = COALESCE(delivered_session_id, ?),
            delivered_agent_id = COALESCE(delivered_agent_id, ?),
            delivered_agent_name = COALESCE(delivered_agent_name, ?),
            read_at = COALESCE(read_at, ?)
          WHERE id = ?
            AND cancelled_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
            AND (delivered_at IS NULL OR read_at IS NULL)
        `,
        )
        .run(
          timestamp,
          sessionId,
          task.agent_id,
          task.agent_name,
          timestamp,
          row.id,
          timestamp,
        );
      changed = changed || update.changes > 0;
    }
    return changed;
  }

  #sourceForOperation(
    taskId: string,
    principalId: string,
    workspaceRoot: string,
  ): TaskIdentityRow {
    const task = this.task(taskId);
    this.assertWithinWorkspace(task, workspaceRoot);
    if (task.principal_id !== principalId) taskNotFound(taskId);
    if (task.source === "inferred") {
      denied(
        "Coordination sender must use a formal Task, not automatic activity.",
      );
    }
    return task;
  }

  #assertReplayIdentity(
    row: CoordinationRow,
    agentId: string,
    principalId: string,
  ): void {
    if (row.sender_principal_id !== principalId)
      taskNotFound(row.sender_task_id);
    if (row.sender_agent_id !== agentId) {
      denied("Coordination replay does not match the recorded sending Agent.");
    }
  }

  send(
    input: SendTaskCoordinationMessageInput,
    context: TaskCoordinationContext,
  ): SendTaskCoordinationMessageResult {
    const sourceTaskId = requiredIdentifier(
      input.sourceTaskId,
      "Source Task ID",
    );
    const sourceSessionId = requiredIdentifier(
      input.sourceSessionId,
      "Source session ID",
    );
    const sourceAgentId = requiredIdentifier(
      input.sourceAgentId,
      "Source Agent ID",
    );
    const targetTaskId = requiredIdentifier(
      input.targetTaskId,
      "Target Task ID",
    );
    const idempotencyKey = requiredIdentifier(
      input.idempotencyKey,
      "Coordination idempotency key",
    );
    const body = normalizeMessageBody(input);
    const digest = messageRequestHash(sourceTaskId, targetTaskId, body, null);
    const principalId = requiredIdentifier(context.principalId, "Principal ID");
    const workspaceRoot = this.workspaceRoot(context);
    const timestamp = isoTimestamp(context.now);
    const result = this.transaction(() => {
      const sender = this.#sourceForOperation(
        sourceTaskId,
        principalId,
        workspaceRoot,
      );
      const rows = this.database
        .prepare(
          `
        SELECT * FROM ${MESSAGE_TABLE}
        WHERE sender_task_id = ? AND idempotency_key = ? ORDER BY ordinal LIMIT 2
      `,
        )
        .all(sourceTaskId, idempotencyKey) as unknown as CoordinationRow[];
      const batch = this.database
        .prepare(
          `
        SELECT sender_principal_id FROM ${BROADCAST_TABLE}
        WHERE sender_task_id = ? AND idempotency_key = ?
      `,
        )
        .get(sourceTaskId, idempotencyKey) as
        Pick<BroadcastRow, "sender_principal_id"> | undefined;
      const existing = rows[0];
      if (existing !== undefined) {
        this.#assertReplayIdentity(existing, sourceAgentId, principalId);
        if (
          batch !== undefined ||
          rows.length !== 1 ||
          existing.recipient_task_id !== targetTaskId ||
          existing.reply_to_message_id !== null ||
          existing.request_hash !== digest
        ) {
          conflict(
            "Coordination idempotency key was reused for another request or operation.",
          );
        }
        return {
          schemaVersion: "scr.task-coordination-send/v2" as const,
          created: false,
          message: this.mapMessage(existing, timestamp),
        };
      }
      if (batch !== undefined) {
        if (batch.sender_principal_id !== principalId)
          taskNotFound(sourceTaskId);
        conflict(
          "Coordination idempotency key was reused for another operation.",
        );
      }
      if (sourceTaskId === targetTaskId) {
        invalid("Task coordination cannot target the source Task itself.");
      }
      this.assertOwnedTask(
        sender,
        sourceAgentId,
        principalId,
        workspaceRoot,
        "Coordination sender",
      );
      const recipient = this.task(targetTaskId);
      this.assertRecipient(recipient, workspaceRoot);
      this.bindSession(
        sender,
        sourceSessionId,
        sourceAgentId,
        principalId,
        timestamp,
        context.sessionId,
      );
      return this.insertMessage(
        {
          ...input,
          ...body,
          sourceTaskId,
          sourceSessionId,
          sourceAgentId,
          targetTaskId,
          idempotencyKey,
          correlationId: randomUUID(),
          replyToMessageId: null,
        },
        sender,
        recipient,
        principalId,
        timestamp,
      );
    });
    if (result.created) this.onChanged();
    return result;
  }

  broadcast(
    input: BroadcastTaskCoordinationMessageInput,
    context: TaskCoordinationContext,
  ): BroadcastTaskCoordinationMessageResult {
    const sourceTaskId = requiredIdentifier(
      input.sourceTaskId,
      "Source Task ID",
    );
    const sourceSessionId = requiredIdentifier(
      input.sourceSessionId,
      "Source session ID",
    );
    const sourceAgentId = requiredIdentifier(
      input.sourceAgentId,
      "Source Agent ID",
    );
    const idempotencyKey = requiredIdentifier(
      input.idempotencyKey,
      "Broadcast idempotency key",
    );
    if (!Array.isArray(input.targetTaskIds)) {
      invalid("Broadcast target Task IDs must be an array.");
    }
    const targetTaskIds = input.targetTaskIds.map((taskId) =>
      requiredIdentifier(taskId, "Broadcast target Task ID"),
    );
    if (new Set(targetTaskIds).size !== targetTaskIds.length) {
      invalid("Broadcast target Task IDs must be unique.");
    }
    if (targetTaskIds.includes(sourceTaskId)) {
      invalid("Task coordination broadcast cannot target its source Task.");
    }
    const sortedTargets = [...targetTaskIds].sort();
    const { kind, content, requiresAcknowledgement, expiresAt } =
      normalizeMessageBody(input);
    const timestamp = isoTimestamp(context.now);
    const digest = requestHash({
      sourceTaskId,
      targetTaskIds: sortedTargets,
      kind,
      content,
      requiresAcknowledgement,
      expiresAt,
    });
    const principalId = requiredIdentifier(context.principalId, "Principal ID");
    const workspaceRoot = this.workspaceRoot(context);

    const result = this.transaction(() => {
      const sender = this.#sourceForOperation(
        sourceTaskId,
        principalId,
        workspaceRoot,
      );
      const existing = this.database
        .prepare(
          `
          SELECT * FROM ${BROADCAST_TABLE}
          WHERE sender_task_id = ? AND idempotency_key = ?
        `,
        )
        .get(sourceTaskId, idempotencyKey) as BroadcastRow | undefined;
      if (existing !== undefined) {
        if (existing.sender_principal_id !== principalId)
          taskNotFound(sourceTaskId);
        const rows = this.database
          .prepare(
            `
            SELECT * FROM ${MESSAGE_TABLE}
            WHERE correlation_id = ? AND sender_task_id = ? AND sender_principal_id = ?
              AND reply_to_message_id IS NULL
            ORDER BY recipient_task_id ASC
          `,
          )
          .all(
            existing.correlation_id,
            sourceTaskId,
            principalId,
          ) as unknown as CoordinationRow[];
        for (const row of rows) {
          this.#assertReplayIdentity(row, sourceAgentId, principalId);
        }
        if (existing.request_hash !== digest) {
          conflict(
            "Broadcast idempotency key was reused for another recipient set or body.",
          );
        }
        if (
          rows.length === 0 ||
          rows.length !== sortedTargets.length ||
          rows.some((row, index) => row.recipient_task_id !== sortedTargets[index])
        ) {
          conflict(
            "Stored coordination broadcast is incomplete or inconsistent.",
          );
        }
        return this.boundedResponse({
          schemaVersion: "scr.task-coordination-broadcast/v2" as const,
          correlationId: existing.correlation_id,
          createdCount: 0,
          replayedCount: rows.length,
          messages: rows.map((row) => this.mapMessage(row, timestamp)),
        });
      }

      const other = this.database
        .prepare(`
          SELECT * FROM ${MESSAGE_TABLE}
          WHERE sender_task_id = ? AND idempotency_key = ? LIMIT 1
        `)
        .get(sourceTaskId, idempotencyKey) as CoordinationRow | undefined;
      if (other !== undefined) {
        this.#assertReplayIdentity(other, sourceAgentId, principalId);
        conflict("Broadcast idempotency key was already used for another operation.");
      }
      if (sortedTargets.length < 1 || sortedTargets.length > MAX_BROADCAST_TARGETS) {
        invalid(`Broadcast must target 1-${MAX_BROADCAST_TARGETS} Tasks.`);
      }
      optionalExpiry(expiresAt, timestamp);
      this.assertOwnedTask(
        sender,
        sourceAgentId,
        principalId,
        workspaceRoot,
        "Coordination sender",
      );
      const recipients = sortedTargets.map((taskId) => {
        const recipient = this.task(taskId);
        this.assertRecipient(recipient, workspaceRoot);
        this.assertSameProject(sender, recipient);
        return recipient;
      });
      this.bindSession(
        sender,
        sourceSessionId,
        sourceAgentId,
        principalId,
        timestamp,
        context.sessionId,
      );
      this.assertCapacity(
        recipients.map((recipient) => recipient.id),
        timestamp,
      );
      const correlationId = randomUUID();
      this.database
        .prepare(
          `
          INSERT INTO ${BROADCAST_TABLE} (
            sender_task_id, sender_principal_id, idempotency_key,
            request_hash, correlation_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          sourceTaskId,
          principalId,
          idempotencyKey,
          digest,
          correlationId,
          timestamp,
        );
      const messages = recipients.map(
        (recipient) =>
          this.insertMessage(
            {
              ...input,
              sourceTaskId,
              sourceSessionId,
              sourceAgentId,
              targetTaskId: recipient.id,
              kind,
              content,
              requiresAcknowledgement,
              expiresAt,
              idempotencyKey,
              correlationId,
              replyToMessageId: null,
            },
            sender,
            recipient,
            principalId,
            timestamp,
            true,
          ).message,
      );
      return this.boundedResponse({
        schemaVersion: "scr.task-coordination-broadcast/v2" as const,
        correlationId,
        createdCount: messages.length,
        replayedCount: 0,
        messages,
      });
    });
    if (result.createdCount > 0) this.onChanged();
    return result;
  }

  reply(
    input: ReplyTaskCoordinationMessageInput,
    context: TaskCoordinationContext,
  ): SendTaskCoordinationMessageResult {
    const sourceTaskId = requiredIdentifier(
      input.sourceTaskId,
      "Source Task ID",
    );
    const sourceSessionId = requiredIdentifier(
      input.sourceSessionId,
      "Source session ID",
    );
    const sourceAgentId = requiredIdentifier(
      input.sourceAgentId,
      "Source Agent ID",
    );
    const parentId = requiredIdentifier(
      input.replyToMessageId,
      "Reply message ID",
    );
    const principalId = requiredIdentifier(context.principalId, "Principal ID");
    const workspaceRoot = this.workspaceRoot(context);
    const timestamp = isoTimestamp(context.now);
    const result = this.transaction(() => {
      const parent = this.message(parentId);
      if (
        parent.recipient_task_id !== sourceTaskId ||
        parent.recipient_principal_id !== principalId
      ) {
        taskNotFound(parentId);
      }
      if (parent.cancelled_at !== null) {
        conflict("Cancelled coordination cannot be replied to.");
      }
      if (
        parent.expires_at !== null &&
        Date.parse(parent.expires_at) <= Date.parse(timestamp) &&
        parent.acknowledged_at === null &&
        parent.replied_at === null
      ) {
        conflict("Expired coordination cannot be replied to.");
      }
      const sender = this.task(sourceTaskId);
      this.assertOwnedTask(
        sender,
        sourceAgentId,
        principalId,
        workspaceRoot,
        "Coordination reply sender",
        true,
      );
      const recipient = this.task(parent.sender_task_id);
      this.assertRecipient(recipient, workspaceRoot, true);
      if (recipient.principal_id !== parent.sender_principal_id) {
        denied("Coordination reply target belongs to another principal now.");
      }
      this.bindSession(
        sender,
        sourceSessionId,
        sourceAgentId,
        principalId,
        timestamp,
        context.sessionId,
      );
      const sent = this.insertMessage(
        {
          ...input,
          sourceTaskId,
          sourceSessionId,
          sourceAgentId,
          targetTaskId: recipient.id,
          correlationId: parent.correlation_id,
          replyToMessageId: parent.id,
        },
        sender,
        recipient,
        principalId,
        timestamp,
      );
      if (!sent.created) return sent;
      if (parent.replied_at !== null) {
        conflict("Coordination message already has a reply.");
      }
      this.database
        .prepare(
          `
          UPDATE ${MESSAGE_TABLE}
          SET
            delivered_at = COALESCE(delivered_at, ?),
            delivered_session_id = COALESCE(delivered_session_id, ?),
            delivered_agent_id = COALESCE(delivered_agent_id, ?),
            delivered_agent_name = COALESCE(delivered_agent_name, ?),
            read_at = COALESCE(read_at, ?),
            acknowledged_at = COALESCE(acknowledged_at, ?),
            replied_at = COALESCE(replied_at, ?)
          WHERE id = ?
        `,
        )
        .run(
          timestamp,
          sourceSessionId,
          sender.agent_id,
          sender.agent_name,
          timestamp,
          timestamp,
          timestamp,
          parent.id,
        );
      return sent;
    });
    if (result.created) this.onChanged();
    return result;
  }

  inbox(
    input: TaskCoordinationInboxInput,
    context: TaskCoordinationContext,
  ): TaskCoordinationInbox {
    const taskId = requiredIdentifier(input.taskId, "Recipient Task ID");
    const sessionId = requiredIdentifier(
      input.sessionId,
      "Recipient session ID",
    );
    const agentId = requiredIdentifier(input.agentId, "Recipient Agent ID");
    const afterSequence =
      input.afterSequence === undefined
        ? 0
        : requiredSequence(input.afterSequence, "Coordination inbox cursor");
    const limit = boundedLimit(
      input.limit,
      DEFAULT_MAILBOX_LIMIT,
      MAX_MAILBOX_LIMIT,
      "Coordination inbox limit",
    );
    let changed = false;
    const result = this.transaction(() => {
      const { task, timestamp } = this.mailboxIdentity(
        taskId,
        sessionId,
        agentId,
        context,
      );
      const principalId = requiredIdentifier(
        context.principalId,
        "Principal ID",
      );
      const pendingOnly = input.pendingOnly === true;
      const rows = this.database
        .prepare(
          `
          SELECT * FROM ${MESSAGE_TABLE}
          WHERE recipient_task_id = ?
            AND recipient_principal_id = ?
            AND recipient_sequence > ?
            ${pendingOnly ? `AND ${pendingSql()}` : ""}
          ORDER BY recipient_sequence ASC
          LIMIT ?
        `,
        )
        .all(
          task.id,
          principalId,
          afterSequence,
          ...(pendingOnly ? [timestamp] : []),
          limit + 1,
        ) as unknown as CoordinationRow[];
      const page = this.#boundedRows(rows, limit, timestamp);
      changed = this.#markRead(page.rows, task, sessionId, timestamp);
      const messages = page.rows.map((row) =>
        this.mapMessage(this.message(row.id), timestamp),
      );
      const resultPage: TaskCoordinationInbox = {
        schemaVersion: TASK_COORDINATION_INBOX_SCHEMA_VERSION,
        taskId: task.id,
        sessionId,
        generatedAt: timestamp,
        messages,
        pendingCount: this.#pendingCount(task.id, principalId, timestamp),
        firstSequence: messages[0]?.recipientSequence ?? null,
        lastSequence: messages.at(-1)?.recipientSequence ?? null,
        nextAfterSequence: page.truncated
          ? (messages.at(-1)?.recipientSequence ?? afterSequence)
          : null,
        truncated: page.truncated,
      };
      if (responseBytes(resultPage) > MAX_RESPONSE_BYTES) {
        conflict("Coordination inbox exceeds the bounded response size.");
      }
      return resultPage;
    });
    if (changed) this.onChanged();
    return result;
  }

  outbox(
    input: TaskCoordinationOutboxInput,
    context: TaskCoordinationContext,
  ): TaskCoordinationOutbox {
    const taskId = requiredIdentifier(input.taskId, "Sender Task ID");
    const sessionId = requiredIdentifier(input.sessionId, "Sender session ID");
    const agentId = requiredIdentifier(input.agentId, "Sender Agent ID");
    const afterSequence =
      input.afterSequence === undefined
        ? 0
        : requiredSequence(input.afterSequence, "Coordination outbox cursor");
    const limit = boundedLimit(
      input.limit,
      DEFAULT_MAILBOX_LIMIT,
      MAX_MAILBOX_LIMIT,
      "Coordination outbox limit",
    );
    return this.transaction(() => {
      const { task, timestamp } = this.mailboxIdentity(
        taskId,
        sessionId,
        agentId,
        context,
      );
      const principalId = requiredIdentifier(
        context.principalId,
        "Principal ID",
      );
      const rows = this.database
        .prepare(
          `
          SELECT * FROM ${MESSAGE_TABLE}
          WHERE sender_task_id = ?
            AND sender_principal_id = ?
            AND sender_sequence > ?
          ORDER BY sender_sequence ASC
          LIMIT ?
        `,
        )
        .all(
          task.id,
          principalId,
          afterSequence,
          limit + 1,
        ) as unknown as CoordinationRow[];
      const page = this.#boundedRows(rows, limit, timestamp);
      const awaiting = this.database
        .prepare(
          `
          SELECT COUNT(*) AS value FROM ${MESSAGE_TABLE}
          WHERE sender_task_id = ?
            AND sender_principal_id = ?
            AND ${pendingSql()}
        `,
        )
        .get(task.id, principalId, timestamp) as { readonly value: number };
      const resultPage: TaskCoordinationOutbox = {
        schemaVersion: TASK_COORDINATION_OUTBOX_SCHEMA_VERSION,
        taskId: task.id,
        sessionId,
        generatedAt: timestamp,
        messages: page.messages,
        pendingDeliveryOrAcknowledgementCount: awaiting.value,
        firstSequence: page.messages[0]?.senderSequence ?? null,
        lastSequence: page.messages.at(-1)?.senderSequence ?? null,
        nextAfterSequence: page.truncated
          ? (page.messages.at(-1)?.senderSequence ?? afterSequence)
          : null,
        truncated: page.truncated,
      };
      if (responseBytes(resultPage) > MAX_RESPONSE_BYTES) {
        conflict("Coordination outbox exceeds the bounded response size.");
      }
      return resultPage;
    });
  }

  thread(
    input: TaskCoordinationThreadInput,
    context: TaskCoordinationContext,
  ): TaskCoordinationThread {
    const taskId = requiredIdentifier(input.taskId, "Task ID");
    const sessionId = requiredIdentifier(input.sessionId, "Task session ID");
    const agentId = requiredIdentifier(input.agentId, "Task Agent ID");
    const correlationId = requiredIdentifier(
      input.correlationId,
      "Coordination correlation ID",
    );
    const afterOrdinal =
      input.afterOrdinal === undefined
        ? 0
        : requiredSequence(input.afterOrdinal, "Coordination thread cursor");
    const limit = boundedLimit(
      input.limit,
      DEFAULT_MAILBOX_LIMIT,
      MAX_MAILBOX_LIMIT,
      "Coordination thread limit",
    );
    let changed = false;
    const result = this.transaction(() => {
      const { task, timestamp } = this.mailboxIdentity(
        taskId,
        sessionId,
        agentId,
        context,
      );
      const principalId = requiredIdentifier(
        context.principalId,
        "Principal ID",
      );
      const participant = this.database
        .prepare(
          `
          SELECT 1 AS value FROM ${MESSAGE_TABLE}
          WHERE correlation_id = ?
            AND (
              (sender_task_id = ? AND sender_principal_id = ?)
              OR (recipient_task_id = ? AND recipient_principal_id = ?)
            )
          LIMIT 1
        `,
        )
        .get(correlationId, task.id, principalId, task.id, principalId) as
        { readonly value: number } | undefined;
      if (participant === undefined) taskNotFound(correlationId);
      const rows = this.database
        .prepare(
          `
          SELECT * FROM ${MESSAGE_TABLE}
          WHERE correlation_id = ?
            AND ordinal > ?
            AND (
              (sender_task_id = ? AND sender_principal_id = ?)
              OR (recipient_task_id = ? AND recipient_principal_id = ?)
            )
          ORDER BY ordinal ASC
          LIMIT ?
        `,
        )
        .all(
          correlationId,
          afterOrdinal,
          task.id,
          principalId,
          task.id,
          principalId,
          limit + 1,
        ) as unknown as CoordinationRow[];
      const page = this.#boundedRows(rows, limit, timestamp);
      const incoming = page.rows.filter(
        (row) => row.recipient_task_id === task.id,
      );
      changed = this.#markRead(incoming, task, sessionId, timestamp);
      const messages = page.rows.map((row) =>
        this.mapMessage(this.message(row.id), timestamp),
      );
      const resultPage: TaskCoordinationThread = {
        schemaVersion: TASK_COORDINATION_THREAD_SCHEMA_VERSION,
        correlationId,
        taskId: task.id,
        sessionId,
        generatedAt: timestamp,
        messages,
        nextAfterOrdinal: page.truncated
          ? (messages.at(-1)?.ordinal ?? afterOrdinal)
          : null,
        truncated: page.truncated,
      };
      if (responseBytes(resultPage) > MAX_RESPONSE_BYTES) {
        conflict("Coordination thread exceeds the bounded response size.");
      }
      return resultPage;
    });
    if (changed) this.onChanged();
    return result;
  }

  acknowledge(
    input: AcknowledgeTaskCoordinationMessageInput,
    context: TaskCoordinationContext,
  ): AcknowledgeTaskCoordinationMessageResult {
    const messageId = requiredIdentifier(
      input.messageId,
      "Coordination message ID",
    );
    const taskId = requiredIdentifier(input.taskId, "Recipient Task ID");
    const sessionId = requiredIdentifier(
      input.sessionId,
      "Recipient session ID",
    );
    const agentId = requiredIdentifier(input.agentId, "Recipient Agent ID");
    let changed = false;
    const result = this.transaction(() => {
      const { task, timestamp } = this.mailboxIdentity(
        taskId,
        sessionId,
        agentId,
        context,
      );
      const principalId = requiredIdentifier(
        context.principalId,
        "Principal ID",
      );
      const before = this.message(messageId);
      if (
        before.recipient_task_id !== task.id ||
        before.recipient_principal_id !== principalId
      ) {
        taskNotFound(messageId);
      }
      const state = deliveryState(before, true, timestamp);
      if (state === "cancelled" || state === "expired") {
        conflict(
          `Coordination message is ${state} and cannot be acknowledged.`,
        );
      }
      if (before.requires_acknowledgement !== 1) {
        invalid("This coordination message does not require acknowledgement.");
      }
      if (before.read_at === null || before.delivered_at === null) {
        invalid("Coordination message must be read before acknowledgement.");
      }
      changed = before.acknowledged_at === null;
      if (changed) {
        this.database
          .prepare(
            `UPDATE ${MESSAGE_TABLE} SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?`,
          )
          .run(timestamp, messageId);
      }
      return {
        schemaVersion: "scr.task-coordination-acknowledge/v2" as const,
        changed,
        message: this.mapMessage(this.message(messageId), timestamp),
      };
    });
    if (changed) this.onChanged();
    return result;
  }

  acknowledgeThrough(
    input: AcknowledgeTaskCoordinationThroughInput,
    context: TaskCoordinationContext,
  ): AcknowledgeTaskCoordinationThroughResult {
    const taskId = requiredIdentifier(input.taskId, "Recipient Task ID");
    const sessionId = requiredIdentifier(
      input.sessionId,
      "Recipient session ID",
    );
    const agentId = requiredIdentifier(input.agentId, "Recipient Agent ID");
    const throughSequence = requiredSequence(
      input.throughSequence,
      "Coordination acknowledgement cursor",
    );
    const result = this.transaction(() => {
      const { task, timestamp } = this.mailboxIdentity(
        taskId,
        sessionId,
        agentId,
        context,
      );
      const principalId = requiredIdentifier(
        context.principalId,
        "Principal ID",
      );
      const update = this.database
        .prepare(
          `
          UPDATE ${MESSAGE_TABLE}
          SET acknowledged_at = COALESCE(acknowledged_at, ?)
          WHERE recipient_task_id = ?
            AND recipient_principal_id = ?
            AND recipient_sequence <= ?
            AND requires_acknowledgement = 1
            AND read_at IS NOT NULL
            AND acknowledged_at IS NULL
            AND replied_at IS NULL
            AND cancelled_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
        `,
        )
        .run(timestamp, task.id, principalId, throughSequence, timestamp);
      return {
        schemaVersion: "scr.task-coordination-acknowledge-through/v1" as const,
        changedCount: Number(update.changes),
        throughSequence,
        pendingCount: this.#pendingCount(task.id, principalId, timestamp),
      };
    });
    if (result.changedCount > 0) this.onChanged();
    return result;
  }

  cancel(
    input: CancelTaskCoordinationMessageInput,
    context: TaskCoordinationContext,
  ): CancelTaskCoordinationMessageResult {
    const sourceTaskId = requiredIdentifier(
      input.sourceTaskId,
      "Source Task ID",
    );
    const sourceSessionId = requiredIdentifier(
      input.sourceSessionId,
      "Source session ID",
    );
    const sourceAgentId = requiredIdentifier(
      input.sourceAgentId,
      "Source Agent ID",
    );
    const messageId = requiredIdentifier(
      input.messageId,
      "Coordination message ID",
    );
    let changed = false;
    const result = this.transaction(() => {
      const principalId = requiredIdentifier(
        context.principalId,
        "Principal ID",
      );
      const workspaceRoot = this.workspaceRoot(context);
      const timestamp = isoTimestamp(context.now);
      const sender = this.task(sourceTaskId);
      this.assertOwnedTask(
        sender,
        sourceAgentId,
        principalId,
        workspaceRoot,
        "Coordination cancellation sender",
        true,
      );
      this.bindSession(
        sender,
        sourceSessionId,
        sourceAgentId,
        principalId,
        timestamp,
        context.sessionId,
      );
      const before = this.message(messageId);
      if (
        before.sender_task_id !== sender.id ||
        before.sender_principal_id !== principalId
      ) {
        taskNotFound(messageId);
      }
      if (before.acknowledged_at !== null || before.replied_at !== null) {
        conflict("Acknowledged or replied coordination cannot be cancelled.");
      }
      if (
        before.expires_at !== null &&
        Date.parse(before.expires_at) <= Date.parse(timestamp)
      ) {
        return {
          schemaVersion: "scr.task-coordination-cancel/v1" as const,
          changed: false,
          message: this.mapMessage(before, timestamp),
        };
      }
      changed = before.cancelled_at === null;
      if (changed) {
        this.database
          .prepare(
            `UPDATE ${MESSAGE_TABLE} SET cancelled_at = COALESCE(cancelled_at, ?) WHERE id = ?`,
          )
          .run(timestamp, messageId);
      }
      return {
        schemaVersion: "scr.task-coordination-cancel/v1" as const,
        changed,
        message: this.mapMessage(this.message(messageId), timestamp),
      };
    });
    if (changed) this.onChanged();
    return result;
  }
}
