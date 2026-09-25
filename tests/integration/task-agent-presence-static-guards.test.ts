import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("task Agent presence static guards", () => {
  it("uses the heartbeat-derived presence for both labels and visual state", () => {
    const model = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-board-model.ts",
    );
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const conversation = source(
      "apps", "desktop", "src", "renderer", "task-conversation-delivery.ts",
    );
    expect(model).toContain('task: Pick<TaskBoardItem, "agent">');
    expect(controller).toContain(
      "PRESENCE_LABELS[taskBoardAgentPresence(task)]",
    );
    expect(
      controller.match(/task-agent-\$\{taskBoardAgentPresence\(task\)\}/gu),
    ).toHaveLength(2);
    expect(controller).not.toContain("task-agent-${task.agent.presence}");
    expect(controller).toContain("const presence = taskBoardAgentPresence(task);");
    expect(controller).toContain("renderTaskConversationDelivery(messages, task, timestamp,");
    expect(conversation).toContain("const agentPresence = taskBoardAgentPresence(task);");
    expect(controller).not.toContain('task.agent.presence === "online"');
    expect(controller).not.toContain('task.agent.presence === "stale"');
    expect(controller).not.toContain('task.agent.presence === "offline"');
    expect(conversation).not.toContain("task.agent.presence");
  });
});
