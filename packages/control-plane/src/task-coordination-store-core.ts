import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  TASK_COORDINATION_KINDS,
  TASK_COORDINATION_MESSAGE_SCHEMA_VERSION,
  type DesktopTaskSource,
  type DesktopTaskStatus,
  type SendTaskCoordinationMessageInput,
  type SendTaskCoordinationMessageResult,
  type TaskCoordinationDeliveryState,
  type TaskCoordinationKind,
  type TaskCoordinationMessage,
} from "@sovereign/control-plane-contract";
import { RuntimeError } from "@sovereign/runtime-core";

import { migrateTaskCoordinationV1 } from "./task-coordination-v1-migration.js";
import { TaskSessionLeaseStore, taskSessionId } from "./task-session-leases.js";

export const STORE_SCHEMA_VERSION = "scr.task-coordination-store/v2";
export const TABLE_PREFIX = "task_coordination_v2";
export const METADATA_TABLE = `${TABLE_PREFIX}_metadata`;
export const SESSION_TABLE = `${TABLE_PREFIX}_sessions`;
export const CURSOR_TABLE = `${TABLE_PREFIX}_cursors`;
export const MESSAGE_TABLE = `${TABLE_PREFIX}_messages`;
export const BROADCAST_TABLE = `${TABLE_PREFIX}_broadcasts`;
const MIGRATION_SAVEPOINT = "task_coordination_store_v2_migration";
export const MAX_CONTENT_LENGTH = 8_000;
export const MAX_IDENTIFIER_LENGTH = 128;
export const MAX_AGENT_NAME_LENGTH = 160;
export const MAX_MAILBOX_LIMIT = 100;
export const DEFAULT_MAILBOX_LIMIT = 50;
export const MAX_DIRECTORY_LIMIT = 100;
export const DEFAULT_DIRECTORY_LIMIT = 50;
export const MAX_PENDING_TASK_LIMIT = 50;
export const DEFAULT_PENDING_TASK_LIMIT = 20;
export const MAX_PENDING_MESSAGE_LIMIT = 50;
export const DEFAULT_PENDING_MESSAGE_LIMIT = 20;
export const MAX_BROADCAST_TARGETS = 32;
export const MAX_SESSIONS_PER_TASK = 256;
export const MAX_TOTAL_MESSAGES = 100_000;
export const MAX_PENDING_MESSAGES_PER_TASK = 1_000;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const COORDINATION_KINDS = new Set<string>(TASK_COORDINATION_KINDS);
export const TERMINAL_STATUSES = new Set<DesktopTaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);
export const SAFE_IDENTIFIER_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,128}$/u;
export const UNSAFE_CONTENT_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export interface TaskIdentityRow {
  readonly id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly project_root: string;
  readonly title: string;
  readonly status: DesktopTaskStatus;
  readonly source: DesktopTaskSource;
  readonly agent_id: string | null;
  readonly agent_name: string | null;
  readonly principal_id: string | null;
  readonly last_heartbeat_at: string | null;
  readonly updated_at: string;
}

export interface CoordinationRow {
  readonly ordinal: number;
  readonly id: string;
  readonly recipient_sequence: number;
  readonly sender_sequence: number;
  readonly kind: TaskCoordinationKind;
  readonly sender_task_id: string;
  readonly sender_task_title: string;
  readonly sender_session_id: string;
  readonly sender_agent_id: string;
  readonly sender_agent_name: string;
  readonly sender_principal_id: string;
  readonly recipient_task_id: string;
  readonly recipient_task_title: string;
  readonly recipient_task_status: DesktopTaskStatus;
  readonly intended_agent_id: string;
  readonly intended_agent_name: string;
  readonly recipient_principal_id: string;
  readonly delivered_session_id: string | null;
  readonly delivered_agent_id: string | null;
  readonly delivered_agent_name: string | null;
  readonly content: string;
  readonly correlation_id: string;
  readonly reply_to_message_id: string | null;
  readonly requires_acknowledgement: number;
  readonly request_hash: string;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly delivered_at: string | null;
  readonly read_at: string | null;
  readonly acknowledged_at: string | null;
  readonly replied_at: string | null;
  readonly cancelled_at: string | null;
}

