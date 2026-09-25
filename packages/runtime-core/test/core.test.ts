import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  MemoryAuditStore,
  PolicyEngine,
  RUN_SCHEMA_VERSION,
  SqliteAuditStore,
  SqliteRunStore,
  buildToolManifest,
  createPrincipal,
  type ToolSpec,
} from "../src/index.js";

const sampleTool: ToolSpec = {
  name: "system.info",
  version: "1.0.0",
  title: "System information",
  description: "Test tool",
  category: "system",
  requiredCapabilities: ["system.read"],
  sideEffect: "read",
  destructive: false,
  permissionLevel: "observe",
  approvalMode: "none",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};

describe("runtime core", () => {
  it("builds a deterministic, versioned manifest digest", () => {
    const first = buildToolManifest("0.1.0", [sampleTool], "2026-08-10T00:00:00.000Z");
    const second = buildToolManifest("0.1.0", [sampleTool], "2026-08-11T00:00:00.000Z");

    expect(first.schemaVersion).toBe("scr.tools/v1");
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest).toBe(second.digest);
  });

  it("denies missing capabilities", () => {
    const policy = new PolicyEngine();
    const principal = createPrincipal("reader", ["files.read"], ["workspace"]);

    expect(() => policy.require(principal, ["files.write"], "workspace")).toThrowError(
      expect.objectContaining({ code: "POLICY_DENIED" }),
    );
  });

  it("persists SQLite audit receipts", () => {
    const store = new SqliteAuditStore(":memory:");
    store.append({
      id: "receipt-1",
      occurredAt: "2026-08-10T00:00:00.000Z",
      principalId: "owner",
      toolName: "files.create",
      operation: "create_text_file",
      outcome: "succeeded",
      workspaceId: "workspace",
      relativePath: "safe\\note.txt",
      afterSha256: "a".repeat(64),
      details: { bytes: 4 },
    });

    expect(store.list(10)).toEqual([
      expect.objectContaining({
        id: "receipt-1",
        outcome: "succeeded",
        relativePath: "safe\\note.txt",
      }),
    ]);
    store.close();
  });

  it("persists and recovers background run records", () => {
    const store = new SqliteRunStore(":memory:");
    store.create({
      schemaVersion: RUN_SCHEMA_VERSION,
      id: "run-1",
      kind: "validation",
      label: "pnpm typecheck",
      workspaceId: "workspace",
      state: "running",
      createdAt: "2026-08-10T00:00:00.000Z",
      startedAt: "2026-08-10T00:00:01.000Z",
      completedAt: null,
      exitCode: null,
      signal: null,
      durationMs: null,
      stdout: "checking",
      stderr: "",
      outputTruncated: false,
      cancelRequested: false,
      metadata: { task: "typecheck" },
    });

    expect(store.get("run-1")).toMatchObject({ state: "running", stdout: "checking" });
    expect(store.interruptActive("2026-08-10T00:00:03.000Z")).toBe(1);
    expect(store.list(10)[0]).toMatchObject({
      id: "run-1",
      state: "interrupted",
      durationMs: 2_000,
    });
    store.close();
  });

  it("migrates legacy run storage and accepts Python runs", () => {
    const root = mkdtempSync(join(tmpdir(), "scr-run-migration-"));
    const databasePath = join(root, "runs.sqlite");
    let database: DatabaseSync | null = new DatabaseSync(databasePath);
    let store: SqliteRunStore | null = null;
    try {
      database.exec(`
        CREATE TABLE runs (
          schema_version TEXT NOT NULL,
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('validation', 'terminal')),
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
      `);
      database.prepare(`
        INSERT INTO runs (
          schema_version, id, kind, label, workspace_id, state, created_at,
          started_at, completed_at, exit_code, signal, duration_ms, stdout,
          stderr, output_truncated, cancel_requested, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        RUN_SCHEMA_VERSION,
        "legacy-run",
        "validation",
        "pnpm test",
        "workspace",
        "succeeded",
        "2026-08-10T00:00:00.000Z",
        "2026-08-10T00:00:00.100Z",
        "2026-08-10T00:00:01.000Z",
        0,
        null,
        900,
        "passed",
        "",
        0,
        0,
        "{}",
      );
      database.close();
      database = null;

      store = new SqliteRunStore(databasePath);
      expect(store.get("legacy-run")).toMatchObject({ kind: "validation", state: "succeeded" });
      store.create({
        schemaVersion: RUN_SCHEMA_VERSION,
        id: "python-run",
        kind: "python",
        label: "Python code",
        workspaceId: "workspace",
        state: "queued",
        createdAt: "2026-08-10T00:00:02.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        signal: null,
        durationMs: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        cancelRequested: false,
        metadata: { mode: "code" },
      });
      expect(store.get("python-run")).toMatchObject({ kind: "python", state: "queued" });
    } finally {
      store?.close();
      database?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes SQLite audit receipts to the configured retention limit", () => {
    const store = new SqliteAuditStore(":memory:", 2);
    for (const [index, id] of ["receipt-1", "receipt-2", "receipt-3"].entries()) {
      store.append({
        id,
        occurredAt: `2026-08-10T00:00:0${index}.000Z`,
        principalId: "owner",
        toolName: "files.create",
        operation: "create_text_file",
        outcome: "succeeded",
        details: {},
      });
    }
    expect(store.list(10).map((receipt) => receipt.id)).toEqual(["receipt-3", "receipt-2"]);
    store.close();
  });

  it("prunes old completed runs while preserving active runs", () => {
    const store = new SqliteRunStore(":memory:", 2);
    const createQueued = (id: string, createdAt: string) => {
      store.create({
        schemaVersion: RUN_SCHEMA_VERSION,
        id,
        kind: "validation",
        label: id,
        workspaceId: "workspace",
        state: "queued",
        createdAt,
        startedAt: null,
        completedAt: null,
        exitCode: null,
        signal: null,
        durationMs: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        cancelRequested: false,
        metadata: {},
      });
    };
    createQueued("active-run", "2026-08-10T00:00:00.000Z");
    for (let index = 1; index <= 3; index += 1) {
      const id = `completed-${index}`;
      const timestamp = `2026-08-10T00:00:0${index}.000Z`;
      createQueued(id, timestamp);
      const queued = store.get(id);
      expect(queued).not.toBeNull();
      store.update({
        ...queued!,
        state: "succeeded",
        completedAt: timestamp,
        exitCode: 0,
      });
    }

    expect(store.get("active-run")).toMatchObject({ state: "queued" });
    expect(store.get("completed-1")).toBeNull();
    expect(store.get("completed-2")).toMatchObject({ state: "succeeded" });
    expect(store.get("completed-3")).toMatchObject({ state: "succeeded" });
    store.close();
  });

  it("keeps the in-memory ledger newest-first", () => {
    const store = new MemoryAuditStore();
    for (const id of ["one", "two"]) {
      store.append({
        id,
        occurredAt: "2026-08-10T00:00:00.000Z",
        principalId: "owner",
        toolName: "files.create",
        operation: "create_text_file",
        outcome: "succeeded",
        details: {},
      });
    }
    expect(store.list(1)[0]?.id).toBe("two");
  });
});
