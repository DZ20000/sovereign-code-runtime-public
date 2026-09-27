import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskRegistry } from "../packages/control-plane/dist/task-registry.js";

const PRINCIPAL_ID = "chatgpt-web";
const AGENT_ID = "continuity-demo-agent";
const AGENT_NAME = "Continuity Demo Agent";
const SESSION_A = "demo-session-a";
const SESSION_B = "demo-session-b";

function errorCode(error) {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}

/**
 * Exercise Sovereign's real Task registry and session-lease implementation in
 * an isolated temporary directory. No running Sovereign instance, user Task
 * database, ChatGPT account, Tunnel, or network service is touched.
 */
export async function runContinuityDemo(options = {}) {
  const keep = options.keep === true;
  const root = await mkdtemp(join(tmpdir(), "sovereign-continuity-demo-"));
  const workspace = join(root, "workspace");
  const stateDirectory = join(root, "state");
  const databasePath = join(stateDirectory, "tasks.sqlite");
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });

  let registry = null;
  try {
    registry = new TaskRegistry({ databasePath });
    const created = registry.createTask(
      {
        title: "Continue durable local work",
        category: "development",
        status: "running",
        summary: "Demonstrate that work survives a registry restart and session replacement.",
        currentStep: "Session A recorded the first durable checkpoint.",
        progressCurrent: 1,
        progressTotal: 3,
        progressLabel: "checkpoint",
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        idempotencyKey: "continuity-demo-task",
      },
      PRINCIPAL_ID,
      workspace,
      "agent",
      SESSION_A,
    );
    const taskId = created.id;

    registry.addUserMessage(taskId, "Continue this Task even if the web session disconnects.");
    registry.addAgentMessage(
      taskId,
      "Session A saved a durable checkpoint.",
      "assistant",
      AGENT_ID,
      AGENT_NAME,
      PRINCIPAL_ID,
      SESSION_A,
    );

    registry.close();
    registry = null;

    registry = new TaskRegistry({ databasePath });
    const persisted = registry.detail(taskId);
    assert.equal(persisted.task.title, "Continue durable local work");
    assert.equal(persisted.task.progress.current, 1);
    assert.ok(
      persisted.messages.some((message) => message.content === "Session A saved a durable checkpoint."),
      "The Agent checkpoint did not persist across the registry restart.",
    );

    assert.deepEqual(
      registry.closeSession(PRINCIPAL_ID, SESSION_A, "Demo transport disconnected."),
      [taskId],
    );
    const offline = registry.requiredTask(taskId);
    assert.equal(offline.status, "running");
    assert.equal(offline.agent.presence, "offline");

    const resumed = registry.heartbeat(
      {
        taskId,
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        status: "running",
        currentStep: "Session B resumed from the durable checkpoint.",
        progressCurrent: 2,
        progressTotal: 3,
        progressLabel: "resumed",
      },
      PRINCIPAL_ID,
      SESSION_B,
    );
    assert.equal(resumed.task.agent.presence, "online");
    assert.equal(resumed.task.progress.current, 2);

    registry.addAgentMessage(
      taskId,
      "Session B continued the same local Task.",
      "assistant",
      AGENT_ID,
      AGENT_NAME,
      PRINCIPAL_ID,
      SESSION_B,
    );

    let closedSessionErrorCode = null;
    try {
      registry.addAgentMessage(
        taskId,
        "A closed session must not regain authority.",
        "assistant",
        AGENT_ID,
        AGENT_NAME,
        PRINCIPAL_ID,
        SESSION_A,
      );
    } catch (error) {
      closedSessionErrorCode = errorCode(error);
    }
    assert.equal(closedSessionErrorCode, "POLICY_DENIED");

    const finalDetail = registry.detail(taskId);
    const report = {
      schemaVersion: "scr.continuity-demo/v1",
      checks: {
        taskPersistedAcrossRestart: true,
        workflowStateSurvivedDisconnect: finalDetail.task.status === "running",
        replacementSessionResumed: finalDetail.task.agent.presence === "online",
        closedSessionRejected: closedSessionErrorCode === "POLICY_DENIED",
      },
      finalTask: {
        status: finalDetail.task.status,
        currentStep: finalDetail.task.currentStep,
        progress: finalDetail.task.progress,
        agentPresence: finalDetail.task.agent.presence,
        messageCount: finalDetail.messages.length,
      },
      closedSessionErrorCode,
      retainedDirectory: keep ? root : null,
    };

    assert.ok(Object.values(report.checks).every(Boolean));
    return report;
  } finally {
    registry?.close();
    if (!keep) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}
