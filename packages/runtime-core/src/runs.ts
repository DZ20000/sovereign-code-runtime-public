import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const RUN_SCHEMA_VERSION = "scr.run/v1" as const;

export type RunKind = "validation" | "terminal" | "python" | "workflow";
export type RunState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "interrupted";

export interface RunRecord {
  readonly schemaVersion: typeof RUN_SCHEMA_VERSION;
  readonly id: string;
  readonly kind: RunKind;
  readonly label: string;
  readonly workspaceId: string;
  readonly state: RunState;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly cancelRequested: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RunSummary extends Omit<RunRecord, "stdout" | "stderr"> {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export function summarizeRun(run: RunRecord): RunSummary {
  const { stdout, stderr, ...summary } = run;
  return {
    ...summary,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
  };
}

export interface RunStore {
  create(run: RunRecord): void;
  update(run: RunRecord): void;
  get(runId: string): RunRecord | null;
  list(limit?: number, workspaceId?: string): readonly RunRecord[];
  interruptActive(completedAt?: string): number;
  close?(): void;
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(limit, 1_000));
}

function durationBetween(startedAt: string | null, completedAt: string): number | null {
  if (startedAt === null) {
    return null;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function cloneRun(run: RunRecord): RunRecord {
  return {
    ...run,
    metadata: { ...run.metadata },
  };
}

export class MemoryRunStore implements RunStore {
  readonly #runs = new Map<string, RunRecord>();

  create(run: RunRecord): void {
    if (this.#runs.has(run.id)) {
      throw new Error(`Run already exists: ${run.id}`);
    }
    this.#runs.set(run.id, cloneRun(run));
  }

  update(run: RunRecord): void {
    if (!this.#runs.has(run.id)) {
      throw new Error(`Run does not exist: ${run.id}`);
    }
    this.#runs.set(run.id, cloneRun(run));
  }

  get(runId: string): RunRecord | null {
    const run = this.#runs.get(runId);
    return run === undefined ? null : cloneRun(run);
  }

  list(limit = 100, workspaceId?: string): readonly RunRecord[] {
    return [...this.#runs.values()]
      .filter((run) => workspaceId === undefined || run.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, boundedLimit(limit))
      .map((run) => cloneRun(run));
  }

  interruptActive(completedAt = new Date().toISOString()): number {
    let count = 0;
    for (const run of this.#runs.values()) {
      if (run.state !== "queued" && run.state !== "running") {
        continue;
      }
      this.#runs.set(run.id, {
        ...run,
        state: "interrupted",
        completedAt,
        durationMs: durationBetween(run.startedAt, completedAt),
        cancelRequested: false,
      });
      count += 1;
    }
    return count;
  }
}

interface SqliteRunRow {
  readonly schema_version: typeof RUN_SCHEMA_VERSION;
  readonly id: string;
  readonly kind: RunKind;
  readonly label: string;
  readonly workspace_id: string;
  readonly state: RunState;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly duration_ms: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly output_truncated: number;
  readonly cancel_requested: number;
  readonly metadata_json: string;
}

function parseMetadata(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Readonly<Record<string, unknown>>;
    }
  } catch {
    // Historical metadata should never make the run ledger unreadable.
  }
  return {};
}

function runFromRow(row: SqliteRunRow): RunRecord {
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    kind: row.kind,
    label: row.label,
    workspaceId: row.workspace_id,
    state: row.state,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    exitCode: row.exit_code,
    signal: row.signal,
    durationMs: row.duration_ms,
    stdout: row.stdout,
    stderr: row.stderr,
    outputTruncated: row.output_truncated === 1,
    cancelRequested: row.cancel_requested === 1,
    metadata: parseMetadata(row.metadata_json),
  };
}

const RUN_COLUMNS = `
  schema_version,
  id,
  kind,
  label,
  workspace_id,
  state,
  created_at,
  started_at,
  completed_at,
  exit_code,
  signal,
  duration_ms,
  stdout,
  stderr,
  output_truncated,
  cancel_requested,
  metadata_json
`;

interface SqliteSchemaRow {
  readonly sql: string | null;
}

function createRunSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      schema_version TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('validation', 'terminal', 'python', 'workflow')),
      label TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed-out', 'interrupted')
      ),
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      exit_code INTEGER,
      signal TEXT,
      duration_ms INTEGER,
      stdout TEXT NOT NULL,
      stderr TEXT NOT NULL,
      output_truncated INTEGER NOT NULL CHECK (output_truncated IN (0, 1)),
      cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
      metadata_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_created_at_idx
      ON runs (created_at DESC);
    CREATE INDEX IF NOT EXISTS runs_workspace_state_idx
      ON runs (workspace_id, state, created_at DESC);
  `);
}

function migrateLegacyRunKindConstraint(database: DatabaseSync): void {
  const existing = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
    .get() as unknown as SqliteSchemaRow | undefined;
  if (existing === undefined || existing.sql === null || existing.sql.includes("'workflow'")) {
    return;
  }

  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      DROP INDEX IF EXISTS runs_created_at_idx;
      DROP INDEX IF EXISTS runs_workspace_state_idx;
      ALTER TABLE runs RENAME TO runs_legacy_kind_v1;
      CREATE TABLE runs (
        schema_version TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('validation', 'terminal', 'python', 'workflow')),
        label TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed-out', 'interrupted')
        ),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        duration_ms INTEGER,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        output_truncated INTEGER NOT NULL CHECK (output_truncated IN (0, 1)),
        cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
        metadata_json TEXT NOT NULL
      );
      INSERT INTO runs (${RUN_COLUMNS})
        SELECT ${RUN_COLUMNS} FROM runs_legacy_kind_v1;
      DROP TABLE runs_legacy_kind_v1;
      CREATE INDEX runs_created_at_idx
        ON runs (created_at DESC);
      CREATE INDEX runs_workspace_state_idx
        ON runs (workspace_id, state, created_at DESC);
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

export class SqliteRunStore implements RunStore {
  readonly #database: DatabaseSync;
  readonly #completedRetentionLimit: number;

  constructor(databasePath: string, completedRetentionLimit = 2_000) {
    if (!Number.isInteger(completedRetentionLimit) || completedRetentionLimit < 1) {
      throw new Error("Completed-run retention limit must be a positive integer.");
    }
    this.#completedRetentionLimit = completedRetentionLimit;
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    if (databasePath !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
    }
    createRunSchema(this.#database);
    migrateLegacyRunKindConstraint(this.#database);
  }

  create(run: RunRecord): void {
    this.#database
      .prepare(`
        INSERT INTO runs (${RUN_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.schemaVersion,
        run.id,
        run.kind,
        run.label,
        run.workspaceId,
        run.state,
        run.createdAt,
        run.startedAt,
        run.completedAt,
        run.exitCode,
        run.signal,
        run.durationMs,
        run.stdout,
        run.stderr,
        run.outputTruncated ? 1 : 0,
        run.cancelRequested ? 1 : 0,
        JSON.stringify(run.metadata),
      );
  }

  update(run: RunRecord): void {
    const result = this.#database
      .prepare(`
        UPDATE runs SET
          schema_version = ?,
          kind = ?,
          label = ?,
          workspace_id = ?,
          state = ?,
          created_at = ?,
          started_at = ?,
          completed_at = ?,
          exit_code = ?,
          signal = ?,
          duration_ms = ?,
          stdout = ?,
          stderr = ?,
          output_truncated = ?,
          cancel_requested = ?,
          metadata_json = ?
        WHERE id = ?
      `)
      .run(
        run.schemaVersion,
        run.kind,
        run.label,
        run.workspaceId,
        run.state,
        run.createdAt,
        run.startedAt,
        run.completedAt,
        run.exitCode,
        run.signal,
        run.durationMs,
        run.stdout,
        run.stderr,
        run.outputTruncated ? 1 : 0,
        run.cancelRequested ? 1 : 0,
        JSON.stringify(run.metadata),
        run.id,
      );
    if (result.changes !== 1) {
      throw new Error(`Run does not exist: ${run.id}`);
    }
    if (run.state !== "queued" && run.state !== "running") {
      this.#database
        .prepare(`
          DELETE FROM runs
          WHERE id IN (
            SELECT id FROM runs
            WHERE state NOT IN ('queued', 'running')
            ORDER BY created_at DESC
            LIMIT -1 OFFSET ?
          )
        `)
        .run(this.#completedRetentionLimit);
    }
  }

  get(runId: string): RunRecord | null {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`)
      .get(runId) as unknown as SqliteRunRow | undefined;
    return row === undefined ? null : runFromRow(row);
  }

  list(limit = 100, workspaceId?: string): readonly RunRecord[] {
    const rows = (workspaceId === undefined
      ? this.#database.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at DESC LIMIT ?`)
        .all(boundedLimit(limit))
      : this.#database.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(workspaceId, boundedLimit(limit))) as unknown as SqliteRunRow[];
    return rows.map((row) => runFromRow(row));
  }

  interruptActive(completedAt = new Date().toISOString()): number {
    const active = this.#database
      .prepare(`
        SELECT ${RUN_COLUMNS}
        FROM runs
        WHERE state IN ('queued', 'running')
      `)
      .all() as unknown as SqliteRunRow[];
    for (const row of active) {
      const run = runFromRow(row);
      this.update({
        ...run,
        state: "interrupted",
        completedAt,
        durationMs: durationBetween(run.startedAt, completedAt),
        cancelRequested: false,
      });
    }
    return active.length;
  }

  close(): void {
    this.#database.close();
  }
}
