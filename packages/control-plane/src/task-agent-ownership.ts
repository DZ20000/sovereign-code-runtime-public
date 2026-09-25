import type { DesktopTaskSummary } from "@sovereign/control-plane-contract";
import { RuntimeError } from "@sovereign/runtime-core";

export function requireCurrentTaskAgent(
  task: DesktopTaskSummary,
  principalId: string,
  agentId: string,
  agentName: string | undefined,
  operation: string,
): string {
  if (task.agent.principalId !== principalId) {
    throw new RuntimeError(
      "POLICY_DENIED",
      "This Task belongs to another Agent principal.",
      403,
    );
  }
  if (task.agent.id === null || task.agent.id !== agentId) {
    throw new RuntimeError(
      "POLICY_DENIED",
      `${operation} does not match the Task's current Agent owner.`,
      403,
    );
  }
  if (task.agent.name === null) {
    throw new RuntimeError(
      "POLICY_DENIED",
      `${operation} requires a named Task Agent owner.`,
      403,
    );
  }
  if (agentName !== undefined && agentName !== task.agent.name) {
    throw new RuntimeError(
      "POLICY_DENIED",
      `${operation} cannot rename the current Task Agent owner.`,
      403,
    );
  }
  return task.agent.name;
}
