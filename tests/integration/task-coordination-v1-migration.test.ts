import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { validateTaskCoordinationMessageCausality } from "../../packages/control-plane-contract/src/index.js";
import { TaskRegistry } from "../../packages/control-plane/src/task-registry.js";
import {
  BROADCAST_TABLE,
  CURSOR_TABLE,
  MESSAGE_TABLE,
  METADATA_TABLE,
  SESSION_TABLE,
} from "../../packages/control-plane/src/task-coordination-store-core.js";

const cleanupRoots: string[] = [];
const openRegistries: TaskRegistry[] = [];
const openDatabases: DatabaseSync[] = [];
const PRINCIPAL_ID = "principal-v1-migration";
const BASE_TIME = "2026-08-29T12:00:00.000Z";

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly databasePath: string;
  readonly senderTaskId: string;
  readonly recipientTaskId: string;
}

function directDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  openDatabases.push(database);
  return database;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "scr-task-coordination-v1-"));
  cleanupRoots.push(root);
  const workspace = join(root, "workspace");
  const databasePath = join(root, "tasks.sqlite");
  await mkdir(workspace, { recursive: true });
  const registry = new TaskRegistry({ databasePath });
  const sender = registry.createTask(
    {
      title: "Legacy sender",
      status: "running",
      agentId: "legacy-sender-agent",
      agentName: "Legacy Sender Agent",
    },
    PRINCIPAL_ID,
    workspace,
    "agent",
    "legacy-sender-transport",
  );
  const recipient = registry.createTask(
    {
      title: "Legacy recipient",
      status: "running",
      agentId: "legacy-recipient-agent",
      agentName: "Legacy Recipient Agent",
    },
    PRINCIPAL_ID,
    workspace,
    "agent",
    "legacy-recipient-transport",
  );
  registry.close();
  return {
    root,
    workspace,
    databasePath,
    senderTaskId: sender.id,
    recipientTaskId: recipient.id,
  };
}