export interface BroadcastRow {
  readonly sender_task_id: string;
  readonly sender_principal_id: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly correlation_id: string;
  readonly created_at: string;
}

export interface TaskCoordinationContext {
  readonly principalId: string;
  readonly workspaceRoot: string;
  readonly sessionId?: string | null;
  readonly now?: string;
}

export interface TaskCoordinationStoreOptions {
  readonly onChanged?: () => void;
  readonly sessionLeases?: TaskSessionLeaseStore;
}

export interface InternalSendInput extends SendTaskCoordinationMessageInput {
  readonly correlationId: string;
  readonly replyToMessageId: string | null;
}

export function invalid(message: string): never {
  throw new RuntimeError("INVALID_INPUT", message, 400);
}

export function denied(message: string): never {
  throw new RuntimeError("POLICY_DENIED", message, 403);
}

export function conflict(message: string): never {
  throw new RuntimeError("POLICY_DENIED", message, 409);
}

export function taskNotFound(taskId: string): never {
  throw new RuntimeError("TASK_NOT_FOUND", `Unknown task: ${taskId}`, 404);
}

export function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is missing or has an invalid format.`);
  }
  return value;
}

export function requiredAgentName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_AGENT_NAME_LENGTH ||
    UNSAFE_CONTENT_CONTROL_PATTERN.test(value)
  ) {
    return invalid(`${label} is missing, invalid, or exceeds its limit.`);
  }
  return value;
}

export function requiredContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_CONTENT_LENGTH ||
    UNSAFE_CONTENT_CONTROL_PATTERN.test(value)
  ) {
    return invalid(
      `Coordination message content must contain 1-${MAX_CONTENT_LENGTH} safe characters.`,
    );
  }
  return value;
}

export function requiredKind(value: unknown): TaskCoordinationKind {
  if (value === undefined) return "message";
  if (typeof value !== "string" || !COORDINATION_KINDS.has(value)) {
    return invalid("Coordination message kind is unsupported.");
  }
  return value as TaskCoordinationKind;
}

export function requiredSequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalid(`${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

export function boundedLimit(
  value: unknown,
  fallback: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed = requiredSequence(value, label);
  if (parsed < 1 || parsed > maximum) {
    return invalid(`${label} must be 1-${maximum}.`);
  }
  return parsed;
}

export function isoTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return invalid("Coordination message timestamp is invalid.");
  }
  return new Date(parsed).toISOString();
}

export function normalizeExpiry(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    return invalid("Coordination expiry is invalid.");
  return new Date(parsed).toISOString();
}

export function optionalExpiry(
  value: string | null | undefined,
  createdAt: string,
): string | null {
  const normalized = normalizeExpiry(value);
  if (normalized === null) return null;
  const parsed = Date.parse(normalized);
  const created = Date.parse(createdAt);
  if (parsed <= created) {
    return invalid("Coordination expiry must be later than message creation.");
  }
  if (parsed - created > MAX_MESSAGE_TTL_MS) {
    return invalid("Coordination expiry may not exceed 30 days.");
  }
  return normalized;
}

export function normalizeMessageBody(
  input: Pick<
    SendTaskCoordinationMessageInput,
    "kind" | "content" | "requiresAcknowledgement" | "expiresAt"
  >,
) {
  const kind = requiredKind(input.kind);
  return {
    kind,
    content: requiredContent(input.content),
    requiresAcknowledgement: input.requiresAcknowledgement ?? kind !== "notice",
    expiresAt: normalizeExpiry(input.expiresAt),
  };
}

export function messageRequestHash(
  senderTaskId: string,
  recipientTaskId: string,
  body: ReturnType<typeof normalizeMessageBody>,
  replyToMessageId: string | null,
): string {
  return requestHash({
    senderTaskId,
    recipientTaskId,
    ...body,
    replyToMessageId,
  });
}

