import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { fixture } from "./task-registry-fixture.js";

interface WorkerResult {
  readonly ok: boolean;
  readonly processId?: number;
  readonly intercepted?: boolean;
  readonly owner?: { readonly id: string | null };
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly stack: string | null;
    readonly code: unknown;
    readonly status: unknown;
  };
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function sourcePath(...parts: string[]): string {
  return resolve(process.cwd(), ...parts).replaceAll("\\", "/");
}

function buildWorker(root: string): string {
  const output = join(root, "task-agent-message-owner-race-worker.mjs");
  execFileSync(
    process.execPath,
    [
      sourcePath("node_modules", "esbuild", "bin", "esbuild"),
      sourcePath(
        "tests",
        "integration",
        "fixtures",
        "task-agent-message-owner-race-worker.ts",
      ),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      "--sourcemap=inline",
      "--log-level=error",
      `--outfile=${output.replaceAll("\\", "/")}`,
      `--alias:@sovereign/control-plane-contract=${sourcePath(
        "packages",
        "control-plane-contract",
        "src",
        "index.ts",
      )}`,
      `--alias:@sovereign/runtime-core=${sourcePath(
        "packages",
        "runtime-core",
        "src",
        "index.ts",
      )}`,
      `--alias:@sovereign/toolkit=${sourcePath(
        "packages",
        "toolkit",
        "src",
        "index.ts",
      )}`,
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  );
  return output;
}

function startWorker(
  bundle: string,
  mode: "writer" | "claimant",
  config: string,
) {
  const child = spawn(process.execPath, [bundle, mode, config], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => {
    stdout += value;
  });
  child.stderr.on("data", (value: string) => {
    stderr += value;
  });
  const completed = new Promise<ChildResult>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for ${mode}: ${stderr}`));
    }, 25_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
  return { child, completed };
}

async function waitForJson<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          await access(path);
        } catch {
          // The writer has not atomically published the file yet.
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

function expireOwnerSession(
  databasePath: string,
  taskId: string,
  sessionId: string,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `
        UPDATE task_agent_session_leases_v1
        SET created_at_unix_ms = 0,
          last_seen_at_unix_ms = 0,
          expires_at_unix_ms = 1
        WHERE task_id = ? AND session_id = ?
      `,
      )
      .run(taskId, sessionId);
    database
      .prepare("UPDATE tasks SET last_heartbeat_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", taskId);
  } finally {
    database.close();
  }
}

function persistedTaskState(databasePath: string, taskId: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return JSON.stringify({
      task: database
        .prepare(
          `
          SELECT id, project_id, status, agent_id, agent_name, principal_id,
            last_heartbeat_at, updated_at
          FROM tasks WHERE id = ?
        `,
        )
        .get(taskId),
      messages: database
        .prepare(
          `
          SELECT id, sequence, role, content, agent_id, agent_name,
            created_at, acknowledged_at
          FROM task_messages
          WHERE task_id = ?
          ORDER BY sequence ASC
        `,
        )
        .all(taskId),
      leases: database
        .prepare(
          `
          SELECT session_id, agent_id, principal_id, created_at_unix_ms,
            last_seen_at_unix_ms, expires_at_unix_ms,
            closed_at_unix_ms, close_reason
          FROM task_agent_session_leases_v1
          WHERE task_id = ?
          ORDER BY created_at_unix_ms ASC, session_id ASC
        `,
        )
        .all(taskId),
    });
  } finally {
    database.close();
  }
}

function leaseRows(databasePath: string, taskId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT session_id, agent_id, closed_at_unix_ms
        FROM task_agent_session_leases_v1
        WHERE task_id = ?
        ORDER BY session_id ASC
      `,
      )
      .all(taskId) as unknown as Array<{
      readonly session_id: string;
      readonly agent_id: string;
      readonly closed_at_unix_ms: number | null;
    }>;
  } finally {
    database.close();
  }
}

