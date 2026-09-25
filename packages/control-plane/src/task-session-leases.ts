import { TaskStatementCache } from "./task-statement-cache.js";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { DesktopTaskAgentPresence } from "@sovereign/control-plane-contract";
import { RuntimeError } from "@sovereign/runtime-core";

export const TASK_SESSION_LEASE_SCHEMA_VERSION =
  "scr.task-session-lease/v1" as const;
export const TASK_SESSION_LEASE_TABLE = "task_agent_session_leases_v1";
export const TASK_SESSION_ONLINE_AFTER_MS = 45_000;
export const TASK_SESSION_LEASE_TTL_MS = 5 * 60_000;
const MAX_SESSION_ID_LENGTH = 160;
const MAX_AGENT_ID_LENGTH = 128;
const MAX_PRINCIPAL_ID_LENGTH = 160;
const MAX_CLOSE_REASON_LENGTH = 240;
const MAX_LEASES_PER_TASK = 256;
const SESSION_INDEX = "idx_task_session_leases_session";
const TASK_OWNER_INDEX = "idx_task_session_leases_task_owner";
const SESSION_INDEX_SQL = `
  CREATE INDEX ${SESSION_INDEX}
  ON ${TASK_SESSION_LEASE_TABLE} (
    principal_id, session_id, closed_at_unix_ms, expires_at_unix_ms
  )
`;
const TASK_OWNER_INDEX_SQL = `
  CREATE INDEX ${TASK_OWNER_INDEX}
  ON ${TASK_SESSION_LEASE_TABLE} (
    task_id, agent_id, principal_id, closed_at_unix_ms, expires_at_unix_ms
  )
`;
const SAFE_IDENTIFIER = /^[^\s\u0000-\u001f\u007f]{1,160}$/u;

interface LeaseRow {
  readonly task_id: string;
  readonly session_id: string;
  readonly agent_id: string;
  readonly principal_id: string;
  readonly created_at_unix_ms: number;
  readonly last_seen_at_unix_ms: number;
  readonly expires_at_unix_ms: number;
  readonly closed_at_unix_ms: number | null;
  readonly close_reason: string | null;
}

interface TaskOwnerRow {
  readonly id: string;
  readonly agent_id: string | null;
  readonly principal_id: string | null;
  readonly last_heartbeat_at: string | null;
}

export interface TaskSessionLeaseTouchInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly principalId: string;
  readonly observedAt?: string | number;
  /** Internal compatibility path only; never derived from a supplied ID prefix. */
  readonly legacy?: boolean;
}

export interface TaskSessionLeaseCloseInput {
  readonly sessionId: string;
  readonly principalId: string;
  readonly observedAt?: string | number;
  readonly reason: string;
}

export interface TaskSessionLeaseStoreOptions {
  readonly onChanged?: () => void;
}

function normalizeSchemaSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

function invalid(message: string): never {
  throw new RuntimeError("INVALID_INPUT", message, 400);
}

function denied(message: string): never {
  throw new RuntimeError("POLICY_DENIED", message, 403);
}

function conflict(message: string): never {
  throw new RuntimeError("POLICY_DENIED", message, 409);
}

function identifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !SAFE_IDENTIFIER.test(value)
  ) {
    return invalid(`${label} is missing or invalid.`);
  }
  return value;
}

function timestamp(value: string | number | undefined): number {
  const parsed =
    value === undefined
      ? Date.now()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return invalid("Task session lease timestamp is invalid.");
  }
  return parsed;
}

function leaseExpiry(observedAt: number): number {
  if (observedAt > Number.MAX_SAFE_INTEGER - TASK_SESSION_LEASE_TTL_MS) {
    return invalid(
      "Task session lease timestamp exceeds the safe expiry range.",
    );
  }
  return observedAt + TASK_SESSION_LEASE_TTL_MS;
}

function closeReason(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_CLOSE_REASON_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    return invalid("Task session lease close reason is invalid.");
  }
  return normalized;
}

function leaseSessionId(
  taskId: string,
  agentId: string,
  principalId: string,
): string {
  return `legacy-${createHash("sha256")
    .update(taskId, "utf8")
    .update("\0", "utf8")
    .update(agentId, "utf8")
    .update("\0", "utf8")
    .update(principalId, "utf8")
    .digest("hex")}`;
}

