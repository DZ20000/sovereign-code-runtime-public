import type { DatabaseSync } from "node:sqlite";

export function initializeTaskRegistrySchema(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 2000;");
  database.exec(`
      CREATE TABLE IF NOT EXISTS task_projects (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        normalized_root TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
        idempotency_key TEXT,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        current_step TEXT NOT NULL,
        progress_current INTEGER,
        progress_total INTEGER,
        progress_label TEXT,
        steps_json TEXT NOT NULL,
        agent_id TEXT,
        agent_name TEXT,
        principal_id TEXT,
        last_heartbeat_at TEXT,
        last_activity_label TEXT,
        last_activity_at TEXT,
        agent_ack_sequence INTEGER NOT NULL DEFAULT 0,
        next_message_sequence INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(project_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS task_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        agent_id TEXT,
        agent_name TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        UNIQUE(task_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS task_tool_execution_evidence_v1 (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        activity_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('pending', 'succeeded', 'failed')),
        receipt_id TEXT,
        error_code TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_tasks_project_updated
        ON tasks(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_principal_status
        ON tasks(principal_id, status, last_heartbeat_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_messages_task_sequence
        ON task_messages(task_id, sequence ASC);
    `);
  const taskColumns = database
    .prepare("PRAGMA table_info(tasks)")
    .all() as unknown as { readonly name: string }[];
  if (!taskColumns.some((column) => column.name === "next_message_sequence")) {
    database.exec(
      "ALTER TABLE tasks ADD COLUMN next_message_sequence INTEGER NOT NULL DEFAULT 1;",
    );
  }
  database.exec(`
      UPDATE tasks
      SET next_message_sequence = COALESCE(
        (SELECT MAX(sequence) + 1 FROM task_messages WHERE task_id = tasks.id),
        1
      )
      WHERE next_message_sequence <= COALESCE(
        (SELECT MAX(sequence) FROM task_messages WHERE task_id = tasks.id),
        0
      );
    `);
}