function closeChild(child: ChildProcess | undefined): void {
  if (
    child !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    child.kill();
  }
}

describe("Task Agent message owner/session fencing", () => {
  it("fences an old tasks.message.send after a new owner commits first", async () => {
    const value = await fixture();
    const task = value.registry.createTask(
      {
        title: "Owner transfer race",
        status: "running",
        agentId: "old-owner",
        agentName: "Old Owner",
      },
      "principal",
      value.workspace,
      "agent",
      "old-transport",
    );
    expireOwnerSession(value.databasePath, task.id, "old-transport");
    value.registry.close();

    const bundle = buildWorker(value.root);
    const readyPath = join(value.root, "old-writer-ready.json");
    const releasePath = join(value.root, "release-old-writer");
    const writerResultPath = join(value.root, "old-writer-result.json");
    const claimantResultPath = join(value.root, "new-owner-result.json");
    const configPath = join(value.root, "race-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        databasePath: value.databasePath,
        workspaceRoot: value.workspace,
        taskId: task.id,
        principalId: "principal",
        oldAgentId: "old-owner",
        oldAgentName: "Old Owner",
        oldSessionId: "old-transport",
        newAgentId: "new-owner",
        newAgentName: "New Owner",
        newSessionId: "new-transport",
        readyPath,
        releasePath,
        writerResultPath,
        claimantResultPath,
      }),
      { encoding: "utf8", flag: "wx" },
    );

    let writer: ReturnType<typeof startWorker> | undefined;
    let claimant: ReturnType<typeof startWorker> | undefined;
    try {
      writer = startWorker(bundle, "writer", configPath);
      const ready = await waitForJson<{
        readonly processId: number;
        readonly stage: string;
        readonly sql: string;
      }>(readyPath);
      expect(ready).toEqual({
        processId: expect.any(Number),
        stage: "old-owner-before-write-transaction",
        sql: "BEGIN IMMEDIATE;",
      });

      claimant = startWorker(bundle, "claimant", configPath);
      const claimantExit = await claimant.completed;
      expect(claimantExit).toMatchObject({ code: 0, signal: null });
      expect(claimantExit.stderr).toBe("");
      const claimed = await waitForJson<WorkerResult>(claimantResultPath);
      expect(claimed).toMatchObject({
        ok: true,
        processId: expect.any(Number),
        owner: { id: "new-owner" },
      });
      expect(claimed.processId).not.toBe(ready.processId);
      const leases = leaseRows(value.databasePath, task.id);
      expect(leases).toEqual([
        expect.objectContaining({
          session_id: "new-transport",
          agent_id: "new-owner",
          closed_at_unix_ms: null,
        }),
        expect.objectContaining({
          session_id: "old-transport",
          agent_id: "old-owner",
          closed_at_unix_ms: expect.any(Number),
        }),
      ]);
      const afterClaim = persistedTaskState(value.databasePath, task.id);

      await writeFile(releasePath, "release\n", {
        encoding: "utf8",
        flag: "wx",
      });
      const writerExit = await writer.completed;
      expect(writerExit).toMatchObject({ code: 0, signal: null });
      expect(writerExit.stderr).toBe("");
      const oldWriter = await waitForJson<WorkerResult>(writerResultPath);
      expect(oldWriter).toMatchObject({
        ok: false,
        processId: ready.processId,
        intercepted: true,
        error: {
          name: "RuntimeError",
          code: "POLICY_DENIED",
          status: 403,
          message:
            "Task message does not match the Task's current Agent owner.",
        },
      });
      expect(persistedTaskState(value.databasePath, task.id)).toBe(afterClaim);
    } finally {
      try {
        await writeFile(releasePath, "cleanup-release\n", {
          encoding: "utf8",
          flag: "wx",
        });
      } catch {
        // The expected release already exists.
      }
      closeChild(writer?.child);
      closeChild(claimant?.child);
    }
  });
});
