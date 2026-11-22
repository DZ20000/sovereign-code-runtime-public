import type { ExternalToolAuthorizationRequest } from "@sovereign/gateway/runtime";
import type { DesktopApprovalContext } from "@sovereign/control-plane-contract";
import type { ApprovalRequestInput } from "./approval-broker.js";

function bounded(value: string, limit = 2_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function targetFor(request: ExternalToolAuthorizationRequest): DesktopApprovalContext["target"] {
  const { spec, input } = request;
  const keys: readonly [string, DesktopApprovalContext["target"]["kind"]][] =
    spec.name.startsWith("terminal.") ? [["command", "command"]]
      : spec.name.startsWith("files.") ? [["path", "path"], ["relativePath", "path"]]
        : spec.name.startsWith("browser.") ? [["url", "url"]] : [];
  for (const [key, kind] of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return { kind, value: bounded(value) };
  }
  return { kind: "tool", value: spec.name };
}

export function externalApprovalPresentation(request: ExternalToolAuthorizationRequest): ApprovalRequestInput {
  const { spec, principal, input } = request;
  const requestedWorkspace = typeof input.workspaceId === "string" ? input.workspaceId : null;
  const workspaceId = requestedWorkspace !== null && principal.workspaceIds.has(requestedWorkspace)
    ? requestedWorkspace : principal.workspaceIds.size === 1 ? [...principal.workspaceIds][0] ?? null : null;
  const level = spec.permissionLevel === "consequential" ? "L3" : spec.permissionLevel === "workspace" ? "L2" : "L1";
  let detail: string;
  try { detail = JSON.stringify(input, null, 2); } catch { detail = "Request details unavailable."; }
  return {
    toolName: spec.name,
    title: `${level} · Sovereign`,
    message: `Allow this request to run ${spec.name}?`,
    detail: `${spec.description}\n\nThis approval covers exactly this external tool call and expires at its stated deadline.\n\n${bounded(detail)}`,
    context: {
      requesterId: bounded(principal.id, 256),
      workspaceId,
      permissionLevel: spec.permissionLevel,
      destructive: spec.destructive,
      sideEffect: spec.sideEffect,
      target: targetFor(request),
      // Administrator elevation is never inferred from command text or arbitrary input fields.
    },
  };
}
