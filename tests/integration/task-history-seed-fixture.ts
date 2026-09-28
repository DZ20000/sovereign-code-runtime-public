import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

interface AssistantHistoryBatch {
  readonly taskId: string;
  readonly taskNumber: number;
  readonly count: number;
}

/**
 * Prepare synthetic history strictly below the real global retention boundary.
 * This is test setup, not a batching API. Live triggers, foreign keys and normal
 * durability remain enabled. Boundary crossings must use the real TaskRegistry.
 */
export function seedAssistantHistory(
  databasePath: string,
  batches: readonly AssistantHistoryBatch[],
): void {
  assert.ok(batches.length > 0);
  assert.equal(new Set(batches.map((batch) => batch.taskId)).size, batches.length);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const durability = database.prepare("PRAGMA synchronous").get() as { synchronous: number };
    assert.equal(durability.synchronous, 2, "History setup must retain FULL synchronization");
    database.exec("BEGIN IMMEDIATE;");
    try {
      const total = database.prepare("SELECT COUNT(*) AS count FROM task_messages")
        .get() as { count: number };
      const taskQuery = database.prepare(`
        SELECT agent_id, agent_name, next_message_sequence,
          (SELECT COUNT(*) FROM task_messages WHERE task_id = tasks.id) AS count
        FROM tasks WHERE id = ?
      `);
      const plans = batches.map((batch) => {
        assert.ok(Number.isSafeInteger(batch.count) && batch.count > 0);
        assert.ok(Number.isSafeInteger(batch.taskNumber) && batch.taskNumber > 0);
        const task = taskQuery.get(batch.taskId) as {
          agent_id: string | null; agent_name: string | null;
          next_message_sequence: number; count: number;
        } | undefined;
        assert.ok(task, "History fixture requires an existing Task");
        assert.equal(task.count, 1, "Seed only a newly created Task");
        assert.equal(task.next_message_sequence, 2);
        assert.ok(task.agent_id !== null);
        assert.ok(task.count + batch.count <= 500, "Seed cannot cross per-Task retention");
        return { batch, task };
      });
      const expectedTotal = total.count + plans.reduce((n, { batch }) => n + batch.count, 0);
      assert.ok(expectedTotal < 2000, "Seed must remain below global retention");
      const insert = database.prepare(`
        INSERT INTO task_messages (
          id, task_id, sequence, role, agent_id, agent_name, content, created_at, acknowledged_at
        ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, NULL)
      `);
      const update = database.prepare("UPDATE tasks SET next_message_sequence = ?, updated_at = ? WHERE id = ?");
      const updateProject = database.prepare(`
        UPDATE task_projects SET updated_at = ?
        WHERE id = (SELECT project_id FROM tasks WHERE id = ?)
      `);
      for (const { batch, task } of plans) {
        let createdAt = "";
        for (let index = 0; index < batch.count; index += 1) {
          createdAt = new Date().toISOString();
          insert.run(randomUUID(), batch.taskId, task.next_message_sequence + index,
            task.agent_id, task.agent_name, `Task ${batch.taskNumber} message ${index + 1}`, createdAt);
        }
        update.run(task.next_message_sequence + batch.count, createdAt, batch.taskId);
        updateProject.run(createdAt, batch.taskId);
      }
      // Read the trigger-maintained counters; never manufacture or repair them.
      const storedTotal = database.prepare(`
        SELECT message_count FROM task_message_retention_totals_v1 WHERE key = 'all'
      `).get() as { message_count: number } | undefined;
      assert.equal(storedTotal?.message_count, expectedTotal);
      const mismatches = database.prepare(`
        SELECT t.id FROM tasks t
        LEFT JOIN task_message_retention_counts_v1 c ON c.task_id = t.id
        WHERE COALESCE(c.message_count, 0) != (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id)
      `).all();
      assert.equal(mismatches.length, 0, "Seed counters must match stored messages");
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    database.close();
  }
}
