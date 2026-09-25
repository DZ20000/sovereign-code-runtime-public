import { TaskStatementCache } from "./task-statement-cache.js";
import type { DatabaseSync } from "node:sqlite";

import type { DesktopTaskMessageRole } from "@sovereign/control-plane-contract";
import { RuntimeError } from "@sovereign/runtime-core";

export const TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE =
  "task_message_retention_counts_v1";
export const TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE =
  "task_message_retention_totals_v1";
export const TASK_MESSAGE_RETENTION_INSERT_TRIGGER =
  "task_message_retention_insert_v1";
export const TASK_MESSAGE_RETENTION_DELETE_TRIGGER =
  "task_message_retention_delete_v1";
const RETENTION_ORDER_INDEX = "idx_task_messages_retention_order";
const TOTAL_KEY = "all";
const RETENTION_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER ${TASK_MESSAGE_RETENTION_INSERT_TRIGGER}
  AFTER INSERT ON task_messages
  BEGIN
    INSERT INTO ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE} (
      task_id,
      message_count
    ) VALUES (NEW.task_id, 1)
    ON CONFLICT(task_id) DO UPDATE
      SET message_count = message_count + 1;
    UPDATE ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE}
    SET message_count = message_count + 1
    WHERE key = '${TOTAL_KEY}';
  END
`;
const RETENTION_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER ${TASK_MESSAGE_RETENTION_DELETE_TRIGGER}
  AFTER DELETE ON task_messages
  BEGIN
    UPDATE ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE}
    SET message_count = message_count - 1
    WHERE task_id = OLD.task_id;
    DELETE FROM ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE}
    WHERE task_id = OLD.task_id AND message_count = 0;
    UPDATE ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE}
    SET message_count = message_count - 1
    WHERE key = '${TOTAL_KEY}';
  END
`;
const RETENTION_ORDER_INDEX_SQL = `
  CREATE INDEX ${RETENTION_ORDER_INDEX}
  ON task_messages(created_at ASC, task_id ASC, sequence ASC)
`;

interface CountRow {
  readonly count: number;
}

interface RetentionCountsRow {
  readonly task_count: number;
  readonly total_count: number;
}

export interface TaskMessageRetentionLimits {
  readonly perTask: number;
  readonly total: number;
}

export interface TaskMessageRetentionAppend {
  readonly taskId: string;
  readonly messageId: string;
  readonly role: DesktopTaskMessageRole;
}

function normalizeSchemaSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

function validCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeError(
      "POLICY_DENIED",
      `${label} is invalid or exceeds the safe integer range.`,
      409,
    );
  }
  return value;
}

export class TaskMessageRetentionStore {
  readonly #database: DatabaseSync;
  readonly #statements: TaskStatementCache;
  readonly #limits: TaskMessageRetentionLimits;

