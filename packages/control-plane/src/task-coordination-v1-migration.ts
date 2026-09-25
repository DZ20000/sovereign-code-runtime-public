import type { DatabaseSync } from "node:sqlite";

import { RuntimeError } from "@sovereign/runtime-core";

const V1 = {
  metadata: "task_coordination_v1_metadata",
  sessions: "task_coordination_v1_sessions",
  cursors: "task_coordination_v1_cursors",
  messages: "task_coordination_v1_messages",
  broadcasts: "task_coordination_v1_broadcasts",
} as const;
const V1_SCHEMA = "scr.task-coordination-store/v1";
const MIGRATION_KEY = "legacyV1Migration";
const MIGRATION_SCHEMA = "scr.task-coordination-v1-migration/v1";
const SAVEPOINT = "task_coordination_v1_migration";
const EXPECTED_COLUMNS = new Map<string, readonly string[]>([
  [V1.metadata, ["key", "value"]],
  [
    V1.sessions,
    [
      "task_id",
      "session_id",
      "agent_id",
      "principal_id",
      "created_at",
      "last_seen_at",
    ],
  ],
  [V1.cursors, ["task_id", "next_inbox_sequence", "next_outbox_sequence"]],
  [
    V1.messages,
    [
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
      "recipient_agent_id",
      "recipient_agent_name",
      "recipient_principal_id",
      "content",
      "correlation_id",
      "reply_to_message_id",
      "requires_acknowledgement",
      "request_hash",
      "idempotency_key",
      "created_at",
      "delivered_at",
      "delivered_session_id",
      "read_at",
      "acknowledged_at",
      "replied_at",
    ],
  ],
  [
    V1.broadcasts,
    [
      "sender_task_id",
      "sender_session_id",
      "idempotency_key",
      "request_hash",
      "correlation_id",
      "created_at",
    ],
  ],
]);

export interface TaskCoordinationV2Tables {
  readonly metadata: string;
  readonly sessions: string;
  readonly cursors: string;
  readonly messages: string;
  readonly broadcasts: string;
}

function fail(message: string): never {
  throw new RuntimeError("POLICY_DENIED", message, 409);
}

function q(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    return fail(`Unsafe Task coordination table identifier: ${value}`);
  }
  return `"${value}"`;
}

function exists(database: DatabaseSync, table: string): boolean {
  return (
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(table) !== undefined
  );
}

function scalar(database: DatabaseSync, sql: string): number {
  const value = Number(
    (database.prepare(sql).get() as { readonly value: number }).value,
  );
  if (!Number.isSafeInteger(value) || value < 0) {
    return fail("Legacy Task coordination storage returned an invalid count.");
  }
  return value;
}

function assertLegacySchema(database: DatabaseSync): boolean {
  const present = [...EXPECTED_COLUMNS.keys()].filter((table) =>
    exists(database, table),
  );
  if (present.length === 0) return false;
  if (present.length !== EXPECTED_COLUMNS.size) {
    fail(
      `Legacy Task coordination storage is incomplete: ${present.sort().join(", ")}.`,
    );
  }
  for (const [table, expected] of EXPECTED_COLUMNS) {
    const actual = (
      database.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{
        readonly name: string;
      }>
    ).map((row) => row.name);
    if (
      actual.length !== expected.length ||
      actual.some((name, index) => name !== expected[index])
    ) {
      fail(
        `Legacy Task coordination table ${table} has an incompatible schema.`,
      );
    }
  }
  const version = database
    .prepare(`SELECT value FROM ${q(V1.metadata)} WHERE key = 'schemaVersion'`)
    .get() as { readonly value: string } | undefined;
  if (version?.value !== V1_SCHEMA) {
    fail(
      `Unsupported legacy Task coordination schema: ${version?.value ?? "missing"}.`,
    );
  }
  if (
    scalar(
      database,
      `SELECT COUNT(*) AS value FROM ${q(V1.messages)}
      WHERE length(id) > 96 OR length(correlation_id) > 96`,
    ) > 0
  ) {
    fail("Legacy Task coordination identifiers exceed the migration limit.");
  }
  if (
    scalar(
      database,
      `SELECT COUNT(*) AS value FROM ${q(V1.messages)}
      WHERE recipient_agent_id IS NULL OR recipient_agent_name IS NULL
         OR recipient_principal_id IS NULL`,
    ) > 0
  ) {
    fail("Legacy Task coordination history contains an unowned recipient.");
  }
  return true;
}

