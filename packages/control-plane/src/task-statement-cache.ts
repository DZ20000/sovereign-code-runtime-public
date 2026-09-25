import type { DatabaseSync, StatementSync } from "node:sqlite";

const MAX_CACHED_STATEMENTS = 64;

/** Reuse prepared SQL, never query results or owner/authorization decisions. */
export class TaskStatementCache {
  readonly #database: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  prepare(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached;
    const statement = this.#database.prepare(sql);
    // Keep cardinality bounded even if a future caller supplies distinct SQL.
    // At capacity the statement still executes normally, without caching it.
    if (this.#statements.size < MAX_CACHED_STATEMENTS) {
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}
