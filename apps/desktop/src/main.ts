import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  session,
  type IpcMainInvokeEvent,
} from "electron";

import {
  isDesktopDirectToolName,
  type ControlPlanePrompt,
  type ControlPlaneShellPort,
  type ProtectedSecretRestore,
} from "@sovereign/control-plane";

import { ApprovalWindowController } from "./approval-window.js";
import { RuntimeHostClient } from "./runtime-host-client.js";
import { registerTaskIpc } from "./task-ipc.js";
import {
  IPC_CHANNELS,
  type DesktopAuditReceipt,
  type DesktopConnectionCopyResult,
  type DesktopDirectToolName,
  type DesktopHostStartupState,
  type DesktopManifestView,
  type DesktopPermissionProfile,
  type DesktopProjectWorkspaces,
  type DesktopResourceProcess,
  type DesktopResourceProcessRole,
  type DesktopResourceSnapshot,
  type DesktopSecureTunnelAutomationInput,
  type DesktopSecureTunnelConfigurationInput,
  type DesktopRunRecord,
  type DesktopRunSummary,
  type DesktopRuntimeState,
  type DesktopTaskDetail,
  type DesktopTaskWorkspaceSnapshot,
  type TaskCoordinationOperatorInbox,
} from "./shared.js";

const currentDirectory = __dirname;
const RENDERER_SCHEME = "scr-app";
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://app/`;
const CLIPBOARD_SECRET_TTL_MS = 60_000;
const RESOURCE_BENCHMARK_SCENARIOS = ["R0-shell", "R1-runtime", "R3-navigation", "R4-codemirror"] as const;
type ResourceBenchmarkScenario = typeof RESOURCE_BENCHMARK_SCENARIOS[number];

interface ResourceBenchmarkConfig {
  readonly scenario: ResourceBenchmarkScenario;
  readonly outputPath: string;
  readonly userDataPath: string;
  readonly stabilizationMs: number;
}

interface ResourceBenchmarkReport {
  readonly schemaVersion: "scr.resource-benchmark/v1";
  readonly scenario: ResourceBenchmarkScenario;
  readonly generatedAt: string;
  readonly startupReadyMs: number;
  readonly stabilizationMs: number;
  readonly samples: readonly DesktopResourceSnapshot[];
  readonly summary: {
    readonly sampleCount: number;
    readonly productPrivateMedianBytes: number;
    readonly productPrivateMaxBytes: number;
    readonly shellPrivateMedianBytes: number;
    readonly shellPrivateMaxBytes: number;
    readonly productWorkingSetMedianBytes: number;
    readonly productWorkingSetMaxBytes: number;
    readonly processCountMedian: number;
    readonly processCountMax: number;
  };
}

function resourceBenchmarkConfigFromEnvironment(): ResourceBenchmarkConfig | null {
  const scenario = process.env.SCR_RESOURCE_BENCHMARK_SCENARIO?.trim();
  const outputPath = process.env.SCR_RESOURCE_BENCHMARK_OUTPUT?.trim();
  const userDataPath = process.env.SCR_RESOURCE_BENCHMARK_USER_DATA?.trim();
  if (scenario === undefined && outputPath === undefined && userDataPath === undefined) {
    return null;
  }
  if (
    scenario === undefined ||
    !RESOURCE_BENCHMARK_SCENARIOS.includes(scenario as ResourceBenchmarkScenario) ||
    outputPath === undefined ||
    outputPath.length === 0 ||
    outputPath.length > 4_096 ||
    userDataPath === undefined ||
    userDataPath.length === 0 ||
    userDataPath.length > 4_096
  ) {
    throw new Error("Packaged resource benchmark configuration is invalid.");
  }
  const requestedStabilizationMs = Number(process.env.SCR_RESOURCE_BENCHMARK_STABILIZE_MS ?? "30000");
  const stabilizationMs = Number.isInteger(requestedStabilizationMs)
    ? Math.max(1_000, Math.min(requestedStabilizationMs, 120_000))
    : 30_000;
  return {
    scenario: scenario as ResourceBenchmarkScenario,
    outputPath: resolve(outputPath),
    userDataPath: resolve(userDataPath),
    stabilizationMs,
  };
}

const RESOURCE_BENCHMARK_CONFIG = resourceBenchmarkConfigFromEnvironment();
if (RESOURCE_BENCHMARK_CONFIG !== null) {
  app.setPath("userData", RESOURCE_BENCHMARK_CONFIG.userDataPath);
}
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

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected desktop runtime error occurred.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeAgentPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "native", "bin", "SovereignNativeAgent.exe")
    : resolve(currentDirectory, "..", "..", "native", "bin", "SovereignNativeAgent.exe");
}

function packagedTunnelClientPath(): string | undefined {
  return app.isPackaged
    ? join(process.resourcesPath, "tunnel-client", "tunnel-client.exe")
    : undefined;
}

function runtimeHostScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "runtime-host.cjs")
    : resolve(currentDirectory, "..", "..", "..", "runtime-host", "dist", "bundle", "runtime-host.cjs");
}

