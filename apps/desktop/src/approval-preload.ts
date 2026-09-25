import { contextBridge, ipcRenderer } from "electron";

import {
  IPC_CHANNELS,
  type DesktopApprovalDecision,
  type DesktopApprovalView,
  type SovereignApprovalApi,
} from "./shared.js";

const api: SovereignApprovalApi = {
  getCurrent: () =>
    ipcRenderer.invoke(IPC_CHANNELS.approvalGetCurrent) as Promise<DesktopApprovalView | null>,
  resolve: (requestId: string, decision: DesktopApprovalDecision) =>
    ipcRenderer.invoke(IPC_CHANNELS.approvalResolve, requestId, decision) as Promise<void>,
};

contextBridge.exposeInMainWorld("sovereignApproval", api);