function assertNoConflicts(
  database: DatabaseSync,
  target: TaskCoordinationV2Tables,
): void {
  if (
    scalar(
      database,
      `SELECT COUNT(*) AS value FROM ${q(V1.sessions)} legacy
      JOIN ${q(target.sessions)} current
        ON current.task_id = legacy.task_id AND current.session_id = legacy.session_id
      WHERE current.agent_id IS NOT legacy.agent_id
         OR current.principal_id IS NOT legacy.principal_id
         OR current.created_at IS NOT legacy.created_at`,
    ) > 0
  ) {
    fail("Legacy Task coordination sessions conflict with v2 history.");
  }
  if (
    scalar(
      database,
      `SELECT COUNT(*) AS value FROM ${q(V1.messages)} legacy
      JOIN ${q(target.messages)} current ON current.id = legacy.id
      WHERE current.kind IS NOT legacy.kind
         OR current.sender_task_id IS NOT legacy.sender_task_id
         OR current.sender_session_id IS NOT legacy.sender_session_id
         OR current.sender_agent_id IS NOT legacy.sender_agent_id
         OR current.sender_principal_id IS NOT legacy.sender_principal_id
         OR current.recipient_task_id IS NOT legacy.recipient_task_id
         OR current.content IS NOT legacy.content
         OR current.correlation_id IS NOT legacy.correlation_id
         OR current.reply_to_message_id IS NOT legacy.reply_to_message_id
         OR current.requires_acknowledgement IS NOT legacy.requires_acknowledgement
         OR current.created_at IS NOT legacy.created_at`,
    ) > 0
  ) {
    fail("Legacy Task coordination messages conflict with v2 history.");
  }
  if (
    scalar(
      database,
      `SELECT COUNT(*) AS value FROM ${q(V1.messages)} child
      LEFT JOIN ${q(V1.messages)} parent ON parent.id = child.reply_to_message_id
      WHERE child.reply_to_message_id IS NOT NULL
        AND (parent.id IS NULL OR parent.correlation_id IS NOT child.correlation_id)`,
    ) > 0
  ) {
    fail("Legacy Task coordination history contains an invalid reply link.");
  }
  if (
    scalar(
      database,
      `SELECT COUNT(*) AS value FROM ${q(V1.broadcasts)} broadcast
      LEFT JOIN tasks task ON task.id = broadcast.sender_task_id
      WHERE COALESCE((SELECT sender_principal_id FROM ${q(V1.messages)} message
        WHERE message.correlation_id = broadcast.correlation_id
          AND message.sender_task_id = broadcast.sender_task_id
        ORDER BY message.ordinal ASC LIMIT 1), task.principal_id) IS NULL`,
    ) > 0
  ) {
    fail("Legacy Task coordination broadcasts have no sender principal.");
  }
}