function isTrustedRendererUrl(value: string): boolean {
  return value.startsWith(RENDERER_ORIGIN);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderFrame = event.senderFrame;
  if (senderFrame === null || !isTrustedRendererUrl(senderFrame.url)) {
    throw new Error("IPC request rejected because its sender is not the trusted application renderer.");
  }
}

function unavailableHostAvailability(): DesktopHostStartupState["availability"] {
  return {
    schemaVersion: "scr.host-availability/v1",
    available: false,
    monitorStartedAt: new Date(0).toISOString(),
    sampledAt: null,
    monitorIntervalMs: 5_000,
    possibleSuspendGapThresholdMs: 20_000,
    eventStorage: "memory-only",
    systemUptimeMs: null,
    powerSource: "unknown",
    batteryPercent: null,
    batterySaver: null,
    possibleSuspendCount: 0,
    lastPossibleSuspendAt: null,
    lastPossibleSuspendDurationMs: null,
    networkState: "not-configured",
    networkDesired: false,
    lastNetworkCheckAt: null,
    lastNetworkReadyAt: null,
    lastNetworkLossAt: null,
    lastNetworkRecoveryAt: null,
    lastNetworkOutageDurationMs: null,
    reconnectAttempt: 0,
    nextReconnectAt: null,
    detail: "Host availability monitoring is provided by the primary packaged Tauri shell.",
    recentEvents: [],
  };
}

function electronHostStartupState(): DesktopHostStartupState {
  const executablePath = process.execPath;
  if (process.platform !== "win32") {
    return {
      schemaVersion: "scr.host-startup/v1",
      supported: false,
      enabled: false,
      executablePath,
      launchKind: "legacy-electron",
      registeredCommand: null,
      warning: "Windows login startup is only available on Windows.",
      guardian: {
        available: false,
        processId: null,
        closeToTray: false,
        circuitOpen: false,
        lastIncident: null,
      },
      availability: unavailableHostAvailability(),
    };
  }
  const args = ["--autostart"];
  const settings = app.getLoginItemSettings({ path: executablePath, args });
  const enabled = settings.openAtLogin && settings.executableWillLaunchAtLogin;
  return {
    schemaVersion: "scr.host-startup/v1",
    supported: true,
    enabled,
    executablePath,
    launchKind: "legacy-electron",
    registeredCommand: enabled ? `"${executablePath}" --autostart` : null,
    warning: "This setting belongs to the legacy Electron shell. Prefer the primary Tauri build for deployment.",
    guardian: {
      available: false,
      processId: null,
      closeToTray: false,
      circuitOpen: false,
      lastIncident: null,
    },
    availability: unavailableHostAvailability(),
  };
}

function setElectronLaunchAtLogin(enabled: boolean): DesktopHostStartupState {
  if (process.platform !== "win32") {
    throw new Error("Windows login startup is unavailable on this platform.");
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ["--autostart"],
  });
  return electronHostStartupState();
}

interface WindowsProcessMemory {
  readonly workingSetBytes: number;
  readonly privateBytes: number | null;
}

function kilobytesToBytes(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1024) : 0;
}

function electronProcessRole(type: string): DesktopResourceProcessRole {
  switch (type) {
    case "Browser":
      return "desktop-main";
    case "Tab":
      return "renderer";
    case "GPU":
      return "gpu";
    case "Utility":
      return "utility";
    default:
      return "other-owned";
  }
}

function parseWindowsProcessMemory(source: string): ReadonlyMap<number, WindowsProcessMemory> {
  const result = new Map<number, WindowsProcessMemory>();
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return result;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const processId = row.processId;
    const workingSetBytes = row.workingSetBytes;
    const privateBytes = row.privateBytes;
    if (
      typeof processId !== "number" ||
      !Number.isInteger(processId) ||
      processId <= 0 ||
      typeof workingSetBytes !== "number" ||
      !Number.isFinite(workingSetBytes) ||
      workingSetBytes < 0
    ) {
      continue;
    }
    result.set(processId, {
      workingSetBytes: Math.round(workingSetBytes),
      privateBytes:
        typeof privateBytes === "number" && Number.isFinite(privateBytes) && privateBytes >= 0
          ? Math.round(privateBytes)
          : null,
    });
  }
  return result;
}