export function canonicalDirectory(value: string, label: string): string {
  const resolved = resolve(value);
  try {
    const metadata = lstatSync(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return invalid(`${label} must be one direct directory.`);
    }
    return realpathSync.native(resolved);
  } catch {
    return invalid(`${label} must be an existing directory.`);
  }
}

export function pathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

export function requestHash(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function pendingSqlAt(alias: string, timestampExpression: string): string {
  const prefix = alias.length > 0 ? `${alias}.` : "";
  return `(
    ${prefix}cancelled_at IS NULL
    AND ${prefix}replied_at IS NULL
    AND (${prefix}expires_at IS NULL OR ${prefix}expires_at > ${timestampExpression})
    AND (
      (${prefix}requires_acknowledgement = 1 AND ${prefix}acknowledged_at IS NULL)
      OR (${prefix}requires_acknowledgement = 0 AND ${prefix}read_at IS NULL)
    )
  )`;
}

export function pendingSql(alias = ""): string {
  return pendingSqlAt(alias, "?");
}

export function taskCoordinationPendingProjection(taskAlias = "t"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(taskAlias)) {
    invalid("Task coordination projection alias is invalid.");
  }
  const now = "?";
  return `(
    SELECT COUNT(*)
    FROM ${MESSAGE_TABLE} coordination
    WHERE coordination.recipient_task_id = ${taskAlias}.id
      AND coordination.recipient_principal_id = ${taskAlias}.principal_id
      AND ${pendingSqlAt("coordination", now)}
  ) AS coordination_pending_count`;
}

function messageExpired(row: CoordinationRow, now: string): boolean {
  return (
    row.expires_at !== null && Date.parse(row.expires_at) <= Date.parse(now)
  );
}

export function deliveryState(
  row: CoordinationRow,
  principalCurrent: boolean,
  now: string,
): TaskCoordinationDeliveryState {
  if (row.replied_at !== null) return "replied";
  if (row.acknowledged_at !== null) return "acknowledged";
  if (row.cancelled_at !== null) return "cancelled";
  if (row.requires_acknowledgement === 0 && row.read_at !== null) return "read";
  if (messageExpired(row, now)) return "expired";
  if (row.read_at !== null) return "read";
  if (row.delivered_at !== null) return "delivered";
  if (!principalCurrent) return "recipient-changed";
  return "queued";
}

