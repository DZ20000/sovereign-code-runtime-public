import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type {
  DesktopAuditReceipt,
  DesktopConnectionCopyResult,
  DesktopDirectToolName,
  DesktopHostStartupState,
  DesktopManifestView,
  DesktopPermissionProfile,
  DesktopProjectWorkspaces,
  DesktopRendererHandoff,
  DesktopRendererUpdateStatus,
  DesktopRuntimeRollingStatus,
  DesktopResourceSnapshot,
  DesktopRunRecord,
  DesktopRunSummary,
  DesktopRuntimeState,
  DesktopTaskDetail,
  DesktopTaskWorkspaceSnapshot,
  TaskCoordinationOperatorInbox,
  DesktopSecureTunnelAutomationInput,
  DesktopSecureTunnelConfigurationInput,
  RuntimeCandidateActivationReceipt,
  RuntimeCandidateInstallReceipt,
  RuntimeCandidateUpdateStatus,
  SovereignDesktopApi,
} from "@sovereign/control-plane-contract";

type TauriUiScale = 1 | 1.1 | 1.25 | 1.5;

let requestedUiScale: TauriUiScale = 1.1;
let displayScaleListenerInstalled = false;

const currentWindow = getCurrentWindow();
const rendererPreflight = currentWindow.label.startsWith("renderer-preflight-");

function rejectDuringRendererPreflight<T>(operation: string): Promise<T> {
  return Promise.reject(
    new Error(
      `${operation} is disabled inside a renderer candidate preflight.`,
    ),
  );
}


async function control<T>(
  method: string,
  params: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  return await invoke<T>(
    rendererPreflight ? "renderer_preflight_control_call" : "control_call",
    { method, params },
  );
}

async function applyTauriUiScale(scale: TauriUiScale): Promise<void> {
  requestedUiScale = scale;
  await getCurrentWebview().setZoom(scale);
}

function installDisplayScaleRecovery(): void {
  if (displayScaleListenerInstalled) {
    return;
  }
  displayScaleListenerInstalled = true;
  void currentWindow
    .onScaleChanged(() => {
      window.setTimeout(() => {
        void getCurrentWebview().setZoom(requestedUiScale);
      }, 0);
    })
    .catch(() => {
      displayScaleListenerInstalled = false;
    });
}

