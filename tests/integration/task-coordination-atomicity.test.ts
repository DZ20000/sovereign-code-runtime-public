import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_TABLE,
} from "../../packages/control-plane/src/task-coordination-store-core.js";
import { TaskRegistry } from "../../packages/control-plane/src/task-registry.js";
import { TASK_SESSION_LEASE_TABLE } from "../../packages/control-plane/src/task-session-leases.js";
import { fixture } from "./task-registry-fixture.js";

function persisted(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return JSON.stringify([
      database.prepare("SELECT * FROM tasks ORDER BY id").all(),
      database.prepare("SELECT * FROM task_projects ORDER BY id").all(),
      database.prepare("SELECT * FROM task_messages ORDER BY id").all(),
      database
        .prepare(
          "SELECT * FROM task_agent_session_leases_v1 ORDER BY task_id, session_id",
        )
        .all(),
    ]);
  } finally {
    database.close();
  }
}

function countRows(
  database: DatabaseSync,
  sql: string,
  ...parameters: SQLInputValue[]
): number {
  const row = database.prepare(sql).get(...parameters) as unknown as {
    readonly value: number;
  };
  return Number(row.value);
}

async function coordinationFixture() {
  const value = await fixture();
  const make = (agent: string, projectRoot = value.workspace) =>
    value.registry.createTask(
      {
        title: agent,
        projectRoot,
        agentId: agent,
        agentName: agent,
        status: "running",
      },
      "principal",
      value.workspace,
      "agent",
      `transport-${agent}`,
    );
  const source = make("source");
  const target = make("target");
  const third = make("third");
  const context = {
    principalId: "principal",
    workspaceRoot: value.workspace,
    sessionId: "transport-source",
  };
  const input = {
    sourceTaskId: source.id,
    sourceSessionId: "source-mailbox",
    sourceAgentId: "source",
    targetTaskId: target.id,
    content: "advisory only",
    idempotencyKey: "operation-one",
  };
  return {
    ...value,
    make,
    source,
    target,
    third,
    context,
    input,
    store: value.registry.coordinationStore(),
  };
}

