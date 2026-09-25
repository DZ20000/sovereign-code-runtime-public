import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import { verifySharedControls } from "./visual-shared-controls-verification.js";
import { verifyWorkbenchInteractions } from "./visual-interaction-verification.js";

import {
  IPC_CHANNELS,
  type DesktopApprovalView,
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
const OUTPUT_ROOT = resolve(
  process.env.SCR_VISUAL_OUTPUT?.trim() || join(currentDirectory, "..", "..", "visual-artifacts"),
);
const USER_DATA_ROOT = resolve(
  process.env.SCR_VISUAL_USER_DATA?.trim() || join(OUTPUT_ROOT, `user-data-${process.pid}`),
);

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
  runtimeVersion: "0.1.0",
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

const visualApproval: DesktopApprovalView = {
  id: "approval-visual-001",
  toolName: "terminal.start",
  title: "L3 Consequential · ChatGPT Web",
  message: "Allow connected web agent to run terminal.start?",
  detail: "Starts one approved PowerShell command.\n\nThis approval covers exactly this external tool call and expires after 30 seconds.\n\n{\n  \"command\": \"pnpm typecheck\"\n}",
  requestedAt: "2026-08-11T14:00:00.000Z",
  expiresAt: "2099-08-11T14:00:30.000Z",
  burstDetected: false,
};

const manifest: DesktopManifestView = {
  schemaVersion: "scr.tools/v1",
  runtimeVersion: "0.1.0",
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
    relativePath: "apps/desktop/src/renderer/styles.css",
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

const visualBrowserObservation: DesktopBrowserObservation = {
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

const visualComputerObservation: DesktopComputerObservation = {
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
  readonly verificationScope: "tasks" | "all";
  readonly functionalErrors: readonly string[];
  readonly schemaVersion: "scr.visual-test/v1";
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
  ipcMain.handle(IPC_CHANNELS.approvalGetCurrent, () => visualApproval);
  ipcMain.handle(IPC_CHANNELS.approvalResolve, (_event, requestId: unknown, decision: unknown) => {
    if (requestId !== visualApproval.id) {
      throw new Error("Visual approval request id mismatch.");
    }
    if (decision !== "allow-once" && decision !== "deny" && decision !== "drop-to-l1") {
      throw new Error("Invalid visual approval decision.");
    }
  });
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
      `Boolean(document.querySelector(".application-shell") && document.querySelector("#global-status-label")?.textContent === "Running" && document.querySelectorAll(".manifest-group").length >= 1)`,
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

async function verifyInterfacePreferences(window: BrowserWindow): Promise<void> {
  const result = await window.webContents.executeJavaScript(
    `(async () => {
      const language = document.querySelector('#ui-language');
      const mode = document.querySelector('#ui-experience-mode');
      const execute = document.querySelector('.navigation-execute-section');
      const overviewButton = document.querySelector('.navigation-item[data-view="overview"]');
      const agentButton = document.querySelector('.navigation-item[data-view="agent"]');
      const securityTab = document.querySelector('[data-settings-tab="security"]');
      const securityPane = document.querySelector('[data-settings-pane="security"]');
      const permissionButtons = Array.from(document.querySelectorAll('#web-permission-profiles [data-permission-profile]'));
      const bypassTile = document.querySelector('#web-bypass-toggle');
      const statusPermission = document.querySelector('#status-permission-action');
      const simplePermission = document.querySelector('#simple-overview [data-open-settings-tab="security"]');
      const homePermissionCard = document.querySelector('.home-permission-card');
      const agentAuthority = document.querySelector('.agent-authority-priority');
      const runsButton = document.querySelector('.navigation-item[data-view="runs"]');
      const computerButton = document.querySelector('.navigation-item[data-view="computer"]');
      const workbenchToggle = document.querySelector('#execute-group-toggle');
      const shell = document.querySelector('.application-shell');
      const sidebar = document.querySelector('.sidebar');
      const sidebarSetting = document.querySelector('#sidebar-collapsed-setting');
      const appearanceTab = document.querySelector('[data-settings-tab="appearance"]');
      const hostTab = document.querySelector('[data-settings-tab="host"]');
      const startupView = document.querySelector('#ui-startup-view');
      const simpleOverview = document.querySelector('#simple-overview');
      const fullOverview = document.querySelector('.overview-full-content');
      if (
        !(language instanceof HTMLSelectElement) ||
        !(mode instanceof HTMLSelectElement) ||
        !(execute instanceof HTMLElement) ||
        !(overviewButton instanceof HTMLButtonElement) ||
        !(agentButton instanceof HTMLButtonElement) ||
        !(securityTab instanceof HTMLButtonElement) ||
        !(securityPane instanceof HTMLElement) ||
        permissionButtons.length !== 3 ||
        !permissionButtons.every((button) => button instanceof HTMLButtonElement) ||
        !(bypassTile instanceof HTMLButtonElement) ||
        !(statusPermission instanceof HTMLButtonElement) ||
        !(simplePermission instanceof HTMLButtonElement) ||
        !(homePermissionCard instanceof HTMLButtonElement) ||
        !(agentAuthority instanceof HTMLElement) ||
        !(runsButton instanceof HTMLButtonElement) ||
        !(computerButton instanceof HTMLButtonElement) ||
        !(workbenchToggle instanceof HTMLButtonElement) ||
        !(shell instanceof HTMLElement) ||
        !(sidebar instanceof HTMLElement) ||
        !(sidebarSetting instanceof HTMLInputElement) ||
        !(appearanceTab instanceof HTMLButtonElement) ||
        !(hostTab instanceof HTMLButtonElement) ||
        !(startupView instanceof HTMLSelectElement) ||
        !(simpleOverview instanceof HTMLElement) ||
        !(fullOverview instanceof HTMLElement)
      ) {
        return { ok: false, reason: 'preference controls missing' };
      }
      overviewButton.click();
      language.value = 'zh-CN';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      mode.value = 'simple';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const chineseSimple =
        document.documentElement.lang === 'zh-CN' &&
        document.documentElement.dataset.experienceMode === 'simple' &&
        getComputedStyle(execute).display === 'none' &&
        getComputedStyle(simpleOverview).display !== 'none' &&
        getComputedStyle(fullOverview).display === 'none' &&
        simpleOverview.innerText.includes('工作区') &&
        simpleOverview.innerText.includes('连接') &&
        simpleOverview.innerText.includes('权限') &&
        !(document.body?.innerText ?? '').includes('最近活动') &&
        !(document.body?.innerText ?? '').includes('技术详情');
      agentButton.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const simpleAuthorityBoundary =
        getComputedStyle(securityTab).display !== 'none' &&
        getComputedStyle(bypassTile).display !== 'none' &&
        getComputedStyle(agentAuthority).display !== 'none' &&
        getComputedStyle(statusPermission).display !== 'none' &&
        getComputedStyle(simplePermission).display !== 'none' &&
        getComputedStyle(permissionButtons[0]).display !== 'none' &&
        getComputedStyle(permissionButtons[1]).display !== 'none' &&
        getComputedStyle(permissionButtons[2]).display !== 'none' &&
        permissionButtons[2].classList.contains('is-selected') &&
        permissionButtons[2].getAttribute('aria-pressed') === 'true' &&
        simplePermission.textContent?.trim() === '更改权限';
      const chineseNavigation =
        overviewButton.querySelector('.navigation-label')?.textContent?.trim() === '首页' &&
        agentButton.querySelector('.navigation-label')?.textContent?.trim() === 'ChatGPT 连接' &&
        runsButton.querySelector('.navigation-label')?.textContent?.trim() === '任务记录' &&
        computerButton.querySelector('.navigation-label')?.textContent?.trim() === '桌面控制' &&
        workbenchToggle.querySelector('span')?.textContent?.trim() === '工作台' &&
        securityTab.textContent?.trim() === '权限与安全';
      statusPermission.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const simplePermissionEntry =
        document.querySelector('#view-settings')?.classList.contains('is-active') === true &&
        securityPane.classList.contains('is-active') &&
        !securityPane.hidden &&
        securityTab.classList.contains('is-active');

      securityTab.focus();
      securityTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const hostKeyboard =
        document.activeElement === hostTab &&
        hostTab.getAttribute('aria-selected') === 'true' &&
        hostTab.tabIndex === 0 &&
        document.querySelector('[data-settings-pane="host"]')?.hasAttribute('hidden') === false;
      hostTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const settingsKeyboard =
        hostKeyboard &&
        document.activeElement === securityTab &&
        securityTab.getAttribute('aria-selected') === 'true' &&
        securityTab.tabIndex === 0;

      sidebarSetting.checked = true;
      sidebarSetting.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const collapsedSidebar =
        shell.classList.contains('sidebar-collapsed') &&
        Math.abs(sidebar.getBoundingClientRect().width - 56) <= 1 &&
        getComputedStyle(overviewButton.querySelector('.navigation-label')).display === 'none' &&
        getComputedStyle(overviewButton.querySelector('.navigation-icon')).display !== 'none';
      sidebarSetting.checked = false;
      sidebarSetting.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      overviewButton.click();
      language.value = 'en';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      mode.value = 'full';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const englishFull =
        document.documentElement.lang === 'en' &&
        document.documentElement.dataset.experienceMode === 'full' &&
        getComputedStyle(execute).display !== 'none' &&
        getComputedStyle(simpleOverview).display === 'none' &&
        getComputedStyle(fullOverview).display !== 'none' &&
        getComputedStyle(homePermissionCard).display !== 'none' &&
        getComputedStyle(statusPermission).display !== 'none' &&
        overviewButton.querySelector('.navigation-label')?.textContent?.trim() === 'Home' &&
        agentButton.querySelector('.navigation-label')?.textContent?.trim() === 'ChatGPT Connection' &&
        runsButton.querySelector('.navigation-label')?.textContent?.trim() === 'Task History' &&
        computerButton.querySelector('.navigation-label')?.textContent?.trim() === 'Desktop Control' &&
        workbenchToggle.querySelector('span')?.textContent?.trim() === 'Workbench' &&
        appearanceTab.textContent?.trim() === 'Appearance' &&
        hostTab.textContent?.trim() === 'Host' &&
        securityTab.textContent?.trim() === 'Permissions & Security' &&
        startupView.querySelector('option[value="runs"]')?.textContent?.trim() === 'Task History' &&
        document.querySelector('#status-permission-action .statusbar-label')?.textContent?.trim() === 'Permission' &&
        document.querySelector('#status-authority')?.textContent?.trim() === 'Ask for high-risk actions · L3' &&
        !(document.body?.innerText ?? '').includes('Recent activity') &&
        (document.body?.innerText ?? '').includes('Technical details');
      return {
        ok:
          chineseSimple &&
          simpleAuthorityBoundary &&
          chineseNavigation &&
          simplePermissionEntry &&
          settingsKeyboard &&
          collapsedSidebar &&
          englishFull,
        chineseSimple,
        simpleAuthorityBoundary,
        chineseNavigation,
        simplePermissionEntry,
        settingsKeyboard,
        collapsedSidebar,
        englishFull,
      };
    })()`,
    true,
  ) as {
    readonly ok: boolean;
    readonly reason?: string;
    readonly chineseSimple?: boolean;
    readonly simpleAuthorityBoundary?: boolean;
    readonly chineseNavigation?: boolean;
    readonly simplePermissionEntry?: boolean;
    readonly settingsKeyboard?: boolean;
    readonly collapsedSidebar?: boolean;
    readonly englishFull?: boolean;
  };
  if (!result.ok) {
    throw new Error(`Interface preference verification failed: ${JSON.stringify(result)}`);
  }
}

async function activateView(window: BrowserWindow, view: string): Promise<void> {
  const activated = await window.webContents.executeJavaScript(
    `(() => {
      const button = document.querySelector('.navigation-item[data-view=${JSON.stringify(view)}]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      const scroll = document.querySelector('.content-scroll');
      if (scroll instanceof HTMLElement) scroll.scrollTop = 0;
      return document.querySelector('#view-${view}')?.classList.contains('is-active') === true;
    })()`,
    true,
  ) as boolean;
  if (!activated) {
    throw new Error(`Could not activate renderer view: ${view}`);
  }
  await window.webContents.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    true,
  );
  await delay(80);
}

async function verifyPermissionSelectionRetention(window: BrowserWindow): Promise<void> {
  await activateView(window, "settings");
  const result = await window.webContents.executeJavaScript(
    `(async () => {
      const hostTab = document.querySelector('[data-settings-tab="host"]');
      const securityTab = document.querySelector('[data-settings-tab="security"]');
      const unattended = document.querySelector('#unattended-workspace-access');
      const settingsBypass = document.querySelector('#settings-bypass-toggle');
      const webBypass = document.querySelector('#web-bypass-toggle');
      const bypassStateLabel = document.querySelector('#settings-bypass-state');
      const restartValue = document.querySelector('#restart-authority-value');
      const statusAuthority = document.querySelector('#status-authority');
      const settingsGroup = document.querySelector('#settings-permission-profiles');
      const webGroup = document.querySelector('#web-permission-profiles');
      const settingsConsequential = document.querySelector(
        '[data-settings-pane="security"] [data-permission-profile="consequential"]',
      );
      const webConsequential = document.querySelector(
        '#web-permission-profiles [data-permission-profile="consequential"]',
      );
      if (
        !(hostTab instanceof HTMLButtonElement) ||
        !(securityTab instanceof HTMLButtonElement) ||
        !(unattended instanceof HTMLInputElement) ||
        !(settingsBypass instanceof HTMLButtonElement) ||
        !(webBypass instanceof HTMLButtonElement) ||
        !(bypassStateLabel instanceof HTMLElement) ||
        !(restartValue instanceof HTMLElement) ||
        !(statusAuthority instanceof HTMLElement) ||
        !(settingsGroup instanceof HTMLElement) ||
        !(webGroup instanceof HTMLElement) ||
        !(settingsConsequential instanceof HTMLButtonElement) ||
        !(webConsequential instanceof HTMLButtonElement)
      ) {
        return { ok: false, reason: 'permission selector controls missing' };
      }

      const settingsButtons = Array.from(settingsGroup.querySelectorAll('[data-permission-profile]'));
      const webButtons = Array.from(webGroup.querySelectorAll('[data-permission-profile]'));
      if (
        settingsButtons.length !== 3 ||
        webButtons.length !== 3 ||
        !settingsButtons.every((button) => button instanceof HTMLButtonElement) ||
        !webButtons.every((button) => button instanceof HTMLButtonElement)
      ) {
        return { ok: false, reason: 'L1-L3 permission buttons missing' };
      }

      const waitForState = async (predicate) => {
        const deadline = Date.now() + 2_000;
        let snapshot = await window.sovereign.getState();
        while (!predicate(snapshot) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          snapshot = await window.sovereign.getState();
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return snapshot;
      };
      const selectedLabel = 'Ask for high-risk actions · L3';
      const l4Label = 'Bypass confirmations · L4';
      const isSelected = (button) =>
        button.classList.contains('is-selected') && button.getAttribute('aria-pressed') === 'true';
      const noL1ToL3Selected = (buttons) => buttons.every((button) =>
        !button.classList.contains('is-selected') && button.getAttribute('aria-pressed') === 'false'
      );

      hostTab.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const initialState = await waitForState((snapshot) =>
        snapshot.permissionProfile === 'consequential' &&
        snapshot.rememberedPermissionProfile === 'consequential' &&
        snapshot.unattendedWorkspaceAccess === true
      );
      const initialSelection =
        initialState.permissionProfile === 'consequential' &&
        initialState.rememberedPermissionProfile === 'consequential' &&
        unattended.checked &&
        restartValue.textContent?.trim() === selectedLabel &&
        statusAuthority.textContent?.trim() === selectedLabel &&
        isSelected(settingsConsequential) &&
        isSelected(webConsequential) &&
        !isSelected(settingsBypass) &&
        !isSelected(webBypass);

      unattended.checked = false;
      unattended.dispatchEvent(new Event('change', { bubbles: true }));
      const disabledState = await waitForState((snapshot) =>
        snapshot.unattendedWorkspaceAccess === false &&
        snapshot.permissionProfile === 'consequential' &&
        snapshot.rememberedPermissionProfile === 'consequential'
      );
      const preservedWhenDisabled =
        disabledState.unattendedWorkspaceAccess === false &&
        disabledState.permissionProfile === 'consequential' &&
        disabledState.rememberedPermissionProfile === 'consequential' &&
        !unattended.checked;

      unattended.checked = true;
      unattended.dispatchEvent(new Event('change', { bubbles: true }));
      const enabledState = await waitForState((snapshot) =>
        snapshot.unattendedWorkspaceAccess === true &&
        snapshot.permissionProfile === 'consequential' &&
        snapshot.rememberedPermissionProfile === 'consequential'
      );
      const preservedWhenEnabled =
        enabledState.unattendedWorkspaceAccess === true &&
        enabledState.permissionProfile === 'consequential' &&
        enabledState.rememberedPermissionProfile === 'consequential' &&
        unattended.checked;

      securityTab.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      settingsBypass.click();
      const bypassState = await waitForState((snapshot) =>
        snapshot.permissionProfile === 'bypass' &&
        snapshot.rememberedPermissionProfile === 'consequential'
      );
      const bypassShowsSingleActiveLevel =
        bypassState.permissionProfile === 'bypass' &&
        bypassState.rememberedPermissionProfile === 'consequential' &&
        statusAuthority.textContent?.trim() === l4Label &&
        restartValue.textContent?.trim() === l4Label &&
        noL1ToL3Selected(settingsButtons) &&
        noL1ToL3Selected(webButtons) &&
        isSelected(settingsBypass) &&
        isSelected(webBypass) &&
        settingsGroup.classList.contains('shows-bypass-active') &&
        webGroup.classList.contains('shows-bypass-active') &&
        settingsGroup.getAttribute('aria-label') === 'ChatGPT permission level' &&
        bypassStateLabel.textContent?.trim() === 'On';

      settingsBypass.click();
      const restoredState = await waitForState((snapshot) =>
        snapshot.permissionProfile === 'consequential' &&
        snapshot.rememberedPermissionProfile === 'consequential'
      );
      const restoredAfterBypass =
        restoredState.permissionProfile === 'consequential' &&
        restoredState.rememberedPermissionProfile === 'consequential' &&
        restoredState.unattendedWorkspaceAccess === true &&
        statusAuthority.textContent?.trim() === selectedLabel &&
        restartValue.textContent?.trim() === selectedLabel &&
        isSelected(settingsConsequential) &&
        isSelected(webConsequential) &&
        !isSelected(settingsBypass) &&
        !isSelected(webBypass) &&
        bypassStateLabel.textContent?.trim() === 'Off';

      return {
        ok:
          initialSelection &&
          preservedWhenDisabled &&
          preservedWhenEnabled &&
          bypassShowsSingleActiveLevel &&
          restoredAfterBypass,
        initialSelection,
        preservedWhenDisabled,
        preservedWhenEnabled,
        bypassShowsSingleActiveLevel,
        restoredAfterBypass,
      };
    })()`,
    true,
  ) as {
    readonly ok: boolean;
    readonly reason?: string;
    readonly initialSelection?: boolean;
    readonly preservedWhenDisabled?: boolean;
    readonly preservedWhenEnabled?: boolean;
    readonly bypassShowsSingleActiveLevel?: boolean;
    readonly restoredAfterBypass?: boolean;
  };
  if (!result.ok) {
    throw new Error(`Permission selection retention verification failed: ${JSON.stringify(result)}`);
  }
}

async function verifyActivityView(window: BrowserWindow): Promise<void> {
  await activateView(window, "runs");
  const result = await window.webContents.executeJavaScript(
    `(async () => {
      const language = document.querySelector('#ui-language');
      const empty = document.querySelector('#runs-empty-state');
      const workbench = document.querySelector('#runs-workbench');
      const runsCount = document.querySelector('#runs-count');
      const cancel = document.querySelector('#run-cancel');
      const stdout = document.querySelector('#run-stdout');
      const stderr = document.querySelector('#run-stderr');
      const runsTab = document.querySelector('#runs-tab-runs');
      const auditTab = document.querySelector('#runs-tab-audit');
      const search = document.querySelector('#audit-search');
      const outcomeFilter = document.querySelector('#audit-outcome-filter');
      const subviewTabs = document.querySelector('.subview-tabs');
      const outputTabs = document.querySelector('.run-output-tabs');
      const activeSection = document.querySelector('#active-run-section');
      const activeEmpty = document.querySelector('#active-run-empty');
      const activeTitle = document.querySelector('#active-run-title');
      const activeDuration = document.querySelector('#active-run-duration');
      const activeOutput = document.querySelector('#active-run-output');
      const activeView = document.querySelector('#active-run-view');
      const activeCancel = document.querySelector('#active-run-cancel');
      if (
        !(language instanceof HTMLSelectElement) ||
        !(empty instanceof HTMLElement) ||
        !(workbench instanceof HTMLElement) ||
        !(runsCount instanceof HTMLElement) ||
        !(cancel instanceof HTMLButtonElement) ||
        !(stdout instanceof HTMLElement) ||
        !(stderr instanceof HTMLElement) ||
        !(runsTab instanceof HTMLButtonElement) ||
        !(auditTab instanceof HTMLButtonElement) ||
        !(search instanceof HTMLInputElement) ||
        !(outcomeFilter instanceof HTMLSelectElement) ||
        !(subviewTabs instanceof HTMLElement) ||
        !(outputTabs instanceof HTMLElement) ||
        !(activeSection instanceof HTMLElement) ||
        !(activeEmpty instanceof HTMLElement) ||
        !(activeTitle instanceof HTMLElement) ||
        !(activeDuration instanceof HTMLElement) ||
        !(activeOutput instanceof HTMLElement) ||
        !(activeView instanceof HTMLButtonElement) ||
        !(activeCancel instanceof HTMLButtonElement)
      ) {
        return { ok: false, reason: 'task history controls missing' };
      }

      // Task History intentionally restores the operator's last subview. Establish the
      // Runs tab explicitly before asserting its tab semantics so prior visual runs cannot
      // leak a persisted Audit selection into this verification.
      runsTab.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const deadline = Date.now() + 2_000;
      while (
        (document.querySelectorAll('#runs-list .run-row').length < 3 || activeTitle.textContent?.trim() !== 'pnpm typecheck') &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Recent output arrives asynchronously. Sampling before it lands captures
      // the loading placeholder, and the later language comparison then reads a
      // legitimate content change as a localization failure.
      const activeOutputDeadline = Date.now() + 5_000;
      while (
        !(activeOutput.textContent ?? '').includes('tsc -b --pretty false') &&
        Date.now() < activeOutputDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const originalStdout = stdout.textContent ?? '';
      const originalActiveOutput = activeOutput.textContent ?? '';
      const activeRunState =
        !activeSection.hidden &&
        getComputedStyle(activeSection).display !== 'none' &&
        activeEmpty.hidden &&
        getComputedStyle(activeEmpty).display === 'none' &&
        activeTitle.textContent?.trim() === 'pnpm typecheck' &&
        activeDuration.textContent?.trim() !== '—' &&
        originalActiveOutput.includes('tsc -b --pretty false') &&
        !activeCancel.disabled &&
        Number.parseFloat(getComputedStyle(activeOutput).fontSize) >= 11.5 &&
        document.querySelector('.activity-monitor') === null;
      const historyState =
        empty.hidden &&
        getComputedStyle(empty).display === 'none' &&
        !workbench.hidden &&
        getComputedStyle(workbench).display !== 'none' &&
        document.querySelectorAll('#runs-list .run-row').length === 3 &&
        runsCount.textContent?.trim() === '1 active · 3 total';
      const tabValues = {
        subviewRole: subviewTabs.getAttribute('role'),
        runsRole: runsTab.getAttribute('role'),
        runsControls: runsTab.getAttribute('aria-controls'),
        runsSelected: runsTab.getAttribute('aria-selected'),
        runsTabIndex: runsTab.tabIndex,
        auditSelected: auditTab.getAttribute('aria-selected'),
        auditTabIndex: auditTab.tabIndex,
        outputRole: outputTabs.getAttribute('role'),
        stdoutRole: document.querySelector('#run-output-pane-stdout')?.getAttribute('role'),
      };
      const tabSemantics =
        tabValues.subviewRole === 'tablist' &&
        tabValues.runsRole === 'tab' &&
        tabValues.runsControls === 'runs-pane-runs' &&
        tabValues.runsSelected === 'true' &&
        tabValues.runsTabIndex === 0 &&
        tabValues.auditTabIndex === -1 &&
        tabValues.outputRole === 'tablist' &&
        tabValues.stdoutRole === 'tabpanel';

      runsTab.focus();
      runsTab.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const focusedAuditTab = document.activeElement;
      const keyboardAudit =
        focusedAuditTab instanceof HTMLButtonElement &&
        focusedAuditTab.dataset.runsTab === 'audit' &&
        focusedAuditTab.getAttribute('aria-selected') === 'true' &&
        focusedAuditTab.tabIndex === 0 &&
        !document.querySelector('#runs-pane-audit')?.hasAttribute('hidden');
      if (focusedAuditTab instanceof HTMLButtonElement) {
        focusedAuditTab.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          bubbles: true,
          cancelable: true,
          composed: true,
        }));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const focusedRunsTab = document.activeElement;
      const keyboardTabs =
        keyboardAudit &&
        focusedRunsTab instanceof HTMLButtonElement &&
        focusedRunsTab.dataset.runsTab === 'runs' &&
        focusedRunsTab.getAttribute('aria-selected') === 'true' &&
        focusedRunsTab.tabIndex === 0 &&
        !document.querySelector('#runs-pane-runs')?.hasAttribute('hidden');

      language.value = 'zh-CN';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const localizedOutputDeadline = Date.now() + 2_000;
      while (activeOutput.textContent !== originalActiveOutput && Date.now() < localizedOutputDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const chineseValues = {
        lang: document.documentElement.lang,
        emptyHidden: empty.hidden,
        emptyDisplay: getComputedStyle(empty).display,
        emptyTitle: empty.querySelector('strong')?.textContent?.trim(),
        emptyText: empty.textContent?.trim(),
        runsCount: runsCount.textContent?.trim(),
        subviewLabel: subviewTabs.getAttribute('aria-label'),
        outputLabel: outputTabs.getAttribute('aria-label'),
        cancel: cancel.textContent?.trim(),
        activeText: activeSection.innerText,
        activeView: activeView.textContent?.trim(),
        activeCancel: activeCancel.textContent?.trim(),
        stderr: stderr.textContent?.trim(),
        stderrPlaceholder: stderr.hasAttribute('data-i18n-placeholder'),
        stdoutSame: stdout.textContent === originalStdout,
        stdoutPlaceholder: stdout.hasAttribute('data-i18n-placeholder'),
        activeOutputSame: activeOutput.textContent === originalActiveOutput,
      };
      const chineseRuns =
        chineseValues.lang === 'zh-CN' &&
        chineseValues.emptyHidden &&
        chineseValues.emptyDisplay === 'none' &&
        chineseValues.emptyTitle === '尚无运行历史' &&
        chineseValues.emptyText?.includes('持续时间和退出状态') === true &&
        chineseValues.runsCount === '1 个活动 · 共 3 条' &&
        chineseValues.subviewLabel === '任务记录视图' &&
        chineseValues.outputLabel === '运行输出' &&
        chineseValues.cancel === '取消任务' &&
        chineseValues.activeText.includes('当前任务') &&
        chineseValues.activeView === '查看详情' &&
        chineseValues.activeCancel === '取消任务' &&
        chineseValues.activeOutputSame &&
        chineseValues.stderr === '未捕获 stderr。' &&
        chineseValues.stderrPlaceholder &&
        chineseValues.stdoutSame &&
        !chineseValues.stdoutPlaceholder;
      auditTab.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const chineseAudit =
        search.placeholder === '按工具、操作或路径筛选' &&
        outcomeFilter.getAttribute('aria-label') === '审计结果筛选' &&
        document.querySelector('.outcome-denied')?.textContent?.trim() === '已拒绝';

      search.value = '__visual_no_receipt_match__';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const filteredEmpty = document.querySelector('#audit-body .table-empty')?.textContent?.trim();
      const chineseFilteredEmpty = filteredEmpty === '没有符合当前筛选条件的回执。';

      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      runsTab.click();
      language.value = 'en';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const restoredOutputDeadline = Date.now() + 2_000;
      while (activeOutput.textContent !== originalActiveOutput && Date.now() < restoredOutputDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const restoredEnglish =
        document.documentElement.lang === 'en' &&
        runsCount.textContent?.trim() === '1 active · 3 total' &&
        empty.querySelector('strong')?.textContent?.trim() === 'No run history yet' &&
        subviewTabs.getAttribute('aria-label') === 'Task history views' &&
        activeSection.innerText.includes('CURRENT TASK') &&
        activeCancel.textContent?.trim() === 'Cancel task' &&
        stderr.textContent?.trim() === 'No stderr captured.' &&
        stdout.textContent === originalStdout &&
        activeOutput.textContent === originalActiveOutput &&
        document.querySelector('#status-permission-action .statusbar-label')?.textContent?.trim() === 'Permission';

      return {
        ok:
          activeRunState &&
          historyState &&
          tabSemantics &&
          keyboardTabs &&
          chineseRuns &&
          chineseAudit &&
          chineseFilteredEmpty &&
          restoredEnglish,
        activeRunState,
        historyState,
        tabSemantics,
        tabValues,
        keyboardTabs,
        chineseRuns,
        chineseValues,
        chineseAudit,
        chineseFilteredEmpty,
        filteredEmpty,
        restoredEnglish,
        restoredEnglishValues: {
          lang: document.documentElement.lang,
          runsCount: runsCount.textContent?.trim(),
          emptyTitle: empty.querySelector('strong')?.textContent?.trim(),
          subviewLabel: subviewTabs.getAttribute('aria-label'),
          activeText: activeSection.innerText,
          activeCancel: activeCancel.textContent?.trim(),
          stderr: stderr.textContent?.trim(),
          stdoutSame: stdout.textContent === originalStdout,
          activeOutputSame: activeOutput.textContent === originalActiveOutput,
          permissionLabel: document.querySelector('#status-permission-action .statusbar-label')?.textContent?.trim(),
        },
      };
    })()`,
    true,
  ) as {
    readonly ok: boolean;
    readonly reason?: string;
    readonly activeRunState?: boolean;
    readonly historyState?: boolean;
    readonly tabSemantics?: boolean;
    readonly tabValues?: Readonly<Record<string, unknown>>;
    readonly keyboardTabs?: boolean;
    readonly chineseRuns?: boolean;
    readonly chineseValues?: Readonly<Record<string, unknown>>;
    readonly chineseAudit?: boolean;
    readonly chineseFilteredEmpty?: boolean;
    readonly filteredEmpty?: string;
    readonly restoredEnglish?: boolean;
  };
  if (!result.ok) {
    throw new Error(`Task History verification failed: ${JSON.stringify(result)}`);
  }
}

async function verifyPersistentL4RendererState(
  window: BrowserWindow,
  rendererProblems: readonly string[],
): Promise<void> {
  await activateView(window, "settings");
  const enabled = await window.webContents.executeJavaScript(
    `(async () => {
      const securityTab = document.querySelector('[data-settings-tab="security"]');
      const consequential = document.querySelector(
        '[data-settings-pane="security"] [data-permission-profile="consequential"]',
      );
      const permissionGroup = document.querySelector('#settings-permission-profiles');
      const bypassToggle = document.querySelector('#settings-bypass-toggle');
      const authority = document.querySelector('#status-authority');
      const restartValue = document.querySelector('#restart-authority-value');
      const experienceMode = document.querySelector('#ui-experience-mode');
      if (
        !(securityTab instanceof HTMLButtonElement) ||
        !(consequential instanceof HTMLButtonElement) ||
        !(permissionGroup instanceof HTMLElement) ||
        !(bypassToggle instanceof HTMLButtonElement) ||
        !(authority instanceof HTMLElement) ||
        !(restartValue instanceof HTMLElement) ||
        !(experienceMode instanceof HTMLSelectElement)
      ) {
        return { ok: false, reason: 'persistent L4 controls missing' };
      }
      const buttons = Array.from(permissionGroup.querySelectorAll('[data-permission-profile]'));
      const waitForState = async (predicate) => {
        const deadline = Date.now() + 2_000;
        let state = await window.sovereign.getState();
        while (!predicate(state) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          state = await window.sovereign.getState();
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return state;
      };
      const noL1ToL3Selected = () => buttons.every((button) =>
        button instanceof HTMLButtonElement &&
        !button.classList.contains('is-selected') &&
        button.getAttribute('aria-pressed') === 'false'
      );

      securityTab.click();
      consequential.click();
      await waitForState((state) => state.permissionProfile === 'consequential');
      bypassToggle.click();
      const state = await waitForState((candidate) =>
        candidate.permissionProfile === 'bypass' &&
        candidate.rememberedPermissionProfile === 'consequential'
      );

      experienceMode.value = 'simple';
      experienceMode.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const simpleModeKeepsL4Visible =
        getComputedStyle(bypassToggle).display !== 'none' &&
        bypassToggle.getBoundingClientRect().height > 0;
      experienceMode.value = 'full';
      experienceMode.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return {
        ok:
          state.permissionProfile === 'bypass' &&
          state.rememberedPermissionProfile === 'consequential' &&
          authority.textContent?.trim() === 'Bypass confirmations · L4' &&
          restartValue.textContent?.trim() === 'Bypass confirmations · L4' &&
          noL1ToL3Selected() &&
          bypassToggle.classList.contains('is-selected') &&
          bypassToggle.getAttribute('aria-pressed') === 'true' &&
          permissionGroup.classList.contains('shows-bypass-active') &&
          simpleModeKeepsL4Visible,
        permissionProfile: state.permissionProfile,
        rememberedPermissionProfile: state.rememberedPermissionProfile,
        selectedCount: buttons.filter((button) => button.classList.contains('is-selected')).length,
        l4Selected: bypassToggle.classList.contains('is-selected'),
        simpleModeKeepsL4Visible,
      };
    })()`,
    true,
  ) as {
    readonly ok: boolean;
    readonly reason?: string;
    readonly permissionProfile?: string;
    readonly rememberedPermissionProfile?: string;
    readonly selectedCount?: number;
    readonly l4Selected?: boolean;
    readonly simpleModeKeepsL4Visible?: boolean;
  };
  if (!enabled.ok) {
    throw new Error(`Could not establish persistent L4 state: ${JSON.stringify(enabled)}`);
  }

  await window.loadURL(`${RENDERER_ORIGIN}index.html`);
  await waitForRenderer(window, rendererProblems);
  await activateView(window, "settings");
  const deadline = Date.now() + 2_000;
  let restored: {
    readonly ok: boolean;
    readonly state?: unknown;
    readonly selectedCount?: number;
    readonly l4Selected?: boolean;
  } = { ok: false };
  while (!restored.ok && Date.now() < deadline) {
    restored = await window.webContents.executeJavaScript(
      `(async () => {
        const securityTab = document.querySelector('[data-settings-tab="security"]');
        if (securityTab instanceof HTMLButtonElement) {
          securityTab.click();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        const state = await window.sovereign.getState();
        const group = document.querySelector('#settings-permission-profiles');
        const bypassToggle = document.querySelector('#settings-bypass-toggle');
        const buttons = Array.from(group?.querySelectorAll('[data-permission-profile]') ?? []);
        const selectedCount = buttons.filter((button) =>
          button.classList.contains('is-selected') || button.getAttribute('aria-pressed') === 'true'
        ).length;
        return {
          ok:
            state.permissionProfile === 'bypass' &&
            state.rememberedPermissionProfile === 'consequential' &&
            selectedCount === 0 &&
            bypassToggle instanceof HTMLButtonElement &&
            bypassToggle.classList.contains('is-selected') &&
            bypassToggle.getAttribute('aria-pressed') === 'true' &&
            group?.classList.contains('shows-bypass-active') === true,
          state,
          selectedCount,
          l4Selected: bypassToggle?.classList.contains('is-selected'),
        };
      })()`,
      true,
    ) as typeof restored;
    if (!restored.ok) {
      await delay(25);
    }
  }
  if (!restored.ok) {
    throw new Error(`L4 was not retained after renderer reload: ${JSON.stringify(restored)}`);
  }

  const revoked = await window.webContents.executeJavaScript(
    `(async () => {
      const securityTab = document.querySelector('[data-settings-tab="security"]');
      const bypassToggle = document.querySelector('#settings-bypass-toggle');
      const consequential = document.querySelector(
        '[data-settings-pane="security"] [data-permission-profile="consequential"]',
      );
      const experienceMode = document.querySelector('#ui-experience-mode');
      if (
        !(securityTab instanceof HTMLButtonElement) ||
        !(bypassToggle instanceof HTMLButtonElement) ||
        !(consequential instanceof HTMLButtonElement) ||
        !(experienceMode instanceof HTMLSelectElement)
      ) {
        return false;
      }
      securityTab.click();
      bypassToggle.click();
      const deadline = Date.now() + 2_000;
      let state = await window.sovereign.getState();
      while (state.permissionProfile !== 'consequential' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        state = await window.sovereign.getState();
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      experienceMode.value = 'simple';
      experienceMode.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const simpleModeKeepsActiveL3Visible =
        consequential.classList.contains('is-selected') &&
        consequential.getAttribute('aria-pressed') === 'true' &&
        getComputedStyle(consequential).display !== 'none' &&
        consequential.getBoundingClientRect().height > 0;
      experienceMode.value = 'full';
      experienceMode.dispatchEvent(new Event('change', { bubbles: true }));
      return state.permissionProfile === 'consequential' &&
        state.rememberedPermissionProfile === 'consequential' &&
        simpleModeKeepsActiveL3Visible;
    })()`,
    true,
  ) as boolean;
  if (!revoked) {
    throw new Error('Could not revoke persistent L4 and restore the remembered L3 profile.');
  }
}

async function verifyRoundTwoUiComposition(window: BrowserWindow): Promise<void> {
  await activateView(window, "settings");
  const settingsResult = await window.webContents.executeJavaScript(
    `(async () => {
      const language = document.querySelector('#ui-language');
      const mode = document.querySelector('#ui-experience-mode');
      const appearanceTab = document.querySelector('[data-settings-tab="appearance"]');
      const hostTab = document.querySelector('[data-settings-tab="host"]');
      const securityTab = document.querySelector('[data-settings-tab="security"]');
      const tablist = document.querySelector('.settings-tabs');
      const navRow = document.querySelector('.settings-nav-row');
      const content = document.querySelector('.settings-content');
      if (
        !(language instanceof HTMLSelectElement) ||
        !(mode instanceof HTMLSelectElement) ||
        !(appearanceTab instanceof HTMLButtonElement) ||
        !(hostTab instanceof HTMLButtonElement) ||
        !(securityTab instanceof HTMLButtonElement) ||
        !(tablist instanceof HTMLElement) ||
        !(navRow instanceof HTMLElement) ||
        !(content instanceof HTMLElement)
      ) {
        return { ok: false, reason: 'round-two settings controls missing' };
      }
      mode.value = 'full';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      language.value = 'zh-CN';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      securityTab.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const permissionGroup = document.querySelector('#settings-permission-profiles');
      const permissionTiles = Array.from(permissionGroup?.querySelectorAll('button') ?? []);
      const permissionRects = permissionTiles.map((tile) => tile.getBoundingClientRect());
      const widths = permissionRects.map((rect) => rect.width);
      const heights = permissionRects.map((rect) => rect.height);
      const balancedPermissions =
        permissionGroup instanceof HTMLElement &&
        permissionTiles.length === 4 &&
        permissionTiles.every((tile) => tile instanceof HTMLButtonElement) &&
        Math.max(...widths) - Math.min(...widths) < 2 &&
        Math.max(...heights) - Math.min(...heights) < 2 &&
        Math.min(...heights) >= 80 &&
        permissionTiles.every(tile => {
          const description = tile.querySelector('.permission-profile-description');
          return description && description.textContent.trim().length > 0 &&
            description.scrollHeight <= description.clientHeight + 1;
        }) &&
        document.querySelector('#settings-bypass-section') === null &&
        document.querySelector('#settings-bypass-row') === null;

      appearanceTab.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const tabs = Array.from(tablist.querySelectorAll('[data-settings-tab]'));
      const tabRects = tabs.map((tab) => tab.getBoundingClientRect());
      const firstRow = document.querySelector('#settings-pane-appearance .settings-row');
      const firstControl = firstRow?.querySelector('.settings-select');
      const navRect = navRow.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const firstRowStyle = firstRow instanceof HTMLElement ? getComputedStyle(firstRow) : null;
      const rootStyle = getComputedStyle(document.documentElement);
      const canvasToken = rootStyle.getPropertyValue('--ui-canvas').trim().toLowerCase();
      const surfaceToken = rootStyle.getPropertyValue('--ui-surface').trim().toLowerCase();
      const rowHasBreathingRoom =
        firstRowStyle !== null &&
        Number.parseFloat(firstRowStyle.paddingLeft) >= 16 &&
        Number.parseFloat(firstRowStyle.paddingRight) >= 16 &&
        Number.parseFloat(firstRowStyle.paddingTop) >= 12 &&
        Number.parseFloat(firstRowStyle.paddingBottom) >= 12;
      const neutralDarkPalette =
        canvasToken === '#1e1e1e' &&
        surfaceToken === '#252526' &&
        getComputedStyle(document.body).backgroundColor === 'rgb(30, 30, 30)';
      const compactSettings =
        getComputedStyle(tablist).display === 'flex' &&
        getComputedStyle(tablist).flexDirection === 'row' &&
        navRect.height <= 58 &&
        tabRects.length === 4 &&
        Math.max(...tabRects.map((rect) => rect.top)) - Math.min(...tabRects.map((rect) => rect.top)) < 2 &&
        contentRect.left - navRect.left < 90 &&
        firstRow instanceof HTMLElement &&
        firstControl instanceof HTMLElement &&
        firstRow.getBoundingClientRect().height <= 96 &&
        firstControl.getBoundingClientRect().width <= 200 &&
        rowHasBreathingRoom &&
        neutralDarkPalette;

      hostTab.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const hostSummary = document.querySelector('.remote-host-summary');
      const hostSummaryText = hostSummary?.textContent ?? '';
      const hostLocalized =
        hostSummary instanceof HTMLElement &&
        /[\u3400-\u9fff]/u.test(hostSummaryText) &&
        !hostSummaryText.includes('Sovereign restores the authorized folder');

      language.value = 'en';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        ok: balancedPermissions && compactSettings && hostLocalized,
        balancedPermissions,
        compactSettings,
        hostLocalized,
        permissionCount: permissionTiles.length,
        permissionWidths: widths,
        permissionHeights: heights,
        navHeight: navRect.height,
        contentOffset: contentRect.left - navRect.left,
        firstRowHeight: firstRow?.getBoundingClientRect().height,
        firstControlWidth: firstControl?.getBoundingClientRect().width,
        firstRowPadding: firstRowStyle === null
          ? null
          : [firstRowStyle.paddingTop, firstRowStyle.paddingRight, firstRowStyle.paddingBottom, firstRowStyle.paddingLeft],
        rowHasBreathingRoom,
        canvasToken,
        surfaceToken,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        neutralDarkPalette,
        hostSummaryText,
      };
    })()`,
    true,
  ) as Readonly<Record<string, unknown>> & { readonly ok: boolean };
  if (!settingsResult.ok) {
    throw new Error(`Round-two settings composition failed: ${JSON.stringify(settingsResult)}`);
  }

  await activateView(window, "tasks");
  await delay(120);
  const taskResult = await window.webContents.executeJavaScript(
    `(() => {
      const grid = document.querySelector('.task-project-task-list');
      const cards = Array.from(document.querySelectorAll('.task-summary-card')).filter(
        (card) => card instanceof HTMLElement && card.getClientRects().length > 0,
      );
      const rects = cards.map((card) => card.getBoundingClientRect());
      const styles = cards.map((card) => getComputedStyle(card));
      const scanRows =
        grid instanceof HTMLElement &&
        getComputedStyle(grid).display === 'grid' &&
        cards.length > 0 &&
        Math.max(...rects.map((rect) => rect.height)) <= 180 &&
        Math.max(...rects.map((rect) => rect.width)) - Math.min(...rects.map((rect) => rect.width)) < 2 &&
        rects.every((rect, index) => index === 0 || rect.top >= rects[index - 1].bottom - 1) &&
        styles.every((style) => style.borderRadius === '0px' && style.boxShadow === 'none');
      return {
        ok: scanRows,
        cardCount: cards.length,
        cardWidths: rects.map((rect) => rect.width),
        cardHeights: rects.map((rect) => rect.height),
        cardTops: rects.map((rect) => rect.top),
        gridColumns: grid instanceof HTMLElement ? getComputedStyle(grid).gridTemplateColumns : null,
      };
    })()`,
    true,
  ) as Readonly<Record<string, unknown>> & { readonly ok: boolean };
  if (!taskResult.ok) {
    throw new Error(`Round-two task card composition failed: ${JSON.stringify(taskResult)}`);
  }

  await activateView(window, "overview");
  await delay(80);
  const overviewResult = await window.webContents.executeJavaScript(
    `(() => {
      const rows = Array.from(document.querySelectorAll('.overview-attention-row'));
      const statusbar = document.querySelector('.statusbar');
      const mainSurface = document.querySelector('.main-surface');
      const topbar = document.querySelector('.topbar');
      const contentScroll = document.querySelector('.content-scroll');
      const activeWorkCard = document.querySelector('.home-active-work-card');
      const summaryGrid = document.querySelector('.home-summary-grid');
      const summaryCards = Array.from(
        document.querySelectorAll('.home-summary-card:not(.home-active-work-card)'),
      );
      const firstAttention = rows[0];
      const firstAttentionTitle = firstAttention?.querySelector('strong');
      const firstAttentionMarker = firstAttention?.querySelector('.overview-attention-marker');
      const firstAttentionRect = firstAttention?.getBoundingClientRect();
      const firstAttentionTitleRect = firstAttentionTitle?.getBoundingClientRect();
      const firstAttentionMarkerRect = firstAttentionMarker?.getBoundingClientRect();
      const markerSeparatedFromCopy =
        rows.length === 0 ||
        (
          firstAttention instanceof HTMLElement &&
          firstAttentionTitle instanceof HTMLElement &&
          firstAttentionMarker instanceof HTMLElement &&
          firstAttentionRect !== undefined &&
          firstAttentionTitleRect !== undefined &&
          firstAttentionMarkerRect !== undefined &&
          getComputedStyle(firstAttention).display === 'grid' &&
          firstAttentionMarkerRect.right + 8 <= firstAttentionTitleRect.left &&
          firstAttentionTitleRect.left - firstAttentionRect.left >= 20
        );
      const compactAttention =
        rows.length <= 4 &&
        rows.every((row) => row.getBoundingClientRect().height <= 132) &&
        markerSeparatedFromCopy;
      const statusbarHeight = statusbar?.getBoundingClientRect().height ?? 0;
      const compactStatusbar = statusbarHeight >= 35 && statusbarHeight <= 37;
      const topbarHeight = topbar?.getBoundingClientRect().height ?? 0;
      const contentRect = contentScroll?.getBoundingClientRect();
      const statusbarRect = statusbar?.getBoundingClientRect();
      const shellAligned =
        mainSurface instanceof HTMLElement &&
        topbar instanceof HTMLElement &&
        contentScroll instanceof HTMLElement &&
        statusbar instanceof HTMLElement &&
        topbarHeight >= 47 &&
        topbarHeight <= 49 &&
        contentRect !== undefined &&
        statusbarRect !== undefined &&
        Math.abs(contentRect.bottom - statusbarRect.top) <= 1;
      const activeWorkRect = activeWorkCard?.getBoundingClientRect();
      const summaryRects = summaryCards.map((card) => card.getBoundingClientRect());
      const activeWorkFirst =
        activeWorkCard instanceof HTMLElement &&
        summaryGrid instanceof HTMLElement &&
        summaryCards.length === 3 &&
        activeWorkRect !== undefined &&
        activeWorkRect.height >= 178 &&
        activeWorkRect.height <= 182 &&
        summaryRects.every((rect) => rect.height >= 74 && rect.height <= 78) &&
        activeWorkRect.top + 1 < Math.min(...summaryRects.map((rect) => rect.top));
      return {
        ok: compactAttention && compactStatusbar && shellAligned && activeWorkFirst,
        attentionCount: rows.length,
        attentionHeights: rows.map((row) => row.getBoundingClientRect().height),
        attentionTitleOffset: firstAttentionRect === undefined || firstAttentionTitleRect === undefined
          ? null
          : firstAttentionTitleRect.left - firstAttentionRect.left,
        markerGap: firstAttentionMarkerRect === undefined || firstAttentionTitleRect === undefined
          ? null
          : firstAttentionTitleRect.left - firstAttentionMarkerRect.right,
        markerSeparatedFromCopy,
        statusbarHeight,
        topbarHeight,
        contentBottom: contentRect?.bottom,
        statusbarTop: statusbarRect?.top,
        activeWorkHeight: activeWorkRect?.height,
        summaryHeights: summaryRects.map((rect) => rect.height),
        activeWorkTop: activeWorkRect?.top,
        summaryTops: summaryRects.map((rect) => rect.top),
        compactAttention,
        compactStatusbar,
        shellAligned,
        activeWorkFirst,
      };
    })()`,
    true,
  ) as Readonly<Record<string, unknown>> & { readonly ok: boolean };
  if (!overviewResult.ok) {
    throw new Error(`Round-two overview composition failed: ${JSON.stringify(overviewResult)}`);
  }
}

async function verifyRoundFourSurfaceComposition(window: BrowserWindow): Promise<void> {
  await activateView(window, "overview");
  await delay(80);
  const overviewResult = await window.webContents.executeJavaScript(
    `(() => {
      const grid = document.querySelector('.home-summary-grid');
      const cards = Array.from(document.querySelectorAll('.home-summary-card'));
      const activeWorkCard = document.querySelector('.home-active-work-card');
      const permissionCard = document.querySelector('.home-permission-card');
      const parseColor = (value) => {
        const channels = value.match(/[\\d.]+/gu)?.map(Number) ?? [];
        if (value.startsWith('color(srgb ') && channels.length >= 3) {
          return {
            red: channels[0] * 255,
            green: channels[1] * 255,
            blue: channels[2] * 255,
            alpha: channels[3] ?? 1,
          };
        }
        return {
          red: channels[0] ?? -1,
          green: channels[1] ?? -1,
          blue: channels[2] ?? -1,
          alpha: channels[3] ?? 1,
        };
      };
      const cardStyles = cards.map((card) => getComputedStyle(card));
      const cardBackgrounds = cardStyles.map((style) => style.backgroundColor);
      const cardColors = cardBackgrounds.map(parseColor);
      const activeIndex = cards.indexOf(activeWorkCard);
      const summaryColors = cardColors.filter((_color, index) => index !== activeIndex);
      const neutralSurface = (color) =>
        Math.min(color.red, color.green, color.blue) >= 35 &&
        Math.max(color.red, color.green, color.blue) <= 50 &&
        Math.max(color.red, color.green, color.blue) - Math.min(color.red, color.green, color.blue) <= 2 &&
        color.alpha >= 0.45 &&
        color.alpha <= 0.65;
      const summaryAlpha = summaryColors[0]?.alpha ?? -1;
      const activeColor = activeIndex >= 0 ? cardColors[activeIndex] : null;
      const gridStyle = grid instanceof HTMLElement ? getComputedStyle(grid) : null;
      const coherentSummary =
        grid instanceof HTMLElement &&
        cards.length === 4 &&
        activeWorkCard instanceof HTMLElement &&
        permissionCard instanceof HTMLElement &&
        gridStyle !== null &&
        gridStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        Number.parseFloat(gridStyle.borderTopWidth) === 0 &&
        Number.parseFloat(gridStyle.columnGap) >= 9.5 &&
        cardColors.every(neutralSurface) &&
        summaryColors.every((color) => Math.abs(color.alpha - summaryAlpha) <= 0.02) &&
        activeColor !== null &&
        activeColor.alpha >= summaryAlpha &&
        cardStyles.every((style) => Number.parseFloat(style.borderTopLeftRadius) >= 7);
      return {
        ok: coherentSummary,
        coherentSummary,
        gridBackground: gridStyle?.backgroundColor ?? null,
        gridBorder: gridStyle?.borderTopWidth ?? null,
        gridGap: gridStyle?.columnGap ?? null,
        cardBackgrounds,
        cardColors,
        cardRadii: cardStyles.map((style) => style.borderTopLeftRadius),
        activeIndex,
        summaryAlpha,
      };
    })()`,
    true,
  ) as Readonly<Record<string, unknown>> & { readonly ok: boolean };
  if (!overviewResult.ok) {
    throw new Error(`Round-four overview surfaces failed: ${JSON.stringify(overviewResult)}`);
  }

  await verifyAgentConnectionSurface(window, activateView);
  await activateView(window, "browser");
  await delay(120);
  const browserResult = await window.webContents.executeJavaScript(
    `(() => {
      const workbench = document.querySelector('.browser-workbench');
      const sessionPanel = document.querySelector('.browser-session-panel');
      const inspector = document.querySelector('.browser-direct-inspector');
      const nav = document.querySelector('.browser-direct-nav');
      const observation = document.querySelector('.browser-direct-observation');
      const actions = document.querySelector('.browser-direct-actions');
      const observationSections = Array.from(observation?.children ?? []);
      const actionSections = Array.from(actions?.children ?? []);
      const colorFloor = (value) => {
        const channels = value.match(/[\\d.]+/gu)?.slice(0, 3).map(Number) ?? [];
        return channels.length === 3 ? Math.min(...channels) : -1;
      };
      const sectionGap = (sections) => {
        if (sections.length < 2) return 0;
        const first = sections[0].getBoundingClientRect();
        const second = sections[1].getBoundingClientRect();
        return second.left - first.right;
      };
      const workbenchStyle = workbench instanceof HTMLElement ? getComputedStyle(workbench) : null;
      const navStyle = nav instanceof HTMLElement ? getComputedStyle(nav) : null;
      const observationStyle = observation instanceof HTMLElement ? getComputedStyle(observation) : null;
      const actionStyle = actions instanceof HTMLElement ? getComputedStyle(actions) : null;
      const sectionStyles = [...observationSections, ...actionSections].map((section) => getComputedStyle(section));
      const coherentBrowser =
        workbench instanceof HTMLElement &&
        sessionPanel instanceof HTMLElement &&
        inspector instanceof HTMLElement &&
        nav instanceof HTMLElement &&
        observation instanceof HTMLElement &&
        actions instanceof HTMLElement &&
        workbenchStyle !== null &&
        navStyle !== null &&
        observationStyle !== null &&
        actionStyle !== null &&
        Number.parseFloat(workbenchStyle.columnGap) >= 10 &&
        Number.parseFloat(workbenchStyle.borderTopWidth) === 0 &&
        workbenchStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        colorFloor(navStyle.backgroundColor) >= 40 &&
        Number.parseFloat(observationStyle.borderBottomWidth) === 0 &&
        Number.parseFloat(actionStyle.borderBottomWidth) === 0 &&
        sectionGap(observationSections) >= 10 &&
        sectionGap(actionSections) >= 10 &&
        sectionStyles.every((style) =>
          Number.parseFloat(style.borderTopLeftRadius) >= 7 &&
          colorFloor(style.backgroundColor) >= 40
        );
      return {
        ok: coherentBrowser,
        coherentBrowser,
        workbenchGap: workbenchStyle?.columnGap ?? null,
        workbenchBorder: workbenchStyle?.borderTopWidth ?? null,
        workbenchBackground: workbenchStyle?.backgroundColor ?? null,
        navBackground: navStyle?.backgroundColor ?? null,
        observationBorder: observationStyle?.borderBottomWidth ?? null,
        actionBorder: actionStyle?.borderBottomWidth ?? null,
        observationGap: sectionGap(observationSections),
        actionGap: sectionGap(actionSections),
        sectionBackgrounds: sectionStyles.map((style) => style.backgroundColor),
        sectionRadii: sectionStyles.map((style) => style.borderTopLeftRadius),
      };
    })()`,
    true,
  ) as Readonly<Record<string, unknown>> & { readonly ok: boolean };
  if (!browserResult.ok) {
    throw new Error(`Round-four browser surfaces failed: ${JSON.stringify(browserResult)}`);
  }
}

async function verifyLargeSurfaceNeutrality(window: BrowserWindow): Promise<void> {
  const views = [
    "overview",
    "tasks",
    "agent",
    "runs",
    "settings",
    "terminal",
    "python",
    "browser",
    "computer",
    "workflows",
  ] as const;
  const failures: Array<{ readonly view: string; readonly offenders: readonly unknown[] }> = [];

  for (const view of views) {
    await activateView(window, view);
    if (view === "settings") {
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-settings-tab="appearance"]')?.click()`,
        true,
      );
    }
    await delay(80);
    const result = await window.webContents.executeJavaScript(
      `(() => {
        const root = document.querySelector('#view-${view}');
        if (!(root instanceof HTMLElement)) {
          return { ok: false, missing: true, offenders: [] };
        }
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
        const ignoredSelector = [
          'html', 'body', '#app', '.application-shell', '.content-shell', '.content-scroll',
          '.view', '.view-content', 'img', 'canvas', 'video', 'iframe', 'svg'
        ].join(',');
        const parseColor = (value) => {
          const match = value.match(/rgba?\\(([^)]+)\\)/u);
          if (match === null) return null;
          const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
          if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
          return {
            red: parts[0],
            green: parts[1],
            blue: parts[2],
            alpha: parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1,
          };
        };
        const describe = (element) => {
          const id = element.id.length > 0 ? '#' + element.id : '';
          const classes = Array.from(element.classList).slice(0, 4).map((name) => '.' + name).join('');
          return element.tagName.toLowerCase() + id + classes;
        };
        const offenders = [];
        for (const element of root.querySelectorAll('*')) {
          if (!(element instanceof HTMLElement) || element.matches(ignoredSelector)) continue;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visible =
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) > 0 &&
            rect.width > 220 &&
            rect.height > 70 &&
            rect.width * rect.height >= viewportArea * 0.055;
          if (!visible) continue;
          const color = parseColor(style.backgroundColor);
          if (color === null || color.alpha < 0.12) continue;
          const channels = [color.red, color.green, color.blue];
          const floor = Math.min(...channels);
          const ceiling = Math.max(...channels);
          const chroma = ceiling - floor;
          const acceptable = floor >= 24 && chroma <= 18;
          if (!acceptable) {
            offenders.push({
              element: describe(element),
              background: style.backgroundColor,
              size: [Math.round(rect.width), Math.round(rect.height)],
              floor,
              chroma,
              text: (element.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 100),
            });
          }
        }
        return { ok: offenders.length === 0, missing: false, offenders: offenders.slice(0, 20) };
      })()`,
      true,
    ) as {
      readonly ok: boolean;
      readonly missing: boolean;
      readonly offenders: readonly unknown[];
    };
    if (!result.ok) failures.push({ view, offenders: result.offenders });
  }

  if (failures.length > 0) {
    throw new Error(`Large surface neutrality verification failed: ${JSON.stringify(failures)}`);
  }
}

interface ReadabilityRequirement {
  readonly view: string;
  readonly selector: string;
  readonly minimumFontSize?: number;
  readonly minimumHeight?: number;
}

interface ReadabilityMeasurement extends ReadabilityRequirement {
  readonly exists: boolean;
  readonly visible: boolean;
  readonly fontSize: number | null;
  readonly height: number | null;
  readonly text: string;
}

async function verifyCoreReadability(window: BrowserWindow): Promise<void> {
  const requirements: readonly ReadabilityRequirement[] = [
    { view: "overview", selector: ".topbar h1", minimumFontSize: 15 },
    { view: "overview", selector: '.navigation-item[data-view="overview"]', minimumFontSize: 11.5, minimumHeight: 34 },
    { view: "overview", selector: ".statusbar", minimumFontSize: 10.5, minimumHeight: 30 },
    { view: "overview", selector: "#status-permission-action", minimumHeight: 28 },
    { view: "overview", selector: ".home-hero p", minimumFontSize: 12 },
    { view: "overview", selector: ".home-summary-card > small", minimumFontSize: 10.5 },
    { view: "agent", selector: ".agent-authority-intro", minimumFontSize: 11.5 },
    { view: "agent", selector: ".permission-segment button strong", minimumFontSize: 11.5 },
    { view: "runs", selector: ".active-run-output", minimumFontSize: 11.5 },
    { view: "runs", selector: ".run-row-identity span", minimumFontSize: 10 },
    { view: "runs", selector: ".subview-tab", minimumFontSize: 10.5, minimumHeight: 32 },
    { view: "settings", selector: ".settings-tab", minimumFontSize: 11, minimumHeight: 34 },
    { view: "settings", selector: ".settings-pane.is-active .settings-row small", minimumFontSize: 10.5 },
  ];
  const measurements: ReadabilityMeasurement[] = [];

  for (const view of [...new Set(requirements.map((requirement) => requirement.view))]) {
    await activateView(window, view);
    if (view === "settings") {
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-settings-tab="appearance"]')?.click()`,
        true,
      );
      await window.webContents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        true,
      );
    }
    const viewRequirements = requirements.filter((requirement) => requirement.view === view);
    const measured = await window.webContents.executeJavaScript(
      `(${JSON.stringify(viewRequirements)}).map((requirement) => {
        const element = document.querySelector(requirement.selector);
        if (!(element instanceof HTMLElement)) {
          return { ...requirement, exists: false, visible: false, fontSize: null, height: null, text: '' };
        }
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          ...requirement,
          exists: true,
          visible:
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) > 0 &&
            rect.width > 0 &&
            rect.height > 0,
          fontSize: Number.parseFloat(style.fontSize),
          height: rect.height,
          text: (element.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        };
      })`,
      true,
    ) as ReadabilityMeasurement[];
    measurements.push(...measured);
  }

  const failures = measurements.filter((measurement) =>
    !measurement.exists ||
    !measurement.visible ||
    (
      measurement.minimumFontSize !== undefined &&
      (measurement.fontSize === null || measurement.fontSize + 0.01 < measurement.minimumFontSize)
    ) ||
    (
      measurement.minimumHeight !== undefined &&
      (measurement.height === null || measurement.height + 0.01 < measurement.minimumHeight)
    )
  );
  if (failures.length > 0) {
    throw new Error(`Core readability verification failed: ${JSON.stringify(failures)}`);
  }
}

