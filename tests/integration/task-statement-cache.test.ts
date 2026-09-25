import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { TaskStatementCache } from "../../packages/control-plane/src/task-statement-cache.js";

describe("Task SQL statement reuse", () => {
  it("reuses preparation without caching values, ownership, or rollback state", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE owner (id INTEGER PRIMARY KEY, agent TEXT); INSERT INTO owner VALUES (1, 'first');",
      );
      const prepare = vi.spyOn(database, "prepare");
      const cache = new TaskStatementCache(database);
      const sql = "SELECT agent FROM owner WHERE id = ?";
      const first = cache.prepare(sql);
      expect(first.get(1)).toMatchObject({ agent: "first" });
      database.exec("BEGIN; UPDATE owner SET agent = 'second' WHERE id = 1;");
      expect(cache.prepare(sql)).toBe(first);
      expect(cache.prepare(sql).get(1)).toMatchObject({ agent: "second" });
      database.exec("ROLLBACK;");
      expect(cache.prepare(sql).get(1)).toMatchObject({ agent: "first" });
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("bounds retained statements while executing SQL beyond the cache capacity", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const prepare = vi.spyOn(database, "prepare");
      const cache = new TaskStatementCache(database);
      const first = cache.prepare("SELECT 0 AS value");
      for (let index = 1; index < 64; index += 1) {
        expect(cache.prepare(`SELECT ${index} AS value`).get()).toMatchObject({
          value: index,
        });
      }
      expect(cache.prepare("SELECT 64 AS value").get()).toMatchObject({
        value: 64,
      });
      expect(cache.prepare("SELECT 64 AS value").get()).toMatchObject({
        value: 64,
      });
      expect(cache.prepare("SELECT 0 AS value")).toBe(first);
      expect(prepare).toHaveBeenCalledTimes(66);
    } finally {
      database.close();
    }
  });
});