function seedLegacyV1(value: Fixture): void {
  const database = directDatabase(value.databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE task_coordination_v1_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE task_coordination_v1_sessions (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (task_id, session_id)
    ) STRICT;
    CREATE TABLE task_coordination_v1_cursors (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      next_inbox_sequence INTEGER NOT NULL CHECK (next_inbox_sequence > 0),
      next_outbox_sequence INTEGER NOT NULL CHECK (next_outbox_sequence > 0)
    ) STRICT;
    CREATE TABLE task_coordination_v1_messages (
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
      recipient_agent_id TEXT,
      recipient_agent_name TEXT,
      recipient_principal_id TEXT,
      content TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      reply_to_message_id TEXT REFERENCES task_coordination_v1_messages(id) ON DELETE RESTRICT,
      requires_acknowledgement INTEGER NOT NULL CHECK (requires_acknowledgement IN (0, 1)),
      request_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      delivered_session_id TEXT,
      read_at TEXT,
      acknowledged_at TEXT,
      replied_at TEXT,
      UNIQUE (recipient_task_id, recipient_sequence),
      UNIQUE (sender_task_id, sender_sequence),
      UNIQUE (sender_task_id, sender_session_id, recipient_task_id, idempotency_key)
    ) STRICT;
    CREATE TABLE task_coordination_v1_broadcasts (
      sender_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      sender_session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      correlation_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (sender_task_id, sender_session_id, idempotency_key)
    ) STRICT;
  `);
  database
    .prepare(
      "INSERT INTO task_coordination_v1_metadata (key, value) VALUES ('schemaVersion', ?)",
    )
    .run("scr.task-coordination-store/v1");
  const insertSession = database.prepare(`
    INSERT INTO task_coordination_v1_sessions (
      task_id, session_id, agent_id, principal_id, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertSession.run(
    value.senderTaskId,
    "legacy-sender-session",
    "legacy-sender-agent",
    PRINCIPAL_ID,
    BASE_TIME,
    BASE_TIME,
  );
  insertSession.run(
    value.recipientTaskId,
    "legacy-recipient-session",
    "legacy-recipient-agent",
    PRINCIPAL_ID,
    BASE_TIME,
    BASE_TIME,
  );
  const insertCursor = database.prepare(`
    INSERT INTO task_coordination_v1_cursors (
      task_id, next_inbox_sequence, next_outbox_sequence
    ) VALUES (?, ?, ?)
  `);
  insertCursor.run(value.senderTaskId, 2, 2);
  insertCursor.run(value.recipientTaskId, 2, 2);
  const insertMessage = database.prepare(`
    INSERT INTO task_coordination_v1_messages (
      id, recipient_sequence, sender_sequence, kind,
      sender_task_id, sender_task_title, sender_session_id,
      sender_agent_id, sender_agent_name, sender_principal_id,
      recipient_task_id, recipient_task_title, recipient_task_status,
      recipient_agent_id, recipient_agent_name, recipient_principal_id,
      content, correlation_id, reply_to_message_id,
      requires_acknowledgement, request_hash, idempotency_key, created_at,
      delivered_at, delivered_session_id, read_at, acknowledged_at, replied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMessage.run(
    "legacy-message-parent",
    1,
    1,
    "request",
    value.senderTaskId,
    "Legacy sender",
    "legacy-sender-session",
    "legacy-sender-agent",
    "Legacy Sender Agent",
    PRINCIPAL_ID,
    value.recipientTaskId,
    "Legacy recipient",
    "running",
    "legacy-recipient-agent",
    "Legacy Recipient Agent",
    PRINCIPAL_ID,
    "Please validate the legacy migration.",
    "legacy-correlation",
    null,
    1,
    "legacy-request-hash-parent",
    "legacy-send-parent",
    BASE_TIME,
    BASE_TIME,
    "legacy-recipient-session",
    BASE_TIME,
    BASE_TIME,
    BASE_TIME,
  );
  insertMessage.run(
    "legacy-message-reply",
    1,
    1,
    "decision",
    value.recipientTaskId,
    "Legacy recipient",
    "legacy-recipient-session",
    "legacy-recipient-agent",
    "Legacy Recipient Agent",
    PRINCIPAL_ID,
    value.senderTaskId,
    "Legacy sender",
    "running",
    "legacy-sender-agent",
    "Legacy Sender Agent",
    PRINCIPAL_ID,
    "Legacy migration is accepted.",
    "legacy-correlation",
    "legacy-message-parent",
    1,
    "legacy-request-hash-reply",
    "legacy-send-reply",
    "2026-08-29T12:00:01.000Z",
    null,
    null,
    null,
    null,
    null,
  );
  database
    .prepare(
      `
      INSERT INTO task_coordination_v1_broadcasts (
        sender_task_id, sender_session_id, idempotency_key,
        request_hash, correlation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      value.senderTaskId,
      "legacy-sender-session",
      "legacy-broadcast-key",
      "legacy-broadcast-hash",
      "legacy-correlation",
      BASE_TIME,
    );
  database.close();
  openDatabases.splice(openDatabases.indexOf(database), 1);
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
    .get() as {
    readonly value: number;
  };
  return Number(row.value);
}

interface CoordinationV2SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}

function coordinationV2State(database: DatabaseSync): {
  readonly objects: readonly CoordinationV2SchemaObject[];
  readonly metadata: readonly { readonly key: string; readonly value: string }[];
} {
  const objects = database
    .prepare(
      `
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE name GLOB 'task_coordination_v2_*'
      ORDER BY type ASC, name ASC
    `,
    )
    .all() as unknown as CoordinationV2SchemaObject[];
  const metadata = objects.some(
    (object) => object.type === "table" && object.name === METADATA_TABLE,
  )
    ? (database
        .prepare(`SELECT key, value FROM ${METADATA_TABLE} ORDER BY key ASC`)
        .all() as unknown as Array<{ readonly key: string; readonly value: string }>)
    : [];
  return { objects, metadata };
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // Best-effort failure cleanup.
    }
  }
  for (const registry of openRegistries.splice(0)) {
    try {
      registry.close();
    } catch {
      // Best-effort failure cleanup.
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

describe("Task coordination v1 migration", () => {
  it("rolls back v2 schema creation when legacy validation fails", async () => {
    const value = await fixture();
    const database = directDatabase(value.databasePath);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS ${BROADCAST_TABLE};
      DROP TABLE IF EXISTS ${MESSAGE_TABLE};
      DROP TABLE IF EXISTS ${CURSOR_TABLE};
      DROP TABLE IF EXISTS ${SESSION_TABLE};
      DROP TABLE IF EXISTS ${METADATA_TABLE};
      CREATE TABLE task_coordination_v1_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO task_coordination_v1_metadata (key, value)
      VALUES ('schemaVersion', 'scr.task-coordination-store/v1');
      PRAGMA foreign_keys = ON;
    `);
    const before = coordinationV2State(database);
    expect(before).toEqual({ objects: [], metadata: [] });
    database.close();
    openDatabases.splice(openDatabases.indexOf(database), 1);

    expect(
      () => new TaskRegistry({ databasePath: value.databasePath }),
    ).toThrow(/legacy Task coordination storage is incomplete/iu);

    const verification = directDatabase(value.databasePath);
    expect(coordinationV2State(verification)).toEqual(before);
  });

  it("reopens migrated history after an authenticated mailbox session renews", async () => {
    const value = await fixture();
    seedLegacyV1(value);
    const first = new TaskRegistry({ databasePath: value.databasePath });
    openRegistries.push(first);
    first.coordinationStore().inbox(
      {
        taskId: value.recipientTaskId,
        sessionId: "legacy-recipient-session",
        agentId: "legacy-recipient-agent",
      },
      {
        principalId: PRINCIPAL_ID,
        workspaceRoot: value.workspace,
        sessionId: "new-trusted-transport",
        now: "2026-08-30T00:00:00.000Z",
      },
    );
    first.close();
    const second = new TaskRegistry({ databasePath: value.databasePath });
    openRegistries.push(second);
    const database = directDatabase(value.databasePath);
    expect(countRows(database, MESSAGE_TABLE)).toBe(2);
    expect(
      database
        .prepare(
          `SELECT last_seen_at FROM ${SESSION_TABLE} WHERE task_id = ? AND session_id = ?`,
        )
        .get(value.recipientTaskId, "legacy-recipient-session"),
    ).toMatchObject({ last_seen_at: "2026-08-30T00:00:00.000Z" });
  });

  it("imports sessions, messages, replies, cursors and broadcasts exactly once", async () => {
    const value = await fixture();
    seedLegacyV1(value);

    const first = new TaskRegistry({ databasePath: value.databasePath });
    openRegistries.push(first);
    for (const taskId of [value.recipientTaskId, value.senderTaskId]) {
      const historical = first.coordinationInbox(taskId);
      for (const message of historical.messages) {
        validateTaskCoordinationMessageCausality(message, historical.generatedAt);
      }
    }
    const database = directDatabase(value.databasePath);
    expect(countRows(database, SESSION_TABLE)).toBe(2);
    expect(countRows(database, MESSAGE_TABLE)).toBe(2);
    expect(countRows(database, BROADCAST_TABLE)).toBe(1);
    expect(countRows(database, CURSOR_TABLE)).toBe(2);
    const messages = database
      .prepare(
        `
        SELECT id, recipient_sequence, sender_sequence, correlation_id,
          reply_to_message_id, intended_agent_id, delivered_agent_id,
          delivered_session_id, idempotency_key
        FROM ${MESSAGE_TABLE}
        ORDER BY created_at ASC
      `,
      )
      .all() as unknown as Array<Record<string, unknown>>;
    expect(messages).toEqual([
      expect.objectContaining({
        id: "legacy-message-parent",
        recipient_sequence: 1,
        sender_sequence: 1,
        correlation_id: "legacy-correlation",
        reply_to_message_id: null,
        intended_agent_id: "legacy-recipient-agent",
        delivered_agent_id: "legacy-recipient-agent",
        delivered_session_id: "legacy-recipient-session",
        idempotency_key: "legacy-v1-message-legacy-message-parent",
      }),
      expect.objectContaining({
        id: "legacy-message-reply",
        recipient_sequence: 1,
        sender_sequence: 1,
        correlation_id: "legacy-correlation",
        reply_to_message_id: "legacy-message-parent",
        intended_agent_id: "legacy-sender-agent",
        delivered_agent_id: null,
        delivered_session_id: null,
        idempotency_key: "legacy-v1-message-legacy-message-reply",
      }),
    ]);
    const migration = database
      .prepare(
        `SELECT value FROM ${METADATA_TABLE} WHERE key = 'legacyV1Migration'`,
      )
      .get() as { readonly value: string };
    expect(JSON.parse(migration.value)).toEqual({
      schemaVersion: "scr.task-coordination-v1-migration/v1",
      legacyCounts: { sessions: 2, messages: 2, broadcasts: 1 },
    });
    database.close();
    openDatabases.splice(openDatabases.indexOf(database), 1);
    first.close();
    openRegistries.splice(openRegistries.indexOf(first), 1);

    const second = new TaskRegistry({ databasePath: value.databasePath });
    openRegistries.push(second);
    const verification = directDatabase(value.databasePath);
    expect(countRows(verification, SESSION_TABLE)).toBe(2);
    expect(countRows(verification, MESSAGE_TABLE)).toBe(2);
    expect(countRows(verification, BROADCAST_TABLE)).toBe(1);
    expect(countRows(verification, CURSOR_TABLE)).toBe(2);
  });

  it("fails closed and rolls back when legacy history conflicts with imported v2 history", async () => {
    const value = await fixture();
    seedLegacyV1(value);
    const first = new TaskRegistry({ databasePath: value.databasePath });
    first.close();

    const database = directDatabase(value.databasePath);
    const before = {
      sessions: countRows(database, SESSION_TABLE),
      messages: countRows(database, MESSAGE_TABLE),
      broadcasts: countRows(database, BROADCAST_TABLE),
      schema: coordinationV2State(database),
    };
    database
      .prepare(
        "UPDATE task_coordination_v1_messages SET content = ? WHERE id = ?",
      )
      .run(
        "Conflicting history must never replace v2.",
        "legacy-message-parent",
      );
    database.close();
    openDatabases.splice(openDatabases.indexOf(database), 1);

    expect(
      () => new TaskRegistry({ databasePath: value.databasePath }),
    ).toThrow(/messages conflict with v2 history/u);
    const verification = directDatabase(value.databasePath);
    expect({
      sessions: countRows(verification, SESSION_TABLE),
      messages: countRows(verification, MESSAGE_TABLE),
      broadcasts: countRows(verification, BROADCAST_TABLE),
      schema: coordinationV2State(verification),
    }).toEqual(before);
  });
});