export function taskSessionId(
  sessionId: string | null | undefined,
  taskId: string,
  agentId: string,
  principalId: string,
): string {
  return sessionId === null || sessionId === undefined
    ? leaseSessionId(taskId, agentId, principalId)
    : identifier(sessionId, "Task session ID", MAX_SESSION_ID_LENGTH);
}

export function taskSessionLeaseProjection(taskAlias = "t"): string {
  const owner = `l.task_id = ${taskAlias}.id AND l.agent_id = ${taskAlias}.agent_id AND l.principal_id = ${taskAlias}.principal_id`;
  const order =
    "CASE WHEN l.closed_at_unix_ms IS NULL THEN 0 ELSE 1 END, l.last_seen_at_unix_ms DESC";
  return `
    (SELECT l.last_seen_at_unix_ms
       FROM ${TASK_SESSION_LEASE_TABLE} l
      WHERE ${owner}
      ORDER BY ${order}
      LIMIT 1) AS session_last_seen_at_unix_ms,
    (SELECT l.expires_at_unix_ms
       FROM ${TASK_SESSION_LEASE_TABLE} l
      WHERE ${owner}
      ORDER BY ${order}
      LIMIT 1) AS session_expires_at_unix_ms,
    (SELECT l.closed_at_unix_ms
       FROM ${TASK_SESSION_LEASE_TABLE} l
      WHERE ${owner}
      ORDER BY ${order}
      LIMIT 1) AS session_closed_at_unix_ms`;
}

export function taskSessionPresence(
  lastSeenAtUnixMs: number | null,
  expiresAtUnixMs: number | null,
  closedAtUnixMs: number | null,
  nowUnixMs = Date.now(),
): DesktopTaskAgentPresence {
  if (lastSeenAtUnixMs === null || expiresAtUnixMs === null) return "unknown";
  if (
    !Number.isSafeInteger(lastSeenAtUnixMs) ||
    !Number.isSafeInteger(expiresAtUnixMs) ||
    lastSeenAtUnixMs < 0 ||
    expiresAtUnixMs < lastSeenAtUnixMs
  ) {
    return "offline";
  }
  if (closedAtUnixMs !== null || expiresAtUnixMs <= nowUnixMs) return "offline";
  return nowUnixMs - lastSeenAtUnixMs <= TASK_SESSION_ONLINE_AFTER_MS
    ? "online"
    : "stale";
}

export function taskSessionLastSeenIso(
  lastSeenAtUnixMs: number | null,
): string | null {
  if (!Number.isSafeInteger(lastSeenAtUnixMs) || lastSeenAtUnixMs === null) {
    return null;
  }
  return new Date(lastSeenAtUnixMs).toISOString();
}

export class TaskSessionLeaseStore {
  readonly #database: DatabaseSync;
  readonly #statements: TaskStatementCache;
  readonly #onChanged: () => void;

  constructor(
    database: DatabaseSync,
    options: TaskSessionLeaseStoreOptions = {},
  ) {
    this.#database = database;
    this.#statements = new TaskStatementCache(this.#database);
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.#migrate();
  }

