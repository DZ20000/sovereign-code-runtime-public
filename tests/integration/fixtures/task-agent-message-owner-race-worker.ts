import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createTaskGatewayToolDefinitions } from "../../../packages/control-plane/src/task-gateway-integration.js";
import { TaskRegistry } from "../../../packages/control-plane/src/task-registry.js";

interface RaceConfig {
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly taskId: string;
  readonly principalId: string;
  readonly oldAgentId: string;
  readonly oldAgentName: string;
  readonly oldSessionId: string;
  readonly newAgentId: string;
  readonly newAgentName: string;
  readonly newSessionId: string;
  readonly readyPath: string;
  readonly releasePath: string;
  readonly writerResultPath: string;
  readonly claimantResultPath: string;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function serializedError(error: unknown) {
  const value = error as {
    readonly name?: unknown;
    readonly message?: unknown;
    readonly stack?: unknown;
    readonly code?: unknown;
    readonly status?: unknown;
  };
  return {
    name: typeof value?.name === "string" ? value.name : "Error",
    message: typeof value?.message === "string" ? value.message : String(error),
    stack: typeof value?.stack === "string" ? value.stack : null,
    code: value?.code ?? null,
    status: value?.status ?? null,
  };
}

function waitForRelease(path: string): void {
  const deadline = Date.now() + 20_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the deterministic race release.");
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

async function runWriter(config: RaceConfig): Promise<void> {
  const originalExec = DatabaseSync.prototype.exec;
  let armed = false;
  let intercepted = false;
  DatabaseSync.prototype.exec = function patchedExec(sql: string): void {
    if (
      armed &&
      !intercepted &&
      sql.trim().toUpperCase() === "BEGIN IMMEDIATE;"
    ) {
      intercepted = true;
      writeJson(config.readyPath, {
        processId: process.pid,
        stage: "old-owner-before-write-transaction",
        sql: sql.trim(),
      });
      waitForRelease(config.releasePath);
    }
    originalExec.call(this, sql);
  };

  const registry = new TaskRegistry({ databasePath: config.databasePath });
  try {
    const tool = createTaskGatewayToolDefinitions(
      registry,
      config.workspaceRoot,
      "desktop-workspace",
    ).find((definition) => definition.spec.name === "tasks.message.send");
    if (tool === undefined)
      throw new Error("tasks.message.send is unavailable.");
    armed = true;
    try {
      const detail = (await tool.execute(
        {
          principal: { id: config.principalId },
          sessionId: config.oldSessionId,
        } as never,
        tool.parse({
          taskId: config.taskId,
          content: "Stale old-owner message must be fenced.",
          agentId: config.oldAgentId,
          agentName: config.oldAgentName,
        }),
      )) as { readonly task?: { readonly messageCount?: number } };
      writeJson(config.writerResultPath, {
        ok: true,
        processId: process.pid,
        intercepted,
        messageCount: detail.task?.messageCount ?? null,
      });
    } catch (error) {
      writeJson(config.writerResultPath, {
        ok: false,
        processId: process.pid,
        intercepted,
        error: serializedError(error),
      });
    }
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    registry.close();
  }
}

function runClaimant(config: RaceConfig): void {
  const registry = new TaskRegistry({ databasePath: config.databasePath });
  try {
    const claimed = registry.claimTask(
      {
        taskId: config.taskId,
        agentId: config.newAgentId,
        agentName: config.newAgentName,
        expectedCurrentAgentId: config.oldAgentId,
      },
      config.principalId,
      config.newSessionId,
    );
    writeJson(config.claimantResultPath, {
      ok: true,
      processId: process.pid,
      owner: claimed.agent,
    });
  } catch (error) {
    writeJson(config.claimantResultPath, {
      ok: false,
      processId: process.pid,
      error: serializedError(error),
    });
    process.exitCode = 2;
  } finally {
    registry.close();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const configPath = process.argv[3];
  if ((mode !== "writer" && mode !== "claimant") || configPath === undefined) {
    throw new Error("Expected writer|claimant and one configuration path.");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as RaceConfig;
  if (mode === "writer") await runWriter(config);
  else runClaimant(config);
}

await main();
