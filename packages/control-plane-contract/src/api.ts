import type { DesktopConnectionCopyResult } from "./connection.js";
import type {
  DesktopRendererHandoff,
  DesktopRendererUpdateStatus,
} from "./renderer-update.js";
import type {
  DesktopAuditReceipt,
  DesktopHostStartupState,
  DesktopManifestView,
  DesktopPermissionProfile,
  DesktopProjectWorkspaces,
  DesktopResourceSnapshot,
  DesktopRunRecord,
  DesktopRunSummary,
  DesktopRuntimeState,
  DesktopSecureTunnelAutomationInput,
  DesktopSecureTunnelConfigurationInput,
} from "./runtime.js";
import type {
  DesktopTaskDetail,
  DesktopTaskWorkspaceSnapshot,
} from "./tasks.js";
import type { TaskCoordinationOperatorInbox } from "./task-coordination.js";
import type { DesktopDirectToolName } from "./tools.js";
import type { DesktopRuntimeRollingStatus } from "./runtime-rolling.js";
import type {
  RuntimeCandidateActivationReceipt,
  RuntimeCandidateInstallReceipt,
  RuntimeCandidateUpdateStatus,
} from "./runtime-candidate-update.js";

export interface SovereignDesktopApi {
  readonly getState: () => Promise<DesktopRuntimeState>;
  readonly chooseWorkspace: () => Promise<DesktopRuntimeState>;
  readonly readProjectWorkspaces: (projectId: string) => Promise<DesktopProjectWorkspaces>;
  readonly chooseProjectWorkspace: (projectId: string) => Promise<DesktopProjectWorkspaces>;
  readonly selectProjectWorkspace: (projectId: string, workspaceId: string) => Promise<DesktopProjectWorkspaces>;
  readonly start: () => Promise<DesktopRuntimeState>;
  readonly stop: () => Promise<DesktopRuntimeState>;
  readonly refresh: () => Promise<DesktopRuntimeState>;
  readonly getManifest: () => Promise<DesktopManifestView | null>;
  readonly getAuditReceipts: (
    limit?: number,
  ) => Promise<readonly DesktopAuditReceipt[]>;
  readonly getResourceSnapshot: () => Promise<DesktopResourceSnapshot>;
  readonly getHostStartupState: () => Promise<DesktopHostStartupState>;
  readonly setLaunchAtLogin: (
    enabled: boolean,
  ) => Promise<DesktopHostStartupState>;
  readonly getRuns: (limit?: number) => Promise<readonly DesktopRunSummary[]>;
  readonly getRun: (runId: string) => Promise<DesktopRunRecord>;
  readonly cancelRun: (runId: string) => Promise<DesktopRunRecord>;
  readonly getTaskWorkspace: (
    offset?: number,
    limit?: number,
  ) => Promise<DesktopTaskWorkspaceSnapshot>;
  readonly getTaskDetail: (
    taskId: string,
    messageLimit?: number,
    beforeSequence?: number,
  ) => Promise<DesktopTaskDetail>;
  readonly getTaskCoordinationInbox: (
    taskId: string,
    beforeSequence?: number,
    limit?: number,
  ) => Promise<TaskCoordinationOperatorInbox>;
  readonly sendTaskUserMessage: (
    taskId: string,
    content: string,
  ) => Promise<DesktopTaskDetail>;
  readonly invokeTool: <T = unknown>(
    toolName: DesktopDirectToolName,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<T>;
  readonly copyConnectionBundle: () => Promise<DesktopConnectionCopyResult>;
  readonly rotateCredentials: () => Promise<DesktopRuntimeState>;
  readonly setAutoStart: (enabled: boolean) => Promise<DesktopRuntimeState>;
  readonly setUnattendedWorkspaceAccess: (
    enabled: boolean,
    workspaceId?: string,
  ) => Promise<DesktopRuntimeState>;
  readonly setPermissionProfile: (
    profile: DesktopPermissionProfile,
    workspaceId?: string,
  ) => Promise<DesktopRuntimeState>;
  readonly setWebBridgeUrl: (
    url: string | null,
  ) => Promise<DesktopRuntimeState>;
  readonly configureSecureTunnel: (
    input: DesktopSecureTunnelConfigurationInput,
  ) => Promise<DesktopRuntimeState>;
  readonly setSecureTunnelAutomation: (
    input: DesktopSecureTunnelAutomationInput,
  ) => Promise<DesktopRuntimeState>;
  readonly chooseSecureTunnelExecutable: () => Promise<DesktopRuntimeState>;
  readonly startSecureTunnel: () => Promise<DesktopRuntimeState>;
  readonly stopSecureTunnel: () => Promise<DesktopRuntimeState>;
  readonly refreshSecureTunnel: () => Promise<DesktopRuntimeState>;
  readonly getRendererUpdateStatus: () => Promise<DesktopRendererUpdateStatus>;
  readonly getRuntimeRollingStatus: () => Promise<DesktopRuntimeRollingStatus>;
  readonly installRendererUpdate: (
    releaseId: string,
  ) => Promise<DesktopRendererUpdateStatus>;
  readonly preflightRendererUpdate: (
    releaseId: string,
  ) => Promise<DesktopRendererUpdateStatus>;
  readonly activateRendererUpdate: (
    releaseId: string,
    handoff?: DesktopRendererHandoff,
  ) => Promise<DesktopRendererUpdateStatus>;
  readonly rollbackRendererUpdate: (
    handoff?: DesktopRendererHandoff,
  ) => Promise<DesktopRendererUpdateStatus>;
  readonly setUiScale: (scale: 1 | 1.1 | 1.25 | 1.5) => Promise<void>;
  readonly onStateChanged: (
    listener: (state: DesktopRuntimeState) => void,
  ) => () => void;

  getRuntimeCandidateUpdateStatus(): Promise<RuntimeCandidateUpdateStatus>;
  installRuntimeCandidateUpdate(
    releaseId: string,
  ): Promise<RuntimeCandidateInstallReceipt>;
  activateRuntimeCandidateUpdate(
    releaseId: string,
  ): Promise<RuntimeCandidateActivationReceipt>;
}