  #indexMatches(name: string, expectedSql: string): boolean {
    const row = this.#statements
      .prepare(
        "SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
      )
      .get(name) as
      | { readonly tbl_name: string; readonly sql: string | null }
      | undefined;
    return (
      row !== undefined &&
      row.tbl_name === TASK_SESSION_LEASE_TABLE &&
      row.sql !== null &&
      normalizeSchemaSql(row.sql) === normalizeSchemaSql(expectedSql)
    );
  }

  #ensureIndex(name: string, expectedSql: string): void {
    if (this.#indexMatches(name, expectedSql)) return;
    this.#database.exec(`DROP INDEX IF EXISTS ${name};
${expectedSql};`);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS ${TASK_SESSION_LEASE_TABLE} (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        created_at_unix_ms INTEGER NOT NULL CHECK (
          created_at_unix_ms >= 0
          AND created_at_unix_ms <= ${Number.MAX_SAFE_INTEGER}
        ),
        last_seen_at_unix_ms INTEGER NOT NULL CHECK (
          last_seen_at_unix_ms >= created_at_unix_ms
          AND last_seen_at_unix_ms <= ${Number.MAX_SAFE_INTEGER}
        ),
        expires_at_unix_ms INTEGER NOT NULL CHECK (
          expires_at_unix_ms >= last_seen_at_unix_ms
          AND expires_at_unix_ms <= ${Number.MAX_SAFE_INTEGER}
        ),
        closed_at_unix_ms INTEGER CHECK (
          closed_at_unix_ms IS NULL
          OR (
            closed_at_unix_ms >= last_seen_at_unix_ms
            AND closed_at_unix_ms <= ${Number.MAX_SAFE_INTEGER}
          )
        ),
        close_reason TEXT,
        PRIMARY KEY (task_id, session_id),
        CHECK (
          (closed_at_unix_ms IS NULL AND close_reason IS NULL)
          OR (closed_at_unix_ms IS NOT NULL AND close_reason IS NOT NULL)
        )
      ) STRICT;
    `);
    const columns = this.#statements
      .prepare(`PRAGMA table_info(${TASK_SESSION_LEASE_TABLE})`)
      .all() as unknown as Array<{ readonly name: string }>;
    const expected = [
      "task_id",
      "session_id",
      "agent_id",
      "principal_id",
      "created_at_unix_ms",
      "last_seen_at_unix_ms",
      "expires_at_unix_ms",
      "closed_at_unix_ms",
      "close_reason",
    ];
    if (
      columns.length !== expected.length ||
      columns.some((column, index) => column.name !== expected[index])
    ) {
      conflict("Task session lease table has an incompatible schema.");
    }

    this.#transaction(() => {
      this.#ensureIndex(SESSION_INDEX, SESSION_INDEX_SQL);
      this.#ensureIndex(TASK_OWNER_INDEX, TASK_OWNER_INDEX_SQL);
      this.#seedLegacyLeases();
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

  #seedLegacyLeases(): void {
    const rows = this.#statements
      .prepare(
        `
        SELECT id, agent_id, principal_id, last_heartbeat_at
        FROM tasks
        WHERE agent_id IS NOT NULL
          AND principal_id IS NOT NULL
          AND last_heartbeat_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${TASK_SESSION_LEASE_TABLE} l WHERE l.task_id = tasks.id
          )
      `,
      )
      .all() as unknown as TaskOwnerRow[];
    const insert = this.#statements.prepare(`
      INSERT OR IGNORE INTO ${TASK_SESSION_LEASE_TABLE} (
        task_id, session_id, agent_id, principal_id,
        created_at_unix_ms, last_seen_at_unix_ms, expires_at_unix_ms,
        closed_at_unix_ms, close_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `);
    for (const row of rows) {
      const observedAt = Date.parse(row.last_heartbeat_at ?? "");
      if (
        row.agent_id === null ||
        row.principal_id === null ||
        !Number.isSafeInteger(observedAt) ||
        observedAt < 0 ||
        observedAt > Number.MAX_SAFE_INTEGER - TASK_SESSION_LEASE_TTL_MS
      ) {
        continue;
      }
      insert.run(
        row.id,
        leaseSessionId(row.id, row.agent_id, row.principal_id),
        row.agent_id,
        row.principal_id,
        observedAt,
        observedAt,
        leaseExpiry(observedAt),
      );
    }
  }

  #leaseForTouch(
    taskId: string,
    sessionId: string,
    legacy: boolean,
  ): LeaseRow | undefined {
    if (!legacy) {
      return this.#statements
        .prepare(
          `SELECT * FROM ${TASK_SESSION_LEASE_TABLE} WHERE task_id = ? AND session_id = ?`,
        )
        .get(taskId, sessionId) as LeaseRow | undefined;
    }
    return this.#statements
      .prepare(
        `
        SELECT *
        FROM ${TASK_SESSION_LEASE_TABLE}
        WHERE task_id = ?
          AND (session_id = ? OR session_id GLOB ?)
        ORDER BY
          CASE WHEN closed_at_unix_ms IS NULL THEN 0 ELSE 1 END,
          created_at_unix_ms DESC,
          session_id DESC
        LIMIT 1
      `,
      )
      .get(taskId, sessionId, `${sessionId}-*`) as LeaseRow | undefined;
  }

  touchTask(input: TaskSessionLeaseTouchInput): boolean {
    const taskId = identifier(input.taskId, "Task ID", 128);
    const sessionId = identifier(
      input.sessionId,
      "Task session ID",
      MAX_SESSION_ID_LENGTH,
    );
    const agentId = identifier(
      input.agentId,
      "Task Agent ID",
      MAX_AGENT_ID_LENGTH,
    );
    const principalId = identifier(
      input.principalId,
      "Task principal ID",
      MAX_PRINCIPAL_ID_LENGTH,
    );
    const observedAt = timestamp(input.observedAt);
    const owner = this.#statements
      .prepare(
        "SELECT id, agent_id, principal_id, last_heartbeat_at FROM tasks WHERE id = ?",
      )
      .get(taskId) as TaskOwnerRow | undefined;
    if (owner === undefined) {
      throw new RuntimeError("TASK_NOT_FOUND", `Unknown task: ${taskId}`, 404);
    }
    if (owner.agent_id !== agentId || owner.principal_id !== principalId) {
      denied("Task session lease does not match the current Task owner.");
    }
    const legacy = input.legacy === true;
    if (legacy && sessionId !== leaseSessionId(taskId, agentId, principalId)) {
      invalid(
        "Legacy Task session identity is not the internal owner binding.",
      );
    }
    const existing = this.#leaseForTouch(taskId, sessionId, legacy);
    if (existing !== undefined) {
      if (
        existing.agent_id !== agentId ||
        existing.principal_id !== principalId
      ) {
        denied(
          "Task session ID is permanently bound to another owner identity.",
        );
      }
      if (existing.closed_at_unix_ms !== null) {
        if (!legacy) {
          denied("Closed Task session leases cannot be reopened.");
        }
      } else {
        if (observedAt <= existing.last_seen_at_unix_ms) return false;
        const update = this.#statements
          .prepare(
            `
            UPDATE ${TASK_SESSION_LEASE_TABLE}
            SET last_seen_at_unix_ms = ?, expires_at_unix_ms = ?
            WHERE task_id = ? AND session_id = ? AND closed_at_unix_ms IS NULL
          `,
          )
          .run(
            observedAt,
            leaseExpiry(observedAt),
            taskId,
            existing.session_id,
          );
        if (update.changes > 0) this.#onChanged();
        return update.changes > 0;
      }
    }
    const count = this.#statements
      .prepare(
        `SELECT COUNT(*) AS value FROM ${TASK_SESSION_LEASE_TABLE} WHERE task_id = ?`,
      )
      .get(taskId) as { readonly value: number };
    if (count.value >= MAX_LEASES_PER_TASK) {
      conflict("Task session lease capacity is exhausted for this Task.");
    }
    const effectiveSessionId =
      existing?.closed_at_unix_ms !== null && existing !== undefined && legacy
        ? identifier(
            `${sessionId}-${count.value + 1}`,
            "Legacy Task session generation",
            MAX_SESSION_ID_LENGTH,
          )
        : sessionId;
    this.#statements
      .prepare(
        `
        INSERT INTO ${TASK_SESSION_LEASE_TABLE} (
          task_id, session_id, agent_id, principal_id,
          created_at_unix_ms, last_seen_at_unix_ms, expires_at_unix_ms,
          closed_at_unix_ms, close_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `,
      )
      .run(
        taskId,
        effectiveSessionId,
        agentId,
        principalId,
        observedAt,
        observedAt,
        leaseExpiry(observedAt),
      );
    this.#onChanged();
    return true;
  }

  renewTask(input: TaskSessionLeaseTouchInput): boolean {
    const taskId = identifier(input.taskId, "Task ID", 128);
    const sessionId = identifier(
      input.sessionId,
      "Task session ID",
      MAX_SESSION_ID_LENGTH,
    );
    const agentId = identifier(
      input.agentId,
      "Task Agent ID",
      MAX_AGENT_ID_LENGTH,
    );
    const principalId = identifier(
      input.principalId,
      "Task principal ID",
      MAX_PRINCIPAL_ID_LENGTH,
    );
    const observedAt = timestamp(input.observedAt);
    const result = this.#statements
      .prepare(
        `
        UPDATE ${TASK_SESSION_LEASE_TABLE}
        SET last_seen_at_unix_ms = ?, expires_at_unix_ms = ?
        WHERE task_id = ?
          AND session_id = ?
          AND agent_id = ?
          AND principal_id = ?
          AND closed_at_unix_ms IS NULL
          AND expires_at_unix_ms > ?
          AND last_seen_at_unix_ms < ?
          AND EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.id = ${TASK_SESSION_LEASE_TABLE}.task_id
              AND t.agent_id = ${TASK_SESSION_LEASE_TABLE}.agent_id
              AND t.principal_id = ${TASK_SESSION_LEASE_TABLE}.principal_id
          )
      `,
      )
      .run(
        observedAt,
        leaseExpiry(observedAt),
        taskId,
        sessionId,
        agentId,
        principalId,
        observedAt,
        observedAt,
      );
    if (result.changes > 0) this.#onChanged();
    return result.changes > 0;
  }

  touchTaskWithoutReopen(input: TaskSessionLeaseTouchInput): boolean {
    const taskId = identifier(input.taskId, "Task ID", 128);
    const sessionId = identifier(
      input.sessionId,
      "Task session ID",
      MAX_SESSION_ID_LENGTH,
    );
    const agentId = identifier(
      input.agentId,
      "Task Agent ID",
      MAX_AGENT_ID_LENGTH,
    );
    const principalId = identifier(
      input.principalId,
      "Task principal ID",
      MAX_PRINCIPAL_ID_LENGTH,
    );
    const observedAt = timestamp(input.observedAt);
    const existing = this.#leaseForTouch(taskId, sessionId, false);
    if (existing === undefined) {
      return this.touchTask({
        taskId,
        sessionId,
        agentId,
        principalId,
        observedAt,
      });
    }
    if (
      existing.agent_id !== agentId ||
      existing.principal_id !== principalId
    ) {
      denied("Task session ID is permanently bound to another owner identity.");
    }
    if (
      existing.closed_at_unix_ms !== null ||
      existing.expires_at_unix_ms <= observedAt
    ) {
      return false;
    }
    return this.renewTask({
      taskId,
      sessionId,
      agentId,
      principalId,
      observedAt,
    });
  }

  hasLiveCurrentSession(
    taskIdValue: string,
    principalIdValue: string,
    sessionIdValue: string,
    observedAtValue?: string | number,
  ): boolean {
    const taskId = identifier(taskIdValue, "Task ID", 128);
    const principalId = identifier(
      principalIdValue,
      "Task principal ID",
      MAX_PRINCIPAL_ID_LENGTH,
    );
    const sessionId = identifier(
      sessionIdValue,
      "Task session ID",
      MAX_SESSION_ID_LENGTH,
    );
    const observedAt = timestamp(observedAtValue);
    return (
      this.#statements
        .prepare(
          `
      SELECT 1 FROM ${TASK_SESSION_LEASE_TABLE} lease
      JOIN tasks task ON task.id = lease.task_id
      WHERE lease.task_id = ? AND lease.principal_id = ? AND lease.session_id = ?
        AND lease.closed_at_unix_ms IS NULL
        AND lease.expires_at_unix_ms > ?
        AND task.agent_id = lease.agent_id AND task.principal_id = lease.principal_id
    `,
        )
        .get(taskId, principalId, sessionId, observedAt) !== undefined
    );
  }

  touchSession(
    principalIdValue: string,
    sessionIdValue: string,
    observedAtValue?: string | number,
  ): readonly string[] {
    const principalId = identifier(
      principalIdValue,
      "Task principal ID",
      MAX_PRINCIPAL_ID_LENGTH,
    );
    const sessionId = identifier(
      sessionIdValue,
      "Task session ID",
      MAX_SESSION_ID_LENGTH,
    );
    const observedAt = timestamp(observedAtValue);
    const taskRows = this.#statements
      .prepare(
        `
        SELECT l.task_id
        FROM ${TASK_SESSION_LEASE_TABLE} l
        JOIN tasks t ON t.id = l.task_id
        WHERE l.principal_id = ?
          AND l.session_id = ?
          AND l.closed_at_unix_ms IS NULL
          AND l.expires_at_unix_ms > ?
          AND t.agent_id = l.agent_id
          AND t.principal_id = l.principal_id
          AND l.last_seen_at_unix_ms < ?
        ORDER BY l.task_id ASC
      `,
      )
      .all(principalId, sessionId, observedAt, observedAt) as unknown as Array<{
      readonly task_id: string;
    }>;
    if (taskRows.length === 0) return [];
    this.#statements
      .prepare(
        `
        UPDATE ${TASK_SESSION_LEASE_TABLE}
        SET last_seen_at_unix_ms = ?, expires_at_unix_ms = ?
        WHERE principal_id = ?
          AND session_id = ?
          AND closed_at_unix_ms IS NULL
          AND expires_at_unix_ms > ?
          AND last_seen_at_unix_ms < ?
          AND EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.id = ${TASK_SESSION_LEASE_TABLE}.task_id
              AND t.agent_id = ${TASK_SESSION_LEASE_TABLE}.agent_id
              AND t.principal_id = ${TASK_SESSION_LEASE_TABLE}.principal_id
          )
      `,
      )
      .run(
        observedAt,
        leaseExpiry(observedAt),
        principalId,
        sessionId,
        observedAt,
        observedAt,
      );
    this.#onChanged();
    return taskRows.map((row) => row.task_id);
  }

  closeSession(input: TaskSessionLeaseCloseInput): readonly string[] {
    const principalId = identifier(
      input.principalId,
      "Task principal ID",
      MAX_PRINCIPAL_ID_LENGTH,
    );
    const sessionId = identifier(
      input.sessionId,
      "Task session ID",
      MAX_SESSION_ID_LENGTH,
    );
    const observedAt = timestamp(input.observedAt);
    const reason = closeReason(input.reason);
    const rows = this.#statements
      .prepare(
        `
        SELECT task_id
        FROM ${TASK_SESSION_LEASE_TABLE}
        WHERE principal_id = ? AND session_id = ? AND closed_at_unix_ms IS NULL
        ORDER BY task_id ASC
      `,
      )
      .all(principalId, sessionId) as unknown as Array<{
      readonly task_id: string;
    }>;
    if (rows.length === 0) return [];
    this.#statements
      .prepare(
        `
        UPDATE ${TASK_SESSION_LEASE_TABLE}
        SET closed_at_unix_ms = MAX(last_seen_at_unix_ms, ?),
            close_reason = ?,
            expires_at_unix_ms = MIN(
              expires_at_unix_ms,
              MAX(last_seen_at_unix_ms, ?)
            )
        WHERE principal_id = ? AND session_id = ? AND closed_at_unix_ms IS NULL
      `,
      )
      .run(observedAt, reason, observedAt, principalId, sessionId);
    this.#onChanged();
    return rows.map((row) => row.task_id);
  }

  closeTaskOwner(
    taskIdValue: string,
    agentIdValue: string,
    principalIdValue: string,
    reasonValue: string,
    observedAtValue?: string | number,
  ): number {
    const taskId = identifier(taskIdValue, "Task ID", 128);
    const agentId = identifier(
      agentIdValue,
      "Task Agent ID",
      MAX_AGENT_ID_LENGTH,
    );
    const principalId = identifier(
      principalIdValue,
      "Task principal ID",
      MAX_PRINCIPAL_ID_LENGTH,
    );
    const observedAt = timestamp(observedAtValue);
    const reason = closeReason(reasonValue);
    const result = this.#statements
      .prepare(
        `
        UPDATE ${TASK_SESSION_LEASE_TABLE}
        SET closed_at_unix_ms = MAX(last_seen_at_unix_ms, ?),
            close_reason = ?,
            expires_at_unix_ms = MIN(
              expires_at_unix_ms,
              MAX(last_seen_at_unix_ms, ?)
            )
        WHERE task_id = ?
          AND agent_id = ?
          AND principal_id = ?
          AND closed_at_unix_ms IS NULL
      `,
      )
      .run(observedAt, reason, observedAt, taskId, agentId, principalId);
    if (result.changes > 0) this.#onChanged();
    return Number(result.changes);
  }

  expiredOwnedTasks(observedAtValue?: string | number): readonly string[] {
    const observedAt = timestamp(observedAtValue);
    const rows = this.#statements
      .prepare(
        `
        SELECT t.id
        FROM tasks t
        WHERE t.agent_id IS NOT NULL
          AND t.principal_id IS NOT NULL
          AND t.status IN ('queued', 'planning', 'running', 'waiting-user')
          AND EXISTS (
            SELECT 1 FROM ${TASK_SESSION_LEASE_TABLE} any_lease
            WHERE any_lease.task_id = t.id
              AND any_lease.agent_id = t.agent_id
              AND any_lease.principal_id = t.principal_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${TASK_SESSION_LEASE_TABLE} live
            WHERE live.task_id = t.id
              AND live.agent_id = t.agent_id
              AND live.principal_id = t.principal_id
              AND live.closed_at_unix_ms IS NULL
              AND live.expires_at_unix_ms > ?
          )
        ORDER BY t.id ASC
      `,
      )
      .all(observedAt) as unknown as Array<{ readonly id: string }>;
    return rows.map((row) => row.id);
  }
}
