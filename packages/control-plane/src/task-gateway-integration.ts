import { win32 } from "node:path";

import type {
  GatewayRuntimeOptions,
  GatewayToolInputNormalizationRequest,
  ToolExecutionActivityEvent,
} from "@sovereign/gateway/runtime";

import { createTaskCoordinationTools } from "./task-coordination-tools.js";
import type { TaskRegistry } from "./task-registry.js";
import { createTaskTools } from "./task-tools.js";

const TASK_ACTIVITY_IGNORED_TOOLS = new Set([
  "tasks.list",
  "tasks.inbox",
  "tasks.get",
  "tasks.create",
  "tasks.claim",
  "tasks.unassign",
  "tasks.update",
  "tasks.heartbeat",
  "tasks.messages.list",
  "tasks.message.send",
  "tasks.coordination.directory",
  "tasks.coordination.pending",
  "tasks.coordination.send",
  "tasks.coordination.broadcast",
  "tasks.coordination.inbox",
  "tasks.coordination.outbox",
  "tasks.coordination.thread",
  "tasks.coordination.acknowledge",
  "tasks.coordination.acknowledgeThrough",
  "tasks.coordination.reply",
  "tasks.coordination.cancel",
  "system.info",
  "system.capabilities",
  "system.manifest",
  "system.audit_receipts",
  "runs.list",
  "runs.get",
  "runs.wait",
  "workspace.list",
  "terminal.session.list",
  "terminal.session.read",
  "browser.capabilities",
  "browser.session.list",
  "computer.capabilities",
  "python.capabilities",
  "workflow.templates",
]);

function bestEffort(operation: () => void): void {
  try {
    operation();
  } catch {
    // Session lease bookkeeping is advisory and must not affect MCP traffic.
  }
}

export function isTaskActivityIgnoredTool(toolName: string): boolean {
  return TASK_ACTIVITY_IGNORED_TOOLS.has(toolName);
}

export function touchTaskSessionForToolActivity(
  registry: TaskRegistry,
  event: ToolExecutionActivityEvent,
): void {
  if (event.sessionId === null) return;
  bestEffort(() => {
    registry.touchSessionActivity(
      event.principalId,
      event.sessionId,
      event.phase === "started"
        ? event.startedAt
        : (event.completedAt ?? event.startedAt),
    );
  });
}

export function normalizeTaskBoundToolInput(
  registry: TaskRegistry,
  workspaceRoot: string | null,
  request: GatewayToolInputNormalizationRequest,
): Readonly<Record<string, unknown>> {
  if (
    request.toolName !== "terminal.exec" ||
    request.sessionId === null ||
    workspaceRoot === null ||
    typeof request.input.cwd !== "string" ||
    request.input.cwd.trim() !== "."
  ) {
    return request.input;
  }
  if (!win32.isAbsolute(workspaceRoot)) return request.input;
  const projectRoot = registry.currentTaskProjectRoot(
    request.principal.id,
    request.sessionId,
  );
  if (projectRoot === null || !win32.isAbsolute(projectRoot))
    return request.input;
  const cwd = win32.relative(workspaceRoot, projectRoot);
  if (
    cwd === ".." ||
    cwd.startsWith(`..${win32.sep}`) ||
    win32.isAbsolute(cwd)
  ) {
    return request.input;
  }
  return { ...request.input, cwd };
}

export function createTaskGatewaySessionCallbacks(
  registry: TaskRegistry,
): Pick<
  GatewayRuntimeOptions,
  "onExternalSessionActivity" | "onExternalSessionClosed"
> {
  return {
    onExternalSessionActivity: (event) => {
      bestEffort(() => {
        registry.touchSessionActivity(
          event.principalId,
          event.sessionId,
          event.observedAt,
        );
      });
    },
    onExternalSessionClosed: (event) => {
      bestEffort(() => {
        registry.closeSession(
          event.principalId,
          event.sessionId,
          event.reason,
          event.observedAt,
        );
      });
    },
  };
}

export function createTaskGatewayToolDefinitions(
  registry: TaskRegistry,
  projectRoot: string,
  workspaceId: string,
) {
  return [
    ...createTaskTools(registry, projectRoot, workspaceId),
    ...createTaskCoordinationTools(
      registry.coordinationStore(),
      projectRoot,
      workspaceId,
    ),
  ];
}