async function readWindowsProcessMemory(
  processIds: readonly number[],
): Promise<ReadonlyMap<number, WindowsProcessMemory>> {
  if (process.platform !== "win32") {
    return new Map();
  }
  const ids = [...new Set(processIds)]
    .filter((processId) => Number.isInteger(processId) && processId > 0 && processId <= 0xffff_ffff)
    .sort((left, right) => left - right);
  if (ids.length === 0) {
    return new Map();
  }

  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `$ids=@(${ids.join(",")});`,
    "$rows=@(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ processId=[int]$_.Id; workingSetBytes=[int64]$_.WorkingSet64; privateBytes=[int64]$_.PrivateMemorySize64 } });",
    "$rows | ConvertTo-Json -Compress",
  ].join(" ");

  return await new Promise<ReadonlyMap<number, WindowsProcessMemory>>((resolveMemory) => {
    const child = spawn(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (value: ReadonlyMap<number, WindowsProcessMemory>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveMemory(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Map());
    }, 3_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = 65_536 - bytes;
      if (remaining <= 0) {
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      chunks.push(accepted);
      bytes += accepted.byteLength;
    });
    child.once("error", () => finish(new Map()));
    child.once("close", () => {
      finish(parseWindowsProcessMemory(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

class ElectronControlPlaneShellPort implements ControlPlaneShellPort {
  readonly #parentWindow: () => BrowserWindow | null;

  constructor(parentWindow: () => BrowserWindow | null) {
    this.#parentWindow = parentWindow;
  }

  async chooseWorkspace(): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: "Choose an authorized workspace",
      buttonLabel: "Use this workspace",
      properties: ["openDirectory", "createDirectory"],
    };
    const parent = this.#parentWindow();
    const result = parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  async chooseSecureTunnelExecutable(): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: "Choose OpenAI Secure MCP Tunnel connector",
      buttonLabel: "Use this connector",
      properties: ["openFile"],
      filters: [{ name: "tunnel-client.exe", extensions: ["exe"] }],
    };
    const parent = this.#parentWindow();
    const result = parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  async protectSecret(value: string): Promise<string | null> {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        return null;
      }
      return (await safeStorage.encryptStringAsync(value)).toString("base64");
    } catch {
      return null;
    }
  }

  async restoreSecret(encoded: string): Promise<ProtectedSecretRestore | null> {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        return null;
      }
      const encrypted = Buffer.from(encoded, "base64");
      if (encrypted.byteLength === 0) {
        return null;
      }
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      const value = decrypted.result.trim();
      if (value.length < 16 || value.length > 4_096 || /[\r\n\0]/u.test(value)) {
        return null;
      }
      if (!decrypted.shouldReEncrypt) {
        return { value, encoded };
      }
      return {
        value,
        encoded: (await safeStorage.encryptStringAsync(value)).toString("base64"),
      };
    } catch {
      return null;
    }
  }

  async prompt(request: ControlPlanePrompt): Promise<number> {
    const options: Electron.MessageBoxOptions = {
      type: request.type,
      title: request.title,
      message: request.message,
      detail: request.detail,
      buttons: [...request.buttons],
      defaultId: request.defaultId,
      cancelId: request.cancelId,
      noLink: true,
    };
    const parent = this.#parentWindow();
    const result = parent === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options);
    return result.response;
  }
}

class DesktopRuntimeController {
  #window: BrowserWindow | null = null;
  readonly #approvalWindow: ApprovalWindowController;
  readonly #runtimeHost: RuntimeHostClient;

