import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskRegistry } from "../../packages/control-plane/src/task-registry.js";
import type { TaskCoordinationStore } from "../../packages/control-plane/src/task-coordination-store.js";
import { createTaskCoordinationTools } from "../../packages/control-plane/src/task-coordination-tools.js";
import {
  TASK_SESSION_LEASE_TTL_MS,
  TaskSessionLeaseStore,
} from "../../packages/control-plane/src/task-session-leases.js";

const cleanup: string[] = [];
const openRegistries: TaskRegistry[] = [];

function track(registry: TaskRegistry): TaskRegistry {
  openRegistries.push(registry);
  return registry;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const registry of openRegistries.splice(0)) {
    try {
      registry.close();
    } catch {
      // Individual tests may close a registry before reopening its database.
    }
  }
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      }),
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-task-session-leases-"));
  cleanup.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const databasePath = join(root, "tasks.sqlite");
  const registry = track(new TaskRegistry({ databasePath }));
  return { workspace, databasePath, registry };
}

function ownerHeartbeat(databasePath: string, taskId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    return database
      .prepare(
        "SELECT agent_id, principal_id, last_heartbeat_at FROM tasks WHERE id = ?",
      )
      .get(taskId) as {
      readonly agent_id: string | null;
      readonly principal_id: string | null;
      readonly last_heartbeat_at: string | null;
    };
  } finally {
    database.close();
  }
}

function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA schema_version").get() as unknown as {
    readonly schema_version: number;
  };
  return Number(row.schema_version);
}

interface LeaseState {
  readonly last_seen_at_unix_ms: number;
  readonly expires_at_unix_ms: number;
  readonly closed_at_unix_ms: number | null;
}