async function captureRenderedPage(window: BrowserWindow): Promise<NativeImage> {
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
  return await window.webContents.capturePage(undefined, { stayHidden: true });
}

async function writeScreenshot(
  image: NativeImage,
  viewportLabel: string,
  view: string,
  audit: LayoutAudit,
): Promise<ScreenshotRecord> {
  const bytes = image.toPNG();
  const relativePath = join(viewportLabel, `${view}.png`);
  const absolutePath = join(OUTPUT_ROOT, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  const size = image.getSize();
  return {
    viewport: viewportLabel,
    view,
    relativePath: relativePath.replaceAll("\\", "/"),
    width: size.width,
    height: size.height,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    audit,
  };
}

function issuesFor(record: ScreenshotRecord): readonly VisualIssue[] {
  const issues: VisualIssue[] = [];
  const audit = record.audit;
  // A locale, profile or surface suffix names the same registry view, so the
  // suffixes come off before the id is derived rather than being listed one
  // by one as each new capture is added.
  const base = record.view.replace(/-zh-CN$/u, "").replace(/-l4$/u, "");
  const expectedView = base.startsWith("tasks-") ? "tasks" : base;
  const expectedViewId = `view-${expectedView}`;

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

async function captureViewport(
  window: BrowserWindow,
  width: number,
  height: number,
  views: readonly string[],
): Promise<readonly ScreenshotRecord[]> {
  window.setContentSize(width, height, false);
  await delay(120);
  await window.webContents.executeJavaScript("Promise.all(document.querySelector('.application-shell').getAnimations().map(animation => animation.finished.catch(() => {})))", true);
  if (width === 1040) {
    const narrowShellLayout = await window.webContents.executeJavaScript(`(() => {
      const shell = document.querySelector('.application-shell');
      const sidebar = document.querySelector('.sidebar');
      const main = document.querySelector('.main-surface');
      return { viewportWidth: innerWidth, gridColumns: getComputedStyle(shell).gridTemplateColumns,
        sidebarRight: sidebar.getBoundingClientRect().right, mainLeft: main.getBoundingClientRect().left,
        gap: main.getBoundingClientRect().left - sidebar.getBoundingClientRect().right };
    })()`, true) as { readonly gap: number };
    await writeFile(join(OUTPUT_ROOT, "narrow-shell-layout.json"), JSON.stringify(narrowShellLayout, null, 2), "utf8");
    if (Math.abs(narrowShellLayout.gap) > 1) {
      throw new Error(`The narrow sidebar and main content do not meet: ${JSON.stringify(narrowShellLayout)}`);
    }
  }
  const viewportLabel = `${width}x${height}`;
  const screenshots: ScreenshotRecord[] = [];

  for (const view of views) {
    await activateView(window, view);
    if (view === "tasks") {
      await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('#task-detail-back')?.click();
        document.querySelector('#task-project-grid').scrollTop = 0;
        const deadline = Date.now() + 4000;
        while (document.querySelector('#toast')?.hidden === false && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })()`, true);
    }
    const audit = await window.webContents.executeJavaScript(
      `${layoutAuditScript}(${JSON.stringify(view)})`,
      true,
    ) as LayoutAudit;
    const image = await captureRenderedPage(window);
    screenshots.push(await writeScreenshot(image, viewportLabel, view, audit));
    if (view === "tasks") {
      for (const surface of ["project-workspace", "conversation", "steps"]) {
        const ready = await window.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate) => {
            const deadline = Date.now() + 2500;
            while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
            return predicate();
          };
          document.querySelector('#task-detail-back')?.click();
          const project = document.querySelector('#task-project-select');
          project.value = ${JSON.stringify(surface === "project-workspace" ? "project-visual-sovereign" : "")};
          project.dispatchEvent(new Event('change', { bubbles: true }));
          if (${JSON.stringify(surface)} === 'project-workspace') {
            const ready = await waitFor(() => document.querySelector('#task-project-workspace')?.getAttribute('aria-busy') === 'false' &&
              document.querySelector('#task-project-workspace-select')?.value === 'workspace-visual-sovereign');
            document.querySelector('#task-project-grid').scrollTop = 0;
            return ready;
          }
          const taskId = ${JSON.stringify(surface === "steps" ? "task-visual-agent-hub" : "task-visual-release")};
          await waitFor(() => document.querySelector('#task-project-grid [data-task-id="' + taskId + '"]') instanceof HTMLButtonElement);
          document.querySelector('#task-project-grid [data-task-id="' + taskId + '"]').click();
          if (${JSON.stringify(surface)} === 'steps') {
            const ready = await waitFor(() => document.querySelector('#task-detail-title')?.textContent?.trim() === 'Build task and Agent hub' &&
              document.querySelectorAll('#task-detail-steps .task-step').length === 4);
            if (!ready) return false;
            document.querySelector('#task-steps-toggle').click();
            return await waitFor(() => document.querySelector('#task-steps-popover').matches(':popover-open'));
          }
          const opened = await waitFor(() => document.querySelector('#task-detail-title')?.textContent?.trim() === 'Package and verify the next desktop release' &&
            document.querySelectorAll('#task-message-list .task-message').length === 300);
          if (!opened) return false;
          for (const details of document.querySelectorAll('.task-technical-details, details.task-coordination-card')) details.open = false;
          document.querySelector('#task-message-load-older').click();
          const loaded = await waitFor(() => document.querySelectorAll('#task-message-list .task-message').length === 350);
          document.querySelector('#task-message-list').scrollTop = 100;
          document.querySelector('#task-project-grid').scrollTop = 0;
          return loaded;
        })()`, true) as boolean;
        if (!ready) throw new Error(`Could not establish task ${surface} screenshot state.`);
        const surfaceAudit = await window.webContents.executeJavaScript(`${layoutAuditScript}("tasks")`, true) as LayoutAudit;
        screenshots.push(await writeScreenshot(await captureRenderedPage(window), viewportLabel, `tasks-${surface}`, surfaceAudit));
      }
      await window.webContents.executeJavaScript(`document.querySelector('#task-detail-back').click()`, true);
    }
  }
  return screenshots;
}