  constructor(userDataPath: string) {
    this.#approvalWindow = new ApprovalWindowController({
      parentWindow: () => this.#window,
      preloadPath: join(currentDirectory, "..", "preload", "approval-preload.cjs"),
      rendererUrl: `${RENDERER_ORIGIN}approval.html`,
      devTools: !app.isPackaged,
    });
    const packagedTunnelClient = packagedTunnelClientPath();
    const environmentWorkspaceRoot = process.env.SCR_WORKSPACE_ROOT;
    this.#runtimeHost = new RuntimeHostClient({
      scriptPath: runtimeHostScriptPath(),
      userDataPath,
      nativeAgentPath: nativeAgentPath(),
      ...(packagedTunnelClient === undefined ? {} : { packagedTunnelClientPath: packagedTunnelClient }),
      ...(environmentWorkspaceRoot === undefined ? {} : { environmentWorkspaceRoot }),
      shell: new ElectronControlPlaneShellPort(() => this.#window),
      approvalSurface: this.#approvalWindow,
      onStateChanged: () => this.broadcast(),
    });
  }

  async initialize(): Promise<void> {
    await this.#runtimeHost.initialize();
  }

  attachWindow(window: BrowserWindow): void {
    this.#window = window;
  }

  detachWindow(window: BrowserWindow): void {
    if (this.#window === window) {
      this.#approvalWindow.destroy();
      this.#window = null;
    }
  }

  state(): DesktopRuntimeState {
    return this.#runtimeHost.state();
  }

  broadcast(): void {
    if (this.#window !== null && !this.#window.isDestroyed()) {
      this.#window.webContents.send(IPC_CHANNELS.stateChanged, this.#runtimeHost.state());
    }
  }

  start(): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.start();
  }

  stop(): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.stop();
  }

  chooseWorkspace(): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.chooseWorkspace();
  }
  readProjectWorkspaces(projectId: string): Promise<DesktopProjectWorkspaces> { return this.#runtimeHost.readProjectWorkspaces(projectId); }
  chooseProjectWorkspace(projectId: string): Promise<DesktopProjectWorkspaces> { return this.#runtimeHost.chooseProjectWorkspace(projectId); }
  selectProjectWorkspace(projectId: string, workspaceId: string): Promise<DesktopProjectWorkspaces> { return this.#runtimeHost.selectProjectWorkspace(projectId, workspaceId); }

  async copyConnectionBundle(): Promise<DesktopConnectionCopyResult> {
    const bundle = await this.#runtimeHost.connectionBundle();
    const copiedAt = new Date();
    const clipboardClearsAt = new Date(copiedAt.getTime() + CLIPBOARD_SECRET_TTL_MS);
    clipboard.writeText(bundle.serialized);
    setTimeout(() => {
      try {
        if (clipboard.readText() === bundle.serialized) {
          clipboard.clear();
        }
      } catch {
        // Clipboard cleanup is best effort and never changes runtime state.
      }
    }, CLIPBOARD_SECRET_TTL_MS);
    return {
      schemaVersion: "scr.connection/v1",
      endpoint: bundle.endpoint,
      target: bundle.target,
      copiedAt: copiedAt.toISOString(),
      clipboardClearsAt: clipboardClearsAt.toISOString(),
    };
  }

  rotateCredentials(): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.rotateCredentials();
  }

  setAutoStart(enabled: boolean): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.setAutoStart(enabled);
  }

  setUnattendedWorkspaceAccess(enabled: boolean, workspaceId?: string): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.setUnattendedWorkspaceAccess(enabled, workspaceId);
  }

  hostStartupState(): DesktopHostStartupState {
    return electronHostStartupState();
  }

  setLaunchAtLogin(enabled: boolean): DesktopHostStartupState {
    return setElectronLaunchAtLogin(enabled);
  }

  setWebBridgeUrl(value: string | null): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.setWebBridgeUrl(value);
  }

  configureSecureTunnel(
    input: DesktopSecureTunnelConfigurationInput,
  ): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.configureSecureTunnel(input);
  }

  setSecureTunnelAutomation(
    input: DesktopSecureTunnelAutomationInput,
  ): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.setSecureTunnelAutomation(input);
  }

  chooseSecureTunnelExecutable(): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.chooseSecureTunnelExecutable();
  }

  startSecureTunnel(): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.startSecureTunnel();
  }

  stopSecureTunnel(): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.stopSecureTunnel();
  }

  refreshSecureTunnel(): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.refreshSecureTunnel();
  }

  setPermissionProfile(profile: DesktopPermissionProfile, workspaceId?: string): Promise<DesktopRuntimeState> {
    return this.#runtimeHost.setPermissionProfile(profile, workspaceId);
  }

  async manifest(): Promise<DesktopManifestView | null> {
    return await this.#runtimeHost.manifest();
  }

  async resourceSnapshot(): Promise<DesktopResourceSnapshot> {
    const electronProcesses: DesktopResourceProcess[] = app.getAppMetrics().map((metric) => ({
      processId: metric.pid,
      role: electronProcessRole(metric.type),
      label: metric.name?.trim() || metric.serviceName?.trim() || `Electron ${metric.type}`,
      workingSetBytes: kilobytesToBytes(metric.memory.workingSetSize),
      privateBytes:
        metric.memory.privateBytes === undefined
          ? null
          : kilobytesToBytes(metric.memory.privateBytes),
      cpuPercent:
        Number.isFinite(metric.cpu.percentCPUUsage) && metric.cpu.percentCPUUsage >= 0
          ? metric.cpu.percentCPUUsage
          : null,
    }));
    const electronProcessIds = new Set(electronProcesses.map((process) => process.processId));
    const ownedDescriptors: Array<{
      readonly processId: number;
      readonly role: DesktopResourceProcessRole;
      readonly label: string;
    }> = (await this.#runtimeHost.ownedProcesses())
      .filter((entry) => !electronProcessIds.has(entry.processId));
    const externalMemory = await readWindowsProcessMemory(
      ownedDescriptors.map((process) => process.processId),
    );
    const externalProcesses = ownedDescriptors.map((process): DesktopResourceProcess => {
      const memory = externalMemory.get(process.processId);
      return {
        ...process,
        workingSetBytes: memory?.workingSetBytes ?? 0,
        privateBytes: memory?.privateBytes ?? null,
        cpuPercent: null,
      };
    });
    const processes = [...electronProcesses, ...externalProcesses]
      .filter((process, index, entries) =>
        entries.findIndex((candidate) => candidate.processId === process.processId) === index
      )
      .sort((left, right) => {
        const roleOrder = left.role.localeCompare(right.role);
        return roleOrder === 0 ? left.processId - right.processId : roleOrder;
      });
    const shellRoles = new Set<DesktopResourceProcessRole>([
      "desktop-main",
      "renderer",
      "gpu",
      "utility",
      "other-owned",
    ]);
    const runtimeRoles = new Set<DesktopResourceProcessRole>(["runtime-host"]);
    const shell = processes.filter((process) => shellRoles.has(process.role));
    const runtime = processes.filter((process) => runtimeRoles.has(process.role));
    const services = processes.filter(
      (process) => !shellRoles.has(process.role) && !runtimeRoles.has(process.role),
    );
    const sumWorkingSet = (entries: readonly DesktopResourceProcess[]): number =>
      entries.reduce((total, process) => total + process.workingSetBytes, 0);
    const sumPrivate = (entries: readonly DesktopResourceProcess[]): number =>
      entries.reduce((total, process) => total + (process.privateBytes ?? 0), 0);

    return {
      schemaVersion: "scr.resources/v1",
      capturedAt: new Date().toISOString(),
      uptimeMs: Math.round(process.uptime() * 1_000),
      runtimePlacement: "sidecar",
      shellExecutablePath: process.execPath,
      shellLaunchKind: "legacy-electron",
      processes,
      totals: {
        shellWorkingSetBytes: sumWorkingSet(shell),
        shellPrivateBytes: sumPrivate(shell),
        runtimeWorkingSetBytes: sumWorkingSet(runtime),
        runtimePrivateBytes: sumPrivate(runtime),
        serviceWorkingSetBytes: sumWorkingSet(services),
        servicePrivateBytes: sumPrivate(services),
        productWorkingSetBytes: sumWorkingSet(processes),
        productPrivateBytes: sumPrivate(processes),
        processCount: processes.length,
      },
    };
  }

  async runs(limit: number): Promise<readonly DesktopRunSummary[]> {
    return await this.#runtimeHost.runs(limit);
  }

  async run(runId: string): Promise<DesktopRunRecord> {
    return await this.#runtimeHost.run(runId);
  }

  async cancelRun(runId: string): Promise<DesktopRunRecord> {
    return await this.#runtimeHost.cancelRun(runId);
  }

  async taskWorkspaceSnapshot(
    offset = 0,
    limit = 64,
  ): Promise<DesktopTaskWorkspaceSnapshot> {
    return await this.#runtimeHost.taskWorkspaceSnapshot(offset, limit);
  }

  async taskDetail(taskId: string, messageLimit = 200, beforeSequence?: number): Promise<DesktopTaskDetail> {
    return await this.#runtimeHost.taskDetail(taskId, messageLimit, beforeSequence);
  }

  async taskCoordinationInbox(
    taskId: string,
    beforeSequence?: number,
    limit = 50,
  ): Promise<TaskCoordinationOperatorInbox> {
    return await this.#runtimeHost.taskCoordinationInbox(taskId, beforeSequence, limit);
  }

  async addTaskUserMessage(taskId: string, content: string): Promise<DesktopTaskDetail> {
    return await this.#runtimeHost.addTaskUserMessage(taskId, content);
  }

  async invokeTool(
    toolName: DesktopDirectToolName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return await this.#runtimeHost.invokeTool(toolName, input);
  }

  approvalCurrent(event: IpcMainInvokeEvent) {
    return this.#approvalWindow.current(event);
  }

  resolveApproval(
    event: IpcMainInvokeEvent,
    requestId: unknown,
    decision: unknown,
  ): void {
    this.#approvalWindow.resolve(event, requestId, decision);
  }

  async auditReceipts(limit: number): Promise<readonly DesktopAuditReceipt[]> {
    return await this.#runtimeHost.auditReceipts(limit);
  }

  async shutdown(): Promise<void> {
    await this.#runtimeHost.shutdown();
  }

}

function benchmarkDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

async function waitForBenchmarkRenderer(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      `Boolean(document.querySelector(".application-shell") && document.querySelector("#global-status-label"))`,
      true,
    ) as boolean;
    if (ready) {
      return;
    }
    await benchmarkDelay(50);
  }
  throw new Error("The packaged benchmark renderer did not become ready.");
}

async function activateBenchmarkView(window: BrowserWindow, view: string): Promise<void> {
  const activated = await window.webContents.executeJavaScript(
    `(() => {
      const button = document.querySelector('.navigation-item[data-view=${JSON.stringify(view)}]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return document.querySelector('#view-${view}')?.classList.contains('is-active') === true;
    })()`,
    true,
  ) as boolean;
  if (!activated) {
    throw new Error(`Could not activate benchmark view: ${view}`);
  }
  await benchmarkDelay(120);
}

async function prepareResourceBenchmarkScenario(
  window: BrowserWindow,
  scenario: ResourceBenchmarkScenario,
): Promise<void> {
  await waitForBenchmarkRenderer(window);
  if (scenario === "R3-navigation") {
    for (const view of [
      "overview",
      "agent",
      "terminal",
      "python",
      "browser",
      "computer",
      "workflows",
      "runs",
      "settings",
    ]) {
      await activateBenchmarkView(window, view);
    }
    return;
  }
  if (scenario === "R4-codemirror") {
    await activateBenchmarkView(window, "python");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const loaded = await window.webContents.executeJavaScript(
        `document.querySelector("#python-code-editor .cm-editor") !== null`,
        true,
      ) as boolean;
      if (loaded) {
        return;
      }
      await benchmarkDelay(50);
    }
    throw new Error("CodeMirror did not load during the packaged resource benchmark.");
  }
}