export function migrateTaskCoordinationV1(
  database: DatabaseSync,
  target: TaskCoordinationV2Tables,
): boolean {
  database.exec(`SAVEPOINT ${SAVEPOINT}`);
  try {
    if (!assertLegacySchema(database)) {
      database.exec(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return false;
    }
    assertNoConflicts(database, target);
    // Validate combined retained history before importing. Normal v2 mailbox
    // renewals may advance last_seen_at; it is not immutable provenance.
    const projectedMessages = scalar(
      database,
      `
      SELECT (SELECT COUNT(*) FROM ${q(target.messages)}) + COUNT(*) AS value
      FROM ${q(V1.messages)} legacy
      WHERE NOT EXISTS (SELECT 1 FROM ${q(target.messages)} current WHERE current.id = legacy.id)
    `,
    );
    if (projectedMessages > 100_000)
      fail("Legacy coordination exceeds the retained message capacity.");
    for (const table of [V1.sessions, target.sessions]) {
      if (
        scalar(database, `SELECT COUNT(*) AS value FROM ${q(table)}`) >
          128_000 ||
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM (SELECT task_id FROM ${q(table)} GROUP BY task_id HAVING COUNT(*) > 256)`,
        ) > 0
      ) {
        fail("Legacy coordination exceeds the retained session capacity.");
      }
    }
    database.exec(`
      INSERT OR IGNORE INTO ${q(target.sessions)} (
        task_id, session_id, agent_id, principal_id, created_at, last_seen_at
      ) SELECT task_id, session_id, agent_id, principal_id, created_at, last_seen_at
        FROM ${q(V1.sessions)};

      WITH mapped AS (
        SELECT legacy.*,
          COALESCE((SELECT MAX(recipient_sequence) FROM ${q(target.messages)} current
            WHERE current.recipient_task_id = legacy.recipient_task_id), 0)
          + ROW_NUMBER() OVER (PARTITION BY recipient_task_id ORDER BY ordinal)
            AS mapped_recipient_sequence,
          COALESCE((SELECT MAX(sender_sequence) FROM ${q(target.messages)} current
            WHERE current.sender_task_id = legacy.sender_task_id), 0)
          + ROW_NUMBER() OVER (PARTITION BY sender_task_id ORDER BY ordinal)
            AS mapped_sender_sequence
        FROM ${q(V1.messages)} legacy
      )
      INSERT INTO ${q(target.messages)} (
        id, recipient_sequence, sender_sequence, kind,
        sender_task_id, sender_task_title, sender_session_id, sender_agent_id,
        sender_agent_name, sender_principal_id, recipient_task_id,
        recipient_task_title, recipient_task_status, intended_agent_id,
        intended_agent_name, recipient_principal_id, delivered_session_id,
        delivered_agent_id, delivered_agent_name, content, correlation_id,
        reply_to_message_id, requires_acknowledgement, request_hash,
        idempotency_key, created_at, expires_at, delivered_at, read_at,
        acknowledged_at, replied_at, cancelled_at
      )
      SELECT id, mapped_recipient_sequence, mapped_sender_sequence, kind,
        sender_task_id, sender_task_title, sender_session_id, sender_agent_id,
        sender_agent_name, sender_principal_id, recipient_task_id,
        recipient_task_title, recipient_task_status, recipient_agent_id,
        recipient_agent_name, recipient_principal_id, delivered_session_id,
        CASE WHEN delivered_at IS NULL THEN NULL ELSE recipient_agent_id END,
        CASE WHEN delivered_at IS NULL THEN NULL ELSE recipient_agent_name END,
        content, correlation_id, NULL, requires_acknowledgement, request_hash,
        'legacy-v1-message-' || id, created_at, NULL, delivered_at, read_at,
        acknowledged_at, replied_at, NULL
      FROM mapped
      WHERE NOT EXISTS (SELECT 1 FROM ${q(target.messages)} current WHERE current.id = mapped.id);

      UPDATE ${q(target.messages)} AS current
      SET reply_to_message_id = (SELECT reply_to_message_id FROM ${q(V1.messages)} legacy
        WHERE legacy.id = current.id)
      WHERE current.id IN (SELECT id FROM ${q(V1.messages)} WHERE reply_to_message_id IS NOT NULL)
        AND current.reply_to_message_id IS NULL;

      WITH task_ids(task_id) AS (
        SELECT task_id FROM ${q(V1.cursors)}
        UNION SELECT sender_task_id FROM ${q(V1.messages)}
        UNION SELECT recipient_task_id FROM ${q(V1.messages)}
      ), desired AS (
        SELECT task_ids.task_id,
          MAX(COALESCE(legacy.next_inbox_sequence, 1), COALESCE((SELECT MAX(recipient_sequence) + 1
            FROM ${q(target.messages)} message WHERE message.recipient_task_id = task_ids.task_id), 1))
            AS next_inbox_sequence,
          MAX(COALESCE(legacy.next_outbox_sequence, 1), COALESCE((SELECT MAX(sender_sequence) + 1
            FROM ${q(target.messages)} message WHERE message.sender_task_id = task_ids.task_id), 1))
            AS next_outbox_sequence
        FROM task_ids LEFT JOIN ${q(V1.cursors)} legacy ON legacy.task_id = task_ids.task_id
      )
      INSERT INTO ${q(target.cursors)} (task_id, next_inbox_sequence, next_outbox_sequence)
      SELECT task_id, next_inbox_sequence, next_outbox_sequence FROM desired WHERE true
      ON CONFLICT(task_id) DO UPDATE SET
        next_inbox_sequence = MAX(next_inbox_sequence, excluded.next_inbox_sequence),
        next_outbox_sequence = MAX(next_outbox_sequence, excluded.next_outbox_sequence);

      INSERT INTO ${q(target.broadcasts)} (
        sender_task_id, sender_principal_id, idempotency_key,
        request_hash, correlation_id, created_at
      ) SELECT broadcast.sender_task_id,
        COALESCE((SELECT sender_principal_id FROM ${q(V1.messages)} message
          WHERE message.correlation_id = broadcast.correlation_id
            AND message.sender_task_id = broadcast.sender_task_id
          ORDER BY message.ordinal ASC LIMIT 1), task.principal_id),
        'legacy-v1-broadcast-' || broadcast.correlation_id,
        broadcast.request_hash, broadcast.correlation_id, broadcast.created_at
      FROM ${q(V1.broadcasts)} broadcast
      JOIN tasks task ON task.id = broadcast.sender_task_id
      WHERE NOT EXISTS (SELECT 1 FROM ${q(target.broadcasts)} current
        WHERE current.correlation_id = broadcast.correlation_id);
    `);
    const counts = {
      sessions: scalar(
        database,
        `SELECT COUNT(*) AS value FROM ${q(V1.sessions)}`,
      ),
      messages: scalar(
        database,
        `SELECT COUNT(*) AS value FROM ${q(V1.messages)}`,
      ),
      broadcasts: scalar(
        database,
        `SELECT COUNT(*) AS value FROM ${q(V1.broadcasts)}`,
      ),
    };
    database
      .prepare(
        `INSERT INTO ${q(target.metadata)} (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`,
      )
      .run(
        MIGRATION_KEY,
        JSON.stringify({
          schemaVersion: MIGRATION_SCHEMA,
          legacyCounts: counts,
        }),
      );
    assertNoConflicts(database, target);
    database.exec(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return true;
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      database.exec(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    } catch {
      // Preserve the migration error and fail closed.
    }
    throw error;
  }
}