export function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class TaskCoordinationStoreCore {
  protected readonly database: DatabaseSync;
  protected readonly onChanged: () => void;
  protected readonly sessionLeases: TaskSessionLeaseStore;

  constructor(
    database: DatabaseSync,
    options: TaskCoordinationStoreOptions = {},
  ) {
    this.database = database;
    this.onChanged = options.onChanged ?? (() => undefined);
    this.sessionLeases =
      options.sessionLeases ?? new TaskSessionLeaseStore(database);
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  protected migrate(): void {
    this.database.exec(`SAVEPOINT ${MIGRATION_SAVEPOINT}`);
    try {
      this.#migrateSchema();
      this.database.exec(`RELEASE SAVEPOINT ${MIGRATION_SAVEPOINT}`);
    } catch (error) {
      try {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${MIGRATION_SAVEPOINT}`);
        this.database.exec(`RELEASE SAVEPOINT ${MIGRATION_SAVEPOINT}`);
      } catch {
        // Preserve the original migration failure.
      }
      throw error;
    }
  }

  #migrateSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ${METADATA_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (task_id, session_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        next_inbox_sequence INTEGER NOT NULL CHECK (next_inbox_sequence > 0),
        next_outbox_sequence INTEGER NOT NULL CHECK (next_outbox_sequence > 0)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ${MESSAGE_TABLE} (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        recipient_sequence INTEGER NOT NULL CHECK (recipient_sequence > 0),
        sender_sequence INTEGER NOT NULL CHECK (sender_sequence > 0),
        kind TEXT NOT NULL,
        sender_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sender_task_title TEXT NOT NULL,
        sender_session_id TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,
        sender_agent_name TEXT NOT NULL,
        sender_principal_id TEXT NOT NULL,
        recipient_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        recipient_task_title TEXT NOT NULL,
        recipient_task_status TEXT NOT NULL,
        intended_agent_id TEXT NOT NULL,
        intended_agent_name TEXT NOT NULL,
        recipient_principal_id TEXT NOT NULL,
        delivered_session_id TEXT,
        delivered_agent_id TEXT,
        delivered_agent_name TEXT,
        content TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        reply_to_message_id TEXT REFERENCES ${MESSAGE_TABLE}(id) ON DELETE RESTRICT,
        requires_acknowledgement INTEGER NOT NULL CHECK (requires_acknowledgement IN (0, 1)),
        request_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        delivered_at TEXT,
        read_at TEXT,
        acknowledged_at TEXT,
        replied_at TEXT,
        cancelled_at TEXT,
        UNIQUE (recipient_task_id, recipient_sequence),
        UNIQUE (sender_task_id, sender_sequence),
        UNIQUE (sender_task_id, recipient_task_id, idempotency_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ${BROADCAST_TABLE} (
        sender_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sender_principal_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        correlation_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (sender_task_id, idempotency_key)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS ${TABLE_PREFIX}_inbox_index
      ON ${MESSAGE_TABLE} (recipient_task_id, recipient_sequence);

      CREATE INDEX IF NOT EXISTS ${TABLE_PREFIX}_recipient_principal_index
      ON ${MESSAGE_TABLE} (recipient_principal_id, recipient_task_id, recipient_sequence);

      CREATE INDEX IF NOT EXISTS ${TABLE_PREFIX}_outbox_index
      ON ${MESSAGE_TABLE} (sender_task_id, sender_principal_id, sender_sequence);

      CREATE INDEX IF NOT EXISTS ${TABLE_PREFIX}_pending_index
      ON ${MESSAGE_TABLE} (
        recipient_task_id,
        recipient_principal_id,
        requires_acknowledgement,
        acknowledged_at,
        read_at,
        recipient_sequence
      );

      CREATE INDEX IF NOT EXISTS ${TABLE_PREFIX}_thread_index
      ON ${MESSAGE_TABLE} (correlation_id, ordinal);
    `);

    this.assertTableColumns(METADATA_TABLE, ["key", "value"]);
    this.assertTableColumns(SESSION_TABLE, [
      "task_id",
      "session_id",
      "agent_id",
      "principal_id",
      "created_at",
      "last_seen_at",
    ]);
    this.assertTableColumns(CURSOR_TABLE, [
      "task_id",
      "next_inbox_sequence",
      "next_outbox_sequence",
    ]);
    this.assertTableColumns(MESSAGE_TABLE, [
      "ordinal",
      "id",
      "recipient_sequence",
      "sender_sequence",
      "kind",
      "sender_task_id",
      "sender_task_title",
      "sender_session_id",
      "sender_agent_id",
      "sender_agent_name",
      "sender_principal_id",
      "recipient_task_id",
      "recipient_task_title",
      "recipient_task_status",
      "intended_agent_id",
      "intended_agent_name",
      "recipient_principal_id",
      "delivered_session_id",
      "delivered_agent_id",
      "delivered_agent_name",
      "content",
      "correlation_id",
      "reply_to_message_id",
      "requires_acknowledgement",
      "request_hash",
      "idempotency_key",
      "created_at",
      "expires_at",
      "delivered_at",
      "read_at",
      "acknowledged_at",
      "replied_at",
      "cancelled_at",
    ]);
    this.assertTableColumns(BROADCAST_TABLE, [
      "sender_task_id",
      "sender_principal_id",
      "idempotency_key",
      "request_hash",
      "correlation_id",
      "created_at",
    ]);

    const version = this.database
      .prepare(
        `SELECT value FROM ${METADATA_TABLE} WHERE key = 'schemaVersion'`,
      )
      .get() as { readonly value: string } | undefined;
    if (version === undefined) {
      this.database
        .prepare(
          `INSERT INTO ${METADATA_TABLE} (key, value) VALUES ('schemaVersion', ?)`,
        )
        .run(STORE_SCHEMA_VERSION);
    } else if (version.value !== STORE_SCHEMA_VERSION) {
      conflict(`Unsupported Task coordination store schema: ${version.value}`);
    }
    migrateTaskCoordinationV1(this.database, {
      metadata: METADATA_TABLE,
      sessions: SESSION_TABLE,
      cursors: CURSOR_TABLE,
      messages: MESSAGE_TABLE,
      broadcasts: BROADCAST_TABLE,
    });
  }

  protected assertTableColumns(
    tableName: string,
    expected: readonly string[],
  ): void {
    const rows = this.database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ readonly name: string }>;
    const actual = rows.map((row) => row.name);
    if (
      actual.length !== expected.length ||
      actual.some((name, index) => name !== expected[index])
    ) {
      conflict(
        `Task coordination table ${tableName} has an incompatible schema.`,
      );
    }
  }

  protected transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  protected task(taskId: string): TaskIdentityRow {
    const row = this.database
      .prepare(
        `
        SELECT
          t.id,
          t.project_id,
          p.name AS project_name,
          p.root AS project_root,
          t.title,
          t.status,
          t.source,
          t.agent_id,
          t.agent_name,
          t.principal_id,
          t.last_heartbeat_at,
          t.updated_at
        FROM tasks t
        JOIN task_projects p ON p.id = t.project_id
        WHERE t.id = ?
      `,
      )
      .get(requiredIdentifier(taskId, "Task ID")) as
      TaskIdentityRow | undefined;
    if (row === undefined) taskNotFound(taskId);
    return row;
  }

  protected taskOrNull(taskId: string): TaskIdentityRow | null {
    try {
      return this.task(taskId);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "TASK_NOT_FOUND")
        return null;
      throw error;
    }
  }

  protected workspaceRoot(context: TaskCoordinationContext): string {
    return canonicalDirectory(
      context.workspaceRoot,
      "Task coordination workspace root",
    );
  }

  protected taskWithinWorkspace(
    task: TaskIdentityRow,
    workspaceRoot: string,
  ): boolean {
    try {
      return pathWithin(
        workspaceRoot,
        canonicalDirectory(task.project_root, "Task project root"),
      );
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "INVALID_INPUT")
        return false;
      throw error;
    }
  }

  protected assertWithinWorkspace(
    task: TaskIdentityRow,
    workspaceRoot: string,
  ): void {
    if (!this.taskWithinWorkspace(task, workspaceRoot)) taskNotFound(task.id);
  }

  protected assertOwnedTask(
    task: TaskIdentityRow,
    agentId: string,
    principalId: string,
    workspaceRoot: string,
    label: string,
    allowTerminal = false,
  ): void {
    this.assertWithinWorkspace(task, workspaceRoot);
    if (task.principal_id !== principalId) taskNotFound(task.id);
    if (task.agent_id !== agentId) {
      denied(`${label} does not match the Task's current Agent identity.`);
    }
    if (task.source === "inferred") {
      denied(`${label} must use a formal Task, not automatic activity.`);
    }
    if (task.agent_name === null) {
      denied(`${label} requires a named Task Agent.`);
    }
    if (!allowTerminal && TERMINAL_STATUSES.has(task.status)) {
      denied(`${label} cannot originate from a terminal Task.`);
    }
  }

  protected assertRecipient(
    task: TaskIdentityRow,
    workspaceRoot: string,
    allowTerminal = false,
  ): void {
    this.assertWithinWorkspace(task, workspaceRoot);
    if (task.source === "inferred") {
      denied("Coordination recipient must be a formal Task.");
    }
    if (
      task.agent_id === null ||
      task.agent_name === null ||
      task.principal_id === null
    ) {
      denied("Coordination recipient has no assigned Agent owner.");
    }
    if (!allowTerminal && TERMINAL_STATUSES.has(task.status)) {
      denied("Coordination recipient is terminal and cannot receive new work.");
    }
  }

  protected bindSession(
    task: TaskIdentityRow,
    sessionId: string,
    agentId: string,
    principalId: string,
    timestamp: string,
    transportSessionId?: string | null,
  ): void {
    const normalizedSession = requiredIdentifier(
      sessionId,
      "Coordination session ID",
    );
    const existing = this.database
      .prepare(
        `
        SELECT agent_id, principal_id
        FROM ${SESSION_TABLE}
        WHERE task_id = ? AND session_id = ?
      `,
      )
      .get(task.id, normalizedSession) as
      { readonly agent_id: string; readonly principal_id: string } | undefined;
    if (
      existing !== undefined &&
      (existing.agent_id !== agentId || existing.principal_id !== principalId)
    ) {
      denied(
        "Coordination session is permanently bound to another Agent identity.",
      );
    }
    if (existing === undefined) {
      const count = this.database
        .prepare(
          `SELECT COUNT(*) AS value FROM ${SESSION_TABLE} WHERE task_id = ?`,
        )
        .get(task.id) as { readonly value: number };
      if (count.value >= MAX_SESSIONS_PER_TASK) {
        conflict("Coordination session capacity is exhausted for this Task.");
      }
      this.database
        .prepare(
          `
          INSERT INTO ${SESSION_TABLE} (
            task_id, session_id, agent_id, principal_id, created_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          task.id,
          normalizedSession,
          agentId,
          principalId,
          timestamp,
          timestamp,
        );
    } else {
      this.database
        .prepare(
          `UPDATE ${SESSION_TABLE} SET last_seen_at = ? WHERE task_id = ? AND session_id = ?`,
        )
        .run(timestamp, task.id, normalizedSession);
    }
    if (transportSessionId === null || transportSessionId === undefined) return;
    this.sessionLeases.touchTask({
      taskId: task.id,
      sessionId: taskSessionId(
        transportSessionId,
        task.id,
        agentId,
        principalId,
      ),
      agentId,
      principalId,
      observedAt: timestamp,
    });
  }

  protected cursor(taskId: string): {
    readonly next_inbox_sequence: number;
    readonly next_outbox_sequence: number;
  } {
    this.database
      .prepare(
        `
        INSERT OR IGNORE INTO ${CURSOR_TABLE} (
          task_id, next_inbox_sequence, next_outbox_sequence
        ) VALUES (?, 1, 1)
      `,
      )
      .run(taskId);
    const row = this.database
      .prepare(
        `SELECT next_inbox_sequence, next_outbox_sequence FROM ${CURSOR_TABLE} WHERE task_id = ?`,
      )
      .get(taskId) as
      | {
          readonly next_inbox_sequence: number;
          readonly next_outbox_sequence: number;
        }
      | undefined;
    if (row === undefined) conflict("Task coordination cursor is unavailable.");
    return row;
  }

  protected allocateSequence(
    taskId: string,
    direction: "inbox" | "outbox",
  ): number {
    const column =
      direction === "inbox" ? "next_inbox_sequence" : "next_outbox_sequence";
    const cursor = this.cursor(taskId);
    const current =
      direction === "inbox"
        ? cursor.next_inbox_sequence
        : cursor.next_outbox_sequence;
    if (
      !Number.isSafeInteger(current) ||
      current < 1 ||
      current >= Number.MAX_SAFE_INTEGER
    ) {
      conflict(
        `Task coordination ${direction} sequence capacity is exhausted.`,
      );
    }
    this.database
      .prepare(`UPDATE ${CURSOR_TABLE} SET ${column} = ? WHERE task_id = ?`)
      .run(current + 1, taskId);
    return current;
  }

  protected message(messageId: string): CoordinationRow {
    const row = this.database
      .prepare(`SELECT * FROM ${MESSAGE_TABLE} WHERE id = ?`)
      .get(requiredIdentifier(messageId, "Coordination message ID")) as
      CoordinationRow | undefined;
    if (row === undefined) taskNotFound(messageId);
    return row;
  }

  protected ownership(row: CoordinationRow): {
    readonly ownershipCurrent: boolean;
    readonly principalCurrent: boolean;
  } {
    const current = this.taskOrNull(row.recipient_task_id);
    const principalCurrent =
      current !== null && current.principal_id === row.recipient_principal_id;
    return {
      principalCurrent,
      ownershipCurrent:
        principalCurrent && current?.agent_id === row.intended_agent_id,
    };
  }

  protected mapMessage(
    row: CoordinationRow,
    now = new Date().toISOString(),
  ): TaskCoordinationMessage {
    const ownership = this.ownership(row);
    const expiredAt =
      row.expires_at !== null && Date.parse(row.expires_at) <= Date.parse(now)
        ? row.expires_at
        : null;
    return {
      schemaVersion: TASK_COORDINATION_MESSAGE_SCHEMA_VERSION,
      id: row.id,
      ordinal: row.ordinal,
      recipientSequence: row.recipient_sequence,
      senderSequence: row.sender_sequence,
      kind: row.kind,
      sender: {
        taskId: row.sender_task_id,
        taskTitle: row.sender_task_title,
        sessionId: row.sender_session_id,
        agentId: row.sender_agent_id,
        agentName: row.sender_agent_name,
      },
      recipient: {
        taskId: row.recipient_task_id,
        taskTitle: row.recipient_task_title,
        taskStatus: row.recipient_task_status,
        intendedAgentId: row.intended_agent_id,
        intendedAgentName: row.intended_agent_name,
        deliveredSessionId: row.delivered_session_id,
        deliveredAgentId: row.delivered_agent_id,
        deliveredAgentName: row.delivered_agent_name,
        ownershipCurrent: ownership.ownershipCurrent,
        principalCurrent: ownership.principalCurrent,
      },
      content: row.content,
      correlationId: row.correlation_id,
      replyToMessageId: row.reply_to_message_id,
      requiresAcknowledgement: row.requires_acknowledgement === 1,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      deliveredAt: row.delivered_at,
      readAt: row.read_at,
      acknowledgedAt: row.acknowledged_at,
      repliedAt: row.replied_at,
      cancelledAt: row.cancelled_at,
      expiredAt,
      deliveryState: deliveryState(row, ownership.principalCurrent, now),
    };
  }

  protected mailboxIdentity(
    taskId: string,
    sessionId: string,
    agentId: string,
    context: TaskCoordinationContext,
    allowTerminal = true,
  ): { readonly task: TaskIdentityRow; readonly timestamp: string } {
    const principalId = requiredIdentifier(context.principalId, "Principal ID");
    const workspaceRoot = this.workspaceRoot(context);
    const normalizedAgent = requiredIdentifier(agentId, "Task Agent ID");
    const timestamp = isoTimestamp(context.now);
    const task = this.task(taskId);
    this.assertOwnedTask(
      task,
      normalizedAgent,
      principalId,
      workspaceRoot,
      "Coordination mailbox",
      allowTerminal,
    );
    this.bindSession(
      task,
      sessionId,
      normalizedAgent,
      principalId,
      timestamp,
      context.sessionId,
    );
    return { task, timestamp };
  }

  protected assertCapacity(
    recipientTaskIds: readonly string[],
    timestamp: string,
  ): void {
    const total = this.database
      .prepare(`SELECT COUNT(*) AS value FROM ${MESSAGE_TABLE}`)
      .get() as { readonly value: number };
    if (total.value + recipientTaskIds.length > MAX_TOTAL_MESSAGES) {
      conflict("Task coordination message capacity is exhausted.");
    }
    for (const taskId of recipientTaskIds) {
      const pending = this.database
        .prepare(
          `
          SELECT COUNT(*) AS value
          FROM ${MESSAGE_TABLE}
          WHERE recipient_task_id = ? AND ${pendingSql()}
        `,
        )
        .get(taskId, timestamp) as { readonly value: number };
      if (pending.value >= MAX_PENDING_MESSAGES_PER_TASK) {
        conflict(
          `Coordination inbox capacity is exhausted for Task ${taskId}.`,
        );
      }
    }
  }

  protected assertSameProject(
    sender: TaskIdentityRow,
    recipient: TaskIdentityRow,
  ): void {
    if (sender.project_id !== recipient.project_id) {
      denied(
        "Task coordination requires source and recipient in the same project.",
      );
    }
  }

  protected boundedResponse<T>(response: T): T {
    if (responseBytes(response) > MAX_RESPONSE_BYTES) {
      conflict("Coordination response exceeds the bounded response size.");
    }
    return response;
  }

  protected insertMessage(
    input: InternalSendInput,
    sender: TaskIdentityRow,
    recipient: TaskIdentityRow,
    principalId: string,
    timestamp: string,
    broadcast = false,
  ): SendTaskCoordinationMessageResult {
    this.assertSameProject(sender, recipient);
    const body = normalizeMessageBody(input);
    const { kind, content, requiresAcknowledgement, expiresAt } = body;
    const idempotencyKey = requiredIdentifier(
      input.idempotencyKey,
      "Coordination idempotency key",
    );
    if (!broadcast) {
      const other = this.database
        .prepare(
          `
        SELECT 1 FROM ${MESSAGE_TABLE}
        WHERE sender_task_id = ? AND idempotency_key = ? AND recipient_task_id <> ?
        LIMIT 1
      `,
        )
        .get(sender.id, idempotencyKey, recipient.id);
      const batch = this.database
        .prepare(
          `
        SELECT 1 FROM ${BROADCAST_TABLE} WHERE sender_task_id = ? AND idempotency_key = ?
      `,
        )
        .get(sender.id, idempotencyKey);
      if (other !== undefined || batch !== undefined) {
        conflict(
          "Coordination idempotency key was reused for another operation.",
        );
      }
    }
    optionalExpiry(expiresAt, timestamp);
    const digest = messageRequestHash(
      sender.id,
      recipient.id,
      body,
      input.replyToMessageId,
    );
    const existing = this.database
      .prepare(
        `
        SELECT * FROM ${MESSAGE_TABLE}
        WHERE sender_task_id = ? AND recipient_task_id = ? AND idempotency_key = ?
      `,
      )
      .get(sender.id, recipient.id, idempotencyKey) as
      CoordinationRow | undefined;
    if (existing !== undefined) {
      if (existing.sender_principal_id !== principalId) taskNotFound(sender.id);
      if (existing.request_hash !== digest) {
        conflict(
          "Coordination idempotency key was reused for another request.",
        );
      }
      return {
        schemaVersion: "scr.task-coordination-send/v2",
        created: false,
        message: this.mapMessage(existing, timestamp),
      };
    }

    this.assertCapacity([recipient.id], timestamp);
    const recipientSequence = this.allocateSequence(recipient.id, "inbox");
    const senderSequence = this.allocateSequence(sender.id, "outbox");
    const messageId = randomUUID();
    this.database
      .prepare(
        `
        INSERT INTO ${MESSAGE_TABLE} (
          id, recipient_sequence, sender_sequence, kind,
          sender_task_id, sender_task_title, sender_session_id,
          sender_agent_id, sender_agent_name, sender_principal_id,
          recipient_task_id, recipient_task_title, recipient_task_status,
          intended_agent_id, intended_agent_name, recipient_principal_id,
          delivered_session_id, delivered_agent_id, delivered_agent_name,
          content, correlation_id, reply_to_message_id,
          requires_acknowledgement, request_hash, idempotency_key,
          created_at, expires_at, delivered_at, read_at,
          acknowledged_at, replied_at, cancelled_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL
        )
      `,
      )
      .run(
        messageId,
        recipientSequence,
        senderSequence,
        kind,
        sender.id,
        sender.title,
        input.sourceSessionId,
        input.sourceAgentId,
        requiredAgentName(sender.agent_name, "Sender Agent name"),
        principalId,
        recipient.id,
        recipient.title,
        recipient.status,
        requiredIdentifier(recipient.agent_id, "Recipient Agent ID"),
        requiredAgentName(recipient.agent_name, "Recipient Agent name"),
        requiredIdentifier(recipient.principal_id, "Recipient principal ID"),
        content,
        input.correlationId,
        input.replyToMessageId,
        requiresAcknowledgement ? 1 : 0,
        digest,
        idempotencyKey,
        timestamp,
        expiresAt,
      );
    return {
      schemaVersion: "scr.task-coordination-send/v2",
      created: true,
      message: this.mapMessage(this.message(messageId), timestamp),
    };
  }
}