/**
 * The connection page under Chinese labels, with the advanced fold open so the
 * proxy and routing fields are measured too. The language is restored before
 * returning so later passes still read English.
 */
async function captureLocalizedAgentViewport(
  window: BrowserWindow,
  width: number,
  height: number,
): Promise<readonly ScreenshotRecord[]> {
  window.setContentSize(width, height, false);
  await delay(120);
  await activateView(window, "agent");
  const ready = await window.webContents.executeJavaScript(
    `(async () => {
      const language = document.querySelector('#ui-language');
      if (!language) return false;
      language.value = 'zh-CN';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      const fold = document.querySelector('.agent-connection-advanced');
      if (fold instanceof HTMLDetailsElement) fold.open = true;
      const ready = () => document.querySelector('#secure-tunnel-start')?.textContent?.trim() === '启动连接';
      const deadline = Date.now() + 2500;
      while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return ready();
    })()`,
    true,
  ) as boolean;
  if (!ready) {
    throw new Error("The Chinese connection page did not render its translated controls.");
  }
  const audit = await window.webContents.executeJavaScript(
    `${layoutAuditScript}("agent")`,
    true,
  ) as LayoutAudit;
  const record = await writeScreenshot(
    await captureRenderedPage(window),
    `${width}x${height}`,
    "agent-zh-CN",
    audit,
  );
  await window.webContents.executeJavaScript(
    `(async () => {
      const language = document.querySelector('#ui-language');
      language.value = 'en';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      const fold = document.querySelector('.agent-connection-advanced');
      if (fold instanceof HTMLDetailsElement) fold.open = false;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`,
    true,
  );
  return [record];
}