  constructor(database: DatabaseSync, limits: TaskMessageRetentionLimits) {
    this.#database = database;
    this.#statements = new TaskStatementCache(this.#database);
    this.#limits = {
      perTask: validCount(limits.perTask, "Per-Task message retention limit"),
      total: validCount(limits.total, "Global message retention limit"),
    };
    if (this.#limits.perTask < 1 || this.#limits.total < 1) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Task message retention limits must be positive.",
        400,
      );
    }
    this.#migrate();
  }

  #schemaObjectMatches(
    type: "index" | "trigger",
    name: string,
    expectedSql: string,
  ): boolean {
    const row = this.#statements
      .prepare(
        "SELECT tbl_name, sql FROM sqlite_schema WHERE type = ? AND name = ?",
      )
      .get(type, name) as
      | { readonly tbl_name: string; readonly sql: string | null }
      | undefined;
    return (
      row !== undefined &&
      row.tbl_name === "task_messages" &&
      row.sql !== null &&
      normalizeSchemaSql(row.sql) === normalizeSchemaSql(expectedSql)
    );
  }

  #ensureSchemaObject(
    type: "index" | "trigger",
    name: string,
    expectedSql: string,
  ): void {
    if (this.#schemaObjectMatches(type, name, expectedSql)) return;
    const dropType = type === "index" ? "INDEX" : "TRIGGER";
    this.#database.exec(`DROP ${dropType} IF EXISTS ${name};
${expectedSql};`);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE} (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        message_count INTEGER NOT NULL CHECK (
          message_count >= 0 AND message_count <= ${Number.MAX_SAFE_INTEGER}
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE} (
        key TEXT PRIMARY KEY CHECK (key = '${TOTAL_KEY}'),
        message_count INTEGER NOT NULL CHECK (
          message_count >= 0 AND message_count <= ${Number.MAX_SAFE_INTEGER}
        )
      ) STRICT;
    `);
    this.#assertColumns(TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE, [
      "task_id",
      "message_count",
    ]);
    this.#assertColumns(TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE, [
      "key",
      "message_count",
    ]);

    this.#transaction(() => {
      this.#ensureSchemaObject(
        "trigger",
        TASK_MESSAGE_RETENTION_INSERT_TRIGGER,
        RETENTION_INSERT_TRIGGER_SQL,
      );
      this.#ensureSchemaObject(
        "trigger",
        TASK_MESSAGE_RETENTION_DELETE_TRIGGER,
        RETENTION_DELETE_TRIGGER_SQL,
      );
      this.#ensureSchemaObject(
        "index",
        RETENTION_ORDER_INDEX,
        RETENTION_ORDER_INDEX_SQL,
      );
      this.#database.exec(`
        INSERT OR IGNORE INTO ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE} (
          key,
          message_count
        ) VALUES ('${TOTAL_KEY}', 0);

        DELETE FROM ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE};
        INSERT INTO ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE} (
          task_id,
          message_count
        )
        SELECT task_id, COUNT(*)
        FROM task_messages
        GROUP BY task_id;

        UPDATE ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE}
        SET message_count = (SELECT COUNT(*) FROM task_messages)
        WHERE key = '${TOTAL_KEY}';
      `);
      this.#assertConsistent();
    });
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK;");
      } catch {
        // Preserve the migration failure. The database remains fail-closed.
      }
      throw error;
    }
  }

  #assertColumns(table: string, expected: readonly string[]): void {
    const rows = this.#statements
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as Array<{ readonly name: string }>;
    if (
      rows.length !== expected.length ||
      rows.some((row, index) => row.name !== expected[index])
    ) {
      throw new RuntimeError(
        "POLICY_DENIED",
        `Task message retention table ${table} has an incompatible schema.`,
        409,
      );
    }
  }

  #totalCount(): number {
    const row = this.#statements
      .prepare(
        `SELECT message_count AS count
         FROM ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE}
         WHERE key = ?`,
      )
      .get(TOTAL_KEY) as CountRow | undefined;
    if (row === undefined) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Global task message retention counter is unavailable.",
        409,
      );
    }
    return validCount(row.count, "Global task message retention counter");
  }

  #counts(taskId: string): { readonly task: number; readonly total: number } {
    const row = this.#statements
      .prepare(
        `
        SELECT
          COALESCE((
            SELECT message_count
            FROM ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE}
            WHERE task_id = ?
          ), 0) AS task_count,
          (
            SELECT message_count
            FROM ${TASK_MESSAGE_RETENTION_TOTAL_COUNT_TABLE}
            WHERE key = ?
          ) AS total_count
      `,
      )
      .get(taskId, TOTAL_KEY) as RetentionCountsRow | undefined;
    if (row === undefined || row.total_count === null) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Task message retention counters are unavailable.",
        409,
      );
    }
    return {
      task: validCount(row.task_count, "Task message retention counter"),
      total: validCount(
        row.total_count,
        "Global task message retention counter",
      ),
    };
  }

  #assertConsistent(): void {
    const actual = this.#statements
      .prepare("SELECT COUNT(*) AS count FROM task_messages")
      .get() as unknown as CountRow;
    const byTask = this.#statements
      .prepare(
        `SELECT COALESCE(SUM(message_count), 0) AS count
         FROM ${TASK_MESSAGE_RETENTION_TASK_COUNT_TABLE}`,
      )
      .get() as unknown as CountRow;
    const total = this.#totalCount();
    if (actual.count !== byTask.count || actual.count !== total) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Task message retention counters do not match persisted messages.",
        409,
      );
    }
  }

  enforceAfterAppend(input: TaskMessageRetentionAppend): void {
    const initial = this.#counts(input.taskId);
    if (
      initial.task <= this.#limits.perTask &&
      initial.total <= this.#limits.total
    ) {
      return;
    }

    const taskExcess = Math.max(0, initial.task - this.#limits.perTask);
    let taskDeleted = 0;
    if (taskExcess > 0) {
      const result = this.#statements
        .prepare(
          `
          DELETE FROM task_messages
          WHERE rowid IN (
            SELECT rowid FROM task_messages
            WHERE task_id = ?
              AND NOT (role = 'user' AND acknowledged_at IS NULL)
            ORDER BY sequence ASC
            LIMIT ?
          )
        `,
        )
        .run(input.taskId, taskExcess) as unknown as {
        readonly changes: number;
      };
      taskDeleted = validCount(
        result.changes,
        "Per-Task message retention deletion count",
      );
    }

    const totalAfterTaskPruning = initial.total - taskDeleted;
    const totalExcess = Math.max(0, totalAfterTaskPruning - this.#limits.total);
    if (totalExcess > 0) {
      this.#statements
        .prepare(
          `
          DELETE FROM task_messages
          WHERE rowid IN (
            SELECT rowid FROM task_messages
            WHERE NOT (role = 'user' AND acknowledged_at IS NULL)
            ORDER BY created_at ASC, task_id ASC, sequence ASC
            LIMIT ?
          )
        `,
        )
        .run(totalExcess);
    }

    const final = this.#counts(input.taskId);
    const retained =
      input.role === "system"
        ? true
        : this.#statements
            .prepare("SELECT 1 AS retained FROM task_messages WHERE id = ?")
            .get(input.messageId) !== undefined;
    if (
      final.task > this.#limits.perTask ||
      final.total > this.#limits.total ||
      !retained
    ) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Task conversation retention is full of unacknowledged user messages.",
        409,
      );
    }
  }
}
