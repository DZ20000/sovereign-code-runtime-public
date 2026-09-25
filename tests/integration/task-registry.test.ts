import { mkdir, symlink, writeFile } from "node:fs/promises";

import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TaskRegistry } from "../../packages/control-plane/src/task-registry.js";
import { fixture } from "./task-registry-fixture.js";

describe("task registry", () => {
  it("groups large project summaries around bounded task records", async () => {
    const { workspace, registry } = await fixture();
    const nested = join(workspace, "packages", "feature-a");
    await mkdir(nested, { recursive: true });

    const first = registry.createTask(
      {
        projectRoot: nested,
        projectName: "Feature A",
        title: "Build task and Agent hub",
        category: "development",
        status: "running",
        summary: "Implement project cards, details and conversation.",
        currentStep: "Create persistence model",
        progressCurrent: 2,
        progressTotal: 6,
        progressLabel: "Core model",
        steps: [
          {
            id: "model",
            title: "Create model",
            status: "running",
            updatedAt: new Date().toISOString(),
          },
          {
            id: "ui",
            title: "Build UI",
            status: "pending",
            updatedAt: new Date().toISOString(),
          },
        ],
        agentId: "agent-1",
        agentName: "Sovereign Agent",
      },
      "chatgpt-web",
      workspace,
    );
    registry.createTask(
      {
        projectRoot: nested,
        projectName: "Feature A",
        title: "Validate task hub",
        category: "testing",
        status: "queued",
      },
      "chatgpt-web",
      workspace,
    );

    const snapshot = registry.snapshot();
    expect(snapshot.schemaVersion).toBe("scr.task-workspace/v1");
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]).toMatchObject({
      name: "Feature A",
      root: resolve(nested),
      status: "active",
      taskCount: 2,
      activeTaskCount: 2,
      attentionTaskCount: 0,
      onlineAgentCount: 2,
    });
    expect(snapshot.projects[0]?.tasks[0]).toMatchObject({
      id: first.id,
      title: "Build task and Agent hub",
      currentStep: "Create persistence model",
      progress: { current: 2, total: 6, label: "Core model" },
      agent: { id: "agent-1", name: "Sovereign Agent", presence: "online" },
    });
    registry.close();
  });

  it("rejects Agent projects outside the authorized workspace", async () => {
    const { root, workspace, registry } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    expect(() =>
      registry.createTask(
        {
          projectRoot: outside,
          title: "Escape",
        },
        "chatgpt-web",
        workspace,
      ),
    ).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
    registry.close();
  });

  it("requires project roots to be existing directories", async () => {
    const { workspace, registry } = await fixture();
    expect(() =>
      registry.createTask(
        {
          projectRoot: join(workspace, "missing-project"),
          title: "Missing project",
        },
        "chatgpt-web",
        workspace,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const filePath = join(workspace, "not-a-directory.txt");
    await writeFile(filePath, "not a project", "utf8");
    expect(() =>
      registry.createTask(
        {
          projectRoot: filePath,
          title: "File project",
        },
        "chatgpt-web",
        workspace,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    registry.close();
  });

  it("rejects a project junction or symlink that resolves outside the workspace", async () => {
    const { root, workspace, registry } = await fixture();
    const outside = join(root, "outside-real");
    const link = join(workspace, "outside-link");
    await mkdir(outside, { recursive: true });
    try {
      await symlink(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        registry.close();
        return;
      }
      throw error;
    }
    expect(() =>
      registry.createTask(
        {
          projectRoot: link,
          title: "Reparse escape",
        },
        "chatgpt-web",
        workspace,
      ),
    ).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
    registry.close();
  });

  it("supports user-to-Agent conversation cursors and acknowledgement", async () => {
    const { workspace, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Conversation",
        status: "running",
        agentId: "agent-chat",
        agentName: "Chat Agent",
      },
      "chatgpt-web",
      workspace,
    );

    const afterFirst = registry.addUserMessage(
      task.id,
      "Continue without asking me to operate anything.",
    );
    expect(afterFirst.task.unreadUserMessageCount).toBe(1);
    const userMessage = afterFirst.messages.at(-1);
    expect(userMessage).toMatchObject({ role: "user", acknowledgedAt: null });

    const heartbeat = registry.heartbeat(
      {
        taskId: task.id,
        agentId: "agent-chat",
        status: "running",
        currentStep: "Applying the requested change",
      },
      "chatgpt-web",
    );
    expect(heartbeat.pendingUserMessages).toHaveLength(1);
    expect(heartbeat.pendingUserMessages[0]?.content).toContain("Continue");

    const acknowledged = registry.heartbeat(
      {
        taskId: task.id,
        agentId: "agent-chat",
        acknowledgeThroughSequence: userMessage!.sequence,
      },
      "chatgpt-web",
    );
    expect(acknowledged.pendingUserMessages).toEqual([]);
    expect(acknowledged.task.unreadUserMessageCount).toBe(0);

    const detail = registry.addAgentMessage(
      task.id,
      "Acknowledged. I am continuing the implementation.",
      "assistant",
      "agent-chat",
      "Chat Agent",
      "chatgpt-web",
    );
    expect(detail.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    registry.close();
  });

  it("derives Agent presence and project attention from heartbeat age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const { workspace, registry } = await fixture();
    const task = registry.createTask(
      { title: "Heartbeat", status: "running" },
      "chatgpt-web",
      workspace,
    );
    expect(registry.requiredTask(task.id).agent.presence).toBe("online");

    vi.setSystemTime(new Date("2026-08-20T00:02:00.000Z"));
    expect(registry.requiredTask(task.id).agent.presence).toBe("stale");
    expect(registry.snapshot().projects[0]?.status).toBe("attention");

    vi.setSystemTime(new Date("2026-08-20T00:10:00.000Z"));
    expect(registry.requiredTask(task.id).agent.presence).toBe("offline");
    registry.close();
  });

  it("attaches activity to an explicit Agent task and completes inferred tasks", async () => {
    const { workspace, registry } = await fixture();
    const explicit = registry.createTask(
      {
        title: "Implement feature",
        status: "running",
        agentId: "agent-1",
      },
      "chatgpt-web",
      workspace,
      "agent",
      "activity-transport",
    );
    const attached = registry.attachActivity({
      principalId: "chatgpt-web",
      sessionId: "activity-transport",
      toolName: "files.replace_text",
      title: "Replace text",
      category: "files",
      startedAt: new Date().toISOString(),
      projectRoot: workspace,
    });
    expect(attached.id).toBe(explicit.id);
    expect(attached.lastActivityLabel).toBe("Replace text");
    expect(
      registry.completeActivity(
        attached.id,
        "succeeded",
        new Date().toISOString(),
        0,
        "Replace text",
        "activity-transport",
      ).status,
    ).toBe("running");

    registry.updateTask(
      { taskId: explicit.id, agentId: "agent-1", status: "succeeded" },
      "chatgpt-web",
      "activity-transport",
    );
    const inferred = registry.attachActivity({
      principalId: "chatgpt-web",
      toolName: "search.text",
      title: "Search source",
      category: "search",
      startedAt: new Date().toISOString(),
      projectRoot: workspace,
    });
    expect(inferred.source).toBe("inferred");
    expect(inferred.category).toBe("research");
    const completed = registry.completeActivity(
      inferred.id,
      "failed",
      new Date().toISOString(),
      0,
      "Search source",
    );
    expect(completed.status).toBe("failed");
    expect(registry.snapshot().projects[0]?.status).toBe("attention");
    registry.close();
  });

  it("persists tasks and messages across registry restarts", async () => {
    const { workspace, databasePath, registry } = await fixture();
    const task = registry.createTask(
      { title: "Persistent task", status: "waiting-user" },
      "chatgpt-web",
      workspace,
    );
    registry.addUserMessage(task.id, "Please continue.");
    registry.close();

    const reopened = new TaskRegistry({ databasePath });
    const detail = reopened.detail(task.id);
    expect(detail.task).toMatchObject({
      title: "Persistent task",
      status: "waiting-user",
    });
    expect(detail.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Please continue.",
    });
    reopened.close();
  });

  it("keeps workflow status independent when one owning session closes", async () => {
    const { workspace, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Long task",
        status: "running",
        currentStep: "Implementing the feature.",
      },
      "chatgpt-web",
      workspace,
      "agent",
      "session-a",
    );
    const messageCount = registry.detail(task.id).messages.length;

    expect(
      registry.closeSession("chatgpt-web", "session-a", "Transport closed."),
    ).toEqual([task.id]);

    const detail = registry.detail(task.id);
    expect(detail.task).toMatchObject({
      status: "running",
      currentStep: "Implementing the feature.",
      agent: { presence: "offline" },
    });
    expect(detail.messages).toHaveLength(messageCount);
    registry.close();
  });

  it("allows descendant names beginning with dots but rejects true parent escapes", async () => {
    const { workspace, registry } = await fixture();
    const dottedRoot = join(workspace, "..project-cache");
    await mkdir(dottedRoot, { recursive: true });
    const dotted = registry.createTask(
      {
        projectRoot: dottedRoot,
        title: "Dotted descendant",
      },
      "chatgpt-web",
      workspace,
    );
    expect(dotted.projectRoot).toBe(resolve(workspace, "..project-cache"));
    const outside = resolve(workspace, "..", "outside");
    await mkdir(outside, { recursive: true });
    expect(() =>
      registry.createTask(
        {
          projectRoot: outside,
          title: "Outside",
        },
        "chatgpt-web",
        workspace,
      ),
    ).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
    registry.close();
  });

  it("keeps idempotency and mutation ownership scoped to the Agent principal", async () => {
    const { workspace, registry } = await fixture();
    const first = registry.createTask(
      {
        title: "Principal A",
        idempotencyKey: "shared-key",
        agentId: "agent-a",
      },
      "principal-a",
      workspace,
    );
    const repeated = registry.createTask(
      {
        title: "Principal A repeated",
        idempotencyKey: "shared-key",
        agentId: "agent-a",
      },
      "principal-a",
      workspace,
    );
    const second = registry.createTask(
      {
        title: "Principal B",
        idempotencyKey: "shared-key",
        agentId: "agent-b",
      },
      "principal-b",
      workspace,
    );

    expect(repeated.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(() =>
      registry.updateTask(
        { taskId: first.id, agentId: "agent-a", status: "blocked" },
        "principal-b",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() =>
      registry.heartbeat(
        { taskId: first.id, agentId: "agent-b" },
        "principal-b",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() =>
      registry.addAgentMessage(
        first.id,
        "Attempted takeover",
        "assistant",
        "agent-b",
        "Agent B",
        "principal-b",
      ),
    ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    registry.close();
  });

  it("scopes Agent-visible task snapshots and details to the current authorized workspace", async () => {
    const { root, workspace, registry } = await fixture();
    const otherWorkspace = join(root, "other-workspace");
    await mkdir(otherWorkspace, { recursive: true });
    const task = registry.createTask(
      {
        title: "Workspace-bound task",
        status: "running",
      },
      "chatgpt-web",
      workspace,
    );

    expect(registry.snapshotForWorkspace(workspace).projects).toHaveLength(1);
    expect(registry.snapshotForWorkspace(otherWorkspace).projects).toEqual([]);
    expect(registry.taskForWorkspace(task.id, workspace).id).toBe(task.id);
    expect(() =>
      registry.taskForWorkspace(task.id, otherWorkspace),
    ).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
    expect(() =>
      registry.detailForWorkspace(task.id, otherWorkspace),
    ).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
    registry.close();
  });

  it("caps Agent acknowledgement at the newest existing message", async () => {
    const { workspace, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Bounded acknowledgement",
        status: "running",
        agentId: "agent-ack",
      },
      "chatgpt-web",
      workspace,
    );
    registry.heartbeat(
      {
        taskId: task.id,
        agentId: "agent-ack",
        acknowledgeThroughSequence: 1_000_000,
      },
      "chatgpt-web",
    );
    registry.addUserMessage(task.id, "This future message must remain unread.");
    const heartbeat = registry.heartbeat(
      {
        taskId: task.id,
        agentId: "agent-ack",
      },
      "chatgpt-web",
    );
    expect(heartbeat.pendingUserMessages).toEqual([
      expect.objectContaining({
        content: "This future message must remain unread.",
      }),
    ]);
    registry.close();
  });

  it("does not attach unrelated activity to waiting or blocked tasks", async () => {
    const { workspace, registry } = await fixture();
    const waiting = registry.createTask(
      {
        title: "Waiting task",
        status: "waiting-user",
        agentId: "agent-waiting",
      },
      "chatgpt-web",
      workspace,
    );
    const inferred = registry.attachActivity({
      principalId: "chatgpt-web",
      toolName: "files.read",
      title: "Read another file",
      category: "files",
      startedAt: new Date().toISOString(),
      projectRoot: workspace,
    });
    expect(inferred.id).not.toBe(waiting.id);
    expect(inferred.source).toBe("inferred");
    expect(registry.requiredTask(waiting.id).lastActivityLabel).toBeNull();
    registry.close();
  });

  it("shows unknown presence when an owning Agent unassigns its display identity", async () => {
    const { workspace, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Unassign Agent",
        status: "running",
        agentId: "agent-before",
      },
      "chatgpt-web",
      workspace,
    );
    const updated = registry.unassignTask(
      {
        taskId: task.id,
        agentId: "agent-before",
      },
      "chatgpt-web",
    );
    expect(updated.agent).toMatchObject({
      id: null,
      name: null,
      principalId: "chatgpt-web",
      presence: "unknown",
    });
    registry.close();
  });

  it("attaches workspace activity to the most recent active nested-project task", async () => {
    const { workspace, registry } = await fixture();
    const nested = join(workspace, "packages", "task-hub");
    await mkdir(nested, { recursive: true });
    const nestedTask = registry.createTask(
      {
        projectRoot: nested,
        projectName: "Task Hub",
        title: "Implement nested project feature",
        status: "running",
        agentId: "agent-nested",
      },
      "chatgpt-web",
      workspace,
      "agent",
      "nested-activity-transport",
    );

    const attached = registry.attachActivity({
      principalId: "chatgpt-web",
      sessionId: "nested-activity-transport",
      toolName: "files.replace_text",
      title: "Update nested project source",
      category: "files",
      startedAt: new Date().toISOString(),
      projectRoot: workspace,
    });
    expect(attached.id).toBe(nestedTask.id);
    expect(attached.projectRoot).toBe(resolve(nested));
    expect(attached.lastActivityLabel).toBe("Update nested project source");
    expect(registry.snapshot().projects).toHaveLength(1);
    registry.close();
  });

  it("uses collision-resistant principal-scoped idempotency keys", async () => {
    const { workspace, registry } = await fixture();
    const first = registry.createTask(
      {
        title: "Colon principal",
        idempotencyKey: "c",
      },
      "a:b",
      workspace,
    );
    const second = registry.createTask(
      {
        title: "Colon key",
        idempotencyKey: "b:c",
      },
      "a",
      workspace,
    );
    expect(second.id).not.toBe(first.id);
    registry.close();
  });

  it("keeps an explicitly named project stable across later Agent task creation", async () => {
    const { workspace, registry } = await fixture();
    registry.createTask(
      {
        projectName: "Stable Project",
        title: "First task",
      },
      "chatgpt-web",
      workspace,
    );
    registry.createTask(
      {
        projectName: "Renamed by another task",
        title: "Second task",
      },
      "chatgpt-web",
      workspace,
    );
    expect(registry.snapshot().projects[0]?.name).toBe("Stable Project");
    registry.close();
  });

  it("prefers an explicit active task over a newer inferred task", async () => {
    const { workspace, registry } = await fixture();
    const explicit = registry.createTask(
      {
        title: "Explicit Agent task",
        status: "running",
        agentId: "agent-explicit",
      },
      "chatgpt-web",
      workspace,
      "agent",
      "explicit-activity-transport",
    );
    const inferred = registry.createTask(
      {
        title: "Inferred activity",
        status: "running",
        agentId: "chatgpt-web",
        idempotencyKey: "inferred:chatgpt-web",
      },
      "chatgpt-web",
      workspace,
      "inferred",
    );
    registry.updateTask(
      {
        taskId: inferred.id,
        agentId: "chatgpt-web",
        currentStep: "Newer inferred work",
      },
      "chatgpt-web",
    );

    const attached = registry.attachActivity({
      principalId: "chatgpt-web",
      sessionId: "explicit-activity-transport",
      toolName: "files.replace_text",
      title: "Continue explicit work",
      category: "files",
      startedAt: new Date().toISOString(),
      projectRoot: workspace,
    });
    expect(attached.id).toBe(explicit.id);
    expect(attached.lastActivityLabel).toBe("Continue explicit work");
    expect(registry.requiredTask(inferred.id).lastActivityLabel).toBeNull();
    registry.close();
  });

  it("scopes Agent-visible reads to the owning principal", async () => {
    const { workspace, registry } = await fixture();
    const first = registry.createTask(
      {
        title: "Principal A private task",
        status: "running",
      },
      "principal-a",
      workspace,
    );
    registry.addUserMessage(first.id, "Message for principal A only.");
    const second = registry.createTask(
      {
        title: "Principal B private task",
        status: "running",
      },
      "principal-b",
      workspace,
    );

    const firstSnapshot = registry.snapshotForPrincipal(
      "principal-a",
    );
    expect(
      firstSnapshot.projects
        .flatMap((project) => project.tasks)
        .map((task) => task.id),
    ).toEqual([first.id]);
    const secondSnapshot = registry.snapshotForPrincipal(
      "principal-b",
    );
    expect(
      secondSnapshot.projects
        .flatMap((project) => project.tasks)
        .map((task) => task.id),
    ).toEqual([second.id]);
    expect(() =>
      registry.taskForPrincipalWorkspace(first.id, workspace, "principal-b"),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_FOUND" }));
    expect(() =>
      registry.detailForPrincipal(first.id, "principal-b"),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_FOUND" }));
    expect(
      registry
        .detailForPrincipal(first.id, "principal-a")
        .messages.at(-1),
    ).toMatchObject({ content: "Message for principal A only." });
    registry.close();
  });

  it("rejects malformed task step and activity timestamps", async () => {
    const { workspace, registry } = await fixture();
    expect(() =>
      registry.createTask(
        {
          title: "Invalid step time",
          steps: [
            {
              id: "bad-time",
              title: "Invalid timestamp",
              status: "pending",
              updatedAt: "not-a-time",
            },
          ],
        },
        "chatgpt-web",
        workspace,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
      }),
    );
    expect(registry.snapshot().projects).toEqual([]);
    expect(() =>
      registry.attachActivity({
        principalId: "chatgpt-web",
        toolName: "files.read",
        title: "Invalid activity time",
        category: "files",
        startedAt: "not-a-time",
        projectRoot: workspace,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(registry.snapshot().projects).toEqual([]);
    registry.close();
  });

  it("paginates compact task snapshots below the control-plane byte budget", async () => {
    const { workspace, registry } = await fixture();
    const projectRoots = [
      join(workspace, "snapshot-page-a"),
      join(workspace, "snapshot-page-b"),
    ];
    await Promise.all(
      projectRoots.map((projectRoot) =>
        mkdir(projectRoot, { recursive: true }),
      ),
    );
    const longSummary = "summary".repeat(250);
    const longStep = "step".repeat(35);
    for (let index = 0; index < 110; index += 1) {
      registry.createTask(
        {
          projectRoot: projectRoots[index < 55 ? 0 : 1]!,
          projectName: index < 55 ? "Snapshot A" : "Snapshot B",
          title: `Snapshot task ${index + 1}`,
          summary: longSummary,
          currentStep: `Current ${index + 1} ${longStep}`,
          status: index % 2 === 0 ? "running" : "succeeded",
          agentId: `snapshot-agent-${index % 4}`,
          agentName: `Snapshot Agent ${index % 4}`,
          steps:
            index === 0
              ? Array.from({ length: 100 }, (_, stepIndex) => ({
                  id: `step-${stepIndex + 1}`,
                  title: `${longStep} ${stepIndex + 1}`,
                  status:
                    stepIndex === 0
                      ? ("running" as const)
                      : ("pending" as const),
                  updatedAt: "2026-08-20T00:00:00.000Z",
                }))
              : [],
        },
        "chatgpt-web",
        workspace,
      );
    }

    const first = registry.snapshot(0, 100);
    expect(first.totalTaskCount).toBe(110);
    expect(first.totalProjectCount).toBe(2);
    expect(first.nextOffset).toBe(first.limit);
    expect(first.limit).toBeGreaterThan(0);
    expect(first.limit).toBeLessThanOrEqual(100);
    expect(
      Buffer.byteLength(JSON.stringify(first, null, 2), "utf8"),
    ).toBeLessThanOrEqual(640 * 1024);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          v: 1,
          session: "s".repeat(43),
          kind: "response",
          id: "task-page",
          ok: true,
          result: first,
        }),
        "utf8",
      ),
    ).toBeLessThan(1_048_576);
    const firstTask = first.projects.flatMap((project) => project.tasks)[0]!;
    expect(firstTask.summaryPreview.length).toBeLessThanOrEqual(240);
    expect(firstTask.currentStep.length).toBeLessThanOrEqual(240);
    expect(firstTask).not.toHaveProperty("steps");
    expect(firstTask).not.toHaveProperty("projectRoot");
    expect(firstTask.agent).not.toHaveProperty("principalId");

    const ids = new Set<string>();
    let offset = 0;
    let revision: number | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = registry.snapshot(offset, 100);
      revision ??= page.revision;
      expect(page.revision).toBe(revision);
      expect(
        Buffer.byteLength(JSON.stringify(page, null, 2), "utf8"),
      ).toBeLessThanOrEqual(640 * 1024);
      for (const task of page.projects.flatMap((project) => project.tasks))
        ids.add(task.id);
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(ids.size).toBe(110);

    const priorRevision = first.revision;
    const changedTask = registry.snapshot(0, 1).projects[0]!.tasks[0]!;
    registry.updateTask(
      {
        taskId: changedTask.id,
        agentId: changedTask.agent.id!,
        currentStep: "Revision changed",
      },
      "chatgpt-web",
    );
    expect(registry.snapshot(0, 1).revision).toBeGreaterThan(priorRevision);
    expect(() => registry.snapshot(-1, 10)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => registry.snapshot(0, 101)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    registry.close();
  });

  it("uses an inferred task instead of misassigning ambiguous activity to one of several active tasks", async () => {
    const { workspace, registry } = await fixture();
    const first = registry.createTask(
      {
        title: "Concurrent explicit task A",
        status: "running",
        agentId: "agent-concurrent",
      },
      "chatgpt-web",
      workspace,
    );
    const second = registry.createTask(
      {
        title: "Concurrent explicit task B",
        status: "running",
        agentId: "agent-concurrent",
      },
      "chatgpt-web",
      workspace,
    );

    const attached = registry.attachActivity({
      principalId: "chatgpt-web",
      toolName: "files.read",
      title: "Ambiguous concurrent file read",
      category: "files",
      startedAt: new Date().toISOString(),
      projectRoot: workspace,
    });
    expect(attached.source).toBe("inferred");
    expect(attached.id).not.toBe(first.id);
    expect(attached.id).not.toBe(second.id);
    expect(registry.requiredTask(first.id).lastActivityLabel).toBeNull();
    expect(registry.requiredTask(second.id).lastActivityLabel).toBeNull();
    registry.close();
  });

  it("closes idempotently during repeated shutdown cleanup", async () => {
    const { registry } = await fixture();
    expect(() => registry.close()).not.toThrow();
    expect(() => registry.close()).not.toThrow();
  });

  it("returns a principal-scoped workspace inbox for unread panel messages", async () => {
    const { workspace, registry } = await fixture();
    const firstRoot = join(workspace, "inbox-first");
    const secondRoot = join(workspace, "inbox-second");
    await Promise.all([
      mkdir(firstRoot, { recursive: true }),
      mkdir(secondRoot, { recursive: true }),
    ]);
    const first = registry.createTask(
      {
        projectRoot: firstRoot,
        projectName: "Inbox First",
        title: "Handle live operator instructions",
        status: "running",
        agentId: "inbox-agent",
        agentName: "Inbox Agent",
      },
      "chatgpt-web",
      workspace,
    );
    const second = registry.createTask(
      {
        projectRoot: secondRoot,
        projectName: "Inbox Second",
        title: "Handle queued operator instruction",
        status: "queued",
        agentId: "inbox-agent",
        agentName: "Inbox Agent",
      },
      "chatgpt-web",
      workspace,
    );
    const otherPrincipal = registry.createTask(
      {
        projectRoot: firstRoot,
        projectName: "Inbox First",
        title: "Other principal task",
        status: "running",
        agentId: "other-agent",
      },
      "other-principal",
      workspace,
    );

    const firstMessage = registry
      .addUserMessage(first.id, "First live instruction")
      .messages.at(-1)!;
    const secondMessage = registry
      .addUserMessage(first.id, "Second live instruction")
      .messages.at(-1)!;
    const queuedMessage = registry
      .addUserMessage(second.id, "Queued instruction")
      .messages.at(-1)!;
    registry.addUserMessage(
      otherPrincipal.id,
      "Must not cross principal boundary",
    );

    const bounded = registry.inboxForPrincipal(
      "chatgpt-web",
      10,
      1,
    );
    expect(bounded).toMatchObject({
      schemaVersion: "scr.task-inbox/v1",
      totalPendingUserMessageCount: 3,
      totalTaskCount: 2,
      truncated: true,
    });
    expect(bounded.entries.map((entry) => entry.task.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(bounded.entries[0]).toMatchObject({
      projectName: "Inbox First",
      task: { id: first.id, unreadUserMessageCount: 2 },
      pendingUserMessages: [
        { id: firstMessage.id, sequence: firstMessage.sequence },
      ],
    });
    expect(bounded.entries[1]).toMatchObject({
      projectName: "Inbox Second",
      task: { id: second.id, unreadUserMessageCount: 1 },
      pendingUserMessages: [
        { id: queuedMessage.id, sequence: queuedMessage.sequence },
      ],
    });
    expect(JSON.stringify(bounded)).not.toContain(
      "Must not cross principal boundary",
    );

    registry.heartbeat(
      {
        taskId: first.id,
        agentId: "inbox-agent",
        acknowledgeThroughSequence: firstMessage.sequence,
      },
      "chatgpt-web",
    );
    const afterAcknowledgement = registry.inboxForPrincipal(
      "chatgpt-web",
      10,
      10,
    );
    expect(afterAcknowledgement).toMatchObject({
      totalPendingUserMessageCount: 2,
      totalTaskCount: 2,
      truncated: false,
    });
    expect(afterAcknowledgement.entries[0]?.pendingUserMessages).toEqual([
      expect.objectContaining({ id: secondMessage.id, acknowledgedAt: null }),
    ]);

    const taskLimited = registry.inboxForPrincipal(
      "chatgpt-web",
      1,
      10,
    );
    expect(taskLimited).toMatchObject({
      totalPendingUserMessageCount: 2,
      totalTaskCount: 2,
      truncated: true,
    });
    expect(taskLimited.entries).toHaveLength(1);
    registry.close();
  });

  it("byte-bounds detail, message pages and heartbeat delivery without losing queued user instructions", async () => {
    const { workspace, registry } = await fixture();
    const task = registry.createTask(
      {
        title: "Bounded transport payload",
        summary: "summary".repeat(250),
        currentStep: "current-step".repeat(30),
        status: "running",
        agentId: "transport-agent",
        agentName: "Transport Agent",
        steps: Array.from({ length: 100 }, (_, index) => ({
          id: `transport-step-${index + 1}`,
          title: `Transport step ${index + 1} ${"detail".repeat(30)}`,
          status: index === 0 ? ("running" as const) : ("pending" as const),
          updatedAt: "2026-08-20T00:00:00.000Z",
        })),
      },
      "chatgpt-web",
      workspace,
    );
    const content = "\u{1F600}".repeat(3_998);
    for (let index = 0; index < 40; index += 1) {
      registry.addUserMessage(task.id, `${index + 1}:${content}`);
    }

    const detail = registry.detail(task.id, 500);
    expect(detail.messagesTruncated).toBe(true);
    expect(detail.messages.length).toBeGreaterThan(0);
    expect(detail.messages.length).toBeLessThan(detail.task.messageCount);
    expect(detail.messages.at(-1)).toMatchObject({
      role: "user",
      content: `40:${content}`,
    });
    expect(detail.oldestMessageSequence).toBe(detail.messages[0]?.sequence);
    expect(detail.newestMessageSequence).toBe(detail.messages.at(-1)?.sequence);
    expect(
      Buffer.byteLength(JSON.stringify(detail, null, 2), "utf8"),
    ).toBeLessThanOrEqual(640 * 1024);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          v: 1,
          session: "s".repeat(43),
          kind: "response",
          id: "detail",
          ok: true,
          result: detail,
        }),
        "utf8",
      ),
    ).toBeLessThan(1_048_576);

    const listedSequences: number[] = [];
    let afterSequence = 0;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = registry.listMessages({
        taskId: task.id,
        afterSequence,
        limit: 500,
      });
      expect(
        Buffer.byteLength(JSON.stringify(page, null, 2), "utf8"),
      ).toBeLessThanOrEqual(512 * 1024);
      if (page.length === 0) break;
      for (const message of page) listedSequences.push(message.sequence);
      const next = page.at(-1)!.sequence;
      expect(next).toBeGreaterThan(afterSequence);
      afterSequence = next;
    }
    expect(new Set(listedSequences).size).toBe(
      registry.requiredTask(task.id).messageCount,
    );
    expect(listedSequences).toEqual(
      [...listedSequences].sort((left, right) => left - right),
    );

    const deliveredSequences: number[] = [];
    let acknowledged = 0;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const heartbeat = registry.heartbeat(
        {
          taskId: task.id,
          agentId: "transport-agent",
          acknowledgeThroughSequence: acknowledged,
        },
        "chatgpt-web",
      );
      expect(
        Buffer.byteLength(JSON.stringify(heartbeat, null, 2), "utf8"),
      ).toBeLessThanOrEqual(640 * 1024);
      if (heartbeat.pendingUserMessages.length === 0) break;
      for (const message of heartbeat.pendingUserMessages)
        deliveredSequences.push(message.sequence);
      acknowledged = heartbeat.pendingUserMessages.at(-1)!.sequence;
    }
    const finalHeartbeat = registry.heartbeat(
      {
        taskId: task.id,
        agentId: "transport-agent",
        acknowledgeThroughSequence: acknowledged,
      },
      "chatgpt-web",
    );
    expect(finalHeartbeat.pendingUserMessages).toEqual([]);
    expect(finalHeartbeat.task.unreadUserMessageCount).toBe(0);
    expect(deliveredSequences).toHaveLength(40);
    expect(new Set(deliveredSequences).size).toBe(40);
    registry.close();
  });

  it("rejects NUL and non-text control characters while preserving message newlines", async () => {
    const { workspace, registry } = await fixture();
    expect(() =>
      registry.createTask(
        {
          title: "Bad\u0000title",
        },
        "chatgpt-web",
        workspace,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
      }),
    );
    const task = registry.createTask(
      { title: "Valid title" },
      "chatgpt-web",
      workspace,
    );
    expect(() =>
      registry.addUserMessage(task.id, "Bad\u0007message"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(
      registry.addUserMessage(task.id, "Line one\nLine two").messages.at(-1)
        ?.content,
    ).toBe("Line one\nLine two");
    registry.close();
  });
});
