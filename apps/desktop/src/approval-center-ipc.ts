import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type DesktopApprovalOpenResult, type DesktopPendingApproval } from "./shared.js";

interface ApprovalCenterController {
  approvals(): readonly DesktopPendingApproval[] | Promise<readonly DesktopPendingApproval[]>;
  openApproval(requestId: string): Promise<DesktopApprovalOpenResult>;
}

export function registerApprovalCenterIpc(
  controller: ApprovalCenterController,
  assertTrustedSender: (event: IpcMainInvokeEvent) => void,
): void {
  ipcMain.handle(IPC_CHANNELS.getApprovals, async (event) => {
    assertTrustedSender(event);
    return await controller.approvals();
  });
  ipcMain.handle(IPC_CHANNELS.openApproval, async (event, requestId: unknown) => {
    assertTrustedSender(event);
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 256) {
      throw new Error("Approval request id is invalid.");
    }
    return await controller.openApproval(requestId);
  });
}