describe("Task/session transaction boundaries", () => {
  it("keeps logical mailbox sessions from minting Task leases without a trusted transport", async () => {
    const value = await coordinationFixture();
    expect(
      value.registry.closeSession(
        "principal",
        "transport-source",
        "Test transport closed.",
      ),
    ).toEqual([value.source.id]);
    const before = value.registry.requiredTask(value.source.id);
    const database = new DatabaseSync(value.databasePath);
    try {
      const leaseCountBefore = countRows(
        database,
        `SELECT COUNT(*) AS value FROM ${TASK_SESSION_LEASE_TABLE} WHERE task_id = ?`,
        value.source.id,
      );

      const sent = value.store.send(value.input, {
        ...value.context,
        sessionId: null,
      });

      expect(sent.created).toBe(true);
      expect(
        countRows(
          database,
          `SELECT COUNT(*) AS value FROM ${SESSION_TABLE}
           WHERE task_id = ? AND session_id = ?`,
          value.source.id,
          "source-mailbox",
        ),
      ).toBe(1);
      expect(
        countRows(
          database,
          `SELECT COUNT(*) AS value FROM ${TASK_SESSION_LEASE_TABLE} WHERE task_id = ?`,
          value.source.id,
        ),
      ).toBe(leaseCountBefore);
      expect(
        countRows(
          database,
          `SELECT COUNT(*) AS value FROM ${TASK_SESSION_LEASE_TABLE}
           WHERE task_id = ? AND session_id = ?`,
          value.source.id,
          "source-mailbox",
        ),
      ).toBe(0);
      expect(value.registry.requiredTask(value.source.id).agent).toEqual(
        before.agent,
      );
    } finally {
      database.close();
    }
  });

  it("does not treat a supplied legacy-looking transport ID as permission to reopen a closed lease", async () => {
    const { registry, workspace } = await fixture();
    const task = registry.createTask(
      { title: "Exact transport", agentId: "owner", agentName: "Owner" },
      "principal",
      workspace,
      "agent",
      "legacy-supplied-transport",
    );
    registry.closeSession(
      "principal",
      "legacy-supplied-transport",
      "client-delete",
    );
    expect(() =>
      registry.heartbeat(
        { taskId: task.id, agentId: "owner" },
        "principal",
        "legacy-supplied-transport",
      ),
    ).toThrow(/cannot be reopened/iu);
  });

  it("does not attach an unrelated authenticated transport to a formal Task merely by shared principal", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-30T00:00:00.000Z");
    vi.setSystemTime(start);
    const { registry, workspace } = await fixture();
    const task = registry.createTask(
      {
        title: "Offline owner",
        status: "running",
        agentId: "owner",
        agentName: "Owner",
      },
      "principal",
      workspace,
      "agent",
      "owner-transport",
    );
    vi.setSystemTime(start + 301_000);
    const activity = registry.attachActivity({
      principalId: "principal",
      sessionId: "unrelated-transport",
      toolName: "files.read",
      category: "files",
      title: "Unrelated read",
      startedAt: new Date().toISOString(),
      projectRoot: workspace,
    });
    expect(activity.id).not.toBe(task.id);
    expect(activity.source).toBe("inferred");
    expect(registry.requiredTask(task.id)).toMatchObject({
      status: "running",
      lastActivityAt: null,
      agent: { id: "owner", presence: "offline" },
    });
  });

  it("routes activity without a trusted transport into inferred work without touching the sole formal Task", async () => {
    const { registry, workspace, databasePath } = await fixture();
    const task = registry.createTask(
      {
        title: "Sole formal Task",
        status: "running",
        agentId: "owner",
        agentName: "Owner",
      },
      "principal",
      workspace,
      "agent",
      "owner-transport",
    );
    const before = registry.requiredTask(task.id);

    const activity = registry.attachActivity({
      principalId: "principal",
      toolName: "files.read",
      category: "files",
      title: "Transportless read",
      startedAt: new Date(Date.now() + 1_000).toISOString(),
      projectRoot: workspace,
    });

    expect(activity.id).not.toBe(task.id);
    expect(activity.source).toBe("inferred");
    expect(registry.requiredTask(task.id)).toMatchObject({
      lastActivityLabel: before.lastActivityLabel,
      lastActivityAt: before.lastActivityAt,
      agent: before.agent,
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        countRows(
          database,
          `SELECT COUNT(*) AS value FROM ${TASK_SESSION_LEASE_TABLE} WHERE task_id = ?`,
          task.id,
        ),
      ).toBe(1);
      expect(
        countRows(
          database,
          `SELECT COUNT(*) AS value FROM ${TASK_SESSION_LEASE_TABLE}
           WHERE task_id = ? AND session_id GLOB 'legacy-*'`,
          task.id,
        ),
      ).toBe(0);
      expect(
        countRows(
          database,
          `SELECT COUNT(*) AS value FROM ${TASK_SESSION_LEASE_TABLE} WHERE task_id = ?`,
          activity.id,
        ),
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rolls back Task, project, conversation and retention writes when the initial lease is invalid", async () => {
    const { registry, workspace, databasePath } = await fixture();
    const before = persisted(databasePath);
    expect(() =>
      registry.createTask(
        { title: "Atomic create", agentId: "owner", agentName: "Owner" },
        "principal",
        workspace,
        "agent",
        "invalid session",
      ),
    ).toThrow();
    expect(persisted(databasePath)).toBe(before);
  });

  it("does not bind an idempotent creation replay from another Agent to the stored owner", async () => {
    const { registry, workspace, databasePath } = await fixture();
    registry.createTask(
      {
        title: "Owner",
        agentId: "owner",
        agentName: "Owner",
        idempotencyKey: "create-once",
      },
      "principal",
      workspace,
      "agent",
      "owner-transport",
    );
    const before = persisted(databasePath);
    expect(() =>
      registry.createTask(
        {
          title: "Other",
          agentId: "other",
          agentName: "Other",
          idempotencyKey: "create-once",
        },
        "principal",
        workspace,
        "agent",
        "other-transport",
      ),
    ).toThrow();
    expect(persisted(databasePath)).toBe(before);
  });

  it("rolls back ownership transfer and its audit messages when the new owner reuses an old session", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-30T00:00:00.000Z");
    vi.setSystemTime(start);
    const { registry, workspace, databasePath } = await fixture();
    const task = registry.createTask(
      {
        title: "Transfer",
        agentId: "old-owner",
        agentName: "Old",
        status: "running",
      },
      "principal",
      workspace,
      "agent",
      "bound-transport",
    );
    vi.setSystemTime(start + 301_000);
    const before = persisted(databasePath);
    expect(() =>
      registry.claimTask(
        {
          taskId: task.id,
          agentId: "new-owner",
          agentName: "New",
          expectedCurrentAgentId: "old-owner",
        },
        "principal",
        "bound-transport",
      ),
    ).toThrow();
    expect(persisted(databasePath)).toBe(before);
    expect(registry.requiredTask(task.id)).toMatchObject({
      status: "running",
      agent: { id: "old-owner", presence: "offline" },
    });
  });

  it("fences an old Agent message after a newer owner commits before the writer lock", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T08:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { registry: writer, workspace, databasePath } = await fixture();
    const task = writer.createTask(
      {
        title: "Old owner write race",
        status: "running",
        agentId: "old-owner",
        agentName: "Old Owner",
      },
      "principal",
      workspace,
      "agent",
      "old-transport",
    );
    vi.setSystemTime(startedAt + 301_000);
    const claimant = new TaskRegistry({ databasePath });
    const originalExec = DatabaseSync.prototype.exec;
    let intercepted = false;
    let claimedAgentId: string | null = null;
    let afterClaim: string | null = null;
    let writeError: unknown;

    DatabaseSync.prototype.exec = function patchedExec(sql: string): void {
      if (!intercepted && sql.trim().toUpperCase() === "BEGIN IMMEDIATE;") {
        intercepted = true;
        const claimed = claimant.claimTask(
          {
            taskId: task.id,
            agentId: "new-owner",
            agentName: "New Owner",
            expectedCurrentAgentId: "old-owner",
          },
          "principal",
          "new-transport",
        );
        claimedAgentId = claimed.agent.id;
        afterClaim = persisted(databasePath);
      }
      originalExec.call(this, sql);
    };

    try {
      writer.addAgentMessage(
        task.id,
        "Stale old-owner output must not be appended.",
        "assistant",
        "old-owner",
        "Old Owner",
        "principal",
        "old-transport",
      );
    } catch (error) {
      writeError = error;
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      claimant.close();
    }

    expect.soft(intercepted).toBe(true);
    expect.soft(claimedAgentId).toBe("new-owner");
    expect.soft(writeError).toMatchObject({
      name: "RuntimeError",
      code: "POLICY_DENIED",
      status: 403,
      message: "Task message does not match the Task's current Agent owner.",
    });
    expect(afterClaim).not.toBeNull();
    expect(persisted(databasePath)).toBe(afterClaim);
  });
});

