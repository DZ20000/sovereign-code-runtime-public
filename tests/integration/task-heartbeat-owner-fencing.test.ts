import { describe, expect, it, vi } from "vitest";

import { fixture } from "./task-registry-fixture.js";

describe("task heartbeat owner fencing", () => {
  // `updateTask` and `unassignTask` fence a changed owner inside their own
  // conditional UPDATE. `heartbeat` writes the owner columns too, so it carries
  // the same compare-and-swap rather than depending on the session-lease layer
  // alone. Whichever guard reports first, a heartbeat built from a stale
  // ownership snapshot must never commit.
  it("never reinstates an owner that changed after the ownership pre-check", async () => {
    const { workspace, registry } = await fixture();

    const task = registry.createTask(
      {
        title: "Fence a stale heartbeat",
        category: "development",
        status: "running",
        agentId: "agent-a",
        agentName: "Agent A",
      },
      "principal-a",
      workspace,
    );

    // Ownership snapshot taken while agent-a still owns the task. Another
    // process sharing this database can commit an ownership change between
    // that read and the heartbeat write.
    const stale = registry.requiredTask(task.id);

    registry.unassignTask(
      { taskId: task.id, agentId: "agent-a", agentName: "Agent A" },
      "principal-a",
    );
    registry.claimTask(
      { taskId: task.id, agentId: "agent-b", agentName: "Agent B" },
      "principal-a",
    );
    expect(registry.requiredTask(task.id).agent.id).toBe("agent-b");

    const staleRead = vi.spyOn(registry, "requiredTask").mockReturnValue(stale);
    try {
      expect(() =>
        registry.heartbeat(
          {
            taskId: task.id,
            agentId: "agent-a",
            status: "running",
            currentStep: "Stale owner progress",
          },
          "principal-a",
        ),
      ).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    } finally {
      staleRead.mockRestore();
    }

    // The rejected heartbeat must leave the committed owner and its progress
    // untouched.
    const committed = registry.requiredTask(task.id);
    expect(committed.agent.id).toBe("agent-b");
    expect(committed.agent.name).toBe("Agent B");
    expect(committed.currentStep).not.toBe("Stale owner progress");
  });
});