async function captureL4PermissionViewport(
  window: BrowserWindow,
  width: number,
  height: number,
): Promise<readonly ScreenshotRecord[]> {
  window.setContentSize(width, height, false);
  await delay(120);
  const viewportLabel = `${width}x${height}`;
  const screenshots: ScreenshotRecord[] = [];
  const originalProfile = await window.webContents.executeJavaScript(
    `window.sovereign.getState().then((snapshot) => snapshot.permissionProfile)`,
    true,
  ) as string;
  if (
    originalProfile !== "observe" &&
    originalProfile !== "workspace" &&
    originalProfile !== "consequential"
  ) {
    throw new Error(`L4 screenshot fixture requires an L1-L3 starting profile, received ${originalProfile}.`);
  }

  await activateView(window, "settings");
  const established = await window.webContents.executeJavaScript(
    `(async () => {
      const mode = document.querySelector('#ui-experience-mode');
      const securityTab = document.querySelector('[data-settings-tab="security"]');
      const workspace = document.querySelector(
        '[data-settings-pane="security"] [data-permission-profile="workspace"]',
      );
      const toggle = document.querySelector('#settings-bypass-toggle');
      const group = document.querySelector('#settings-permission-profiles');
      if (
        !(mode instanceof HTMLSelectElement) ||
        !(securityTab instanceof HTMLButtonElement) ||
        !(workspace instanceof HTMLButtonElement) ||
        !(toggle instanceof HTMLButtonElement) ||
        !(group instanceof HTMLElement)
      ) {
        return { ok: false, reason: 'L4 screenshot controls missing' };
      }
      mode.value = 'full';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      securityTab.click();
      const waitFor = async (predicate) => {
        const deadline = Date.now() + 2_000;
        let snapshot = await window.sovereign.getState();
        while (!predicate(snapshot) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          snapshot = await window.sovereign.getState();
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return snapshot;
      };
      let snapshot = await window.sovereign.getState();
      if (snapshot.permissionProfile === 'bypass') {
        toggle.click();
        snapshot = await waitFor((candidate) => candidate.permissionProfile !== 'bypass');
      }
      if (snapshot.permissionProfile !== 'workspace') {
        workspace.click();
        snapshot = await waitFor((candidate) => candidate.permissionProfile === 'workspace');
      }
      toggle.click();
      snapshot = await waitFor((candidate) =>
        candidate.permissionProfile === 'bypass' &&
        candidate.rememberedPermissionProfile === 'workspace'
      );
      const buttons = Array.from(group.querySelectorAll('[data-permission-profile]'));
      const selectedCount = buttons.filter((button) =>
        button.classList.contains('is-selected') || button.getAttribute('aria-pressed') === 'true'
      ).length;
      const scroll = document.querySelector('.content-scroll');
      if (scroll instanceof HTMLElement) scroll.scrollTop = 0;
      return {
        ok:
          snapshot.permissionProfile === 'bypass' &&
          snapshot.rememberedPermissionProfile === 'workspace' &&
          selectedCount === 0 &&
          toggle.classList.contains('is-selected') &&
          toggle.getAttribute('aria-pressed') === 'true' &&
          group.classList.contains('shows-bypass-active') &&
          group.getAttribute('aria-label') === 'ChatGPT permission level',
        permissionProfile: snapshot.permissionProfile,
        rememberedPermissionProfile: snapshot.rememberedPermissionProfile,
        selectedCount,
        l4Selected: toggle.classList.contains('is-selected'),
      };
    })()`,
    true,
  ) as {
    readonly ok: boolean;
    readonly reason?: string;
    readonly permissionProfile?: string;
    readonly rememberedPermissionProfile?: string;
    readonly selectedCount?: number;
    readonly l4Selected?: boolean;
  };
  if (!established.ok) {
    throw new Error(`Could not establish L4 screenshot state: ${JSON.stringify(established)}`);
  }

  const settingsAudit = await window.webContents.executeJavaScript(
    `${layoutAuditScript}("settings")`,
    true,
  ) as LayoutAudit;
  screenshots.push(await writeScreenshot(
    await captureRenderedPage(window),
    viewportLabel,
    "settings-l4",
    settingsAudit,
  ));

  await activateView(window, "agent");
  const agentState = await window.webContents.executeJavaScript(
    `(() => {
      const group = document.querySelector('#web-permission-profiles');
      const toggle = document.querySelector('#web-bypass-toggle');
      const buttons = Array.from(group?.querySelectorAll('[data-permission-profile]') ?? []);
      const selectedCount = buttons.filter((button) =>
        button.classList.contains('is-selected') || button.getAttribute('aria-pressed') === 'true'
      ).length;
      const scroll = document.querySelector('.content-scroll');
      if (scroll instanceof HTMLElement) scroll.scrollTop = 0;
      return {
        ok:
          group instanceof HTMLElement &&
          toggle instanceof HTMLButtonElement &&
          selectedCount === 0 &&
          toggle.classList.contains('is-selected') &&
          toggle.getAttribute('aria-pressed') === 'true' &&
          group.classList.contains('shows-bypass-active') &&
          group.getAttribute('aria-label') === 'ChatGPT permission level',
        selectedCount,
        l4Selected: toggle instanceof HTMLButtonElement
          ? toggle.classList.contains('is-selected')
          : false,
      };
    })()`,
    true,
  ) as {
    readonly ok: boolean;
    readonly selectedCount?: number;
    readonly l4Selected?: boolean;
  };
  if (!agentState.ok) {
    throw new Error(`Agent L4 screenshot state is inconsistent: ${JSON.stringify(agentState)}`);
  }
  const agentAudit = await window.webContents.executeJavaScript(
    `${layoutAuditScript}("agent")`,
    true,
  ) as LayoutAudit;
  screenshots.push(await writeScreenshot(
    await captureRenderedPage(window),
    viewportLabel,
    "agent-l4",
    agentAudit,
  ));

  await activateView(window, "settings");
  const restored = await window.webContents.executeJavaScript(
    `(async () => {
      const securityTab = document.querySelector('[data-settings-tab="security"]');
      const toggle = document.querySelector('#settings-bypass-toggle');
      const originalProfile = ${JSON.stringify(originalProfile)};
      if (!(securityTab instanceof HTMLButtonElement) || !(toggle instanceof HTMLButtonElement)) {
        return false;
      }
      const waitFor = async (predicate) => {
        const deadline = Date.now() + 2_000;
        let snapshot = await window.sovereign.getState();
        while (!predicate(snapshot) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          snapshot = await window.sovereign.getState();
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return snapshot;
      };
      securityTab.click();
      toggle.click();
      let snapshot = await waitFor((candidate) => candidate.permissionProfile === 'workspace');
      if (originalProfile !== 'workspace') {
        const originalButton = document.querySelector(
          '[data-settings-pane="security"] [data-permission-profile="' + originalProfile + '"]',
        );
        if (!(originalButton instanceof HTMLButtonElement)) return false;
        originalButton.click();
        snapshot = await waitFor((candidate) => candidate.permissionProfile === originalProfile);
      }
      return snapshot.permissionProfile === originalProfile;
    })()`,
    true,
  ) as boolean;
  if (!restored) {
    throw new Error(`Could not restore permission profile ${originalProfile} after L4 screenshots.`);
  }

  return screenshots;
}

