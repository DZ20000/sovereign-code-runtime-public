import { contextBridge, ipcRenderer } from "electron";

import {
  IPC_CHANNELS,
  type DesktopAuditReceipt,
  type DesktopConnectionCopyResult,
  type DesktopDirectToolName,
  type DesktopHostStartupState,
  type DesktopManifestView,
  type DesktopProjectWorkspaces,
  type DesktopRendererUpdateStatus,
  type DesktopRuntimeRollingStatus,
  type DesktopResourceSnapshot,
  type DesktopRunRecord,
  type DesktopRunSummary,
  type DesktopRuntimeState,
  type RuntimeCandidateUpdateStatus,
  type DesktopTaskDetail,
  type DesktopTaskWorkspaceSnapshot,
  type TaskCoordinationOperatorInbox,
  type SovereignDesktopApi,
} from "./shared.js";

const disabledRendererUpdateStatus: DesktopRendererUpdateStatus = {
  schemaVersion: "scr.renderer-update-status/v1",
  enabled: false,
  shellVersion: "0.0.0",
  bridgeApiVersion: 1,
  trustedKeyCount: 0,
  highestReleaseSequence: 0,
  activeRelease: null,
  builtInActive: true,
  lastKnownGoodRelease: null,
  installedReleases: [],
  inboxReleaseIds: [],
  preflightedReleaseIds: [],
  pendingActivation: null,
  lastFailure: "Renderer-only hot updates are available in the Tauri shell only.",
};

const disabledRuntimeRollingStatus: DesktopRuntimeRollingStatus = {
  schemaVersion: "scr.runtime-rolling-service-status/v1",
  enabled: false,
  busy: false,
  active: {
    generation: 1,
    active: {
      instanceId: "electron-runtime-host",
      releaseId: "electron-shell",
    },
    fencingTokenSha256: null,
  },
  disabledReason:
    "Runtime Host rolling updates are available in the Tauri shell only.",
};

const disabledRuntimeCandidateUpdateStatus: RuntimeCandidateUpdateStatus = {
  schemaVersion: "scr.runtime-candidate-update-status/v1",
  enabled: false,
  busy: false,
  trustedKeyCount: 0,
  highestReleaseSequence: 0,
  activeReleaseId: null,
  installedReleaseIds: [],
  inboxReleaseIds: [],
  lastFailure:
    "Runtime Host candidate updates are available in the Tauri shell only.",
};

function rejectRendererUpdateInElectron(): Promise<never> {
  return Promise.reject(
    new Error("Renderer-only hot updates are available in the Tauri shell only."),
  );
}

function rejectRuntimeCandidateUpdateInElectron(): Promise<never> {
  return Promise.reject(
    new Error("Runtime Host candidate updates are available in the Tauri shell only."),
  );
}