async function runPackagedResourceBenchmark(
  controller: DesktopRuntimeController,
  window: BrowserWindow,
  config: ResourceBenchmarkConfig,
): Promise<void> {
  await prepareResourceBenchmarkScenario(window, config.scenario);
  const startupReadyMs = Math.round(process.uptime() * 1_000);
  await benchmarkDelay(config.stabilizationMs);

  const samples: DesktopResourceSnapshot[] = [];
  for (let index = 0; index < 5; index += 1) {
    samples.push(await controller.resourceSnapshot());
    if (index < 4) {
      await benchmarkDelay(2_000);
    }
  }

  const productPrivate = samples.map((sample) => sample.totals.productPrivateBytes);
  const shellPrivate = samples.map((sample) => sample.totals.shellPrivateBytes);
  const productWorkingSet = samples.map((sample) => sample.totals.productWorkingSetBytes);
  const processCounts = samples.map((sample) => sample.totals.processCount);
  const report: ResourceBenchmarkReport = {
    schemaVersion: "scr.resource-benchmark/v1",
    scenario: config.scenario,
    generatedAt: new Date().toISOString(),
    startupReadyMs,
    stabilizationMs: config.stabilizationMs,
    samples,
    summary: {
      sampleCount: samples.length,
      productPrivateMedianBytes: median(productPrivate),
      productPrivateMaxBytes: Math.max(...productPrivate),
      shellPrivateMedianBytes: median(shellPrivate),
      shellPrivateMaxBytes: Math.max(...shellPrivate),
      productWorkingSetMedianBytes: median(productWorkingSet),
      productWorkingSetMaxBytes: Math.max(...productWorkingSet),
      processCountMedian: median(processCounts),
      processCountMax: Math.max(...processCounts),
    },
  };
  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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

function registerIpc(controller: DesktopRuntimeController): void {
  ipcMain.handle(IPC_CHANNELS.getState, (event) => {
    assertTrustedSender(event);
    return controller.state();
  });
  ipcMain.handle(IPC_CHANNELS.chooseWorkspace, async (event) => {
    assertTrustedSender(event);
    return await controller.chooseWorkspace();
  });
  for (const method of ["readProjectWorkspaces", "chooseProjectWorkspace"] as const) {
    ipcMain.handle(IPC_CHANNELS[method], async (event, projectId: unknown) => {
      assertTrustedSender(event);
      if (typeof projectId !== "string") throw new Error("Project id must be a string.");
      return await controller[method](projectId);
    });
  }
  ipcMain.handle(IPC_CHANNELS.selectProjectWorkspace, async (event, projectId: unknown, workspaceId: unknown) => {
    assertTrustedSender(event);
    if (typeof projectId !== "string" || typeof workspaceId !== "string") throw new Error("Project and workspace ids must be strings.");
    return await controller.selectProjectWorkspace(projectId, workspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.start, async (event) => {
    assertTrustedSender(event);
    return await controller.start();
  });
  ipcMain.handle(IPC_CHANNELS.stop, async (event) => {
    assertTrustedSender(event);
    return await controller.stop();
  });
  ipcMain.handle(IPC_CHANNELS.refresh, (event) => {
    assertTrustedSender(event);
    return controller.state();
  });
  ipcMain.handle(IPC_CHANNELS.getManifest, async (event) => {
    assertTrustedSender(event);
    return await controller.manifest();
  });
  ipcMain.handle(IPC_CHANNELS.getAuditReceipts, async (event, requestedLimit: unknown) => {
    assertTrustedSender(event);
    const limit =
      typeof requestedLimit === "number" && Number.isInteger(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 500))
        : 100;
    return await controller.auditReceipts(limit);
  });
  ipcMain.handle(IPC_CHANNELS.getResourceSnapshot, async (event) => {
    assertTrustedSender(event);
    return await controller.resourceSnapshot();
  });
  ipcMain.handle(IPC_CHANNELS.getHostStartupState, (event) => {
    assertTrustedSender(event);
    return controller.hostStartupState();
  });
  ipcMain.handle(IPC_CHANNELS.setLaunchAtLogin, (event, enabled: unknown) => {
    assertTrustedSender(event);
    if (typeof enabled !== "boolean") {
      throw new Error("Launch-at-login enabled must be a boolean value.");
    }
    return controller.setLaunchAtLogin(enabled);
  });
  ipcMain.handle(IPC_CHANNELS.getRuns, async (event, requestedLimit: unknown) => {
    assertTrustedSender(event);
    const limit =
      typeof requestedLimit === "number" && Number.isInteger(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 500))
        : 100;
    return await controller.runs(limit);
  });
  ipcMain.handle(IPC_CHANNELS.getRun, async (event, runId: unknown) => {
    assertTrustedSender(event);
    if (typeof runId !== "string" || runId.length === 0 || runId.length > 128) {
      throw new Error("Run id must contain 1 through 128 characters.");
    }
    return await controller.run(runId);
  });
  ipcMain.handle(IPC_CHANNELS.cancelRun, async (event, runId: unknown) => {
    assertTrustedSender(event);
    if (typeof runId !== "string" || runId.length === 0 || runId.length > 128) {
      throw new Error("Run id must contain 1 through 128 characters.");
    }
    return await controller.cancelRun(runId);
  });
  registerTaskIpc(controller, assertTrustedSender);
  ipcMain.handle(
    IPC_CHANNELS.invokeTool,
    async (event, toolName: unknown, input: unknown) => {
      assertTrustedSender(event);
      if (typeof toolName !== "string" || !isDesktopDirectToolName(toolName)) {
        throw new Error("The requested desktop tool is not exposed.");
      }
      if (!isRecord(input)) {
        throw new Error("Desktop tool input must be an object.");
      }
      return await controller.invokeTool(toolName, input);
    },
  );
  ipcMain.handle(IPC_CHANNELS.copyConnectionBundle, async (event) => {
    assertTrustedSender(event);
    return await controller.copyConnectionBundle();
  });
  ipcMain.handle(IPC_CHANNELS.rotateCredentials, async (event) => {
    assertTrustedSender(event);
    return await controller.rotateCredentials();
  });
  ipcMain.handle(IPC_CHANNELS.setAutoStart, async (event, enabled: unknown) => {
    assertTrustedSender(event);
    if (typeof enabled !== "boolean") {
      throw new Error("Runtime auto-start must be a boolean value.");
    }
    return await controller.setAutoStart(enabled);
  });
  ipcMain.handle(IPC_CHANNELS.setUnattendedWorkspaceAccess, async (event, enabled: unknown, workspaceId: unknown) => {
    assertTrustedSender(event);
    if (typeof enabled !== "boolean") {
      throw new Error("Unattended workspace access must be a boolean value.");
    }
    if (workspaceId !== undefined && typeof workspaceId !== "string") throw new Error("Workspace id must be a string.");
    return await controller.setUnattendedWorkspaceAccess(enabled, workspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.setWebBridgeUrl, async (event, value: unknown) => {
    assertTrustedSender(event);
    if (value !== null && typeof value !== "string") {
      throw new Error("Web bridge URL must be a string or null.");
    }
    return await controller.setWebBridgeUrl(value);
  });
  ipcMain.handle(IPC_CHANNELS.configureSecureTunnel, async (event, input: unknown) => {
    assertTrustedSender(event);
    if (!isRecord(input)) {
      throw new Error("Secure MCP Tunnel configuration must be an object.");
    }
    const tunnelId = input.tunnelId;
    const runtimeApiKey = input.runtimeApiKey;
    const clearRuntimeApiKey = input.clearRuntimeApiKey;
    const controlPlaneProxyUrl = input.controlPlaneProxyUrl;
    const clearControlPlaneProxy = input.clearControlPlaneProxy;
    const controlPlaneBackupProxyUrl = input.controlPlaneBackupProxyUrl;
    const clearControlPlaneBackupProxy = input.clearControlPlaneBackupProxy;
    const controlPlaneDirectFallbackEnabled = input.controlPlaneDirectFallbackEnabled;
    if (tunnelId !== null && typeof tunnelId !== "string") {
      throw new Error("Secure MCP Tunnel ID must be a string or null.");
    }
    if (runtimeApiKey !== undefined && typeof runtimeApiKey !== "string") {
      throw new Error("Secure MCP Tunnel runtime API key must be a string when supplied.");
    }
    if (clearRuntimeApiKey !== undefined && typeof clearRuntimeApiKey !== "boolean") {
      throw new Error("Secure MCP Tunnel clearRuntimeApiKey must be a boolean when supplied.");
    }
    if (controlPlaneProxyUrl !== undefined && typeof controlPlaneProxyUrl !== "string") {
      throw new Error("Secure MCP Tunnel controlPlaneProxyUrl must be a string when supplied.");
    }
    if (clearControlPlaneProxy !== undefined && typeof clearControlPlaneProxy !== "boolean") {
      throw new Error("Secure MCP Tunnel clearControlPlaneProxy must be a boolean when supplied.");
    }
    if (
      controlPlaneBackupProxyUrl !== undefined &&
      typeof controlPlaneBackupProxyUrl !== "string"
    ) {
      throw new Error("Secure MCP Tunnel backup control-plane proxy URL must be a string when supplied.");
    }
    if (
      clearControlPlaneBackupProxy !== undefined &&
      typeof clearControlPlaneBackupProxy !== "boolean"
    ) {
      throw new Error("Secure MCP Tunnel clearControlPlaneBackupProxy must be boolean when supplied.");
    }
    if (
      controlPlaneDirectFallbackEnabled !== undefined &&
      typeof controlPlaneDirectFallbackEnabled !== "boolean"
    ) {
      throw new Error("Secure MCP Tunnel direct fallback must be boolean when supplied.");
    }
    return await controller.configureSecureTunnel({
      tunnelId,
      ...(runtimeApiKey === undefined ? {} : { runtimeApiKey }),
      ...(clearRuntimeApiKey === undefined ? {} : { clearRuntimeApiKey }),
      ...(controlPlaneProxyUrl === undefined ? {} : { controlPlaneProxyUrl }),
      ...(clearControlPlaneProxy === undefined ? {} : { clearControlPlaneProxy }),
      ...(controlPlaneBackupProxyUrl === undefined
        ? {}
        : { controlPlaneBackupProxyUrl }),
      ...(clearControlPlaneBackupProxy === undefined
        ? {}
        : { clearControlPlaneBackupProxy }),
      ...(controlPlaneDirectFallbackEnabled === undefined
        ? {}
        : { controlPlaneDirectFallbackEnabled }),
    });
  });
  ipcMain.handle(IPC_CHANNELS.setSecureTunnelAutomation, async (event, input: unknown) => {
    assertTrustedSender(event);
    if (
      !isRecord(input) ||
      typeof input.autoStart !== "boolean" ||
      typeof input.autoReconnect !== "boolean"
    ) {
      throw new Error("Secure MCP Tunnel automation must contain boolean autoStart and autoReconnect values.");
    }
    return await controller.setSecureTunnelAutomation({
      autoStart: input.autoStart,
      autoReconnect: input.autoReconnect,
    });
  });
  ipcMain.handle(IPC_CHANNELS.chooseSecureTunnelExecutable, async (event) => {
    assertTrustedSender(event);
    return await controller.chooseSecureTunnelExecutable();
  });
  ipcMain.handle(IPC_CHANNELS.startSecureTunnel, async (event) => {
    assertTrustedSender(event);
    return await controller.startSecureTunnel();
  });
  ipcMain.handle(IPC_CHANNELS.stopSecureTunnel, async (event) => {
    assertTrustedSender(event);
    return await controller.stopSecureTunnel();
  });
  ipcMain.handle(IPC_CHANNELS.refreshSecureTunnel, async (event) => {
    assertTrustedSender(event);
    return await controller.refreshSecureTunnel();
  });
  ipcMain.handle(IPC_CHANNELS.setUiScale, (event, scale: unknown) => {
    assertTrustedSender(event);
    if (scale !== 1 && scale !== 1.1 && scale !== 1.25 && scale !== 1.5) {
      throw new Error("UI scale must be one of 100%, 110%, 125%, or 150%.");
    }
    event.sender.setZoomFactor(scale);
  });
  ipcMain.handle(IPC_CHANNELS.approvalGetCurrent, (event) => {
    return controller.approvalCurrent(event);
  });
  ipcMain.handle(IPC_CHANNELS.approvalResolve, (event, requestId: unknown, decision: unknown) => {
    controller.resolveApproval(event, requestId, decision);
  });
  ipcMain.handle(IPC_CHANNELS.setPermissionProfile, async (event, profile: unknown, workspaceId: unknown) => {
    assertTrustedSender(event);
    if (
      profile !== "observe" &&
      profile !== "workspace" &&
      profile !== "consequential" &&
      profile !== "bypass"
    ) {
      throw new Error("Unknown permission profile.");
    }
    if (workspaceId !== undefined && typeof workspaceId !== "string") throw new Error("Workspace id must be a string.");
    return await controller.setPermissionProfile(profile, workspaceId);
  });
}

async function createMainWindow(controller: DesktopRuntimeController): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0a0d12",
    title: "Sovereign Code Runtime",
    webPreferences: {
      preload: join(currentDirectory, "..", "preload", "preload.cjs"),
      zoomFactor: 1.1,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      backgroundThrottling: RESOURCE_BENCHMARK_CONFIG === null,
    },
  });

  controller.attachWindow(window);
  window.on("closed", () => {
    controller.detachWindow(window);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  window.once("ready-to-show", () => {
    if (RESOURCE_BENCHMARK_CONFIG === null) {
      window.show();
      if (process.argv.includes("--autostart")) {
        window.minimize();
      }
    }
  });
  window.webContents.once("did-finish-load", () => {
    controller.broadcast();
  });

  await window.loadURL(`${RENDERER_ORIGIN}index.html`);
  return window;
}

const singleInstance = RESOURCE_BENCHMARK_CONFIG !== null || app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  let controller: DesktopRuntimeController | null = null;
  let mainWindow: BrowserWindow | null = null;
  let quitAfterShutdown = false;

  app.on("second-instance", () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("before-quit", (event) => {
    if (controller !== null && !quitAfterShutdown) {
      event.preventDefault();
      quitAfterShutdown = true;
      void controller.shutdown().finally(() => {
        app.quit();
      });
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId("com.sovereign.SovereignCodeRuntime");
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });

    await registerRendererProtocol();
    const initializedController = new DesktopRuntimeController(app.getPath("userData"));
    controller = initializedController;
    registerIpc(initializedController);
    await initializedController.initialize();
    mainWindow = await createMainWindow(initializedController);

    const benchmarkConfig = RESOURCE_BENCHMARK_CONFIG;
    if (benchmarkConfig !== null) {
      await runPackagedResourceBenchmark(initializedController, mainWindow, benchmarkConfig);
      quitAfterShutdown = true;
      await initializedController.shutdown();
      app.exit(0);
    }
  }).catch(async (error: unknown) => {
    const benchmarkConfig = RESOURCE_BENCHMARK_CONFIG;
    if (benchmarkConfig !== null) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      try {
        const failurePath = `${benchmarkConfig.outputPath}.failure.txt`;
        await mkdir(dirname(failurePath), { recursive: true });
        await writeFile(failurePath, `${message}\n`, "utf8");
      } catch {
        // Benchmark failure reporting is best effort.
      }
      console.error(message);
      app.exit(1);
      return;
    }
    dialog.showErrorBox("Sovereign Code Runtime", messageFrom(error));
    app.quit();
  });
}
