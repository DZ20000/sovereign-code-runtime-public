import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  TASK_MESSAGE_RETENTION_DELETE_TRIGGER,
  TASK_MESSAGE_RETENTION_INSERT_TRIGGER,
  TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE,
  TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE,
  TaskMessageRetentionStore,
} from "../../packages/control-plane/src/task-message-retention.js";

interface Fixture {
  readonly root: string;
  readonly database: DatabaseSync;
}

const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "scr-task-message-retention-"));
  const database = new DatabaseSync(join(root, "tasks.sqlite"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE task_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      UNIQUE(task_id, sequence)
    ) STRICT;
  `);
  const value = { root, database };
  fixtures.push(value);
  return value;
}

function insertTask(database: DatabaseSync, taskId: string): void {
  database.prepare("INSERT INTO tasks (id) VALUES (?)").run(taskId);
}

function appendMessage(
  database: DatabaseSync,
  retention: TaskMessageRetentionStore,
  input: {
    readonly taskId: string;
    readonly sequence: number;
    readonly role: "user" | "assistant" | "system";
    readonly acknowledged?: boolean;
    readonly createdAt?: string;
  },
): string {
  const id = randomUUID();
  database.exec("BEGIN IMMEDIATE;");
  try {
    database
      .prepare(
        `
        INSERT INTO task_messages (
          id, task_id, sequence, role, content, created_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.taskId,
        input.sequence,
        input.role,
        `message-${input.sequence}`,
        input.createdAt ?? new Date(input.sequence * 1_000).toISOString(),
        input.acknowledged === true ? new Date().toISOString() : null,
      );
    retention.enforceAfterAppend({
      taskId: input.taskId,
      messageId: id,
      role: input.role,
    });
    database.exec("COMMIT;");
    return id;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function count(
  database: DatabaseSync,
  sql: string,
  ...parameters: SQLInputValue[]
): number {
  const row = database.prepare(sql).get(...parameters) as unknown as {
    readonly count: number;
  };
  return row.count;
}

function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA schema_version").get() as unknown as {
    readonly schema_version: number;
  };
  return Number(row.schema_version);
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("task message retention counters", () => {
  it("leaves matching retention triggers and indexes as a DDL no-op", async () => {
    const { database } = await fixture();
    new TaskMessageRetentionStore(database, { perTask: 10, total: 20 });
    const before = schemaVersion(database);

    new TaskMessageRetentionStore(database, { perTask: 10, total: 20 });

    expect(schemaVersion(database)).toBe(before);
  });

  it("atomically backfills counters and replaces an incompatible same-name trigger", async () => {
    const { database } = await fixture();
    insertTask(database, "task-a");
    database.exec(`
      INSERT INTO task_messages (
        id, task_id, sequence, role, content, created_at, acknowledged_at
      ) VALUES
        ('message-1', 'task-a', 1, 'assistant', 'first', '2026-01-01T00:00:00.000Z', NULL),
        ('message-2', 'task-a', 2, 'assistant', 'second', '2026-01-01T00:00:01.000Z', NULL);
      CREATE TRIGGER ${TASK_MESSAGE_RETENTION_INSERT_TRIGGER}
      AFTER INSERT ON task_messages
      BEGIN
        SELECT 1;
      END;
    `);

    const retention = new TaskMessageRetentionStore(database, {
      perTask: 10,
      total: 20,
    });
    expect(
      count(
        database,
        `SELECT message_count AS count FROM ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE} WHERE task_id = ?`,
        "task-a",
      ),
    ).toBe(2);
    expect(
      count(
        database,
        `SELECT message_count AS count FROM ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE} WHERE key = 'all'`,
      ),
    ).toBe(2);

    appendMessage(database, retention, {
      taskId: "task-a",
      sequence: 3,
      role: "assistant",
    });
    expect(
      count(
        database,
        `SELECT message_count AS count FROM ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE} WHERE key = 'all'`,
      ),
    ).toBe(3);

    database.exec(`
      UPDATE ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE}
      SET message_count = 999;
      UPDATE ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE}
      SET message_count = 999
      WHERE key = 'all';
    `);
    new TaskMessageRetentionStore(database, { perTask: 10, total: 20 });
    expect(
      count(
        database,
        `SELECT message_count AS count FROM ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE} WHERE task_id = ?`,
        "task-a",
      ),
    ).toBe(3);
    expect(
      count(
        database,
        `SELECT message_count AS count FROM ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE} WHERE key = 'all'`,
      ),
    ).toBe(3);
  });

  it("rolls back rejected unread messages without drifting persisted counters", async () => {
    const { database } = await fixture();
    insertTask(database, "task-a");
    const retention = new TaskMessageRetentionStore(database, {
      perTask: 2,
      total: 3,
    });

    appendMessage(database, retention, {
      taskId: "task-a",
      sequence: 1,
      role: "user",
    });
    appendMessage(database, retention, {
      taskId: "task-a",
      sequence: 2,
      role: "user",
    });
    expect(() =>
      appendMessage(database, retention, {
        taskId: "task-a",
        sequence: 3,
        role: "user",
      }),
    ).toThrow(/full of unacknowledged user messages/u);

    expect(count(database, "SELECT COUNT(*) AS count FROM task_messages")).toBe(
      2,
    );
    expect(
      count(
        database,
        `SELECT message_count AS count FROM ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE} WHERE task_id = ?`,
        "task-a",
      ),
    ).toBe(2);
    expect(
      count(
        database,
        `SELECT message_count AS count FROM ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE} WHERE key = 'all'`,
      ),
    ).toBe(2);
  });

  it("keeps counters correct when task deletion cascades through retained messages", async () => {
    const { database } = await fixture();
    insertTask(database, "task-a");
    insertTask(database, "task-b");
    const retention = new TaskMessageRetentionStore(database, {
      perTask: 10,
      total: 20,
    });

    appendMessage(database, retention, {
      taskId: "task-a",
      sequence: 1,
      role: "assistant",
    });
    appendMessage(database, retention, {
      taskId: "task-a",
      sequence: 2,
      role: "assistant",
    });
    appendMessage(database, retention, {
      taskId: "task-b",
      sequence: 1,
      role: "assistant",
    });

    database.prepare("DELETE FROM tasks WHERE id = ?").run("task-a");
    expect(count(database, "SELECT COUNT(*) AS count FROM task_messages")).toBe(
      1,
    );
    expect(
      count(
        database,
        `SELECT COUNT(*) AS count FROM ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE} WHERE task_id = ?`,
        "task-a",
      ),
    ).toBe(0);
    expect(
      count(
        database,
        `SELECT message_count AS count FROM ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE} WHERE key = 'all'`,
      ),
    ).toBe(1);
    expect(
      count(
        database,
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)`,
        TASK_MESSAGE_RETENTION_INSERT_TRIGGER,
        TASK_MESSAGE_RETENTION_DELETE_TRIGGER,
      ),
    ).toBe(2);
  });
});