const api: SovereignDesktopApi = {
  getState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getState) as Promise<DesktopRuntimeState>,
  chooseWorkspace: () =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseWorkspace) as Promise<DesktopRuntimeState>,
  readProjectWorkspaces: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.readProjectWorkspaces, projectId) as Promise<DesktopProjectWorkspaces>,
  chooseProjectWorkspace: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.chooseProjectWorkspace, projectId) as Promise<DesktopProjectWorkspaces>,
  selectProjectWorkspace: (projectId, workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.selectProjectWorkspace, projectId, workspaceId) as Promise<DesktopProjectWorkspaces>,
  start: () =>
    ipcRenderer.invoke(IPC_CHANNELS.start) as Promise<DesktopRuntimeState>,
  stop: () =>
    ipcRenderer.invoke(IPC_CHANNELS.stop) as Promise<DesktopRuntimeState>,
  refresh: () =>
    ipcRenderer.invoke(IPC_CHANNELS.refresh) as Promise<DesktopRuntimeState>,
  getManifest: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getManifest) as Promise<DesktopManifestView | null>,
  getAuditReceipts: (limit = 100) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getAuditReceipts,
      limit,
    ) as Promise<readonly DesktopAuditReceipt[]>,
  getResourceSnapshot: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getResourceSnapshot) as Promise<DesktopResourceSnapshot>,
  getHostStartupState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getHostStartupState) as Promise<DesktopHostStartupState>,
  setLaunchAtLogin: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.setLaunchAtLogin, enabled) as Promise<DesktopHostStartupState>,
  getRuns: (limit = 100) =>
    ipcRenderer.invoke(IPC_CHANNELS.getRuns, limit) as Promise<readonly DesktopRunSummary[]>,
  getRun: (runId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.getRun, runId) as Promise<DesktopRunRecord>,
  cancelRun: (runId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelRun, runId) as Promise<DesktopRunRecord>,
  getTaskWorkspace: (offset = 0, limit = 64) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getTaskWorkspace,
      offset,
      limit,
    ) as Promise<DesktopTaskWorkspaceSnapshot>,
  getTaskDetail: (taskId: string, messageLimit = 200, beforeSequence?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.getTaskDetail, taskId, messageLimit, beforeSequence) as Promise<DesktopTaskDetail>,
  getTaskCoordinationInbox: (
    taskId: string,
    beforeSequence?: number,
    limit = 50,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getTaskCoordinationInbox,
      taskId,
      beforeSequence,
      limit,
    ) as Promise<TaskCoordinationOperatorInbox>,
  sendTaskUserMessage: (taskId: string, content: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.sendTaskUserMessage, taskId, content) as Promise<DesktopTaskDetail>,
  invokeTool: <T = unknown>(
    toolName: DesktopDirectToolName,
    input: Readonly<Record<string, unknown>>,
  ) => ipcRenderer.invoke(IPC_CHANNELS.invokeTool, toolName, input) as Promise<T>,
  copyConnectionBundle: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.copyConnectionBundle,
    ) as Promise<DesktopConnectionCopyResult>,
  rotateCredentials: () =>
    ipcRenderer.invoke(IPC_CHANNELS.rotateCredentials) as Promise<DesktopRuntimeState>,
  setAutoStart: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.setAutoStart, enabled) as Promise<DesktopRuntimeState>,
  setUnattendedWorkspaceAccess: (enabled, workspaceId) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.setUnattendedWorkspaceAccess,
      enabled,
      ...(workspaceId === undefined ? [] : [workspaceId]),
    ) as Promise<DesktopRuntimeState>,
  setPermissionProfile: (profile, workspaceId) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPermissionProfile, profile, ...(workspaceId === undefined ? [] : [workspaceId])) as Promise<DesktopRuntimeState>,
  setWebBridgeUrl: (url) =>
    ipcRenderer.invoke(IPC_CHANNELS.setWebBridgeUrl, url) as Promise<DesktopRuntimeState>,
  configureSecureTunnel: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.configureSecureTunnel, input) as Promise<DesktopRuntimeState>,
  setSecureTunnelAutomation: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.setSecureTunnelAutomation, input) as Promise<DesktopRuntimeState>,
  chooseSecureTunnelExecutable: () =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseSecureTunnelExecutable) as Promise<DesktopRuntimeState>,
  startSecureTunnel: () =>
    ipcRenderer.invoke(IPC_CHANNELS.startSecureTunnel) as Promise<DesktopRuntimeState>,
  stopSecureTunnel: () =>
    ipcRenderer.invoke(IPC_CHANNELS.stopSecureTunnel) as Promise<DesktopRuntimeState>,
  refreshSecureTunnel: () =>
    ipcRenderer.invoke(IPC_CHANNELS.refreshSecureTunnel) as Promise<DesktopRuntimeState>,
  getRendererUpdateStatus: () => Promise.resolve(disabledRendererUpdateStatus),
  getRuntimeRollingStatus: () => Promise.resolve(disabledRuntimeRollingStatus),
  getRuntimeCandidateUpdateStatus: () =>
    Promise.resolve(disabledRuntimeCandidateUpdateStatus),
  installRuntimeCandidateUpdate: () => rejectRuntimeCandidateUpdateInElectron(),
  activateRuntimeCandidateUpdate: () => rejectRuntimeCandidateUpdateInElectron(),
  installRendererUpdate: () => rejectRendererUpdateInElectron(),
  preflightRendererUpdate: () => rejectRendererUpdateInElectron(),
  activateRendererUpdate: () => rejectRendererUpdateInElectron(),
  rollbackRendererUpdate: () => rejectRendererUpdateInElectron(),
  setUiScale: (scale) =>
    ipcRenderer.invoke(IPC_CHANNELS.setUiScale, scale) as Promise<void>,
  onStateChanged(listener): () => void {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopRuntimeState): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.stateChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, handler);
    };
  },
};

contextBridge.exposeInMainWorld("sovereign", api);