export function createTauriSovereignApi(): SovereignDesktopApi {
  return {
    getState: () => control<DesktopRuntimeState>("state.get"),
    chooseWorkspace: () => control<DesktopRuntimeState>("workspace.choose"),
    readProjectWorkspaces: (projectId) => control<DesktopProjectWorkspaces>("project.workspaces.read", { projectId }),
    chooseProjectWorkspace: (projectId) => control<DesktopProjectWorkspaces>("project.workspace.choose", { projectId }),
    selectProjectWorkspace: (projectId, workspaceId) => control<DesktopProjectWorkspaces>("project.workspace.select", { projectId, workspaceId }),
    start: () => control<DesktopRuntimeState>("runtime.start"),
    stop: () => control<DesktopRuntimeState>("runtime.stop"),
    refresh: () => control<DesktopRuntimeState>("state.get"),
    getManifest: () => control<DesktopManifestView | null>("manifest.get"),
    getAuditReceipts: (limit = 100) =>
      control<readonly DesktopAuditReceipt[]>("audit.list", { limit }),
    getResourceSnapshot: () =>
      invoke<DesktopResourceSnapshot>("resource_snapshot"),
    getHostStartupState: () =>
      invoke<DesktopHostStartupState>("host_startup_state"),
    setLaunchAtLogin: (enabled: boolean) =>
      invoke<DesktopHostStartupState>("host_startup_set", { enabled }),
    getRuns: (limit = 100) =>
      control<readonly DesktopRunSummary[]>("runs.list", { limit }),
    getRun: (runId: string) => control<DesktopRunRecord>("runs.get", { runId }),
    cancelRun: (runId: string) =>
      control<DesktopRunRecord>("runs.cancel", { runId }),
    getTaskWorkspace: (offset = 0, limit = 64) =>
      control<DesktopTaskWorkspaceSnapshot>("tasks.snapshot", {
        offset,
        limit,
      }),
    getTaskDetail: (taskId: string, messageLimit = 200, beforeSequence?: number) =>
      control<DesktopTaskDetail>("tasks.get", { taskId, messageLimit, ...(beforeSequence === undefined ? {} : { beforeSequence }) }),
    getTaskCoordinationInbox: (
      taskId: string,
      beforeSequence?: number,
      limit = 50,
    ) =>
      control<TaskCoordinationOperatorInbox>(
        "tasks.coordination.operator-inbox",
        { taskId, ...(beforeSequence === undefined ? {} : { beforeSequence }), limit },
      ),
    sendTaskUserMessage: (taskId: string, content: string) =>
      control<DesktopTaskDetail>("tasks.message.user", { taskId, content }),
    invokeTool: <T = unknown>(
      toolName: DesktopDirectToolName,
      input: Readonly<Record<string, unknown>>,
    ) => control<T>("tool.invoke", { toolName, input }),
    copyConnectionBundle: () =>
      invoke<DesktopConnectionCopyResult>("copy_connection_bundle"),
    rotateCredentials: () => control<DesktopRuntimeState>("credential.rotate"),
    setAutoStart: (enabled: boolean) =>
      control<DesktopRuntimeState>("settings.auto-start", { enabled }),
    setUnattendedWorkspaceAccess: (enabled: boolean, workspaceId?: string) =>
      control<DesktopRuntimeState>("settings.unattended-workspace-access", {
        enabled,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      }),
    setPermissionProfile: (profile: DesktopPermissionProfile, workspaceId?: string) =>
      control<DesktopRuntimeState>("permission.set", { profile, ...(workspaceId === undefined ? {} : { workspaceId }) }),
    setWebBridgeUrl: (value: string | null) =>
      control<DesktopRuntimeState>("settings.web-bridge", { value }),
    configureSecureTunnel: (input: DesktopSecureTunnelConfigurationInput) =>
      control<DesktopRuntimeState>(
        "tunnel.configure",
        input as unknown as Readonly<Record<string, unknown>>,
      ),
    setSecureTunnelAutomation: (input: DesktopSecureTunnelAutomationInput) =>
      control<DesktopRuntimeState>(
        "tunnel.automation",
        input as unknown as Readonly<Record<string, unknown>>,
      ),
    chooseSecureTunnelExecutable: () =>
      control<DesktopRuntimeState>("tunnel.executable.choose"),
    startSecureTunnel: () => control<DesktopRuntimeState>("tunnel.start"),
    stopSecureTunnel: () => control<DesktopRuntimeState>("tunnel.stop"),
    refreshSecureTunnel: () => control<DesktopRuntimeState>("tunnel.refresh"),
    getRendererUpdateStatus: () =>
      rendererPreflight
        ? rejectDuringRendererPreflight<DesktopRendererUpdateStatus>(
            "Renderer update status",
          )
        : invoke<DesktopRendererUpdateStatus>("renderer_update_status"),
    getRuntimeRollingStatus: () =>
      rendererPreflight
        ? rejectDuringRendererPreflight<DesktopRuntimeRollingStatus>(
            "Runtime rolling status",
          )
        : invoke<DesktopRuntimeRollingStatus>("runtime_rolling_status"),
    getRuntimeCandidateUpdateStatus: () =>
      rendererPreflight
        ? rejectDuringRendererPreflight<RuntimeCandidateUpdateStatus>(
            "Runtime candidate update status",
          )
        : invoke<RuntimeCandidateUpdateStatus>("runtime_candidate_update_status"),
    installRuntimeCandidateUpdate: (releaseId: string) =>
      rendererPreflight
        ? rejectDuringRendererPreflight<RuntimeCandidateInstallReceipt>(
            "Runtime candidate installation",
          )
        : invoke<RuntimeCandidateInstallReceipt>(
            "install_runtime_candidate_update",
            { releaseId },
          ),
    activateRuntimeCandidateUpdate: (releaseId: string) =>
      rendererPreflight
        ? rejectDuringRendererPreflight<RuntimeCandidateActivationReceipt>(
            "Runtime candidate activation",
          )
        : invoke<RuntimeCandidateActivationReceipt>(
            "activate_runtime_candidate_update",
            { releaseId },
          ),
    installRendererUpdate: (releaseId: string) =>
      rendererPreflight
        ? rejectDuringRendererPreflight<DesktopRendererUpdateStatus>(
            "Renderer update installation",
          )
        : invoke<DesktopRendererUpdateStatus>("renderer_update_install", {
            releaseId,
          }),
    preflightRendererUpdate: (releaseId: string) =>
      rendererPreflight
        ? rejectDuringRendererPreflight<DesktopRendererUpdateStatus>(
            "Nested renderer preflight",
          )
        : invoke<DesktopRendererUpdateStatus>("renderer_update_preflight", {
            releaseId,
          }),
    activateRendererUpdate: (
      releaseId: string,
      handoff?: DesktopRendererHandoff,
    ) =>
      rendererPreflight
        ? rejectDuringRendererPreflight<DesktopRendererUpdateStatus>(
            "Renderer activation",
          )
        : invoke<DesktopRendererUpdateStatus>("renderer_update_activate", {
            releaseId,
            handoff: handoff ?? null,
          }),
    rollbackRendererUpdate: (handoff?: DesktopRendererHandoff) =>
      rendererPreflight
        ? rejectDuringRendererPreflight<DesktopRendererUpdateStatus>(
            "Renderer rollback",
          )
        : invoke<DesktopRendererUpdateStatus>("renderer_update_rollback", {
            handoff: handoff ?? null,
          }),
    setUiScale: (scale: TauriUiScale) => applyTauriUiScale(scale),
    onStateChanged: (listener) => {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void listen<DesktopRuntimeState>("runtime-state-changed", (event) => {
        if (!disposed) {
          listener(event.payload);
        }
      }).then((resolvedUnlisten) => {
        if (disposed) {
          resolvedUnlisten();
        } else {
          unlisten = resolvedUnlisten;
        }
      });
      return () => {
        disposed = true;
        unlisten?.();
        unlisten = null;
      };
    },
  };
}

export function installTauriSovereignBridge(): void {
  Object.defineProperty(window, "sovereign", {
    value: createTauriSovereignApi(),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  installDisplayScaleRecovery();
}
