import { ipcMain } from "electron";

import { IPC_CHANNELS, type DesktopApprovalView } from "./shared.js";

export const visualApproval: DesktopApprovalView = {
  id: "approval-visual-001",
  toolName: "terminal.start",
  title: "Review one command",
  message: "Review the requester and command before deciding.",
  detail: "One fixture command.\nNo real process is started.\nCommand: pnpm typecheck",
  requestedAt: "2026-08-11T14:00:00.000Z",
  expiresAt: "2099-08-11T14:00:30.000Z",
  burstDetected: false,
  context: {
    requesterId: "fixture-agent-1", workspaceId: "fixture-workspace", permissionLevel: "consequential",
    destructive: false, sideEffect: "process", target: { kind: "command", value: "pnpm typecheck" },
  },
};

export const approvalFixture = {
  opened: [] as string[],
  decisions: [] as { requestId: string; decision: string }[],
  dismissed: [] as boolean[],
};

export function setApprovalWindowFixture(
  getCurrent: () => DesktopApprovalView | null,
  resolve: (requestId: string, decision: string) => unknown,
  dismiss: (returnToCenter: boolean) => unknown = (value) => { approvalFixture.dismissed.push(value); },
): void {
  for (const channel of [IPC_CHANNELS.approvalGetCurrent, IPC_CHANNELS.approvalResolve, IPC_CHANNELS.approvalDismiss]) ipcMain.removeHandler(channel);
  ipcMain.handle(IPC_CHANNELS.approvalGetCurrent, getCurrent);
  ipcMain.handle(IPC_CHANNELS.approvalResolve, (_event, requestId: unknown, decision: unknown) => {
    if (typeof requestId !== "string" || !["allow-once", "deny", "drop-to-l1"].includes(String(decision))) throw new Error("Invalid fixture approval decision.");
    return resolve(requestId, String(decision));
  });
  ipcMain.handle(IPC_CHANNELS.approvalDismiss, (_event, returnToCenter: unknown) => dismiss(returnToCenter === true));
}

export function restoreApprovalWindowFixture(): void {
  setApprovalWindowFixture(() => visualApproval, (requestId, decision) => {
    if (requestId !== visualApproval.id) throw new Error("Fixture approval identity changed.");
    approvalFixture.decisions.push({ requestId, decision });
  });
}

/** No real broker, approval, native window, or command is dispatched by these handlers. */
export function registerApprovalFixture(): void {
  restoreApprovalWindowFixture();
  ipcMain.handle(IPC_CHANNELS.getApprovals, () => [
    { ...visualApproval, expiresAt: new Date(Date.now() + 60_000).toISOString(), phase: "active" as const },
    { ...visualApproval, id: "approval-visual-queued", title: "Queued fixture request", phase: "queued" as const },
  ]);
  ipcMain.handle(IPC_CHANNELS.openApproval, (_event, requestId: unknown) => {
    if (typeof requestId !== "string") throw new Error("Invalid fixture approval identity.");
    approvalFixture.opened.push(requestId);
    return requestId === visualApproval.id ? "opened" : requestId === "approval-visual-queued" ? "queued" : "unavailable";
  });
}