describe("Coordination operation boundaries", () => {
  it("rejects delivery to a different project inside the same workspace", async () => {
    const v = await coordinationFixture();
    const nested = join(v.workspace, "other-project");
    await mkdir(nested);
    const other = v.make("other-project-owner", nested);
    expect(() =>
      v.store.send({ ...v.input, targetTaskId: other.id }, v.context),
    ).toThrow();
    expect(
      v.store.pending({ agentId: "other-project-owner" }, v.context)
        .totalPendingMessageCount,
    ).toBe(0);
  });

  it("rejects one source idempotency key reused for another target or a broadcast", async () => {
    const v = await coordinationFixture();
    const first = v.store.send(v.input, v.context);
    expect(() =>
      v.store.send({ ...v.input, targetTaskId: v.third.id }, v.context),
    ).toThrow();
    expect(() =>
      v.store.broadcast(
        { ...v.input, targetTaskIds: [v.target.id, v.third.id] },
        v.context,
      ),
    ).toThrow();
    const outbox = v.store.outbox(
      { taskId: v.source.id, sessionId: "source-mailbox", agentId: "source" },
      v.context,
    );
    expect(outbox.messages.map((message) => message.id)).toEqual([
      first.message.id,
    ]);
  });

  it("rejects an oversized broadcast before committing any messages or cursors", async () => {
    const v = await coordinationFixture();
    const targets = [
      v.target,
      v.third,
      ...Array.from({ length: 30 }, (_, i) => v.make(`extra-${i}`)),
    ];
    const before = persisted(v.databasePath);
    expect(() =>
      v.store.broadcast(
        {
          ...v.input,
          targetTaskIds: targets.map((task) => task.id),
          content: "界".repeat(8_000),
        },
        v.context,
      ),
    ).toThrow(/response size/iu);
    expect(persisted(v.databasePath)).toBe(before);
    expect(
      v.store.pending({ agentId: "target" }, v.context)
        .totalPendingMessageCount,
    ).toBe(0);
    const small = v.store.send(v.input, v.context);
    expect(small.message.recipientSequence).toBe(1);
    expect(small.message.senderSequence).toBe(1);
  });

  it("replays only original broadcast messages after the sender replies within its thread", async () => {
    const v = await coordinationFixture();
    const sent = v.store.broadcast(
      { ...v.input, targetTaskIds: [v.target.id, v.third.id] },
      v.context,
    );
    const first = sent.messages.find(
      (message) => message.recipient.taskId === v.target.id,
    )!;
    const reply = v.store.reply(
      {
        sourceTaskId: v.target.id,
        sourceSessionId: "target-mailbox",
        sourceAgentId: "target",
        replyToMessageId: first.id,
        content: "Received",
        idempotencyKey: "reply-one",
      },
      { ...v.context, sessionId: "transport-target" },
    );
    v.store.reply(
      {
        sourceTaskId: v.source.id,
        sourceSessionId: "source-mailbox",
        sourceAgentId: "source",
        replyToMessageId: reply.message.id,
        content: "Confirmed",
        idempotencyKey: "reply-two",
      },
      v.context,
    );
    const replay = v.store.broadcast(
      { ...v.input, targetTaskIds: [v.target.id, v.third.id] },
      v.context,
    );
    expect(replay.createdCount).toBe(0);
    expect(replay.replayedCount).toBe(2);
    expect(replay.messages.map((message) => message.id)).toEqual(
      sent.messages.map((message) => message.id),
    );
  });
});