function leaseState(
  databasePath: string,
  taskId: string,
  sessionId: string,
): LeaseState {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT last_seen_at_unix_ms, expires_at_unix_ms, closed_at_unix_ms
        FROM task_agent_session_leases_v1
        WHERE task_id = ? AND session_id = ?
      `,
      )
      .get(taskId, sessionId) as LeaseState | undefined;
    expect(row).toBeDefined();
    return row!;
  } finally {
    database.close();
  }
}

describe("task session leases", () => {
  it("keeps TaskRegistry schema initialization DDL-idempotent and repairs lease drift", async () => {
    const { databasePath, registry } = await fixture();
    registry.close();
    const beforeDatabase = new DatabaseSync(databasePath);
    const before = schemaVersion(beforeDatabase);
    beforeDatabase.close();

    const reopened = track(new TaskRegistry({ databasePath }));
    reopened.close();

    const database = new DatabaseSync(databasePath);
    try {
      expect(schemaVersion(database)).toBe(before);

      database.exec(`
        DROP INDEX idx_task_session_leases_session;
        CREATE INDEX idx_task_session_leases_session
        ON task_agent_session_leases_v1 (task_id);
      `);
      new TaskSessionLeaseStore(database);
      const columns = database
        .prepare("PRAGMA index_info(idx_task_session_leases_session)")
        .all() as unknown as Array<{ readonly name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "principal_id",
        "session_id",
        "closed_at_unix_ms",
        "expires_at_unix_ms",
      ]);
    } finally {
      database.close();
    }
  });

  it("does not revive expired leases through passive session, activity, or Agent message paths", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T05:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, databasePath, registry } = await fixture();
    const sessionTask = registry.createTask(
      {
        title: "Passive session activity",
        status: "running",
        agentId: "session-agent",
        agentName: "Session Agent",
      },
      "principal-session",
      workspace,
      "agent",
      "passive-session",
    );
    const activityTask = registry.createTask(
      {
        title: "Passive tool activity",
        status: "running",
        agentId: "activity-agent",
        agentName: "Activity Agent",
      },
      "principal-activity",
      workspace,
      "agent",
      "passive-activity",
    );
    const messageTask = registry.createTask(
      {
        title: "Passive Agent message",
        status: "running",
        agentId: "message-agent",
        agentName: "Message Agent",
      },
      "principal-message",
      workspace,
      "agent",
      "passive-message",
    );
    const inferredTask = registry.createTask(
      {
        title: "Passive inferred reopening",
        status: "blocked",
        agentId: "principal-inferred",
        agentName: "ChatGPT Agent",
        idempotencyKey: "inferred:principal-inferred",
      },
      "principal-inferred",
      workspace,
      "inferred",
      "passive-inferred",
    );
    const before = {
      session: leaseState(databasePath, sessionTask.id, "passive-session"),
      activity: leaseState(databasePath, activityTask.id, "passive-activity"),
      message: leaseState(databasePath, messageTask.id, "passive-message"),
      inferred: leaseState(databasePath, inferredTask.id, "passive-inferred"),
    };
    const messageCountBefore = messageTask.messageCount;

    vi.setSystemTime(startedAt + TASK_SESSION_LEASE_TTL_MS + 1_000);
    const observedAt = new Date().toISOString();
    const touched = registry.touchSessionActivity(
      "principal-session",
      "passive-session",
      observedAt,
    );
    const activity = registry.attachActivity({
      principalId: "principal-activity",
      sessionId: "passive-activity",
      toolName: "files.read",
      category: "files",
      title: "Expired transport read",
      startedAt: observedAt,
      projectRoot: workspace,
    });
    const reopenedInferred = registry.attachActivity({
      principalId: "principal-inferred",
      sessionId: "passive-inferred",
      toolName: "files.read",
      category: "files",
      title: "Expired inferred transport read",
      startedAt: observedAt,
      projectRoot: workspace,
    });
    expect(() =>
      registry.addAgentMessage(
        messageTask.id,
        "Operator-visible output remains independent from presence recovery.",
        "assistant",
        "message-agent",
        "Message Agent",
        "principal-message",
        "passive-message",
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "RuntimeError",
        code: "POLICY_DENIED",
        status: 403,
        message: "Task message requires a live current-owner session.",
      }),
    );

    expect.soft(touched).toEqual([]);
    expect.soft(activity.id).not.toBe(activityTask.id);
    expect.soft(activity.source).toBe("inferred");
    expect.soft(reopenedInferred.id).toBe(inferredTask.id);
    expect.soft(reopenedInferred.source).toBe("inferred");
    expect.soft(leaseState(databasePath, sessionTask.id, "passive-session")).toEqual(
      before.session,
    );
    expect.soft(leaseState(databasePath, activityTask.id, "passive-activity")).toEqual(
      before.activity,
    );
    expect.soft(leaseState(databasePath, messageTask.id, "passive-message")).toEqual(
      before.message,
    );
    expect.soft(leaseState(databasePath, inferredTask.id, "passive-inferred")).toEqual(
      before.inferred,
    );
    expect(registry.requiredTask(messageTask.id).messageCount).toBe(
      messageCountBefore,
    );
  });

  it("lets an owner message bind a previously unseen trusted transport", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T05:30:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, databasePath, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Fresh message transport",
        status: "running",
        agentId: "message-binding-agent",
        agentName: "Message Binding Agent",
      },
      "principal-message-binding",
      workspace,
      "agent",
      "initial-message-transport",
    );

    const observedAt = startedAt + 1_000;
    vi.setSystemTime(observedAt);
    registry.addAgentMessage(
      task.id,
      "The new trusted transport may establish its first owner binding.",
      "assistant",
      "message-binding-agent",
      "Message Binding Agent",
      "principal-message-binding",
      "fresh-message-transport",
    );

    expect(leaseState(databasePath, task.id, "fresh-message-transport")).toMatchObject({
      last_seen_at_unix_ms: observedAt,
      expires_at_unix_ms: observedAt + TASK_SESSION_LEASE_TTL_MS,
      closed_at_unix_ms: null,
    });
  });

  it("accepts an exact live owner session at the same timestamp", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T05:45:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, databasePath, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Same-timestamp owner message",
        status: "running",
        agentId: "same-time-agent",
        agentName: "Same Time Agent",
      },
      "principal-same-time",
      workspace,
      "agent",
      "same-time-transport",
    );
    const before = leaseState(databasePath, task.id, "same-time-transport");

    const detail = registry.addAgentMessage(
      task.id,
      "The live exact binding remains valid without advancing its timestamp.",
      "assistant",
      "same-time-agent",
      "Same Time Agent",
      "principal-same-time",
      "same-time-transport",
    );

    expect(detail.messages.at(-1)).toMatchObject({
      content:
        "The live exact binding remains valid without advancing its timestamp.",
      agentId: "same-time-agent",
    });
    expect(leaseState(databasePath, task.id, "same-time-transport")).toEqual(before);
  });

  it("keeps terminal owner corrections independent from closed transport presence", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T05:50:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, databasePath, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Terminal owner correction",
        status: "running",
        agentId: "terminal-agent",
        agentName: "Terminal Agent",
      },
      "principal-terminal",
      workspace,
      "agent",
      "terminal-transport",
    );

    vi.setSystemTime(startedAt + 1_000);
    const completed = registry.updateTask(
      {
        taskId: task.id,
        agentId: "terminal-agent",
        status: "succeeded",
      },
      "principal-terminal",
      "terminal-transport",
    );
    expect(completed.completedAt).not.toBeNull();

    vi.setSystemTime(startedAt + 2_000);
    expect(
      registry.closeSession(
        "principal-terminal",
        "terminal-transport",
        "Transport closed after workflow completion.",
      ),
    ).toEqual([task.id]);
    const closedLease = leaseState(
      databasePath,
      task.id,
      "terminal-transport",
    );
    expect(closedLease.closed_at_unix_ms).not.toBeNull();

    vi.setSystemTime(startedAt + 3_000);
    const detail = registry.addAgentMessage(
      task.id,
      "A final correction remains visible without reviving presence.",
      "assistant",
      "terminal-agent",
      "Terminal Agent",
      "principal-terminal",
      "terminal-transport",
    );

    expect(detail.messages.at(-1)).toMatchObject({
      role: "assistant",
      agentId: "terminal-agent",
      content: "A final correction remains visible without reviving presence.",
    });
    expect(detail.task).toMatchObject({
      status: "succeeded",
      completedAt: completed.completedAt,
      agent: { presence: "offline" },
    });
    expect(leaseState(databasePath, task.id, "terminal-transport")).toEqual(
      closedLease,
    );
  });

  it("keeps explicit heartbeat recovery semantics for an expired open lease", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T06:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, databasePath, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Explicit recovery",
        status: "running",
        agentId: "recovery-agent",
        agentName: "Recovery Agent",
      },
      "principal-recovery",
      workspace,
      "agent",
      "recovery-session",
    );

    const recoveredAt = startedAt + TASK_SESSION_LEASE_TTL_MS + 1_000;
    vi.setSystemTime(recoveredAt);
    const heartbeat = registry.heartbeat(
      { taskId: task.id, agentId: "recovery-agent" },
      "principal-recovery",
      "recovery-session",
    );

    expect(heartbeat.task.agent.presence).toBe("online");
    expect(leaseState(databasePath, task.id, "recovery-session")).toMatchObject({
      last_seen_at_unix_ms: recoveredAt,
      expires_at_unix_ms: recoveredAt + TASK_SESSION_LEASE_TTL_MS,
      closed_at_unix_ms: null,
    });
  });

  it("keeps workflow state independent from exact session closure and renewal", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, registry } = await fixture();
    const legacyWorkflowStep = "All authenticated Agent sessions expired.";
    const task = registry.createTask(
      {
        title: "Independent session lease",
        status: "blocked",
        currentStep: legacyWorkflowStep,
        progressCurrent: 2,
        progressTotal: 5,
        agentId: "lease-agent",
        agentName: "Lease Agent",
      },
      "chatgpt-web",
      workspace,
      "agent",
      "transport-one",
    );

    vi.setSystemTime(startedAt + 1_000);
    registry.claimTask(
      {
        taskId: task.id,
        agentId: "lease-agent",
        agentName: "Lease Agent",
        expectedCurrentAgentId: "lease-agent",
      },
      "chatgpt-web",
      "transport-two",
    );

    vi.setSystemTime(startedAt + 2_000);
    expect(
      registry.closeSession("chatgpt-web", "transport-one", "transport closed"),
    ).toEqual([task.id]);
    expect(registry.requiredTask(task.id)).toMatchObject({
      status: "blocked",
      currentStep: legacyWorkflowStep,
      progress: { current: 2, total: 5 },
      agent: {
        id: "lease-agent",
        principalId: "chatgpt-web",
        presence: "online",
      },
    });

    vi.setSystemTime(startedAt + 3_000);
    expect(
      registry.closeSession("chatgpt-web", "transport-two", "transport closed"),
    ).toEqual([task.id]);
    expect(registry.requiredTask(task.id)).toMatchObject({
      status: "blocked",
      currentStep: legacyWorkflowStep,
      progress: { current: 2, total: 5 },
      agent: {
        id: "lease-agent",
        principalId: "chatgpt-web",
        presence: "offline",
      },
    });

    vi.setSystemTime(startedAt + 4_000);
    const heartbeat = registry.heartbeat(
      { taskId: task.id, agentId: "lease-agent" },
      "chatgpt-web",
      "transport-three",
    );
    expect(heartbeat.task).toMatchObject({
      status: "blocked",
      currentStep: legacyWorkflowStep,
      progress: { current: 2, total: 5 },
      agent: {
        id: "lease-agent",
        principalId: "chatgpt-web",
        presence: "online",
      },
    });
  });

  it("renews only the exact transport session and persists leases across restart", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T01:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, databasePath, registry } = await fixture();
    const first = registry.createTask(
      {
        title: "Renewed session",
        status: "running",
        agentId: "first-agent",
        agentName: "First Agent",
      },
      "chatgpt-web",
      workspace,
      "agent",
      "transport-first",
    );
    const second = registry.createTask(
      {
        title: "Expired session",
        status: "running",
        agentId: "second-agent",
        agentName: "Second Agent",
      },
      "chatgpt-web",
      workspace,
      "agent",
      "transport-second",
    );

    vi.setSystemTime(startedAt + TASK_SESSION_LEASE_TTL_MS - 10_000);
    expect(
      registry.touchSessionActivity("chatgpt-web", "transport-first"),
    ).toEqual([first.id]);

    vi.setSystemTime(startedAt + TASK_SESSION_LEASE_TTL_MS + 10_000);
    expect(registry.requiredTask(first.id)).toMatchObject({
      status: "running",
      agent: {
        id: "first-agent",
        principalId: "chatgpt-web",
        presence: "online",
      },
    });
    expect(registry.requiredTask(second.id)).toMatchObject({
      status: "running",
      agent: {
        id: "second-agent",
        principalId: "chatgpt-web",
        presence: "offline",
      },
    });
    expect(registry.sweepExpiredSessionLeases()).toEqual([second.id]);
    expect(registry.requiredTask(second.id).status).toBe("running");

    registry.close();
    const reopened = track(new TaskRegistry({ databasePath }));
    expect(reopened.requiredTask(first.id)).toMatchObject({
      status: "running",
      agent: { id: "first-agent", presence: "online" },
    });
    expect(reopened.requiredTask(second.id)).toMatchObject({
      status: "running",
      agent: { id: "second-agent", presence: "offline" },
    });
  });

  it("does not let Agent messages rewrite Task ownership or heartbeat", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T02:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, databasePath, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Message invariants",
        status: "running",
        agentId: "message-agent",
        agentName: "Message Agent",
      },
      "chatgpt-web",
      workspace,
      "agent",
      "message-session",
    );
    const before = ownerHeartbeat(databasePath, task.id);

    vi.setSystemTime(startedAt + 30_000);
    registry.addAgentMessage(
      task.id,
      "Coordination remains separate from Task heartbeat.",
      "assistant",
      "message-agent",
      "Message Agent",
      "chatgpt-web",
      "message-session",
    );

    expect(ownerHeartbeat(databasePath, task.id)).toEqual(before);
    expect(registry.requiredTask(task.id).agent).toMatchObject({
      id: "message-agent",
      principalId: "chatgpt-web",
    });
  });

  it("allocates a new legacy lease generation when the same owner is explicitly reassigned", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T03:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, databasePath, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Legacy session reassignment",
        status: "running",
        agentId: "legacy-agent",
        agentName: "Legacy Agent",
      },
      "chatgpt-web",
      workspace,
    );

    vi.setSystemTime(startedAt + 1_000);
    registry.unassignTask(
      {
        taskId: task.id,
        agentId: "legacy-agent",
        agentName: "Legacy Agent",
      },
      "chatgpt-web",
    );
    vi.setSystemTime(startedAt + 2_000);
    const reassigned = registry.claimTask(
      {
        taskId: task.id,
        agentId: "legacy-agent",
        agentName: "Legacy Agent",
        expectedCurrentAgentId: null,
      },
      "chatgpt-web",
    );
    expect(reassigned).toMatchObject({
      status: "running",
      agent: {
        id: "legacy-agent",
        principalId: "chatgpt-web",
        presence: "online",
      },
    });

    const database = new DatabaseSync(databasePath);
    try {
      const leases = database
        .prepare(
          `
          SELECT session_id, closed_at_unix_ms
          FROM task_agent_session_leases_v1
          WHERE task_id = ?
          ORDER BY created_at_unix_ms ASC, session_id ASC
        `,
        )
        .all(task.id) as unknown as Array<{
        readonly session_id: string;
        readonly closed_at_unix_ms: number | null;
      }>;
      expect(leases).toHaveLength(2);
      expect(leases[0]).toMatchObject({ closed_at_unix_ms: startedAt + 1_000 });
      expect(leases[1]?.session_id).toMatch(/^legacy-[a-f0-9]{64}-2$/u);
      expect(leases[1]?.closed_at_unix_ms).toBeNull();
    } finally {
      database.close();
    }
  });

  it("never reopens an explicitly closed trusted transport lease", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-30T04:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { workspace, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Closed transport lease",
        status: "running",
        agentId: "transport-agent",
        agentName: "Transport Agent",
      },
      "chatgpt-web",
      workspace,
      "agent",
      "transport-closed",
    );

    vi.setSystemTime(startedAt + 1_000);
    registry.closeSession(
      "chatgpt-web",
      "transport-closed",
      "transport closed",
    );
    vi.setSystemTime(startedAt + 2_000);
    expect(() =>
      registry.heartbeat(
        { taskId: task.id, agentId: "transport-agent" },
        "chatgpt-web",
        "transport-closed",
      ),
    ).toThrow(/closed Task session leases cannot be reopened/iu);
    expect(registry.requiredTask(task.id)).toMatchObject({
      status: "running",
      agent: { presence: "offline" },
    });
  });

  it("passes the trusted transport session into coordination store context", async () => {
    const inbox = vi.fn(() => ({}));
    const store = { inbox } as unknown as TaskCoordinationStore;
    const tool = createTaskCoordinationTools(
      store,
      "C:\\workspace",
      "desktop-workspace",
    ).find((definition) => definition.spec.name === "tasks.coordination.inbox");
    expect(tool).toBeDefined();
    const input = {
      taskId: "recipient-task",
      sessionId: "client-mailbox-cursor",
      agentId: "recipient-agent",
    };

    await tool!.execute(
      {
        principal: { id: "chatgpt-web" },
        sessionId: "trusted-transport-session",
      } as never,
      tool!.parse(input),
    );

    expect(inbox).toHaveBeenCalledWith(input, {
      principalId: "chatgpt-web",
      workspaceRoot: "C:\\workspace",
      sessionId: "trusted-transport-session",
    });
  });
});