interface ApprovalSmokeReport {
  readonly width: number;
  readonly height: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly bodyTextLength: number;
  readonly toolName: string;
  readonly allowLabel: string;
  readonly denyLabel: string;
  readonly consoleProblems: readonly string[];
}

async function runApprovalSmoke(): Promise<void> {
  const window = new BrowserWindow({
    width: 560,
    height: 430,
    useContentSize: true,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#1e1f22",
    title: "Sovereign approval visual smoke",
    webPreferences: {
      preload: resolve(currentDirectory, "..", "preload", "approval-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      backgroundThrottling: false,
    },
  });

  const consoleProblems: string[] = [];
  window.webContents.on("console-message", (event) => {
    const detail = event as unknown as { readonly level?: string; readonly message?: string };
    const message = detail.message?.trim();
    if (message !== undefined && message.length > 0 && (detail.level === "error" || /uncaught|error|failed/i.test(message))) {
      consoleProblems.push(`${detail.level ?? "console"} ${message}`);
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    consoleProblems.push(`render-process-gone: ${details.reason}`);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  try {
    await window.loadURL(`${RENDERER_ORIGIN}approval.html`);
    await window.webContents.executeJavaScript("localStorage.setItem('sovereign.ui.settings.v1', JSON.stringify({language:'en'}))", true);
    await window.loadURL(`${RENDERER_ORIGIN}approval.html`);
    const deadline = Date.now() + 5_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await window.webContents.executeJavaScript(
        `document.querySelector("#approval-tool")?.textContent === ${JSON.stringify(visualApproval.toolName)} && document.querySelector("#approval-allow")?.textContent?.trim() === "Allow once"`,
        true,
      ) as boolean;
      if (ready) {
        break;
      }
      await delay(25);
    }
    if (!ready) {
      throw new Error("Approval renderer did not reach its expected state.");
    }

    const report = await window.webContents.executeJavaScript(
      `(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        bodyTextLength: (document.body?.innerText ?? "").trim().length,
        toolName: document.querySelector("#approval-tool")?.textContent ?? "",
        allowLabel: document.querySelector("#approval-allow")?.textContent?.trim() ?? "",
        denyLabel: document.querySelector("#approval-deny")?.textContent?.trim() ?? "",
      }))()`,
      true,
    ) as Omit<ApprovalSmokeReport, "consoleProblems">;
    const completed: ApprovalSmokeReport = { ...report, consoleProblems };

    if (
      completed.width !== 560 ||
      completed.height !== 430 ||
      completed.scrollWidth > completed.width ||
      completed.bodyTextLength < 80 ||
      completed.toolName !== visualApproval.toolName ||
      completed.allowLabel !== "Allow once" ||
      completed.denyLabel !== "Deny" ||
      completed.consoleProblems.length > 0
    ) {
      throw new Error(`Approval window smoke failed: ${JSON.stringify(completed)}`);
    }

    await writeFile(
      join(OUTPUT_ROOT, "approval-smoke.json"),
      `${JSON.stringify(completed, null, 2)}\n`,
      "utf8",
    );
    const states: unknown[] = [];
    for (const [width, height, scale] of [[560,430,1], [560,430,1.95], [480,340,1], [480,340,1.95]] as const) {
      window.setContentSize(width, height, false);
      await window.webContents.executeJavaScript(`localStorage.setItem('sovereign.ui.settings.v1', JSON.stringify({language:'zh-CN',fontScale:${scale === 1 ? 1 : 1.3},uiScale:${scale === 1 ? 1 : 1.5}}))`, true);
      for (const state of ['pending', 'flood', 'expired', 'failure', 'unavailable'] as const) {
        const request = { ...visualApproval, burstDetected: state === 'flood', expiresAt: new Date(Date.now() + (state === 'expired' ? -1_000 : 30_000)).toISOString() };
        const decisions: unknown[] = [];
        ipcMain.removeHandler(IPC_CHANNELS.approvalGetCurrent);
        ipcMain.handle(IPC_CHANNELS.approvalGetCurrent, () => state === 'unavailable' ? null : request);
        ipcMain.removeHandler(IPC_CHANNELS.approvalResolve);
        ipcMain.handle(IPC_CHANNELS.approvalResolve, (_event, id: unknown, decision: unknown) => {
          if (id !== request.id) throw new Error('Approval request id changed');
          decisions.push(decision);
          if (state === 'failure') throw new Error('Isolated approval submission failure');
        });
        await window.loadURL(`${RENDERER_ORIGIN}approval.html`);
        await delay(100);
        if (state === 'failure') {
          await window.webContents.executeJavaScript("document.querySelector('#approval-allow').click()", true);
          await delay(100);
        }
        const layout = await window.webContents.executeJavaScript(`(() => {
          const buttons = [...document.querySelectorAll('.approval-actions button')].filter(el => !el.hidden);
          const feedback = document.querySelector('#approval-feedback');
          const content = document.querySelector('.approval-content');
          return {
            visibleButtons: buttons.length, disabled: buttons.every(el => el.disabled),
            buttonsFit: buttons.every(el => { const r=el.getBoundingClientRect(); return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight; }),
            horizontalOverflow: document.documentElement.scrollWidth>innerWidth,
            contentHeight: content.clientHeight, detailPreserved: document.querySelector('#approval-detail').textContent===${JSON.stringify(request.detail)},
            feedback:feedback.textContent, error:feedback.classList.contains('is-error'),
            focus:document.activeElement.id, allow:document.querySelector('#approval-allow').textContent.trim(),
          };
        })()`, true) as { visibleButtons:number; disabled:boolean; buttonsFit:boolean; horizontalOverflow:boolean; contentHeight:number; detailPreserved:boolean; feedback:string; error:boolean; focus:string; allow:string };
        const blocked = state === 'expired' || state === 'unavailable';
        if (!layout.buttonsFit || layout.horizontalOverflow || layout.contentHeight < 24 || layout.disabled !== blocked ||
          layout.visibleButtons !== (state === 'flood' ? 3 : 2) || (!blocked && !layout.detailPreserved) ||
          layout.allow !== '仅允许这一次' || (state === 'failure' && (!layout.error || !layout.feedback))) {
          throw new Error(`Approval ${state}/${width}/${scale} failed: ${JSON.stringify(layout)}`);
        }
        await writeFile(join(OUTPUT_ROOT, `approval-${state}-${width}-${scale}.png`), (await captureRenderedPage(window)).toPNG());
        if (state === 'pending' || state === 'flood') {
          await window.webContents.executeJavaScript(`document.querySelector('#approval-${state === 'pending' ? 'allow' : 'drop'}').click()`, true);
          await delay(30);
          if (decisions.length !== 1 || decisions[0] !== (state === 'pending' ? 'allow-once' : 'drop-to-l1')) throw new Error('Approval decision changed');
        }
        states.push({ state, width, height, scale, ...layout, decisions });
      }
    }
    await writeFile(join(OUTPUT_ROOT, 'approval-states.json'), JSON.stringify({ ok:true, states }, null, 2));
  } finally {
    ipcMain.removeHandler(IPC_CHANNELS.approvalGetCurrent);
    ipcMain.handle(IPC_CHANNELS.approvalGetCurrent, () => visualApproval);
    if (!window.isDestroyed()) {
      await window.webContents.executeJavaScript("localStorage.removeItem('sovereign.ui.settings.v1')", true);
      window.destroy();
    }
  }
}

async function run(): Promise<void> {
  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await app.whenReady();
  await registerRendererProtocol();
  registerMockIpc();
  await runApprovalSmoke();

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
      zoomFactor: 1.1,
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
      localStorage.setItem(key, JSON.stringify({ ...current, language: 'en', experienceMode: 'full', reducedMotion: false }));
    })()`,
    true,
  );
  await window.loadURL(`${RENDERER_ORIGIN}index.html`);
  await waitForRenderer(window, rendererProblems);
  await delay(120);
  const verificationScope = process.env.SCR_VISUAL_SCOPE === "tasks" ? "tasks" : "all";
  if (verificationScope === "all") {
    const controlsVerification = await verifySharedControls(window, activateView, OUTPUT_ROOT);
    await writeFile(join(OUTPUT_ROOT, "shared-controls.json"), JSON.stringify(controlsVerification, null, 2));
    if (!controlsVerification.ok) throw new Error(`Shared controls verification failed: ${JSON.stringify(controlsVerification.failures)}`);
    const overviewVerification = await verifyOverviewActivity(window, activateView);
    await writeFile(
      join(OUTPUT_ROOT, "overview-motion.json"),
      `${JSON.stringify(overviewVerification, null, 2)}\n`,
      "utf8",
    );
    if (!overviewVerification.ok || !overviewVerification.nativeWindowStable) {
      throw new Error(
        `Overview convergence verification failed: ${JSON.stringify(overviewVerification)}`,
      );
    }
  }
  await window.webContents.insertCSS(
    "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }",
  );
  if (verificationScope === "all") await verifyActivityView(window);
  await activateView(window, "tasks");
  const taskVerification = await verifyTaskHub(window);
  await writeFile(join(OUTPUT_ROOT, "task-verification.json"), JSON.stringify(taskVerification, null, 2), "utf8");
  const functionalErrors: string[] = [];
  if (!taskVerification.ok) functionalErrors.push(`Task and Agent hub verification failed: ${JSON.stringify(taskVerification)}`);
  const workbenchVerification = await verifyTaskWorkbench(window);
  await writeFile(join(OUTPUT_ROOT, "task-workbench-verification.json"), JSON.stringify(workbenchVerification, null, 2), "utf8");
  if (!workbenchVerification.ok) functionalErrors.push(`Task workbench interaction failed: ${JSON.stringify(workbenchVerification)}`);
  const projectWorkspaceVerification = await verifyProjectWorkspace(window);
  await writeFile(join(OUTPUT_ROOT, "project-workspace.json"), JSON.stringify({ ...projectWorkspaceVerification, terminalRequests: visualTerminalRequests }, null, 2), "utf8");
  if (!projectWorkspaceVerification.ok) functionalErrors.push(`Project working directory verification failed: ${JSON.stringify(projectWorkspaceVerification)}`);
  if (visualTerminalRequests.length !== 1 || visualTerminalRequests[0]?.workspaceId !== "workspace-visual-sovereign-chosen" ||
    visualTerminalRequests[0]?.root !== "C:\\Projects\\sovereign-task-workspace" || visualTerminalRequests[0]?.cwd !== "") {
    functionalErrors.push(`Task terminal used an unexpected directory: ${JSON.stringify(visualTerminalRequests)}`);
  }
  if (verificationScope === "all") {
    await verifyPersistentL4RendererState(window, rendererProblems);
    await verifyRoundTwoUiComposition(window);
    await verifyRoundFourSurfaceComposition(window);
    await verifyLargeSurfaceNeutrality(window);
    await verifyCoreReadability(window);
    await verifyPermissionSelectionRetention(window);
    const interactionVerification = await verifyWorkbenchInteractions(window, activateView);
    await writeFile(join(OUTPUT_ROOT, "interaction-verification.json"), JSON.stringify(interactionVerification, null, 2));
    if (!interactionVerification.ok) throw new Error(`Workbench interaction verification failed: ${JSON.stringify(interactionVerification)}`);
  }

  const views = verificationScope === "tasks" ? ["tasks"] : await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.navigation-item[data-view]'))
      .map((element) => element instanceof HTMLElement ? element.dataset.view : undefined)
      .filter((value) => typeof value === 'string')`,
    true,
  ) as string[];
  if (views.length === 0) {
    throw new Error("The renderer view registry did not produce any navigable views.");
  }

  const screenshots = [
    ...await captureViewport(window, 1360, 860, views),
    ...verificationScope === "all" ? await captureL4PermissionViewport(window, 1360, 860) : [],
    ...await captureViewport(window, 1040, 680, views),
    ...verificationScope === "all" ? await captureL4PermissionViewport(window, 1040, 680) : [],
  ];
  if (verificationScope === "all") {
    // Chinese labels are wider than their English source, and the connection
    // page is the densest row of fields and inline buttons in the product, so
    // it is where translated text runs out of room first. Both standard
    // viewports, because a display running at 125% hands the renderer far
    // fewer CSS pixels than the window's physical size suggests.
    screenshots.push(...await captureLocalizedAgentViewport(window, 1360, 860));
    screenshots.push(...await captureLocalizedAgentViewport(window, 1040, 680));
  }
  if (verificationScope === "tasks") {
    window.setContentSize(1360, 860, false);
    await activateView(window, "tasks");
    const chineseProject = await window.webContents.executeJavaScript(`(async () => {
      const language = document.querySelector('#ui-language');
      language.value = 'zh-CN';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      const project = document.querySelector('#task-project-select');
      project.value = 'project-visual-sovereign';
      project.dispatchEvent(new Event('change', { bubbles: true }));
      const ready = () => document.querySelector('#task-project-workspace-label')?.textContent?.trim() === '此项目的工作目录' &&
        document.querySelector('#task-project-workspace-choose')?.textContent?.trim() === '更改目录' &&
        document.querySelector('#task-project-workspace-access summary')?.textContent?.trim() === '目录权限' &&
        document.querySelector('#task-project-workspace')?.getAttribute('aria-busy') === 'false';
      const deadline = Date.now() + 2500;
      while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      document.querySelector('#task-project-grid').scrollTop = 0;
      return ready();
    })()`, true) as boolean;
    if (!chineseProject) functionalErrors.push("The Chinese project working directory controls did not render correctly.");
    const chineseAudit = await window.webContents.executeJavaScript(`${layoutAuditScript}("tasks")`, true) as LayoutAudit;
    screenshots.push(await writeScreenshot(await captureRenderedPage(window), "1360x860", "tasks-zh-CN", chineseAudit));
    for (const surface of ["conversation", "steps"]) {
      const ready = await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('#task-project-grid [data-task-id="task-visual-agent-hub"]').click();
        const deadline = Date.now() + 2500;
        const ready = () => document.querySelector('#task-detail-pane').hidden === false &&
          document.querySelector('#task-detail-pane').getAttribute('aria-busy') !== 'true' &&
          document.querySelector('#task-detail-layout').hidden === false &&
          document.querySelector('#task-detail-title')?.textContent?.trim() === 'Build task and Agent hub' &&
          document.querySelector('#task-message-send')?.textContent?.trim() === '发送消息';
        while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (!ready()) return false;
        if (${JSON.stringify(surface)} === 'steps') {
          document.querySelector('#task-steps-toggle').click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return document.querySelector('#task-steps-popover').matches(':popover-open') &&
            document.querySelector('#task-steps-title')?.textContent?.trim() === '任务步骤';
        }
        return true;
      })()`, true) as boolean;
      if (!ready) functionalErrors.push(`The Chinese task ${surface} did not render correctly.`);
      const audit = await window.webContents.executeJavaScript(`${layoutAuditScript}("tasks")`, true) as LayoutAudit;
      screenshots.push(await writeScreenshot(await captureRenderedPage(window), "1360x860", `tasks-${surface}-zh-CN`, audit));
    }
  }
  const issues = screenshots.flatMap((record) => issuesFor(record));
  const report: VisualReport = {
    verificationScope,
    functionalErrors,
    schemaVersion: "scr.visual-test/v1",
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
  if (verificationScope === "all") await verifyInterfacePreferences(window);

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
