import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  type NativeImage,
} from "electron";

import { verifyTaskHub } from "./visual-task-verification.js";
import { verifyTaskWorkbench } from "./visual-task-workbench-verification.js";
import { verifyProjectWorkspace } from "./visual-project-workspace-verification.js";
import { verifyOverviewActivity } from "./visual-overview-verification.js";
import { verifyAgentConnectionSurface } from "./visual-agent-verification.js";
import { registerGeminiConnectionFixture } from "./visual-gemini-fixture.js";
import { verifyGeminiConnection } from "./visual-gemini-verification.js";
import { verifySharedControls } from "./visual-shared-controls-verification.js";
import { verifyWorkbenchInteractions } from "./visual-interaction-verification.js";
import { registerApprovalFixture } from "./visual-approval-fixture.js";
import { verifyApprovalWindows } from "./visual-approval-verification.js";
import { verifyHistorySurfaces } from "./visual-history-verification.js";
import { verifyPermissionLifecycle } from "./visual-permission-verification.js";
import { applyVisualContext, captureV2VisualMatrix, verifyInitialV2Navigation, type VisualMatrixCapture } from "./visual-matrix-verification.js";
import { visualScreenshotPath, VISUAL_MATRIX } from "./visual-matrix.js";
import { createVisualPreviewFixtures } from "./visual-preview-fixture.js";
import { activateVisualView } from "./visual-navigation.js";
import { validateVisualWorkspace } from "../scripts/visual-workspace.mjs";

import {
  IPC_CHANNELS,
  type DesktopAuditReceipt,
  type DesktopBrowserObservation,
  type DesktopBrowserSession,
  type DesktopComputerObservation,
  type DesktopConnectionCopyResult,
  type DesktopHostStartupState,
  type DesktopManifestView,
  type DesktopPythonCapabilities,
  type DesktopPermissionProfile,
  type DesktopProjectWorkspace,
  type DesktopProjectWorkspaces,
  type DesktopResourceSnapshot,
  type DesktopRunRecord,
  type DesktopRunSummary,
  type DesktopRuntimeState,
  type DesktopTaskDetail,
  type DesktopTaskListItem,
  type DesktopTaskMessage,
  type DesktopTaskProjectSummary,
  type DesktopTaskSummary,
  type DesktopTaskWorkspaceSnapshot,
  type TaskCoordinationOperatorInbox,
  type DesktopTerminalSession,
} from "./shared.js";
import {
  layoutAuditScript,
  type LayoutAudit,
} from "./visual-layout-audit.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = dirname(currentFile);
const RENDERER_SCHEME = "scr-app";
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://app/`;
const visualWorkspace = validateVisualWorkspace(resolve(currentDirectory, "../../../.."), process.env);
const OUTPUT_ROOT = visualWorkspace.outputRoot;
const USER_DATA_ROOT = visualWorkspace.userDataRoot;

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.setPath("userData", USER_DATA_ROOT);
app.on("window-all-closed", () => {
  // The visual harness controls shutdown explicitly after all smoke checks finish.
});

const capabilities = [
  "system.read",
  "system.notify",
  "workspace.read",
  "files.read",
  "files.write",
  "files.destructive",
  "search.read",
  "git.read",
  "git.write",
  "python.run",
  "runs.read",
  "runs.cancel",
  "tasks.read",
  "tasks.write",
  "validation.run",
  "terminal.observe",
  "terminal.run",
  "browser.observe",
  "browser.control",
  "network.access",
  "workflow.run",
  "subagent.run",
  "computer.observe",
  "computer.control",
] as const;

let state: DesktopRuntimeState = {
  phase: "running",
  runtimeVersion: "0.1.7",
  workspaceRoot: "C:\\Projects\\sovereign-code-runtime",
  endpoint: "http://127.0.0.1:3210/mcp",
  manifestDigest: "4cdb99fe640dd4930c923070b63baa79016dad0c1bc4024cb642adc21ee2245c",
  toolCount: 56,
  sessionCount: 2,
  capabilities,
  tokenStorage: "main-process-memory",
  credentialGeneration: 2,
  autoStart: true,
  unattendedWorkspaceAccess: true,
  permissionProfile: "consequential",
  rememberedPermissionProfile: "consequential",
  activeToolActivities: [
    {
      id: "activity-visual-files",
      toolName: "files.replace_text",
      title: "Replace text",
      category: "files",
      workspaceId: "desktop-workspace",
      startedAt: "2026-08-10T07:59:19.000Z",
    },
  ],
  webBridgeUrl: "https://sovereign.example.test/mcp",
  secureTunnel: {
    phase: "ready",
    clientAvailable: true,
    executablePath: "C:\\Tools\\tunnel-client.exe",
    executableSha256: "e".repeat(64),
    executableTrusted: true,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    processId: 42140,
    hasRuntimeApiKey: true,
    runtimeApiKeyStorage: "windows-protected",
    controlPlaneProxyConfigured: true,
    controlPlaneProxyDisplay: "http://proxy.example.test:8080",
    controlPlaneProxyStorage: "windows-protected",
    controlPlaneBackupProxyConfigured: true,
    controlPlaneBackupProxyDisplay: "https://backup-proxy.example.test:8443",
    controlPlaneBackupProxyStorage: "windows-protected",
    controlPlaneDirectFallbackEnabled: false,
    controlPlaneRouting: {
      schemaVersion: "scr.control-plane-routing/v1",
      enabled: true,
      lifecycle: "running",
      routeOrder: ["primary", "backup"],
      activeRoute: "primary",
      activeRouteDisplay: "Primary proxy · http://proxy.example.test:8080",
      switchCount: 0,
      lastSwitchAt: null,
      circuitReason: null,
      routes: {
        primary: {
          configured: true,
          display: "Primary proxy · http://proxy.example.test:8080",
          status: "ready",
        },
        backup: {
          configured: true,
          display: "Backup proxy · https://backup-proxy.example.test:8443",
          status: "untested",
        },
        direct: {
          configured: false,
          display: "Direct fallback",
          status: "disabled",
        },
      },
    },
    autoStart: true,
    autoReconnect: true,
    desiredRunning: true,
    reconnectAttempt: 0,
    nextReconnectAt: null,
    lastReadyAt: "2026-08-11T14:00:00.000Z",
    healthUrl: "http://127.0.0.1:41001",
    errorMessage: null,
    failureDiagnostic: null,
    logTail: "secure tunnel ready\n",
  },
  errorMessage: null,
};

const visualResources: DesktopResourceSnapshot = {
  schemaVersion: "scr.resources/v1",
  capturedAt: "2026-08-11T14:00:00.000Z",
  uptimeMs: 180_000,
  runtimePlacement: "embedded-main",
  shellExecutablePath: "C:\\Tools\\SovereignCodeRuntime.exe",
  shellLaunchKind: "legacy-electron",
  processes: [
    {
      processId: 42080,
      role: "desktop-main",
      label: "Sovereign Code Runtime",
      workingSetBytes: 72 * 1024 * 1024,
      privateBytes: 54 * 1024 * 1024,
      cpuPercent: 0.4,
    },
    {
      processId: 42090,
      role: "renderer",
      label: "Sovereign Code Runtime",
      workingSetBytes: 98 * 1024 * 1024,
      privateBytes: 76 * 1024 * 1024,
      cpuPercent: 0.8,
    },
    {
      processId: 42140,
      role: "tunnel",
      label: "Secure MCP Tunnel",
      workingSetBytes: 20 * 1024 * 1024,
      privateBytes: 16 * 1024 * 1024,
      cpuPercent: null,
    },
  ],
  totals: {
    shellWorkingSetBytes: 170 * 1024 * 1024,
    shellPrivateBytes: 130 * 1024 * 1024,
    runtimeWorkingSetBytes: 0,
    runtimePrivateBytes: 0,
    serviceWorkingSetBytes: 20 * 1024 * 1024,
    servicePrivateBytes: 16 * 1024 * 1024,
    productWorkingSetBytes: 190 * 1024 * 1024,
    productPrivateBytes: 146 * 1024 * 1024,
    processCount: 3,
  },
};

let visualHostStartup: DesktopHostStartupState = {
  schemaVersion: "scr.host-startup/v1",
  supported: true,
  enabled: true,
  executablePath: "C:\\Tools\\SovereignCodeRuntime.exe",
  launchKind: "installed",
  registeredCommand: "\"C:\\Tools\\SovereignCodeRuntime.exe\" --autostart",
  warning: null,
  guardian: {
    available: true,
    processId: 42070,
    closeToTray: true,
    circuitOpen: false,
    lastIncident: {
      occurredAt: "2026-08-11T13:55:00.000Z",
      outcome: "restarted",
      reason: "runtime-host-process-or-protocol-unhealthy",
      restartCountInWindow: 1,
    },
  },
  availability: {
    schemaVersion: "scr.host-availability/v1",
    available: true,
    monitorStartedAt: "2026-08-11T13:00:00.000Z",
    sampledAt: "2026-08-11T14:00:00.000Z",
    monitorIntervalMs: 5_000,
    possibleSuspendGapThresholdMs: 20_000,
    eventStorage: "persistent",
    systemUptimeMs: 9_600_000,
    powerSource: "ac",
    batteryPercent: 86,
    batterySaver: false,
    possibleSuspendCount: 1,
    lastPossibleSuspendAt: "2026-08-11T13:45:00.000Z",
    lastPossibleSuspendDurationMs: 64_000,
    networkState: "ready",
    networkDesired: true,
    lastNetworkCheckAt: "2026-08-11T14:00:00.000Z",
    lastNetworkReadyAt: "2026-08-11T13:46:05.000Z",
    lastNetworkLossAt: "2026-08-11T13:45:01.000Z",
    lastNetworkRecoveryAt: "2026-08-11T13:46:05.000Z",
    lastNetworkOutageDurationMs: 64_000,
    reconnectAttempt: 0,
    nextReconnectAt: null,
    detail: null,
    recentEvents: [
      {
        occurredAt: "2026-08-11T13:45:00.000Z",
        kind: "possible-suspend-or-stall",
        detail: "Host monitor observed a 64000 ms scheduling gap.",
        durationMs: 64_000,
      },
      {
        occurredAt: "2026-08-11T13:46:05.000Z",
        kind: "network-recovered",
        detail: "Secure MCP Tunnel returned to ready.",
        durationMs: 64_000,
      },
    ],
  },
};

