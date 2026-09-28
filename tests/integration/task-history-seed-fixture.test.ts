import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { fixture } from "./task-registry-fixture.js";
import { seedAssistantHistory } from "./task-history-seed-fixture.js";

async function ready(count = 2) {
  const value = await fixture();
  const tasks = Array.from({ length: count }, (_, index) => value.registry.createTask({
    title: `Seed ${index + 1}`, agentId: `seed-${index + 1}`, agentName: "Seed Agent",
  }, "chatgpt-web", value.workspace));
  return { ...value, tasks };
}

describe("pre-boundary Task history fixture", () => {
  it("commits seeded rows, sequences and live counters without weakening durability", async () => {
    const { databasePath, registry, tasks } = await ready();
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const before = reader.prepare("PRAGMA synchronous").get();
      seedAssistantHistory(databasePath, [
        { taskId: tasks[0]!.id, taskNumber: 1, count: 2 },
        { taskId: tasks[1]!.id, taskNumber: 2, count: 3 },
      ]);
      expect(reader.prepare("PRAGMA synchronous").get()).toEqual(before);
      expect(before).toMatchObject({ synchronous: 2 });
      expect(reader.prepare("SELECT COUNT(*) AS count FROM task_messages").get()).toMatchObject({ count: 7 });
      expect(reader.prepare("SELECT message_count FROM task_message_retention_totals_v1 WHERE key = 'all'").get()).toMatchObject({ message_count: 7 });
      expect(registry.detail(tasks[0]!.id).messages.at(-1)).toMatchObject({ sequence: 3, content: "Task 1 message 2" });
      const next = registry.addAgentMessage(tasks[0]!.id, "Real append", "assistant", "seed-1", "Seed Agent", "chatgpt-web");
      expect(next.messages.at(-1)).toMatchObject({ sequence: 4, content: "Real append" });
      expect(reader.prepare("SELECT COUNT(*) AS count FROM task_messages").get()).toMatchObject({ count: 8 });
    } finally { reader.close(); }
  });

  it.each([0, -1, 0.5, NaN, Infinity, 500])("rejects invalid seed count %s without writing", async (count) => {
    const { databasePath, registry, tasks } = await ready(1);
    expect(() => seedAssistantHistory(databasePath, [{ taskId: tasks[0]!.id, taskNumber: 1, count }])).toThrow();
    expect(registry.detail(tasks[0]!.id).messages).toHaveLength(1);
  });

  it("rejects global overflow, duplicate Tasks and reused Tasks", async () => {
    const { databasePath, registry, tasks } = await ready(5);
    expect(() => seedAssistantHistory(databasePath, tasks.map((task, index) => ({ taskId: task.id, taskNumber: index + 1, count: 400 })))).toThrow(/below global retention/);
    expect(() => seedAssistantHistory(databasePath, [
      { taskId: tasks[0]!.id, taskNumber: 1, count: 1 },
      { taskId: tasks[0]!.id, taskNumber: 1, count: 1 },
    ])).toThrow();
    seedAssistantHistory(databasePath, [{ taskId: tasks[0]!.id, taskNumber: 1, count: 1 }]);
    expect(() => seedAssistantHistory(databasePath, [{ taskId: tasks[0]!.id, taskNumber: 1, count: 1 }])).toThrow(/newly created Task/);
    expect(registry.detail(tasks[0]!.id).messages).toHaveLength(2);
  });

  it("rolls back earlier Task sequences and counters when a later batch fails", async () => {
    const { databasePath, registry, tasks } = await ready(2);
    const injector = new DatabaseSync(databasePath);
    try {
      injector.exec(`CREATE TRIGGER fail_seed BEFORE INSERT ON task_messages
        WHEN NEW.content = 'Task 2 message 2' BEGIN SELECT RAISE(ABORT, 'Synthetic seed failure'); END;`);
      expect(() => seedAssistantHistory(databasePath, [
        { taskId: tasks[0]!.id, taskNumber: 1, count: 1 },
        { taskId: tasks[1]!.id, taskNumber: 2, count: 3 },
      ])).toThrow(/Synthetic seed failure/);
      for (const task of tasks) {
        expect(registry.detail(task.id).messages).toHaveLength(1);
        expect(injector.prepare("SELECT next_message_sequence FROM tasks WHERE id = ?").get(task.id))
          .toMatchObject({ next_message_sequence: 2 });
      }
      expect(injector.prepare("SELECT message_count FROM task_message_retention_totals_v1 WHERE key = 'all'").get())
        .toMatchObject({ message_count: 2 });
    } finally { injector.close(); }
  });
});
