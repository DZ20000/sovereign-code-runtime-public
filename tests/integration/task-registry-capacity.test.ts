import { mkdir } from "node:fs/promises";

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TaskWorkspaceSnapshotAssembler } from "../../apps/desktop/src/renderer/task-workspace-pagination.js";
import { fixture } from "./task-registry-fixture.js";

describe("task registry capacity", () => {
  it("bounds stored conversation history to the newest 500 messages", async () => {
    const { workspace, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Bounded conversation",
        agentId: "agent-bounded",
        agentName: "Bounded Agent",
      },
      "chatgpt-web",
      workspace,
    );
    for (let index = 0; index < 505; index += 1) {
      registry.addAgentMessage(
        task.id,
        `Message ${index + 1}`,
        "assistant",
        "agent-bounded",
        "Bounded Agent",
        "chatgpt-web",
      );
    }
    const detail = registry.detail(task.id, 500);
    expect(detail.messages).toHaveLength(500);
    expect(detail.messages[0]).toMatchObject({
      sequence: 7,
      content: "Message 6",
    });
    expect(detail.messages.at(-1)).toMatchObject({
      sequence: 506,
      content: "Message 505",
    });
    expect(detail.task.messageCount).toBe(500);
    registry.close();
  });

  it("enforces bounded project and task cardinality", async () => {
    const projectFixture = await fixture();
    for (let index = 0; index < 50; index += 1) {
      const projectRoot = join(
        projectFixture.workspace,
        `project-${index + 1}`,
      );
      await mkdir(projectRoot, { recursive: true });
      projectFixture.registry.createTask(
        {
          projectRoot,
          title: `Task ${index + 1}`,
        },
        "chatgpt-web",
        projectFixture.workspace,
      );
    }
    const overflowProjectRoot = join(
      projectFixture.workspace,
      "project-overflow",
    );
    await mkdir(overflowProjectRoot, { recursive: true });
    expect(() =>
      projectFixture.registry.createTask(
        {
          projectRoot: overflowProjectRoot,
          title: "Overflow",
        },
        "chatgpt-web",
        projectFixture.workspace,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "POLICY_DENIED",
      }),
    );
    projectFixture.registry.close();

    const taskFixture = await fixture();
    const retainedTaskIds: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const task = taskFixture.registry.createTask(
        {
          title: `Task ${index + 1}`,
          status: index % 2 === 0 ? "planning" : "cancelled",
          idempotencyKey: `capacity-${index}`,
        },
        "chatgpt-web",
        taskFixture.workspace,
      );
      retainedTaskIds.push(task.id);
      if (index === 0) {
        taskFixture.registry.addUserMessage(task.id, "Keep this pending instruction.");
      }
    }
    expect(() =>
      taskFixture.registry.createTask(
        {
          title: "Task overflow",
        },
        "chatgpt-web",
        taskFixture.workspace,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "POLICY_DENIED",
        message: "A project may contain at most 200 tasks.",
      }),
    );
    const firstPage = taskFixture.registry.snapshot(0, 100);
    const secondPage = taskFixture.registry.snapshot(100, 100);
    expect(firstPage).toMatchObject({ totalTaskCount: 200, nextOffset: 100 });
    expect(secondPage).toMatchObject({ totalTaskCount: 200, nextOffset: null });
    expect(firstPage.projects[0]?.taskCount).toBe(200);
    expect(secondPage.projects[0]?.taskCount).toBe(200);
    const assembler = new TaskWorkspaceSnapshotAssembler();
    expect(assembler.addPage(firstPage)).toEqual({ kind: "continue", nextOffset: 100 });
    const assembled = assembler.addPage(secondPage);
    expect(assembled.kind).toBe("complete");
    if (assembled.kind !== "complete") throw new Error("Expected every retained task to load.");
    expect(assembled.snapshot.projects[0]?.tasks).toHaveLength(200);
    expect(
      [firstPage, secondPage]
        .flatMap((page) => page.projects.flatMap((project) => project.tasks.map((task) => task.id)))
        .sort(),
    ).toEqual([...retainedTaskIds].sort());
    expect(taskFixture.registry.detail(retainedTaskIds[0]!).messages.at(-1)).toMatchObject({
      role: "user",
      content: "Keep this pending instruction.",
      acknowledgedAt: null,
    });
    expect(taskFixture.registry.createTask(
      { title: "Replay existing task at capacity", idempotencyKey: "capacity-0" },
      "chatgpt-web",
      taskFixture.workspace,
    ).id).toBe(retainedTaskIds[0]);
    expect(taskFixture.registry.snapshot().totalTaskCount).toBe(200);
    taskFixture.registry.close();
  });

  it("bounds total retained tasks across projects", async () => {
    const { workspace, registry } = await fixture();
    for (let projectIndex = 0; projectIndex < 5; projectIndex += 1) {
      const projectRoot = join(workspace, `global-project-${projectIndex + 1}`);
      await mkdir(projectRoot, { recursive: true });
      for (let taskIndex = 0; taskIndex < 100; taskIndex += 1) {
        registry.createTask(
          {
            projectRoot,
            title: `Global task ${projectIndex + 1}-${taskIndex + 1}`,
          },
          "chatgpt-web",
          workspace,
        );
      }
    }
    expect(() =>
      registry.createTask(
        {
          title: "Global task overflow",
        },
        "chatgpt-web",
        workspace,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "POLICY_DENIED",
      }),
    );
    const snapshot = registry.snapshot(0, 100);
    expect(snapshot.totalTaskCount).toBe(500);
    expect(snapshot.totalProjectCount).toBe(5);
    expect(snapshot.nextOffset).toBe(100);
    registry.close();
  });

  it("bounds total retained conversation messages across all tasks", async () => {
    const { workspace, registry } = await fixture();
    const tasks = Array.from({ length: 5 }, (_, index) =>
      registry.createTask(
        {
          title: `Conversation ${index + 1}`,
          agentId: `agent-${index + 1}`,
          agentName: `Agent ${index + 1}`,
        },
        "chatgpt-web",
        workspace,
      ),
    );
    for (const [taskIndex, task] of tasks.entries()) {
      for (let messageIndex = 0; messageIndex < 450; messageIndex += 1) {
        registry.addAgentMessage(
          task.id,
          `Task ${taskIndex + 1} message ${messageIndex + 1}`,
          "assistant",
          `agent-${taskIndex + 1}`,
          `Agent ${taskIndex + 1}`,
          "chatgpt-web",
        );
      }
    }
    const snapshot = registry.snapshot();
    const total = snapshot.projects
      .flatMap((project) => project.tasks)
      .reduce((count, task) => count + task.messageCount, 0);
    expect(total).toBe(2_000);
    expect(
      registry.detail(tasks.at(-1)!.id, 500).messages.at(-1),
    ).toMatchObject({
      content: "Task 5 message 450",
    });
    registry.close();
  }, 60_000);

  it("preserves a monotonic message sequence when global pruning reaches an old task", async () => {
    const { workspace, registry } = await fixture();
    const anchor = registry.createTask(
      { title: "Old anchor task" },
      "chatgpt-web",
      workspace,
    );
    const busyTasks = Array.from({ length: 4 }, (_, index) =>
      registry.createTask(
        {
          title: `Busy task ${index + 1}`,
          agentId: `busy-agent-${index + 1}`,
          agentName: `Busy Agent ${index + 1}`,
        },
        "chatgpt-web",
        workspace,
      ),
    );
    for (const [taskIndex, task] of busyTasks.entries()) {
      for (let messageIndex = 0; messageIndex < 500; messageIndex += 1) {
        registry.addAgentMessage(
          task.id,
          `Busy ${taskIndex + 1}-${messageIndex + 1}`,
          "assistant",
          `busy-agent-${taskIndex + 1}`,
          `Busy Agent ${taskIndex + 1}`,
          "chatgpt-web",
        );
      }
    }
    const before = registry.detail(anchor.id, 10);
    expect(before.messages).toEqual([]);
    const after = registry.addUserMessage(anchor.id, "Anchor follow-up");
    expect(after.messages.at(-1)).toMatchObject({
      sequence: 2,
      role: "user",
      content: "Anchor follow-up",
      acknowledgedAt: null,
    });
    expect(after.task.unreadUserMessageCount).toBe(1);
    registry.close();
  }, 60_000);

  it("does not leave empty projects behind when task validation or global bounds fail", async () => {
    const validationFixture = await fixture();
    const invalidProject = join(
      validationFixture.workspace,
      "invalid-task-project",
    );
    await mkdir(invalidProject, { recursive: true });
    expect(() =>
      validationFixture.registry.createTask(
        {
          projectRoot: invalidProject,
          title: "   ",
        },
        "chatgpt-web",
        validationFixture.workspace,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
      }),
    );
    expect(validationFixture.registry.snapshot().projects).toEqual([]);
    validationFixture.registry.close();

    const fullFixture = await fixture();
    for (let projectIndex = 0; projectIndex < 5; projectIndex += 1) {
      const projectRoot = join(
        fullFixture.workspace,
        `full-${projectIndex + 1}`,
      );
      await mkdir(projectRoot, { recursive: true });
      for (let taskIndex = 0; taskIndex < 100; taskIndex += 1) {
        fullFixture.registry.createTask(
          {
            projectRoot,
            title: `Full ${projectIndex + 1}-${taskIndex + 1}`,
          },
          "chatgpt-web",
          fullFixture.workspace,
        );
      }
    }
    const overflowProject = join(fullFixture.workspace, "must-not-be-created");
    await mkdir(overflowProject, { recursive: true });
    expect(() =>
      fullFixture.registry.createTask(
        {
          projectRoot: overflowProject,
          title: "Overflow task",
        },
        "chatgpt-web",
        fullFixture.workspace,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "POLICY_DENIED",
      }),
    );
    const fullSnapshot = fullFixture.registry.snapshot(0, 100);
    expect(fullSnapshot.projects.map((project) => project.name)).not.toContain(
      "must-not-be-created",
    );
    expect(fullSnapshot.totalProjectCount).toBe(5);
    expect(fullSnapshot.totalTaskCount).toBe(500);
    fullFixture.registry.close();
  });

  // This deliberately fills the 500-task global bound; Windows CI needs bounded I/O headroom.
  it("does not leave an inferred project behind when the global task cap rejects activity", async () => {
    const { workspace, registry } = await fixture();
    for (let projectIndex = 0; projectIndex < 5; projectIndex += 1) {
      const projectRoot = join(workspace, `activity-cap-${projectIndex + 1}`);
      await mkdir(projectRoot, { recursive: true });
      for (let taskIndex = 0; taskIndex < 100; taskIndex += 1) {
        registry.createTask(
          {
            projectRoot,
            title: `Activity cap ${projectIndex + 1}-${taskIndex + 1}`,
          },
          "other-principal",
          workspace,
        );
      }
    }
    expect(() =>
      registry.attachActivity({
        principalId: "chatgpt-web",
        toolName: "files.read",
        title: "Overflow inferred activity",
        category: "files",
        startedAt: new Date().toISOString(),
        projectRoot: workspace,
        projectName: "Must not remain",
      }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    const snapshot = registry.snapshot(0, 100);
    expect(snapshot.totalProjectCount).toBe(5);
    expect(snapshot.totalTaskCount).toBe(500);
    expect(snapshot.projects.map((project) => project.name)).not.toContain(
      "Must not remain",
    );
    registry.close();
  }, 60_000);

  // This deliberately fills the 500-message per-task bound; keep the budget explicit.
  it("never silently prunes unacknowledged user messages at the per-task limit", async () => {
    const { workspace, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Pending user message retention",
        status: "running",
        agentId: "retention-agent",
      },
      "chatgpt-web",
      workspace,
    );
    for (let index = 0; index < 500; index += 1) {
      registry.addUserMessage(task.id, `Pending user message ${index + 1}`);
    }
    expect(() =>
      registry.addUserMessage(
        task.id,
        "Must be rejected, not silently dropped",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    const detail = registry.detail(task.id, 500);
    expect(detail.messages).toHaveLength(500);
    expect(detail.messages[0]).toMatchObject({
      sequence: 2,
      role: "user",
      content: "Pending user message 1",
      acknowledgedAt: null,
    });
    expect(detail.messages.at(-1)).toMatchObject({
      sequence: 501,
      content: "Pending user message 500",
    });
    expect(detail.task.unreadUserMessageCount).toBe(500);
    registry.close();
  }, 60_000);

  it("never silently prunes unacknowledged user messages at the global limit", async () => {
    const { workspace, registry } = await fixture();
    const tasks = Array.from({ length: 4 }, (_, index) =>
      registry.createTask(
        {
          title: `Pending global conversation ${index + 1}`,
          status: "running",
          agentId: `pending-agent-${index + 1}`,
        },
        "chatgpt-web",
        workspace,
      ),
    );
    for (const [taskIndex, task] of tasks.entries()) {
      for (let messageIndex = 0; messageIndex < 500; messageIndex += 1) {
        registry.addUserMessage(
          task.id,
          `Pending global ${taskIndex + 1}-${messageIndex + 1}`,
        );
      }
    }
    const overflow = registry.createTask(
      {
        title: "Global pending overflow",
        status: "running",
        agentId: "overflow-agent",
      },
      "chatgpt-web",
      workspace,
    );
    expect(() =>
      registry.addUserMessage(overflow.id, "Must remain rejected"),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    const snapshot = registry.snapshot();
    const total = snapshot.projects
      .flatMap((project) => project.tasks)
      .reduce((count, task) => count + task.messageCount, 0);
    expect(total).toBe(2_000);
    expect(registry.detail(overflow.id).messages).toEqual([]);
    expect(registry.detail(tasks[0]!.id, 500).messages[0]).toMatchObject({
      sequence: 2,
      content: "Pending global 1-1",
      acknowledgedAt: null,
    });
    registry.close();
  }, 60_000);
});