const manifest: DesktopManifestView = {
  schemaVersion: "scr.tools/v1",
  runtimeVersion: "0.1.7",
  generatedAt: "2026-08-10T08:00:00.000Z",
  digest: state.manifestDigest ?? "",
  tools: [
    {
      name: "system.info",
      version: "1.0.0",
      title: "Runtime information",
      category: "system",
      requiredCapabilities: ["system.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "system.audit_receipts",
      version: "1.0.0",
      title: "List audit receipts",
      category: "system",
      requiredCapabilities: ["system.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "system.notify",
      version: "1.0.0",
      title: "Show Windows notification",
      category: "system",
      requiredCapabilities: ["system.notify"],
      sideEffect: "process",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "session",
    },
    {
      name: "workspace.list",
      version: "1.0.0",
      title: "List workspace entries",
      category: "workspace",
      requiredCapabilities: ["workspace.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "files.read",
      version: "1.0.0",
      title: "Read a contained file",
      category: "files",
      requiredCapabilities: ["files.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "files.create",
      version: "1.0.0",
      title: "Create a contained file",
      category: "files",
      requiredCapabilities: ["files.write"],
      sideEffect: "write",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "session",
    },
    {
      name: "files.replace",
      version: "1.0.0",
      title: "Replace with SHA-256 guard",
      category: "files",
      requiredCapabilities: ["files.write"],
      sideEffect: "write",
      destructive: true,
      permissionLevel: "workspace",
      approvalMode: "session",
    },
    {
      name: "files.move",
      version: "1.0.0",
      title: "Move with SHA-256 guard",
      category: "files",
      requiredCapabilities: ["files.read", "files.write"],
      sideEffect: "write",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "session",
    },
    {
      name: "files.delete",
      version: "1.0.0",
      title: "Delete with SHA-256 guard",
      category: "files",
      requiredCapabilities: ["files.read", "files.write", "files.destructive"],
      sideEffect: "write",
      destructive: true,
      permissionLevel: "consequential",
      approvalMode: "single-use",
    },
    {
      name: "search.text",
      version: "1.0.0",
      title: "Search workspace text",
      category: "search",
      requiredCapabilities: ["search.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "git.status",
      version: "1.0.0",
      title: "Read Git status",
      category: "git",
      requiredCapabilities: ["git.read"],
      sideEffect: "process",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "git.diff",
      version: "1.0.0",
      title: "Read Git diff",
      category: "git",
      requiredCapabilities: ["git.read"],
      sideEffect: "process",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "git.stage",
      version: "1.0.0",
      title: "Stage Git paths",
      category: "git",
      requiredCapabilities: ["git.write"],
      sideEffect: "write",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "session",
    },
    {
      name: "git.commit",
      version: "1.0.0",
      title: "Create local Git commit",
      category: "git",
      requiredCapabilities: ["git.write"],
      sideEffect: "write",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "session",
    },
    {
      name: "python.capabilities",
      version: "1.0.0",
      title: "Python capabilities",
      category: "python",
      requiredCapabilities: ["system.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "python.start",
      version: "1.0.0",
      title: "Start Python run",
      category: "python",
      requiredCapabilities: ["python.run"],
      sideEffect: "process",
      destructive: true,
      permissionLevel: "consequential",
      approvalMode: "single-use",
    },
    {
      name: "runs.list",
      version: "1.0.0",
      title: "List runs",
      category: "runs",
      requiredCapabilities: ["runs.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "runs.get",
      version: "1.0.0",
      title: "Get run",
      category: "runs",
      requiredCapabilities: ["runs.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "runs.wait",
      version: "1.0.0",
      title: "Wait for run",
      category: "runs",
      requiredCapabilities: ["runs.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "runs.cancel",
      version: "1.0.0",
      title: "Cancel run",
      category: "runs",
      requiredCapabilities: ["runs.cancel"],
      sideEffect: "process",
      destructive: true,
      permissionLevel: "workspace",
      approvalMode: "session",
    },
    {
      name: "validation.start",
      version: "1.0.0",
      title: "Start background validation",
      category: "validation",
      requiredCapabilities: ["validation.run"],
      sideEffect: "process",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "session",
    },
    {
      name: "validation.run",
      version: "1.0.0",
      title: "Run fixed validation",
      category: "validation",
      requiredCapabilities: ["validation.run"],
      sideEffect: "process",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "session",
    },
    {
      name: "terminal.start",
      version: "1.0.0",
      title: "Start PowerShell run",
      category: "terminal",
      requiredCapabilities: ["terminal.run"],
      sideEffect: "process",
      destructive: true,
      permissionLevel: "consequential",
      approvalMode: "single-use",
    },
    {
      name: "terminal.exec",
      version: "1.0.0",
      title: "Run PowerShell command",
      category: "terminal",
      requiredCapabilities: ["terminal.run"],
      sideEffect: "process",
      destructive: true,
      permissionLevel: "consequential",
      approvalMode: "single-use",
    },
    {
      name: "terminal.session.create",
      version: "1.0.0",
      title: "Create interactive terminal",
      category: "terminal",
      requiredCapabilities: ["terminal.run"],
      sideEffect: "process",
      destructive: true,
      permissionLevel: "consequential",
      approvalMode: "single-use",
    },
    {
      name: "browser.session.create",
      version: "1.0.0",
      title: "Create managed browser",
      category: "browser",
      requiredCapabilities: ["browser.control", "network.access"],
      sideEffect: "process",
      destructive: true,
      permissionLevel: "consequential",
      approvalMode: "single-use",
    },
    {
      name: "browser.click",
      version: "1.0.0",
      title: "Click managed browser element",
      category: "browser",
      requiredCapabilities: ["browser.control", "network.access"],
      sideEffect: "process",
      destructive: true,
      permissionLevel: "consequential",
      approvalMode: "single-use",
    },
    {
      name: "browser.type",
      version: "1.0.0",
      title: "Type into managed browser element",
      category: "browser",
      requiredCapabilities: ["browser.control", "network.access"],
      sideEffect: "process",
      destructive: true,
      permissionLevel: "consequential",
      approvalMode: "single-use",
    },
    {
      name: "workflow.start",
      version: "1.0.0",
      title: "Start workflow",
      category: "workflow",
      requiredCapabilities: ["workflow.run"],
      sideEffect: "process",
      destructive: true,
      permissionLevel: "consequential",
      approvalMode: "single-use",
    },
    {
      name: "tasks.list",
      version: "1.0.0",
      title: "List projects and tasks",
      category: "tasks",
      requiredCapabilities: ["tasks.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "tasks.get",
      version: "1.0.0",
      title: "Read task detail",
      category: "tasks",
      requiredCapabilities: ["tasks.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "tasks.create",
      version: "1.0.0",
      title: "Create or claim task",
      category: "tasks",
      requiredCapabilities: ["tasks.write"],
      sideEffect: "write",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "none",
    },
    {
      name: "tasks.update",
      version: "1.0.0",
      title: "Update task",
      category: "tasks",
      requiredCapabilities: ["tasks.write"],
      sideEffect: "write",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "none",
    },
    {
      name: "tasks.heartbeat",
      version: "1.0.0",
      title: "Update Agent heartbeat",
      category: "tasks",
      requiredCapabilities: ["tasks.write"],
      sideEffect: "write",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "none",
    },
    {
      name: "tasks.messages.list",
      version: "1.0.0",
      title: "Read task messages",
      category: "tasks",
      requiredCapabilities: ["tasks.read"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
    {
      name: "tasks.message.send",
      version: "1.0.0",
      title: "Send task message",
      category: "tasks",
      requiredCapabilities: ["tasks.write"],
      sideEffect: "write",
      destructive: false,
      permissionLevel: "workspace",
      approvalMode: "none",
    },
    {
      name: "computer.observe",
      version: "1.0.0",
      title: "Observe Windows desktop",
      category: "computer",
      requiredCapabilities: ["computer.observe"],
      sideEffect: "read",
      destructive: false,
      permissionLevel: "observe",
      approvalMode: "none",
    },
  ],
};

const auditReceipts: readonly DesktopAuditReceipt[] = [
  {
    id: "receipt-visual-001",
    occurredAt: "2026-08-10T07:58:20.000Z",
    principalId: "desktop-owner",
    toolName: "files.replace",
    operation: "replace",
    outcome: "succeeded",
    workspaceId: "desktop-workspace",
    relativePath: "apps/desktop/src/renderer/v2.css",
    beforeSha256: "a".repeat(64),
    afterSha256: "b".repeat(64),
    errorCode: null,
  },
  {
    id: "receipt-visual-002",
    occurredAt: "2026-08-10T07:57:05.000Z",
    principalId: "desktop-owner",
    toolName: "files.replace",
    operation: "replace",
    outcome: "denied",
    workspaceId: "desktop-workspace",
    relativePath: "..\\outside.txt",
    beforeSha256: null,
    afterSha256: null,
    errorCode: "PATH_REJECTED",
  },
  {
    id: "receipt-visual-003",
    occurredAt: "2026-08-10T07:55:44.000Z",
    principalId: "desktop-owner",
    toolName: "files.create",
    operation: "create",
    outcome: "failed",
    workspaceId: "desktop-workspace",
    relativePath: "notes\\existing.txt",
    beforeSha256: null,
    afterSha256: null,
    errorCode: "FILE_EXISTS",
  },
];


const visualTaskMessages = new Map<string, DesktopTaskMessage[]>([
  [
    "task-visual-agent-hub",
    [
      {
        id: "message-task-hub-1",
        taskId: "task-visual-agent-hub",
        sequence: 1,
        role: "system",
        agentId: null,
        agentName: null,
        content: "Task created with status running.",
        createdAt: "2026-08-20T07:55:00.000Z",
        acknowledgedAt: "2026-08-20T07:55:02.000Z",
      },
      {
        id: "message-task-hub-2",
        taskId: "task-visual-agent-hub",
        sequence: 2,
        role: "assistant",
        agentId: "agent-sovereign-ui",
        agentName: "Sovereign Agent",
        content: "The persistent task registry and Agent heartbeat API are ready. I am connecting the large project cards and conversation pane now.",
        createdAt: "2026-08-20T07:56:10.000Z",
        acknowledgedAt: null,
      },
      {
        id: "message-task-hub-3",
        taskId: "task-visual-agent-hub",
        sequence: 3,
        role: "user",
        agentId: null,
        agentName: null,
        content: "Keep every project in a large separate block and let me talk to the Agent inside the task.",
        createdAt: "2026-08-20T07:57:00.000Z",
        acknowledgedAt: "2026-08-20T07:57:08.000Z",
      },
      {
        id: "message-task-hub-4",
        taskId: "task-visual-agent-hub",
        sequence: 4,
        role: "assistant",
        agentId: "agent-sovereign-ui",
        agentName: "Sovereign Agent",
        content: "Acknowledged. The project view uses large blocks; task detail includes plan, heartbeat, progress and a dedicated conversation window.",
        createdAt: "2026-08-20T07:57:12.000Z",
        acknowledgedAt: null,
      },
    ],
  ],
  [
    "task-visual-release",
    [
      {
        id: "message-release-1",
        taskId: "task-visual-release",
        sequence: 1,
        role: "system",
        agentId: null,
        agentName: null,
        content: "Task created with status planning.",
        createdAt: "2026-08-20T07:54:00.000Z",
        acknowledgedAt: null,
      },
      ...Array.from({ length: 349 }, (_, index): DesktopTaskMessage => ({
        id: `message-release-${index + 2}`,
        taskId: "task-visual-release",
        sequence: index + 2,
        role: "assistant",
        agentId: "agent-release",
        agentName: "Release Agent",
        content: `Retained release checkpoint ${index + 2}: review its validation evidence before continuing.`,
        createdAt: "2026-08-20T07:54:00.000Z",
        acknowledgedAt: null,
      })),
    ],
  ],
  [
    "task-visual-inferred",
    [
      {
        id: "message-inferred-1",
        taskId: "task-visual-inferred",
        sequence: 1,
        role: "system",
        agentId: null,
        agentName: null,
        content: "Task created with status running.",
        createdAt: "2026-08-20T07:59:20.000Z",
        acknowledgedAt: null,
      },
      {
        id: "message-inferred-2",
        taskId: "task-visual-inferred",
        sequence: 2,
        role: "user",
        agentId: null,
        agentName: null,
        content: "Can an Agent read this after claiming the activity?",
        createdAt: "2026-08-20T07:59:28.000Z",
        acknowledgedAt: null,
      },
    ],
  ],
  [
    "task-visual-sample-clipboard",
    [
      {
        id: "message-sample-clipboard-1",
        taskId: "task-visual-sample-clipboard",
        sequence: 1,
        role: "system",
        agentId: null,
        agentName: null,
        content: "Agent connection stopped before the task reported completion.",
        createdAt: "2026-08-20T07:40:00.000Z",
        acknowledgedAt: null,
      },
    ],
  ],
]);

type VisualTaskProject = Omit<DesktopTaskProjectSummary, "tasks"> & {
  readonly tasks: readonly DesktopTaskSummary[];
};

let visualTaskRevision = 1;
let visualTaskGeneratedAt = "2026-08-20T07:59:20.000Z";
let visualTaskProjects: readonly VisualTaskProject[] = [
    {
      id: "project-visual-sovereign",
      name: "Sovereign Code Runtime",
      root: "C:\\Projects\\sovereign-code-runtime",
      status: "active",
      taskCount: 3,
      activeTaskCount: 3,
      attentionTaskCount: 0,
      onlineAgentCount: 2,
      updatedAt: "2026-08-20T07:59:18.000Z",
      tasks: [
        {
          id: "task-visual-agent-hub",
          projectId: "project-visual-sovereign",
          projectName: "Sovereign Code Runtime",
          projectRoot: "C:\\Projects\\sovereign-code-runtime",
          title: "Build task and Agent hub",
          category: "development",
          status: "running",
          source: "agent",
          summary: "Give the operator a project-level view of Agent work with task detail and direct conversation.",
          currentStep: "Connect project cards, task detail and the Agent conversation window",
          progress: { current: 4, total: 7, label: "Desktop task experience" },
          steps: [
            { id: "model", title: "Create persistent project and task model", status: "succeeded", updatedAt: "2026-08-20T07:52:00.000Z" },
            { id: "tools", title: "Expose task tools and heartbeat protocol", status: "succeeded", updatedAt: "2026-08-20T07:54:00.000Z" },
            { id: "ui", title: "Build project blocks and task detail", status: "running", updatedAt: "2026-08-20T07:59:18.000Z" },
            { id: "visual", title: "Validate conversation and responsive layout", status: "pending", updatedAt: "2026-08-20T07:59:18.000Z" },
          ],
          agent: {
            id: "agent-sovereign-ui",
            name: "Sovereign Agent",
            principalId: "chatgpt-web",
            presence: "online",
            lastHeartbeatAt: "2026-08-20T07:59:18.000Z",
          },
          lastActivityLabel: "Update task panel",
          lastActivityAt: "2026-08-20T07:59:18.000Z",
          unreadUserMessageCount: 0,
          coordinationPendingCount: 1,
          messageCount: 4,
          createdAt: "2026-08-20T07:50:00.000Z",
          updatedAt: "2026-08-20T07:59:18.000Z",
          completedAt: null,
        },
        {
          id: "task-visual-release",
          projectId: "project-visual-sovereign",
          projectName: "Sovereign Code Runtime",
          projectRoot: "C:\\Projects\\sovereign-code-runtime",
          title: "Package and verify the next desktop release",
          category: "build",
          status: "planning",
          source: "agent",
          summary: "Prepare an installable checkpoint after the task hub passes all product gates.",
          currentStep: "Waiting for task hub validation",
          progress: { current: 1, total: 4, label: "Release checkpoint" },
          steps: [],
          agent: {
            id: "agent-release",
            name: "Release Agent",
            principalId: "chatgpt-web",
            presence: "online",
            lastHeartbeatAt: "2026-08-20T07:58:55.000Z",
          },
          lastActivityLabel: "Review release inputs",
          lastActivityAt: "2026-08-20T07:58:55.000Z",
          unreadUserMessageCount: 0,
          coordinationPendingCount: 0,
          messageCount: 350,
          createdAt: "2026-08-20T07:54:00.000Z",
          updatedAt: "2026-08-20T07:58:55.000Z",
          completedAt: null,
        },
        {
          id: "task-visual-inferred",
          projectId: "project-visual-sovereign",
          projectName: "Sovereign Code Runtime",
          projectRoot: "C:\\Projects\\sovereign-code-runtime",
          title: "Unclaimed terminal activity",
          category: "development",
          status: "running",
          source: "inferred",
          summary: "Automatically grouped tool activity that has not been claimed by a task Agent.",
          currentStep: "Inspect task page styles",
          progress: { current: null, total: null, label: null },
          steps: [],
          agent: {
            id: "chatgpt-web",
            name: "ChatGPT Agent",
            principalId: "chatgpt-web",
            presence: "online",
            lastHeartbeatAt: "2026-08-20T07:59:30.000Z",
          },
          lastActivityLabel: "Inspect task page styles",
          lastActivityAt: "2026-08-20T07:59:30.000Z",
          unreadUserMessageCount: 1,
          coordinationPendingCount: 0,
          messageCount: 2,
          createdAt: "2026-08-20T07:59:20.000Z",
          updatedAt: "2026-08-20T07:59:30.000Z",
          completedAt: null,
        },
      ],
    },
    {
      id: "project-visual-sample-clipboard",
      name: "Sample Clipboard",
      root: "C:\\Projects\\sovereign-code-runtime\\sample-clipboard",
      status: "attention",
      taskCount: 1,
      activeTaskCount: 0,
      attentionTaskCount: 1,
      onlineAgentCount: 0,
      updatedAt: "2026-08-20T07:40:00.000Z",
      tasks: [
        {
          id: "task-visual-sample-clipboard",
          projectId: "project-visual-sample-clipboard",
          projectName: "Sample Clipboard",
          projectRoot: "C:\\Projects\\sovereign-code-runtime\\sample-clipboard",
          title: "Review clipboard integration",
          category: "maintenance",
          status: "blocked",
          source: "agent",
          summary: "Continue after the project Agent reconnects.",
          currentStep: "Agent connection stopped before completion",
          progress: { current: 2, total: 5, label: "Integration review" },
          steps: [],
          agent: {
            id: "agent-sample-clipboard",
            name: "Sample Agent",
            principalId: "chatgpt-web",
            presence: "offline",
            lastHeartbeatAt: "2026-08-20T07:35:00.000Z",
          },
          lastActivityLabel: "Read Android integration files",
          lastActivityAt: "2026-08-20T07:35:00.000Z",
          unreadUserMessageCount: 0,
          coordinationPendingCount: 0,
          messageCount: 1,
          createdAt: "2026-08-20T07:30:00.000Z",
          updatedAt: "2026-08-20T07:40:00.000Z",
          completedAt: null,
        },
      ],
    },
  ];

function visualTaskListItem(task: DesktopTaskSummary): DesktopTaskListItem {
  return {
    id: task.id,
    title: task.title,
    category: task.category,
    status: task.status,
    source: task.source,
    summaryPreview: task.summary,
    currentStep: task.currentStep,
    progress: task.progress,
    agent: {
      id: task.agent.id,
      name: task.agent.name,
      presence: task.agent.presence,
      lastHeartbeatAt: task.agent.lastHeartbeatAt,
    },
    lastActivityLabel: task.lastActivityLabel,
    lastActivityAt: task.lastActivityAt,
    unreadUserMessageCount: task.unreadUserMessageCount,
    coordinationPendingCount: task.coordinationPendingCount,
    messageCount: task.messageCount,
    updatedAt: task.updatedAt,
  };
}

function visualTaskWorkspace(
  offset = 0,
  limit = 64,
): DesktopTaskWorkspaceSnapshot {
  const entries = visualTaskProjects.flatMap((project) =>
    project.tasks.map((task) => ({ project, task }))
  );
  const selected = entries.slice(offset, offset + limit);
  const projects = visualTaskProjects.flatMap((project) => {
    const tasks = selected
      .filter((entry) => entry.project.id === project.id)
      .map((entry) => visualTaskListItem(entry.task));
    return tasks.length === 0 ? [] : [{ ...project, tasks }];
  });
  const nextOffset = offset + selected.length < entries.length
    ? offset + selected.length
    : null;
  return {
    schemaVersion: "scr.task-workspace/v1",
    generatedAt: visualTaskGeneratedAt,
    revision: visualTaskRevision,
    offset,
    limit: selected.length,
    totalTaskCount: entries.length,
    totalProjectCount: visualTaskProjects.length,
    nextOffset,
    projects,
  };
}

function visualTaskCoordinationInbox(
  taskId: string,
): TaskCoordinationOperatorInbox {
  const task = visualTask(taskId);
  if (taskId !== "task-visual-agent-hub") {
    return {
      schemaVersion: "scr.task-coordination-operator-inbox/v1",
      taskId,
      generatedAt: visualTaskGeneratedAt,
      messages: [],
      unreadCount: 0,
      pendingCount: 0,
      firstSequence: null,
      lastSequence: null,
      nextBeforeSequence: null,
      truncated: false,
    };
  }
  return {
    schemaVersion: "scr.task-coordination-operator-inbox/v1",
    taskId,
    generatedAt: visualTaskGeneratedAt,
    unreadCount: 1,
    pendingCount: 1,
    firstSequence: 1,
    lastSequence: 1,
    nextBeforeSequence: null,
    truncated: false,
    messages: [
      {
        schemaVersion: "scr.task-coordination-message/v2",
        id: "visual-coordination-1",
        ordinal: 1,
        recipientSequence: 1,
        senderSequence: 1,
        kind: "handoff",
        sender: {
          taskId: "task-visual-release",
          taskTitle: "Package and verify the next desktop release",
          sessionId: "visual-release-session",
          agentId: "agent-release",
          agentName: "Release Agent",
        },
        recipient: {
          taskId,
          taskTitle: task.title,
          taskStatus: task.status,
          intendedAgentId: task.agent.id,
          intendedAgentName: task.agent.name,
          deliveredSessionId: null,
          deliveredAgentId: null,
          deliveredAgentName: null,
          ownershipCurrent: true,
          principalCurrent: true,
        },
        content:
          "The release checklist is ready for UI review. This coordination item remains separate from the operator conversation.",
        correlationId: "visual-coordination-thread",
        replyToMessageId: null,
        requiresAcknowledgement: true,
        createdAt: "2026-08-20T07:58:58.000Z",
        expiresAt: null,
        deliveredAt: null,
        readAt: null,
        acknowledgedAt: null,
        repliedAt: null,
        cancelledAt: null,
        expiredAt: null,
        deliveryState: "queued",
      },
    ],
  };
}

function visualTask(taskId: string): DesktopTaskSummary {
  const task = visualTaskProjects
    .flatMap((project) => project.tasks)
    .find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new Error("Task not found.");
  return task;
}

function visualTaskDetail(taskId: string, limit = 200, beforeSequence?: number): DesktopTaskDetail {
  const messages = (visualTaskMessages.get(taskId) ?? [])
    .filter((message) => beforeSequence === undefined || message.sequence < beforeSequence).slice(-limit);
  const task = visualTask(taskId);
  return {
    task,
    messages,
    messagesTruncated: messages.length < task.messageCount,
    oldestMessageSequence: messages[0]?.sequence ?? null,
    newestMessageSequence: messages.at(-1)?.sequence ?? null,
  };
}

function updateVisualTask(taskId: string, update: (task: DesktopTaskSummary) => DesktopTaskSummary): void {
  visualTaskRevision += 1;
  visualTaskGeneratedAt = new Date().toISOString();
  visualTaskProjects = visualTaskProjects.map((project) => ({
    ...project,
    tasks: project.tasks.map((task) => task.id === taskId ? update(task) : task),
  }));
}

let runRecords: DesktopRunRecord[] = [
  {
    schemaVersion: "scr.run/v1",
    id: "run-visual-typecheck",
    kind: "validation",
    label: "pnpm typecheck",
    workspaceId: "desktop-workspace",
    state: "running",
    createdAt: "2026-08-10T07:59:20.000Z",
    startedAt: "2026-08-10T07:59:20.100Z",
    completedAt: null,
    exitCode: null,
    signal: null,
    durationMs: null,
    stdout: "> sovereign-code-runtime@0.1.0 typecheck\n> tsc -b --pretty false\n",
    stderr: "",
    outputTruncated: false,
    cancelRequested: false,
    metadata: { task: "typecheck" },
  },
  {
    schemaVersion: "scr.run/v1",
    id: "run-visual-python",
    kind: "python",
    label: "Python scripts\\analyze.py",
    workspaceId: "desktop-workspace",
    state: "succeeded",
    createdAt: "2026-08-10T07:56:00.000Z",
    startedAt: "2026-08-10T07:56:00.100Z",
    completedAt: "2026-08-10T07:56:01.220Z",
    exitCode: 0,
    signal: null,
    durationMs: 1_120,
    stdout: "analysis complete\nartifact: reports\\summary.json\n",
    stderr: "",
    outputTruncated: false,
    cancelRequested: false,
    metadata: {
      mode: "script",
      scriptPath: "scripts\\analyze.py",
      artifactPaths: ["reports\\summary.json"],
      isolatedMode: true,
      networkIsolation: false,
    },
  },
  {
    schemaVersion: "scr.run/v1",
    id: "run-visual-test",
    kind: "validation",
    label: "pnpm test",
    workspaceId: "desktop-workspace",
    state: "succeeded",
    createdAt: "2026-08-10T07:52:00.000Z",
    startedAt: "2026-08-10T07:52:00.100Z",
    completedAt: "2026-08-10T07:52:16.500Z",
    exitCode: 0,
    signal: null,
    durationMs: 16_400,
    stdout: "Test Files 7 passed\nTests 22 passed\n",
    stderr: "",
    outputTruncated: false,
    cancelRequested: false,
    metadata: { task: "test" },
  },
];

function runSummaries(): readonly DesktopRunSummary[] {
  return runRecords.map((run) => {
    const { stdout, stderr, ...summary } = run;
    return {
      ...summary,
      stdoutBytes: Buffer.byteLength(stdout, "utf8"),
      stderrBytes: Buffer.byteLength(stderr, "utf8"),
    };
  });
}

let visualTerminalSession: DesktopTerminalSession = {
  id: "terminal-visual-session",
  workspaceId: "desktop-workspace",
  relativeCwd: "",
  state: "running",
  createdAt: "2026-08-10T08:01:00.000Z",
  completedAt: null,
  processId: 42100,
  exitCode: null,
  columns: 120,
  rows: 32,
  output: "Windows PowerShell\r\nPS C:\\Projects\\sovereign-code-runtime> pnpm typecheck\r\nTypeScript ready.\r\n",
  outputTruncated: false,
  error: null,
};
let visualCreatedTerminal: DesktopTerminalSession | null = null;
let visualLastPythonCode = "";
const visualTerminalRequests: { readonly workspaceId: string; readonly root: string; readonly cwd: string }[] = [];
let visualPythonStartCount = 0;

const visualPythonCapabilities: DesktopPythonCapabilities = {
  available: true,
  launcher: "python",
  version: "3.11.9",
  implementation: "CPython",
  isolatedMode: true,
  networkIsolation: false,
};

const visualBrowserSession: DesktopBrowserSession = {
  id: "browser-visual-session",
  state: "ready",
  createdAt: "2026-08-10T08:02:00.000Z",
  processId: 42110,
  url: "https://example.com/",
  title: "Example Domain",
  allowedDomains: ["example.com"],
  blockedRequestCount: 2,
  error: null,
};

let visualBrowserOperationCount = 0;
let visualComputerObserveCount = 0;

let visualBrowserObservation: DesktopBrowserObservation = {
  ...visualBrowserSession,
  revision: "b".repeat(64),
  text: "Example Domain\nThis domain is for use in illustrative examples in documents.",
  accessibility: [
    { role: "RootWebArea", name: "Example Domain" },
    { role: "heading", name: "Example Domain" },
    { role: "textbox", name: "Search examples" },
    { role: "button", name: "Run search" },
  ],
  elements: [
    {
      ref: "e1",
      tag: "input",
      role: "textbox",
      name: "Search examples",
      text: "",
      type: "text",
      disabled: false,
      editable: true,
      sensitive: false,
      bounds: { x: 48, y: 180, width: 260, height: 36 },
    },
    {
      ref: "e2",
      tag: "button",
      role: "button",
      name: "Run search",
      text: "Run search",
      type: null,
      disabled: false,
      editable: false,
      sensitive: false,
      bounds: { x: 320, y: 180, width: 110, height: 36 },
    },
    {
      ref: "e3",
      tag: "input",
      role: "textbox",
      name: "Account password",
      text: "",
      type: "password",
      disabled: false,
      editable: true,
      sensitive: true,
      bounds: { x: 48, y: 230, width: 260, height: 36 },
    },
  ],
};

let visualComputerObservation: DesktopComputerObservation = {
  revision: "c".repeat(64),
  capturedAt: "2026-08-10T08:03:00.000Z",
  virtualScreen: { x: 0, y: 0, width: 1920, height: 1080 },
  windows: [
    {
      id: "0012ABCD",
      processId: 42120,
      title: "Sovereign Code Runtime",
      bounds: { x: 120, y: 80, width: 1360, height: 860 },
    },
    {
      id: "0012ABCE",
      processId: 42130,
      title: "Local model server",
      bounds: { x: 1520, y: 90, width: 360, height: 620 },
    },
  ],
  screenshotSha256: "d".repeat(64),
  screenshotBytes: 145_000,
};


interface ScreenshotRecord {
  readonly viewport: string;
  readonly language: string;
  readonly theme: string;
  readonly mode: "full" | "simple";
  readonly zoom: 1;
  readonly view: string;
  readonly relativePath: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly audit: LayoutAudit;
}

interface VisualIssue {
  readonly severity: "error" | "warning";
  readonly viewport: string;
  readonly view: string;
  readonly code: string;
  readonly message: string;
  readonly evidence: readonly string[];
}

interface VisualReport {
  readonly verificationScope: "tasks" | "all" | "checks" | "workbench";
  readonly functionalErrors: readonly string[];
  readonly schemaVersion: "scr.visual-test/v2";
  readonly verificationStatus: "matrix-only" | "checks-only" | "complete";
  readonly contexts: typeof VISUAL_MATRIX;
  readonly generatedAt: string;
  readonly outputRoot: string;
  readonly screenshots: readonly ScreenshotRecord[];
  readonly issues: readonly VisualIssue[];
  readonly summary: {
    readonly viewportCount: number;
    readonly screenshotCount: number;
    readonly errorCount: number;
    readonly warningCount: number;
  };
}


function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function registerRendererProtocol(): Promise<void> {
  const rendererRoot = resolve(currentDirectory, "..", "renderer");
  const rendererPrefix = `${rendererRoot}${sep}`;

  await protocol.handle(RENDERER_SCHEME, async (request) => {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.hostname !== "app") {
        return new Response("Not found", { status: 404 });
      }
      const decodedPath = decodeURIComponent(requestUrl.pathname);
      const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
      const candidate = resolve(rendererRoot, relativePath);
      if (candidate !== rendererRoot && !candidate.startsWith(rendererPrefix)) {
        return new Response("Forbidden", { status: 403 });
      }
      return await net.fetch(pathToFileURL(candidate).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

const visualProjectWorkspaces = new Map<string, DesktopProjectWorkspace[]>([
  ["project-visual-sovereign", [{ id: "workspace-visual-sovereign", root: "C:\\Projects\\sovereign-code-runtime", permissionProfile: "consequential", rememberedPermissionProfile: "consequential", unattendedWorkspaceAccess: true }]],
  ["project-visual-sample-clipboard", [
    { id: "workspace-visual-sample-clipboard", root: "C:\\Projects\\sample-clipboard", permissionProfile: "observe", rememberedPermissionProfile: "observe", unattendedWorkspaceAccess: false },
    { id: "workspace-visual-sovereign", root: "C:\\Projects\\sovereign-code-runtime", permissionProfile: "consequential", rememberedPermissionProfile: "consequential", unattendedWorkspaceAccess: true },
  ]],
]);
const visualSelectedWorkspaces = new Map([
  ["project-visual-sovereign", "workspace-visual-sovereign"],
  ["project-visual-sample-clipboard", "workspace-visual-sample-clipboard"],
]);
let visualProjectActivationFailure: string | null = null;

function visualProjectWorkspaceSnapshot(projectId: unknown): DesktopProjectWorkspaces {
  if (typeof projectId !== "string" || !visualProjectWorkspaces.has(projectId)) {
    throw new Error("Visual fixture received an unknown project.");
  }
  return {
    projectId,
    selectedWorkspaceId: visualSelectedWorkspaces.get(projectId) ?? null,
    activeWorkspaceId: state.activeDesktopWorkspace?.id ?? null,
    workspaces: visualProjectWorkspaces.get(projectId)!,
  };
}

function selectVisualProjectWorkspace(projectId: unknown, workspaceId: unknown): DesktopProjectWorkspaces {
  const snapshot = visualProjectWorkspaceSnapshot(projectId);
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === workspaceId);
  if (workspace === undefined) throw new Error("Visual fixture received an unknown workspace.");
  if (workspace.id === visualProjectActivationFailure) {
    visualProjectActivationFailure = null;
    throw new Error("The saved working directory is unavailable.");
  }
  visualSelectedWorkspaces.set(snapshot.projectId, workspace.id);
  state = { ...state, activeDesktopWorkspace: { ...workspace, projectId: snapshot.projectId } };
  return visualProjectWorkspaceSnapshot(snapshot.projectId);
}

function setVisualProjectPermission(profile: DesktopPermissionProfile, workspaceId: string): DesktopRuntimeState {
  for (const [projectId, workspaces] of visualProjectWorkspaces) {
    const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
    const workspace = workspaces[index];
    if (workspace === undefined) continue;
    const updated = { ...workspace, permissionProfile: profile,
      rememberedPermissionProfile: profile === "bypass" ? workspace.rememberedPermissionProfile : profile,
      unattendedWorkspaceAccess: profile === "observe" ? false : workspace.unattendedWorkspaceAccess };
    workspaces[index] = updated;
    if (state.activeDesktopWorkspace?.id === workspaceId) {
      state = { ...state, activeDesktopWorkspace: { ...updated, projectId } };
    }
    return state;
  }
  throw new Error("Visual fixture received an unknown permission workspace.");
}

function registerMockIpc(): void {
  registerGeminiConnectionFixture();
  registerApprovalFixture();
  ipcMain.handle(IPC_CHANNELS.readProjectWorkspaces, (_event, projectId: unknown) => visualProjectWorkspaceSnapshot(projectId));
  ipcMain.handle(IPC_CHANNELS.selectProjectWorkspace, (_event, projectId: unknown, workspaceId: unknown) => selectVisualProjectWorkspace(projectId, workspaceId));
  ipcMain.handle(IPC_CHANNELS.chooseProjectWorkspace, (_event, projectId: unknown) => {
    const snapshot = visualProjectWorkspaceSnapshot(projectId);
    if (snapshot.projectId !== "project-visual-sovereign") throw new Error("The visual folder choice belongs to Sovereign.");
    const workspace: DesktopProjectWorkspace = { id: "workspace-visual-sovereign-chosen", root: "C:\\Projects\\sovereign-task-workspace", permissionProfile: "observe", rememberedPermissionProfile: "observe", unattendedWorkspaceAccess: false };
    visualProjectWorkspaces.set(snapshot.projectId, [...snapshot.workspaces, workspace]);
    return selectVisualProjectWorkspace(snapshot.projectId, workspace.id);
  });
  ipcMain.handle(IPC_CHANNELS.getState, () => state);
  ipcMain.handle(IPC_CHANNELS.chooseWorkspace, () => state);
  ipcMain.handle(IPC_CHANNELS.start, () => state);
  ipcMain.handle(IPC_CHANNELS.stop, () => state);
  ipcMain.handle(IPC_CHANNELS.refresh, () => state);
  ipcMain.handle(IPC_CHANNELS.getManifest, () => manifest);
  ipcMain.handle(IPC_CHANNELS.getAuditReceipts, () => auditReceipts);
  ipcMain.handle(IPC_CHANNELS.getResourceSnapshot, () => visualResources);
  ipcMain.handle(IPC_CHANNELS.getHostStartupState, () => visualHostStartup);
  ipcMain.handle(IPC_CHANNELS.setLaunchAtLogin, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error("Launch-at-login enabled must be boolean.");
    }
    visualHostStartup = {
      ...visualHostStartup,
      enabled,
      registeredCommand: enabled
        ? `"${visualHostStartup.executablePath}" --autostart`
        : null,
    };
    return visualHostStartup;
  });
  ipcMain.handle(IPC_CHANNELS.getRuns, () => runSummaries());
  ipcMain.handle(IPC_CHANNELS.getRun, (_event, runId: unknown) => {
    const run = runRecords.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      throw new Error("Run not found.");
    }
    return run;
  });
  ipcMain.handle(IPC_CHANNELS.cancelRun, (_event, runId: unknown) => {
    const index = runRecords.findIndex((candidate) => candidate.id === runId);
    const run = runRecords[index];
    if (run === undefined) {
      throw new Error("Run not found.");
    }
    const updated = { ...run, cancelRequested: true } satisfies DesktopRunRecord;
    runRecords = runRecords.map((candidate, candidateIndex) =>
      candidateIndex === index ? updated : candidate
    );
    return updated;
  });
  ipcMain.handle(
    IPC_CHANNELS.getTaskWorkspace,
    (_event, offset: unknown, limit: unknown) => visualTaskWorkspace(
      typeof offset === "number" ? offset : 0,
      Math.min(typeof limit === "number" ? limit : 64, 1),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.getTaskDetail, async (_event, taskId: unknown, limit: unknown, before: unknown) => {
    if (typeof taskId !== "string") throw new Error("Task id is invalid.");
    await delay(taskId === "task-visual-agent-hub" ? 80 : 10);
    return visualTaskDetail(taskId, typeof limit === "number" ? limit : 200, typeof before === "number" ? before : undefined);
  });
  ipcMain.handle(
    IPC_CHANNELS.getTaskCoordinationInbox,
    async (_event, taskId: unknown) => {
      if (typeof taskId !== "string") throw new Error("Task id is invalid.");
      await delay(20);
      return visualTaskCoordinationInbox(taskId);
    },
  );
  ipcMain.handle(IPC_CHANNELS.sendTaskUserMessage, (_event, taskId: unknown, content: unknown) => {
    if (typeof taskId !== "string" || typeof content !== "string" || content.trim().length === 0) {
      throw new Error("Task message is invalid.");
    }
    const messages = visualTaskMessages.get(taskId) ?? [];
    const message: DesktopTaskMessage = {
      id: `message-${taskId}-${messages.length + 1}`,
      taskId,
      sequence: (messages.at(-1)?.sequence ?? 0) + 1,
      role: "user",
      agentId: null,
      agentName: null,
      content: content.trim(),
      createdAt: new Date().toISOString(),
      acknowledgedAt: null,
    };
    visualTaskMessages.set(taskId, [...messages, message]);
    updateVisualTask(taskId, (task) => ({
      ...task,
      unreadUserMessageCount: task.unreadUserMessageCount + 1,
      messageCount: task.messageCount + 1,
      updatedAt: message.createdAt,
    }));
    return visualTaskDetail(taskId);
  });
  ipcMain.handle(IPC_CHANNELS.invokeTool, (_event, toolName: unknown, input: Record<string, unknown>) => {
    switch (toolName) {
      case "visual.fixture.fail-project-activation":
        if (typeof input.workspaceId !== "string") throw new Error("A visual workspace id is required.");
        visualProjectActivationFailure = input.workspaceId;
        return { enabled: true };
      case "visual.fixture.terminal-output":
        visualTerminalSession = { ...visualTerminalSession, output: String(input.output) };
        return { updated: true };
      case "visual.fixture.last-python-code":
        return visualLastPythonCode;
      case "visual.fixture.python-start-count":
        return visualPythonStartCount;
      case "visual.fixture.browser-operation-count":
        return visualBrowserOperationCount;
      case "visual.fixture.computer-observe-count":
        return visualComputerObserveCount;
      case "terminal.session.list":
        return visualCreatedTerminal === null ? [visualTerminalSession] : [visualTerminalSession, visualCreatedTerminal];
      case "terminal.session.read":
        return input.sessionId === visualCreatedTerminal?.id ? visualCreatedTerminal : visualTerminalSession;
      case "terminal.session.create": {
        const workspace = state.activeDesktopWorkspace;
        if (!workspace || typeof input.cwd !== "string") throw new Error("Visual terminal creation needs an active project directory.");
        visualTerminalRequests.push({ workspaceId: workspace.id, root: workspace.root, cwd: input.cwd });
        visualCreatedTerminal = { ...visualTerminalSession, id: "terminal-visual-project", workspaceId: workspace.id, relativeCwd: input.cwd,
          output: `Command Prompt\r\n${workspace.root}>\r\n` };
        return visualCreatedTerminal;
      }
      case "python.capabilities":
        return visualPythonCapabilities;
      case "python.start": {
        visualPythonStartCount += 1;
        visualLastPythonCode = String(input.code);
        const run = runRecords.find((candidate) => candidate.kind === "python");
        if (!run) throw new Error("Python visual fixture is unavailable.");
        return run;
      }
      case "browser.capabilities":
        return {
          available: true,
          engine: "Microsoft Edge CDP",
          sessionIsolation: "temporary-profile",
          domainPolicyRequired: true,
          requestInterception: true,
          semanticElementRefs: true,
        };
      case "browser.session.list":
        return [visualBrowserSession];
      case "browser.observe":
      case "browser.navigate":
      case "browser.click":
      case "browser.type":
        visualBrowserOperationCount += 1;
        return visualBrowserObservation;
      case "workflow.templates":
        return [
          {
            id: "verify",
            label: "Typecheck and test",
            steps: [
              { kind: "validation", task: "typecheck" },
              { kind: "validation", task: "test" },
            ],
          },
          {
            id: "release-check",
            label: "Typecheck, test, and build",
            steps: [
              { kind: "validation", task: "typecheck" },
              { kind: "validation", task: "test" },
              { kind: "validation", task: "build" },
            ],
          },
        ];
      case "computer.capabilities":
        return {
          available: true,
          observationRevisionRequired: true,
          operations: ["focus_window", "click", "type_text", "press_key", "launch_application"],
        };
      case "computer.observe":
        visualComputerObserveCount += 1;
        return visualComputerObservation;
      case "computer.action":
        return visualComputerObservation;
      default:
        throw new Error(`Visual fixture does not implement desktop tool: ${String(toolName)}`);
    }
  });
  ipcMain.handle(IPC_CHANNELS.copyConnectionBundle, (): DesktopConnectionCopyResult => ({
    schemaVersion: "scr.connection/v1",
    endpoint: state.webBridgeUrl ?? state.endpoint ?? "http://127.0.0.1:3210/mcp",
    target: state.webBridgeUrl === null ? "local" : "web-bridge",
    copiedAt: "2026-08-10T08:00:00.000Z",
    clipboardClearsAt: "2026-08-10T08:01:00.000Z",
  }));
  ipcMain.handle(IPC_CHANNELS.rotateCredentials, () => {
    state = {
      ...state,
      credentialGeneration: state.credentialGeneration + 1,
    };
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.setAutoStart, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error("Runtime auto-start must be a boolean value.");
    }
    state = { ...state, autoStart: enabled };
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.setUnattendedWorkspaceAccess, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error("Unattended workspace access must be a boolean value.");
    }
    state = {
      ...state,
      unattendedWorkspaceAccess: enabled,
      permissionProfile: enabled && state.permissionProfile === "observe"
        ? "workspace"
        : state.permissionProfile,
      rememberedPermissionProfile: enabled && state.rememberedPermissionProfile === "observe"
        ? "workspace"
        : state.rememberedPermissionProfile,
    };
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.setPermissionProfile, (_event, profile: unknown, workspaceId: unknown) => {
    if (
      profile !== "observe" &&
      profile !== "workspace" &&
      profile !== "consequential" &&
      profile !== "bypass"
    ) {
      throw new Error("Unknown permission profile.");
    }
    if (typeof workspaceId === "string") return setVisualProjectPermission(profile, workspaceId);
    state = profile === "bypass"
      ? { ...state, permissionProfile: profile }
      : {
          ...state,
          permissionProfile: profile,
          rememberedPermissionProfile: profile,
          unattendedWorkspaceAccess: profile === "observe" ? false : state.unattendedWorkspaceAccess,
        };
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.setWebBridgeUrl, (_event, value: unknown) => {
    if (value !== null && typeof value !== "string") {
      throw new Error("Web bridge URL must be a string or null.");
    }
    state = { ...state, webBridgeUrl: value === null || value.length === 0 ? null : value };
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.configureSecureTunnel, (_event, input: unknown) => {
    const candidate = input as {
      tunnelId?: unknown;
      runtimeApiKey?: unknown;
      clearRuntimeApiKey?: unknown;
      controlPlaneProxyUrl?: unknown;
      clearControlPlaneProxy?: unknown;
      controlPlaneBackupProxyUrl?: unknown;
      clearControlPlaneBackupProxy?: unknown;
      controlPlaneDirectFallbackEnabled?: unknown;
    };
    const nextProxyUrl = candidate.clearControlPlaneProxy === true
      ? null
      : typeof candidate.controlPlaneProxyUrl === "string" && candidate.controlPlaneProxyUrl.length > 0
        ? candidate.controlPlaneProxyUrl
        : state.secureTunnel.controlPlaneProxyDisplay;
    const nextBackupProxyUrl = candidate.clearControlPlaneBackupProxy === true
      ? null
      : typeof candidate.controlPlaneBackupProxyUrl === "string" &&
          candidate.controlPlaneBackupProxyUrl.length > 0
        ? candidate.controlPlaneBackupProxyUrl
        : state.secureTunnel.controlPlaneBackupProxyDisplay;
    const directFallbackEnabled =
      typeof candidate.controlPlaneDirectFallbackEnabled === "boolean"
        ? candidate.controlPlaneDirectFallbackEnabled
        : state.secureTunnel.controlPlaneDirectFallbackEnabled;
    state = {
      ...state,
      secureTunnel: {
        ...state.secureTunnel,
        tunnelId: candidate.tunnelId === null
          ? null
          : typeof candidate.tunnelId === "string"
            ? candidate.tunnelId
            : state.secureTunnel.tunnelId,
        hasRuntimeApiKey: candidate.clearRuntimeApiKey === true
          ? false
          : typeof candidate.runtimeApiKey === "string" && candidate.runtimeApiKey.length > 0
            ? true
            : state.secureTunnel.hasRuntimeApiKey,
        runtimeApiKeyStorage: candidate.clearRuntimeApiKey === true
          ? "none"
          : typeof candidate.runtimeApiKey === "string" && candidate.runtimeApiKey.length > 0
            ? "windows-protected"
            : state.secureTunnel.runtimeApiKeyStorage,
        controlPlaneProxyConfigured: nextProxyUrl !== null,
        controlPlaneProxyDisplay: nextProxyUrl,
        controlPlaneProxyStorage: nextProxyUrl === null ? "none" : "windows-protected",
        controlPlaneBackupProxyConfigured: nextBackupProxyUrl !== null,
        controlPlaneBackupProxyDisplay: nextBackupProxyUrl,
        controlPlaneBackupProxyStorage:
          nextBackupProxyUrl === null ? "none" : "windows-protected",
        controlPlaneDirectFallbackEnabled: directFallbackEnabled,
      },
    };
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.setSecureTunnelAutomation, (_event, input: unknown) => {
    const candidate = input as { autoStart?: unknown; autoReconnect?: unknown };
    if (typeof candidate.autoStart !== "boolean" || typeof candidate.autoReconnect !== "boolean") {
      throw new Error("Tunnel automation values must be boolean.");
    }
    state = {
      ...state,
      secureTunnel: {
        ...state.secureTunnel,
        autoStart: candidate.autoStart,
        autoReconnect: candidate.autoReconnect,
      },
    };
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.startSecureTunnel, () => {
    state = {
      ...state,
      secureTunnel: {
        ...state.secureTunnel,
        phase: "ready",
        desiredRunning: true,
        nextReconnectAt: null,
        errorMessage: null,
      },
    };
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.stopSecureTunnel, () => {
    state = {
      ...state,
      secureTunnel: {
        ...state.secureTunnel,
        phase: "stopped",
        desiredRunning: false,
        reconnectAttempt: 0,
        nextReconnectAt: null,
        healthUrl: null,
      },
    };
    return state;
  });
  ipcMain.handle(IPC_CHANNELS.refreshSecureTunnel, () => state);
  ipcMain.handle(IPC_CHANNELS.setUiScale, (event, scale: unknown) => {
    if (scale !== 1 && scale !== 1.1 && scale !== 1.25 && scale !== 1.5) {
      throw new Error("Invalid visual-test UI scale.");
    }
    event.sender.setZoomFactor(scale);
  });
}

async function waitForRenderer(
  window: BrowserWindow,
  rendererProblems: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      `Boolean(document.querySelector(".application-shell") && document.querySelector("#v2-chatgpt-config") && document.querySelector("#gemini-status")?.textContent !== "Checking…" && document.querySelectorAll("#home-active-work-carousel .active-work-line").length >= 2)`,
      true,
    ) as boolean;
    if (ready) {
      return;
    }
    await delay(50);
  }
  let snapshot = "unavailable";
  try {
    snapshot = await window.webContents.executeJavaScript(
      `JSON.stringify({
        title: document.title,
        body: (document.body?.innerText ?? "").slice(0, 2000),
        appHtml: (document.querySelector("#app")?.innerHTML ?? "").slice(0, 2000),
      })`,
      true,
    ) as string;
  } catch (error) {
    snapshot = `snapshot failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const diagnostics = rendererProblems.length === 0
    ? "No renderer console errors were captured."
    : rendererProblems.join("\n");
  throw new Error(
    `The renderer did not reach the expected visual-test state.\nRenderer diagnostics:\n${diagnostics}\nRenderer snapshot:\n${snapshot}`,
  );
}

async function captureRenderedPage(window: BrowserWindow): Promise<NativeImage> {
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
  return await window.webContents.capturePage(undefined, { stayHidden: true });
}

async function writeScreenshot(window: BrowserWindow, request: VisualMatrixCapture): Promise<ScreenshotRecord> {
  const audit = await window.webContents.executeJavaScript(`${layoutAuditScript}(${JSON.stringify(request.view)})`, true) as LayoutAudit;
  const image = await captureRenderedPage(window);
  const bytes = image.toPNG();
  const relativePath = visualScreenshotPath(request.context, request.surface);
  const absolutePath = join(OUTPUT_ROOT, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  const size = image.getSize();
  return {
    viewport: request.context.width + "x" + request.context.height,
    language: request.context.language, theme: request.context.theme, mode: request.mode, zoom: 1,
    view: request.surface, relativePath, width: size.width, height: size.height,
    sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), audit,
  };
}

function issuesFor(record: ScreenshotRecord): readonly VisualIssue[] {
  const issues: VisualIssue[] = [];
  const audit = record.audit;
  const expectedViewId = `view-${audit.view}`;

  if (audit.activeViewIds.length !== 1 || audit.activeViewIds[0] !== expectedViewId) {
    issues.push({
      severity: "error",
      viewport: record.viewport,
      view: record.view,
      code: "ACTIVE_VIEW_MISMATCH",
      message: `Expected exactly ${expectedViewId} to be active.`,
      evidence: audit.activeViewIds,
    });
  }
  if (audit.documentScrollWidth > audit.viewport.width + 1) {
    issues.push({
      severity: "error",
      viewport: record.viewport,
      view: record.view,
      code: "DOCUMENT_HORIZONTAL_OVERFLOW",
      message: `Document width ${audit.documentScrollWidth} exceeds viewport width ${audit.viewport.width}.`,
      evidence: audit.outOfViewport,
    });
  }
  if (audit.shellBounds === null || Math.abs(audit.shellBounds.width - audit.viewport.width) > 1) {
    issues.push({
      severity: "error",
      viewport: record.viewport,
      view: record.view,
      code: "SHELL_WIDTH_MISMATCH",
      message: "The application shell does not fill the renderer viewport.",
      evidence: audit.shellBounds === null ? [] : [JSON.stringify(audit.shellBounds)],
    });
  }
  if (audit.outOfViewport.length > 0) {
    issues.push({
      severity: "error",
      viewport: record.viewport,
      view: record.view,
      code: "VISIBLE_ELEMENT_OUT_OF_VIEWPORT",
      message: "One or more visible non-scrollable elements extend outside the horizontal viewport.",
      evidence: audit.outOfViewport,
    });
  }
  if (audit.duplicateIds.length > 0) {
    issues.push({
      severity: "error",
      viewport: record.viewport,
      view: record.view,
      code: "DUPLICATE_DOM_IDS",
      message: "The renderer contains duplicate DOM identifiers.",
      evidence: audit.duplicateIds,
    });
  }
  if (audit.missingRequiredSelectors.length > 0) {
    issues.push({
      severity: "error",
      viewport: record.viewport,
      view: record.view,
      code: "MISSING_REQUIRED_UI",
      message: "Required application-shell elements are missing.",
      evidence: audit.missingRequiredSelectors,
    });
  }
  if (audit.edgeCrowding.length > 0) {
    issues.push({
      severity: "warning",
      viewport: record.viewport,
      view: record.view,
      code: "EDGE_CROWDING",
      message: "Text or controls sit closer than 16px horizontally or 12px vertically to their surface edge.",
      evidence: audit.edgeCrowding,
    });
  }
  if (audit.affordance.length > 0) {
    issues.push({
      severity: "warning",
      viewport: record.viewport,
      view: record.view,
      code: "AFFORDANCE_MISMATCH",
      message: "A control reads as text, or plain content reads as a control.",
      evidence: audit.affordance,
    });
  }
  if (audit.pageGutter.length > 0) {
    issues.push({
      severity: "warning",
      viewport: record.viewport,
      view: record.view,
      code: "PAGE_GUTTER_TOO_TIGHT",
      message: "View text sits closer than 20px to the scroll pane edge.",
      evidence: audit.pageGutter,
    });
  }
  if (audit.clippedText.length > 0) {
    issues.push({
      severity: "warning",
      viewport: record.viewport,
      view: record.view,
      code: "POSSIBLE_TEXT_CLIPPING",
      message: "Leaf text may be clipped without an intentional ellipsis rule.",
      evidence: audit.clippedText,
    });
  }
  return issues;
}

async function writeVisualReport(
  verificationScope: VisualReport["verificationScope"], screenshots: readonly ScreenshotRecord[], functionalErrors: readonly string[],
  verificationStatus: VisualReport["verificationStatus"],
): Promise<VisualReport> {
  const issues = screenshots.flatMap((record) => issuesFor(record));
  const report: VisualReport = {
    verificationScope,
    verificationStatus,
    functionalErrors,
    schemaVersion: "scr.visual-test/v2",
    contexts: VISUAL_MATRIX,
    generatedAt: new Date().toISOString(),
    outputRoot: OUTPUT_ROOT,
    screenshots,
    issues,
    summary: {
      viewportCount: 2,
      screenshotCount: screenshots.length,
      errorCount: issues.filter((issue) => issue.severity === "error").length + functionalErrors.length,
      warningCount: issues.filter((issue) => issue.severity === "warning").length,
    },
  };
  await writeFile(join(OUTPUT_ROOT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return report;
}

async function run(): Promise<void> {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await app.whenReady();
  await registerRendererProtocol();
  registerMockIpc();
  const scope = process.env.SCR_VISUAL_SCOPE;
  const verificationScope = scope === "tasks" || scope === "checks" || scope === "workbench" ? scope : "all";
  if (verificationScope === "all") await verifyApprovalWindows({
    rendererOrigin: RENDERER_ORIGIN,
    preloadPath: resolve(currentDirectory, "..", "preload", "approval-preload.cjs"),
    outputRoot: OUTPUT_ROOT,
  });

  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    useContentSize: true,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#0a0d12",
    title: "Sovereign Code Runtime Visual Test",
    webPreferences: {
      preload: resolve(currentDirectory, "..", "preload", "preload.cjs"),
      zoomFactor: 1,
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      backgroundThrottling: false,
    },
  });

  const rendererProblems: string[] = [];
  window.webContents.on("console-message", (event) => {
    const detail = event as unknown as {
      readonly level?: string;
      readonly message?: string;
      readonly lineNumber?: number;
      readonly sourceId?: string;
    };
    const message = detail.message?.trim();
    if (message === undefined || message.length === 0) {
      return;
    }
    if (detail.level === "error" || /uncaught|error|failed/i.test(message)) {
      rendererProblems.push(
        `${detail.level ?? "console"} ${detail.sourceId ?? "renderer"}:${detail.lineNumber ?? 0} ${message}`,
      );
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    rendererProblems.push(
      `render-process-gone: ${details.reason}${details.exitCode === undefined ? "" : ` exit ${details.exitCode}`}`,
    );
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(`${RENDERER_ORIGIN}index.html`);
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await window.webContents.executeJavaScript(
    `(() => {
      const key = 'sovereign.ui.settings.v1';
      let current = {};
      try { current = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch {}
      localStorage.setItem(key, JSON.stringify({ ...current, language: 'en', theme: 'light', experienceMode: 'full', reducedMotion: false, uiScale: 1, fontScale: 1, sidebarCollapsed: false, startupView: 'overview' }));
    })()`,
    true,
  );
  await window.loadURL(`${RENDERER_ORIGIN}index.html`);
  await waitForRenderer(window, rendererProblems);
  await delay(120);
  const previews = await createVisualPreviewFixtures(window);
  visualBrowserObservation = { ...visualBrowserObservation, screenshotBase64: previews.browser, screenshotMediaType: "image/jpeg" };
  const desktopPreview = Buffer.from(previews.computer, "base64");
  visualComputerObservation = { ...visualComputerObservation, screenshotBase64: previews.computer, screenshotMediaType: "image/jpeg",
    screenshotBytes: desktopPreview.length, screenshotSha256: createHash("sha256").update(desktopPreview).digest("hex") };
  await verifyInitialV2Navigation(window);
  if (verificationScope === "workbench") {
    console.log(JSON.stringify({ visualPhase: "workbench", outputRoot: OUTPUT_ROOT }));
    const interaction = await verifyWorkbenchInteractions(window, activateVisualView);
    await writeFile(join(OUTPUT_ROOT, "interaction-verification.json"), JSON.stringify(interaction, null, 2));
    const errors = interaction.ok ? [] : ["Workbench interaction failed: " + JSON.stringify(interaction)];
    await writeVisualReport(verificationScope, [], errors, "checks-only");
    if (errors.length > 0) throw new Error(errors.join("\n"));
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
    return;
  }
  console.log(JSON.stringify({ visualPhase: verificationScope === "checks" ? "checks" : "matrix", outputRoot: OUTPUT_ROOT }));
  const screenshots = verificationScope === "checks" ? [] : await captureV2VisualMatrix(window, request => writeScreenshot(window, request), verificationScope);
  if (verificationScope !== "checks") await writeVisualReport(verificationScope, screenshots, [], "matrix-only");
  console.log(JSON.stringify({ visualPhase: "interactions", screenshotCount: screenshots.length }));
  await applyVisualContext(window, { language: "en", theme: "light", width: 1360, height: 860 });
  await activateVisualView(window, "overview");
  if (verificationScope !== "tasks") {
    const controls = await verifySharedControls(window, activateVisualView, OUTPUT_ROOT);
    await writeFile(join(OUTPUT_ROOT, "shared-controls.json"), JSON.stringify(controls, null, 2));
    if (!controls.ok) throw new Error("Shared controls verification failed: " + JSON.stringify(controls));
    await waitForRenderer(window, rendererProblems);
    const overview = await verifyOverviewActivity(window);
    await writeFile(join(OUTPUT_ROOT, "overview-verification.json"), JSON.stringify(overview, null, 2));
    if (!overview.ok) throw new Error("Overview verification failed: " + JSON.stringify(overview));
    await verifyPermissionLifecycle(window, () => waitForRenderer(window, rendererProblems));
    await verifyAgentConnectionSurface(window);
    await verifyGeminiConnection(window);
    await verifyHistorySurfaces(window);
  }
  await window.webContents.insertCSS(
    "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }",
  );
  await activateVisualView(window, "tasks");
  const functionalErrors: string[] = [];
  const task = await verifyTaskHub(window);
  await writeFile(join(OUTPUT_ROOT, "task-verification.json"), JSON.stringify(task, null, 2));
  if (!task.ok) functionalErrors.push("Task verification failed: " + JSON.stringify(task));
  const workbench = await verifyTaskWorkbench(window);
  await writeFile(join(OUTPUT_ROOT, "task-workbench-verification.json"), JSON.stringify(workbench, null, 2));
  if (!workbench.ok) functionalErrors.push("Task interaction failed: " + JSON.stringify(workbench));
  const project = await verifyProjectWorkspace(window);
  await writeFile(join(OUTPUT_ROOT, "project-workspace.json"), JSON.stringify({ ...project, terminalRequests: visualTerminalRequests }, null, 2));
  if (!project.ok) functionalErrors.push("Project workspace verification failed: " + JSON.stringify(project));
  if (visualTerminalRequests.length !== 1 || visualTerminalRequests[0]?.workspaceId !== "workspace-visual-sovereign-chosen"
      || visualTerminalRequests[0]?.root !== "C:\\Projects\\sovereign-task-workspace" || visualTerminalRequests[0]?.cwd !== "") {
    functionalErrors.push("Task terminal used an unexpected workspace: " + JSON.stringify(visualTerminalRequests));
  }
  if (verificationScope !== "tasks") {
    const interaction = await verifyWorkbenchInteractions(window, activateVisualView);
    await writeFile(join(OUTPUT_ROOT, "interaction-verification.json"), JSON.stringify(interaction, null, 2));
    if (!interaction.ok) functionalErrors.push("Workbench interaction failed: " + JSON.stringify(interaction));
  }
  const report = await writeVisualReport(verificationScope, screenshots, functionalErrors, verificationScope === "checks" ? "checks-only" : "complete");

  if (window.webContents.debugger.isAttached()) {
    window.webContents.debugger.detach();
  }
  window.destroy();
  if (report.summary.errorCount > 0) {
    throw new Error(`Visual test detected ${report.summary.errorCount} error(s). ${functionalErrors.join("\n")}`);
  }
}

void run()
  .then(() => {
    app.exit(0);
    setTimeout(() => process.exit(0), 250);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await mkdir(OUTPUT_ROOT, { recursive: true });
    const failedWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    if (failedWindow !== undefined) {
      await writeFile(join(OUTPUT_ROOT, "failure.png"), (await captureRenderedPage(failedWindow)).toPNG());
      const failureDom = await failedWindow.webContents.executeJavaScript(`({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        text: document.body.innerText,
        html: document.body.innerHTML,
      })`);
      await writeFile(join(OUTPUT_ROOT, "failure-dom.json"), JSON.stringify(failureDom, null, 2), "utf8");
    }
    await writeFile(join(OUTPUT_ROOT, "failure.txt"), `${message}\n`, "utf8");
    console.error(message);
    app.exit(1);
    setTimeout(() => process.exit(1), 250);
  });
