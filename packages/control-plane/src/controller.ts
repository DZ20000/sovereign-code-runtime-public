import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  serializeConnectionBundle,
  type DesktopActiveToolActivity,
  type DesktopAuditReceipt,
  type DesktopControlPlaneRouteId,
  type DesktopControlPlaneRoutingState,
  type DesktopDirectToolName,
  type DesktopManifestView,
  type DesktopPermissionLevel,
  type DesktopPermissionProfile,
  type DesktopProjectWorkspaces,
  type DesktopResourceProcessRole,
  type DesktopRunRecord,
  type DesktopRunSummary,
  type DesktopRuntimeState,
  type DesktopTaskDetail,
  type DesktopTaskWorkspaceSnapshot,
  type TaskCoordinationOperatorInbox,
  type DesktopSecureTunnelAutomationInput,
  type DesktopSecureTunnelConfigurationInput,
  type DesktopTunnelFailureDiagnostic,
} from "@sovereign/control-plane-contract";
import {
  RUNTIME_VERSION,
  startGatewayRuntime,
  type ExternalToolAuthorizationRequest,
  type GatewayDrainReport,
  type GatewayRuntimeHandle,
  type GatewayTrafficStatus,
  type ToolExecutionActivityEvent,
} from "@sovereign/gateway/runtime";
import {
  CAPABILITIES,
  RUNTIME_BUILD_SOURCE,
  RuntimeError,
  type RuntimePermissionProfile,
  type ToolSpec,
} from "@sovereign/runtime-core";

import {
  ApprovalBroker,
  type ApprovalCancellationReason,
  type ApprovalSurface,
} from "./approval-broker.js";
import {
  createControlPlaneFailoverState,
  DEFAULT_CONTROL_PLANE_FAILOVER_POLICY,
  reduceControlPlaneFailover,
  type ControlPlaneFailoverEffect,
  type ControlPlaneFailoverPolicy,
  type ControlPlaneFailoverState,
  type ControlPlaneRouteId,
} from "./control-plane-failover.js";
import {
  CURRENT_PERMISSION_MODEL_VERSION,
  DEFAULT_CONTROL_PLANE_SETTINGS,
  normalizeSecureTunnelControlPlaneProxyUrl,
  normalizeSecureTunnelExecutablePath,
  secureTunnelProxyDisplay,
  normalizeSecureTunnelId,
  normalizeWebBridgeUrl,
  readControlPlaneSettings,
  type ControlPlaneSettings,
  writeControlPlaneSettings,
} from "./settings.js";
import {
  SecureMcpTunnelController,
  type SecureTunnelControllerOptions,
} from "./secure-tunnel.js";
import {
  connectorReportsOwnRetry,
  tunnelFailureClassificationPriority,
} from "./tunnel-failure-classifier.js";
import {
  createTaskGatewaySessionCallbacks,
  createTaskGatewayToolDefinitions,
  isTaskActivityIgnoredTool,
  normalizeTaskBoundToolInput,
  touchTaskSessionForToolActivity,
} from "./task-gateway-integration.js";
import { defaultTaskDatabasePath, TaskRegistry } from "./task-registry.js";
import { CredentialReferenceStore } from "./credential-references.js";
import {
  SandboxManager,
  type SandboxProcessRunner,
} from "./sandbox-manager.js";
import { createSecureExecutionToolPack } from "./secure-execution-tools.js";
import {
  ProjectWorkspaces,
  authorizeDirectWorkspaceTool,
  protectPermissionBypassGrant,
  restorePermissionBypassGrant,
  sameWorkspaceRoot,
} from "./project-workspaces.js";

const DIRECT_TOOL_NAMES = new Set<DesktopDirectToolName>([
  "terminal.session.list",
  "terminal.session.read",
  "terminal.session.create",
  "terminal.session.write",
  "terminal.session.resize",
  "terminal.session.close",
  "python.capabilities",
  "python.start",
  "browser.capabilities",
  "browser.session.list",
  "browser.session.create",
  "browser.navigate",
  "browser.observe",
  "browser.click",
  "browser.type",
  "browser.evaluate",
  "browser.session.close",
  "workflow.templates",
  "workflow.start",
  "computer.capabilities",
  "computer.observe",
  "computer.action",
]);

export function isDesktopDirectToolName(
  value: string,
): value is DesktopDirectToolName {
  return DIRECT_TOOL_NAMES.has(value as DesktopDirectToolName);
}

export interface ControlPlanePrompt {
  readonly type: "warning" | "question";
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly string[];
  readonly defaultId: number;
  readonly cancelId: number;
}

export interface ProtectedSecretRestore {
  readonly value: string;
  readonly encoded: string;
}

export interface ControlPlaneShellPort {
  chooseWorkspace(): Promise<string | null>;
  chooseSecureTunnelExecutable(): Promise<string | null>;
  protectSecret(value: string): Promise<string | null>;
  restoreSecret(encoded: string): Promise<ProtectedSecretRestore | null>;
  prompt(request: ControlPlanePrompt): Promise<number>;
}

export interface ControlPlaneControllerOptions {
  readonly userDataPath: string;
  readonly nativeAgentPath: string;
  readonly packagedTunnelClientPath?: string;
  readonly environmentWorkspaceRoot?: string;
  readonly runCompletionNotificationsEnabled?: boolean;
  readonly sandboxExecutablePath?: string;
  readonly sandboxExpectedVersion?: string;
  readonly sandboxExpectedExecutableSha256?: string;
  readonly sandboxRunner?: SandboxProcessRunner;
  readonly shell: ControlPlaneShellPort;
  readonly approvalSurface: ApprovalSurface;
  readonly onStateChanged?: (state: DesktopRuntimeState) => void;
  readonly secureTunnelFactory?: (
    options: SecureTunnelControllerOptions,
  ) => SecureMcpTunnelController;
  readonly controlPlaneFailoverPolicy?: ControlPlaneFailoverPolicyOverrides;
  readonly passiveCutoverCandidate?: boolean;
  /** Trusted local supervisor injection used to preserve existing MCP credentials. */
  readonly gatewayBearerToken?: string;
}

export interface ControlPlaneConnectionBundle {
  readonly endpoint: string;
  readonly target: "local" | "web-bridge";
  readonly serialized: string;
}

export interface ControlPlaneOwnedProcess {
  readonly processId: number;
  readonly role: Extract<
    DesktopResourceProcessRole,
    "tunnel" | "managed-run" | "terminal" | "browser"
  >;
  readonly label: string;
}

function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unexpected runtime control-plane error occurred.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedJson(value: unknown, maxCharacters = 2_000): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }
  return serialized.length <= maxCharacters
    ? serialized
    : `${serialized.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function permissionLabel(spec: ToolSpec): string {
  switch (spec.permissionLevel) {
    case "observe":
      return "L1 Observe";
    case "workspace":
      return "L2 Workspace";
    case "consequential":
      return "L3 Consequential";
  }
}

function normalizeGatewayBearerToken(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(normalized)) {
    throw new Error(
      "Gateway bearer token must be canonical 256-bit base64url.",
    );
  }
  return normalized;
}

const MAX_ACTIVE_TOOL_ACTIVITIES = 128;

function sameControlPlaneProxyEndpoint(
  left: string | null,
  right: string | null,
): boolean {
  if (left === null || right === null) {
    return false;
  }
  const leftDisplay = secureTunnelProxyDisplay(left);
  const rightDisplay = secureTunnelProxyDisplay(right);
  return (
    leftDisplay !== null &&
    rightDisplay !== null &&
    leftDisplay.toLowerCase() === rightDisplay.toLowerCase()
  );
}

function monotonicMilliseconds(): number {
  return Math.max(0, Math.floor(performance.now()));
}

type ControlPlaneFailoverPolicyOverrides = Partial<
  Omit<ControlPlaneFailoverPolicy, "routeOrder">
>;

function routePolicy(
  routeOrder: readonly ControlPlaneRouteId[],
  overrides: ControlPlaneFailoverPolicyOverrides = {},
): ControlPlaneFailoverPolicy {
  return {
    ...DEFAULT_CONTROL_PLANE_FAILOVER_POLICY,
    ...overrides,
    routeOrder: [...routeOrder],
  };
}

export class ControlPlaneController {
  readonly #settingsPath: string;
  readonly #auditPath: string;
  readonly #nativeAgentPath: string;
  readonly #environmentWorkspaceRoot: string | undefined;
  readonly #runCompletionNotificationsEnabled: boolean;
  readonly #shell: ControlPlaneShellPort;
  readonly #onStateChanged: ((state: DesktopRuntimeState) => void) | undefined;
  readonly #controlPlaneFailoverPolicyOverrides: ControlPlaneFailoverPolicyOverrides;
  readonly #secureTunnel: SecureMcpTunnelController;
  readonly #externalApprovalBroker: ApprovalBroker;
  readonly #taskRegistry: TaskRegistry;
  readonly #projectWorkspaces: ProjectWorkspaces;
  readonly #securityStorageRoot: string;
  readonly #credentialReferencePath: string;
  readonly #sandboxRegistryPath: string;
  readonly #sandboxExecutablePath: string | undefined;
  readonly #sandboxExpectedVersion: string | undefined;
  readonly #sandboxExpectedExecutableSha256: string | undefined;
  readonly #sandboxRunner: SandboxProcessRunner | undefined;
  readonly #activityTaskIds = new Map<string, string>();
  readonly #activeActivityCountByTask = new Map<string, number>();
  #passiveCutoverCandidate: boolean;
  #gatewayBearerToken: string | null;
  #cutoverDetachedCheckpointId: string | null = null;
  #cutoverDetachedRouteDesired = false;
  #promotedCutoverCheckpointId: string | null = null;
  #settings: ControlPlaneSettings = DEFAULT_CONTROL_PLANE_SETTINGS;
  #settingsLoaded = false;
  #runtime: GatewayRuntimeHandle | null = null;
  #bearerToken: string | null = null;
  #credentialGeneration = 0;
  #phase: DesktopRuntimeState["phase"] = "setup-required";
  #permissionProfile: RuntimePermissionProfile = "observe";
  readonly #activeToolActivities = new Map<string, DesktopActiveToolActivity>();
  readonly #directWorkspaceApprovals = new Set<string>();
  #errorMessage: string | null = null;
  #controlPlaneProxyUrl: string | null = null;
  #controlPlaneBackupProxyUrl: string | null = null;
  #controlPlaneRoutePolicy = routePolicy(["direct"]);
  #controlPlaneRouteState: ControlPlaneFailoverState =
    createControlPlaneFailoverState(this.#controlPlaneRoutePolicy);
  #routeDesiredRunning = false;
  #routeFailureDiagnostic: DesktopTunnelFailureDiagnostic | null = null;
  #routeErrorMessage: string | null = null;
  #routeNextLaunchAt: string | null = null;
  #routeLastSwitchAt: string | null = null;
  #routeLaunchTimer: NodeJS.Timeout | null = null;
  #routeEvaluationScheduled = false;
  #routeOperationInFlight = false;
  #handledTunnelAttemptGeneration = 0;
  #readyTunnelAttemptGeneration = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ControlPlaneControllerOptions) {
    this.#passiveCutoverCandidate = options.passiveCutoverCandidate === true;
    this.#gatewayBearerToken =
      options.gatewayBearerToken === undefined
        ? null
        : normalizeGatewayBearerToken(options.gatewayBearerToken);
    this.#settingsPath = join(options.userDataPath, "settings.json");
    this.#auditPath = join(options.userDataPath, "audit", "audit.sqlite");
    this.#nativeAgentPath = options.nativeAgentPath;
    this.#environmentWorkspaceRoot =
      options.environmentWorkspaceRoot?.trim() || undefined;
    this.#runCompletionNotificationsEnabled =
      options.runCompletionNotificationsEnabled ?? true;
    this.#shell = options.shell;
    this.#onStateChanged = options.onStateChanged;
    this.#controlPlaneFailoverPolicyOverrides = {
      ...(options.controlPlaneFailoverPolicy ?? {}),
    };
    const createSecureTunnel =
      options.secureTunnelFactory ??
      ((tunnelOptions: SecureTunnelControllerOptions) =>
        new SecureMcpTunnelController(tunnelOptions));
    this.#secureTunnel = createSecureTunnel({
      healthUrlFile: join(
        options.userDataPath,
        "secure-tunnel",
        "health-url.txt",
      ),
      ...(options.packagedTunnelClientPath === undefined
        ? {}
        : { packagedExecutablePath: options.packagedTunnelClientPath }),
      onStateChanged: () => this.#handleSecureTunnelStateChanged(),
    });
    this.#externalApprovalBroker = new ApprovalBroker({
      surface: options.approvalSurface,
    });
    this.#taskRegistry = new TaskRegistry({
      databasePath: defaultTaskDatabasePath(options.userDataPath),
      onChanged: () => this.#emit(),
    });
    this.#projectWorkspaces = new ProjectWorkspaces({
      settings: () => this.#settings,
      save: async (settings) => {
        await this.#persistSettings(settings);
        this.#settings = settings;
      },
      projectIdentity: (projectId) => this.#taskRegistry.projectIdentity(projectId),
      runtime: () => this.#runtime,
      shell: this.#shell,
    });
    this.#securityStorageRoot = options.userDataPath;
    this.#credentialReferencePath = join(
      options.userDataPath,
      "security",
      "credential-refs.json",
    );
    this.#sandboxRegistryPath = join(
      options.userDataPath,
      "security",
      "sandboxes.json",
    );
    this.#sandboxExecutablePath = options.sandboxExecutablePath;
    this.#sandboxExpectedVersion = options.sandboxExpectedVersion;
    this.#sandboxExpectedExecutableSha256 =
      options.sandboxExpectedExecutableSha256;
    this.#sandboxRunner = options.sandboxRunner;
  }

  #handleExternalToolActivity(event: ToolExecutionActivityEvent): void {
    touchTaskSessionForToolActivity(this.#taskRegistry, event);
    if (event.phase === "started") {
      if (
        !this.#activeToolActivities.has(event.id) &&
        this.#activeToolActivities.size >= MAX_ACTIVE_TOOL_ACTIVITIES
      ) {
        const oldestId = [...this.#activeToolActivities.values()].sort(
          (left, right) =>
            Date.parse(left.startedAt) - Date.parse(right.startedAt),
        )[0]?.id;
        if (oldestId !== undefined) {
          this.#activeToolActivities.delete(oldestId);
        }
      }
      this.#activeToolActivities.set(event.id, {
        id: event.id,
        toolName: event.toolName,
        title: event.title,
        category: event.category,
        workspaceId: event.workspaceId,
        startedAt: event.startedAt,
      });
      const workspaceRoot = this.#settings.workspaceRoot;
      if (
        workspaceRoot !== null &&
        !isTaskActivityIgnoredTool(event.toolName)
      ) {
        try {
          const task = this.#taskRegistry.attachActivity({
            activityId: event.id,
            principalId: event.principalId,
            sessionId: event.sessionId,
            toolName: event.toolName,
            title: event.title,
            category: event.category,
            startedAt: event.startedAt,
            projectRoot: workspaceRoot,
          });
          this.#activityTaskIds.set(event.id, task.id);
          this.#activeActivityCountByTask.set(
            task.id,
            (this.#activeActivityCountByTask.get(task.id) ?? 0) + 1,
          );
        } catch (error) {
          if (event.toolName === "terminal.exec") throw error;
          // Non-terminal Task inference remains best-effort.
        }
      }
    } else {
      this.#activeToolActivities.delete(event.id);
      const taskId = this.#activityTaskIds.get(event.id);
      this.#activityTaskIds.delete(event.id);
      if (taskId !== undefined) {
        const remaining = Math.max(
          0,
          (this.#activeActivityCountByTask.get(taskId) ?? 1) - 1,
        );
        if (remaining === 0) {
          this.#activeActivityCountByTask.delete(taskId);
        } else {
          this.#activeActivityCountByTask.set(taskId, remaining);
        }
        try {
          this.#taskRegistry.completeActivity(
            taskId,
            event.outcome === "failed" ? "failed" : "succeeded",
            event.completedAt ?? new Date().toISOString(),
            remaining,
            event.title,
            event.sessionId,
            {
              activityId: event.id,
              toolName: event.toolName,
              outcome: event.outcome === "failed" ? "failed" : "succeeded",
              receiptId: event.receiptId,
              errorCode: event.errorCode,
            },
          );
        } catch (error) {
          if (event.toolName === "terminal.exec") throw error;
          // Non-terminal Task completion telemetry remains best-effort.
        }
      }
    }
    this.#emit();
  }

  #signalExternalToolRejection(): void {
    this.#emit();
  }

  #controlPlaneRouteOrder(): readonly ControlPlaneRouteId[] {
    const routes: ControlPlaneRouteId[] = [];
    if (this.#controlPlaneProxyUrl !== null) {
      routes.push("primary");
    }
    if (this.#controlPlaneBackupProxyUrl !== null) {
      routes.push("backup");
    }
    if (
      this.#settings.secureTunnelControlPlaneDirectFallback ||
      routes.length === 0
    ) {
      routes.push("direct");
    }
    return routes;
  }

  #routingEnabled(): boolean {
    return this.#controlPlaneRoutePolicy.routeOrder.length > 1;
  }

  #controlPlaneProxyForRoute(route: ControlPlaneRouteId): string | null {
    switch (route) {
      case "primary":
        return this.#controlPlaneProxyUrl;
      case "backup":
        return this.#controlPlaneBackupProxyUrl;
      case "direct":
        return null;
    }
  }

  #controlPlaneRouteDisplay(route: ControlPlaneRouteId): string {
    switch (route) {
      case "primary":
        return `Primary proxy · ${secureTunnelProxyDisplay(this.#controlPlaneProxyUrl) ?? "not configured"}`;
      case "backup":
        return `Backup proxy · ${secureTunnelProxyDisplay(this.#controlPlaneBackupProxyUrl) ?? "not configured"}`;
      case "direct":
        return this.#controlPlaneProxyUrl === null &&
          this.#controlPlaneBackupProxyUrl === null
          ? "Direct"
          : "Direct fallback";
    }
  }

  #cancelRouteLaunchTimer(): void {
    if (this.#routeLaunchTimer !== null) {
      clearTimeout(this.#routeLaunchTimer);
      this.#routeLaunchTimer = null;
    }
    this.#routeNextLaunchAt = null;
  }

  #resetControlPlaneRouting(): void {
    this.#cancelRouteLaunchTimer();
    this.#controlPlaneRoutePolicy = routePolicy(
      this.#controlPlaneRouteOrder(),
      this.#controlPlaneFailoverPolicyOverrides,
    );
    this.#controlPlaneRouteState = createControlPlaneFailoverState(
      this.#controlPlaneRoutePolicy,
    );
    this.#routeDesiredRunning = false;
    this.#routeFailureDiagnostic = null;
    this.#routeErrorMessage = null;
    this.#routeLastSwitchAt = null;
    this.#routeEvaluationScheduled = false;
    this.#routeOperationInFlight = false;
    this.#handledTunnelAttemptGeneration =
      this.#secureTunnel.attemptGeneration();
    this.#readyTunnelAttemptGeneration = 0;
  }

  #singleRouteStatus(): DesktopControlPlaneRoutingState["routes"]["direct"]["status"] {
    const tunnel = this.#secureTunnel.state();
    switch (tunnel.phase) {
      case "starting":
      case "running":
        return "probing";
      case "ready":
        return "ready";
      case "error":
        return "failed";
      case "unavailable":
      case "stopped":
      case "stopping":
        return "untested";
    }
  }

  #controlPlaneRoutingState(): DesktopControlPlaneRoutingState {
    const order = this.#controlPlaneRoutePolicy.routeOrder;
    const enabled = this.#routingEnabled();
    const tunnel = this.#secureTunnel.state();
    const singleRoute = order[0] ?? "direct";
    const singleActive =
      this.#routeDesiredRunning ||
      tunnel.processId !== null ||
      ["starting", "running", "ready", "error"].includes(tunnel.phase);
    const activeRoute = enabled
      ? this.#controlPlaneRouteState.activeRoute
      : singleActive
        ? singleRoute
        : null;
    const singleStatus = this.#singleRouteStatus();
    const statusFor = (route: ControlPlaneRouteId) => {
      if (enabled) {
        return this.#controlPlaneRouteState.routes[route].status;
      }
      return route === singleRoute ? singleStatus : ("disabled" as const);
    };
    const lifecycle = enabled
      ? this.#controlPlaneRouteState.lifecycle
      : !singleActive
        ? ("stopped" as const)
        : tunnel.phase === "error" && tunnel.nextReconnectAt === null
          ? ("needs-attention" as const)
          : ("running" as const);
    const routeView = (route: ControlPlaneRouteId) => ({
      configured:
        route === "primary"
          ? this.#controlPlaneProxyUrl !== null
          : route === "backup"
            ? this.#controlPlaneBackupProxyUrl !== null
            : order.includes("direct"),
      display: this.#controlPlaneRouteDisplay(route),
      status: statusFor(route),
    });
    return {
      schemaVersion: "scr.control-plane-routing/v1",
      enabled,
      lifecycle,
      routeOrder: [...order] as readonly DesktopControlPlaneRouteId[],
      activeRoute: activeRoute as DesktopControlPlaneRouteId | null,
      activeRouteDisplay:
        activeRoute === null
          ? null
          : this.#controlPlaneRouteDisplay(activeRoute),
      switchCount: this.#controlPlaneRouteState.switchHistory.length,
      lastSwitchAt: this.#routeLastSwitchAt,
      circuitReason: this.#controlPlaneRouteState.circuitReason,
      routes: {
        primary: routeView("primary"),
        backup: routeView("backup"),
        direct: routeView("direct"),
      },
    };
  }

  #handleSecureTunnelStateChanged(): void {
    this.#emit();
    if (
      !this.#routingEnabled() ||
      !this.#routeDesiredRunning ||
      this.#routeOperationInFlight
    ) {
      return;
    }
    this.#scheduleRouteEvaluation();
  }

  #scheduleRouteEvaluation(): void {
    if (this.#routeEvaluationScheduled) {
      return;
    }
    this.#routeEvaluationScheduled = true;
    queueMicrotask(() => {
      this.#routeEvaluationScheduled = false;
      void this.#enqueue(async () => {
        await this.#evaluateRouteState();
      }).catch((error: unknown) => {
        this.#routeErrorMessage = messageFrom(error);
        this.#emit();
      });
    });
  }

  #strongerFailureDiagnostic(
    current: DesktopTunnelFailureDiagnostic | null,
    retained: DesktopTunnelFailureDiagnostic | null,
  ): DesktopTunnelFailureDiagnostic | null {
    if (current === null) {
      return retained;
    }
    if (retained === null) {
      return current;
    }
    return tunnelFailureClassificationPriority(current) >=
      tunnelFailureClassificationPriority(retained)
      ? current
      : retained;
  }

  #syntheticProcessFailureDiagnostic(
    detail: string,
  ): DesktopTunnelFailureDiagnostic {
    return {
      schemaVersion: "scr.tunnel-failure/v1",
      failureClass: "connector",
      source: "process",
      confidence: "high",
      routeSwitchEligible: false,
      evidenceCode: "connector-process-failed",
      summary: "The local connector process exited or became unavailable.",
      detail,
      statusCode: null,
      observedAt: new Date().toISOString(),
    };
  }

  #currentAttemptFailureDiagnostic(
    diagnostic: DesktopTunnelFailureDiagnostic | null,
    terminal: boolean,
    terminalDetail: string,
  ): DesktopTunnelFailureDiagnostic | null {
    if (diagnostic !== null) {
      if (
        !terminal &&
        connectorReportsOwnRetry(diagnostic) &&
        !["auth", "identity", "local-mcp"].includes(diagnostic.failureClass)
      ) {
        return null;
      }
      if (
        diagnostic.routeSwitchEligible ||
        diagnostic.source === "health-probe" || diagnostic.source === "readiness-timeout" ||
        (diagnostic.confidence === "high" &&
          ["auth", "identity", "local-mcp"].includes(diagnostic.failureClass))
      ) {
        return diagnostic;
      }
      if (terminal && diagnostic.failureClass === "connector") {
        return diagnostic;
      }
    }
    return terminal
      ? this.#syntheticProcessFailureDiagnostic(terminalDetail)
      : null;
  }

  async #evaluateRouteState(): Promise<void> {
    if (
      !this.#routingEnabled() ||
      !this.#routeDesiredRunning ||
      this.#routeOperationInFlight
    ) {
      return;
    }
    const route = this.#controlPlaneRouteState.activeRoute;
    if (route === null) {
      return;
    }
    const tunnel = this.#secureTunnel.state();
    const attemptGeneration = this.#secureTunnel.attemptGeneration();
    const decisiveDiagnostic = this.#currentAttemptFailureDiagnostic(
      tunnel.failureDiagnostic,
      false,
      "",
    );

    if (tunnel.phase === "ready" && decisiveDiagnostic === null) {
      if (attemptGeneration === this.#readyTunnelAttemptGeneration) {
        return;
      }
      this.#readyTunnelAttemptGeneration = attemptGeneration;
      const transition = reduceControlPlaneFailover(
        this.#controlPlaneRouteState,
        {
          type: "attempt-ready",
          at: monotonicMilliseconds(),
          route,
          generation: this.#controlPlaneRouteState.attemptGeneration,
        },
        this.#controlPlaneRoutePolicy,
      );
      this.#controlPlaneRouteState = transition.state;
      this.#routeFailureDiagnostic = null;
      this.#routeErrorMessage = null;
      this.#routeNextLaunchAt = null;
      this.#emit();
      return;
    }

    const terminal =
      tunnel.processId === null &&
      ["error", "stopped", "unavailable"].includes(tunnel.phase);
    const eventDiagnostic =
      decisiveDiagnostic ??
      this.#currentAttemptFailureDiagnostic(
        tunnel.failureDiagnostic,
        terminal,
        tunnel.errorMessage ?? "The connector process is no longer running.",
      );
    if (eventDiagnostic === null) {
      return;
    }
    if (attemptGeneration === this.#handledTunnelAttemptGeneration) {
      return;
    }
    this.#handledTunnelAttemptGeneration = attemptGeneration;
    this.#routeFailureDiagnostic = eventDiagnostic;
    this.#routeErrorMessage = tunnel.errorMessage ?? eventDiagnostic.summary;

    const previousState = this.#controlPlaneRouteState;
    const transition = reduceControlPlaneFailover(
      previousState,
      {
        type: "attempt-failed",
        at: monotonicMilliseconds(),
        route,
        generation: previousState.attemptGeneration,
        failureClass: eventDiagnostic.failureClass,
        redactedReason: `${eventDiagnostic.summary} ${eventDiagnostic.detail}`,
        hardTransport: eventDiagnostic.routeSwitchEligible,
      },
      this.#controlPlaneRoutePolicy,
    );

    if (
      transition.effect.kind === "launch" &&
      !this.#settings.secureTunnelAutoReconnect
    ) {
      const routes = {
        ...transition.state.routes,
        [route]: {
          ...transition.state.routes[route],
          status: "failed" as const,
        },
      };
      this.#controlPlaneRouteState = {
        ...transition.state,
        lifecycle: "needs-attention",
        activeRoute: route,
        activeSince: previousState.activeSince,
        attemptGeneration: transition.state.attemptGeneration + 1,
        routes,
      };
      this.#routeDesiredRunning = false;
      await this.#retireActiveTunnel();
      this.#emit();
      return;
    }

    this.#controlPlaneRouteState = transition.state;
    await this.#handleRouteEffect(transition.effect, eventDiagnostic);
  }

  async #retireActiveTunnel(): Promise<void> {
    this.#routeOperationInFlight = true;
    try {
      await this.#secureTunnel.stop();
      this.#handledTunnelAttemptGeneration =
        this.#secureTunnel.attemptGeneration();
      this.#readyTunnelAttemptGeneration = 0;
    } finally {
      this.#routeOperationInFlight = false;
    }
  }

  #scheduleRouteLaunch(
    effect: Extract<ControlPlaneFailoverEffect, { kind: "launch" }>,
  ): void {
    this.#cancelRouteLaunchTimer();
    if (
      !this.#routeDesiredRunning ||
      effect.generation !== this.#controlPlaneRouteState.attemptGeneration ||
      effect.route !== this.#controlPlaneRouteState.activeRoute
    ) {
      return;
    }
    this.#routeNextLaunchAt = new Date(
      Date.now() + effect.delayMs,
    ).toISOString();
    this.#routeLaunchTimer = setTimeout(() => {
      this.#routeLaunchTimer = null;
      this.#routeNextLaunchAt = null;
      void this.#enqueue(async () => {
        if (
          !this.#routeDesiredRunning ||
          effect.generation !==
            this.#controlPlaneRouteState.attemptGeneration ||
          effect.route !== this.#controlPlaneRouteState.activeRoute
        ) {
          return;
        }
        await this.#launchControlPlaneRoute(effect, false);
      }).catch((error: unknown) => {
        this.#routeErrorMessage = messageFrom(error);
        this.#emit();
      });
    }, effect.delayMs);
    this.#routeLaunchTimer.unref();
    this.#emit();
  }

  async #launchControlPlaneRoute(
    effect: Extract<ControlPlaneFailoverEffect, { kind: "launch" }>,
    interactive: boolean,
  ): Promise<boolean> {
    if (
      !this.#routeDesiredRunning ||
      effect.generation !== this.#controlPlaneRouteState.attemptGeneration ||
      effect.route !== this.#controlPlaneRouteState.activeRoute
    ) {
      return false;
    }
    const runtime = this.#runtime;
    const bearerToken = this.#bearerToken;
    if (runtime === null || bearerToken === null || this.#phase !== "running") {
      const message =
        "Start the Sovereign Gateway before starting a control-plane route.";
      this.#routeErrorMessage = message;
      if (interactive) {
        throw new Error(message);
      }
      this.#emit();
      return false;
    }
    const controlPlaneProxyUrl = this.#controlPlaneProxyForRoute(effect.route);
    if (effect.route !== "direct" && controlPlaneProxyUrl === null) {
      const message = `${this.#controlPlaneRouteDisplay(effect.route)} is no longer configured.`;
      this.#routeErrorMessage = message;
      if (interactive) {
        throw new Error(message);
      }
      this.#emit();
      return false;
    }

    this.#routeOperationInFlight = true;
    this.#routeNextLaunchAt = null;
    if (effect.cause === "failover") {
      this.#routeLastSwitchAt = new Date().toISOString();
    }
    try {
      this.#secureTunnel.configure({
        tunnelId: this.#settings.secureTunnelId,
        controlPlaneProxyUrl,
      });
      this.#secureTunnel.setAutoReconnect(false);
      const previousAttemptGeneration = this.#secureTunnel.attemptGeneration();
      this.#handledTunnelAttemptGeneration = previousAttemptGeneration;
      this.#readyTunnelAttemptGeneration = 0;
      await this.#secureTunnel.start({
        gatewayEndpoint: runtime.endpoint,
        gatewayBearerToken: bearerToken,
      });
      return true;
    } catch (error) {
      this.#routeErrorMessage = messageFrom(error);
      if (interactive) {
        throw error;
      }
      return false;
    } finally {
      this.#routeOperationInFlight = false;
      if (this.#routeDesiredRunning) {
        this.#scheduleRouteEvaluation();
      }
      this.#emit();
    }
  }

  async #handleRouteEffect(
    effect: ControlPlaneFailoverEffect,
    diagnostic: DesktopTunnelFailureDiagnostic,
  ): Promise<void> {
    switch (effect.kind) {
      case "launch": {
        const target = this.#controlPlaneRouteDisplay(effect.route);
        this.#routeErrorMessage =
          effect.cause === "failover"
            ? `${diagnostic.summary} Switching to ${target}.`
            : `${diagnostic.summary} Retrying ${target}.`;
        await this.#retireActiveTunnel();
        if (effect.delayMs <= 0) {
          await this.#launchControlPlaneRoute(effect, false);
        } else {
          this.#scheduleRouteLaunch(effect);
        }
        return;
      }
      case "attention":
        this.#routeDesiredRunning = this.#settings.secureTunnelAutoReconnect &&
          !["auth", "identity"].includes(effect.failureClass);
        this.#cancelRouteLaunchTimer();
        this.#routeErrorMessage = effect.reason;
        await this.#retireActiveTunnel();
        this.#emit();
        return;
      case "circuit-open":
        this.#cancelRouteLaunchTimer();
        this.#routeErrorMessage = effect.reason;
        await this.#retireActiveTunnel();
        this.#emit();
        return;
      case "hold":
      case "ignored":
        this.#emit();
        return;
      case "stop":
        this.#cancelRouteLaunchTimer();
        await this.#retireActiveTunnel();
        this.#emit();
        return;
    }
  }

  async #startRoutedTunnel(interactive: boolean): Promise<void> {
    const tunnel = this.#secureTunnel.state();
    if (
      this.#routeDesiredRunning &&
      tunnel.processId !== null &&
      ["starting", "running", "ready"].includes(tunnel.phase)
    ) {
      return;
    }
    this.#cancelRouteLaunchTimer();
    this.#routeDesiredRunning = true;
    this.#routeFailureDiagnostic = null;
    this.#routeErrorMessage = null;
    this.#routeNextLaunchAt = null;
    const event =
      this.#controlPlaneRouteState.lifecycle === "stopped"
        ? { type: "start" as const, at: monotonicMilliseconds() }
        : { type: "manual-reset" as const, at: monotonicMilliseconds() };
    const transition = reduceControlPlaneFailover(
      this.#controlPlaneRouteState,
      event,
      this.#controlPlaneRoutePolicy,
    );
    this.#controlPlaneRouteState = transition.state;
    if (event.type === "manual-reset") {
      this.#routeLastSwitchAt = null;
    }
    if (transition.effect.kind !== "launch") {
      this.#routeErrorMessage = transition.effect.reason;
      this.#emit();
      return;
    }
    if (tunnel.processId !== null) {
      await this.#retireActiveTunnel();
    }
    await this.#launchControlPlaneRoute(transition.effect, interactive);
  }

  async #stopControlPlaneRouting(reason: string): Promise<void> {
    this.#routeDesiredRunning = false;
    this.#cancelRouteLaunchTimer();
    const transition = reduceControlPlaneFailover(
      this.#controlPlaneRouteState,
      {
        type: "stop",
        at: monotonicMilliseconds(),
        reason,
      },
      this.#controlPlaneRoutePolicy,
    );
    this.#controlPlaneRouteState = transition.state;
    this.#routeFailureDiagnostic = null;
    this.#routeErrorMessage = null;
    this.#routeEvaluationScheduled = false;
    await this.#retireActiveTunnel();
    this.#emit();
  }

  async initialize(): Promise<void> {
    this.#settingsLoaded = false;
    try {
      this.#settings = await readControlPlaneSettings(this.#settingsPath);
      this.#settingsLoaded = true;
      if (this.#environmentWorkspaceRoot !== undefined) {
        this.#settings = {
          ...this.#settings,
          workspaceRoot: resolve(this.#environmentWorkspaceRoot),
        };
      }

      let settingsChanged = false;
      const workspaceRoot = this.#settings.workspaceRoot;
      let permissionModelVersion = this.#settings.permissionModelVersion;
      if (permissionModelVersion > CURRENT_PERMISSION_MODEL_VERSION) {
        throw new Error(
          `Settings use unsupported permission model version ${permissionModelVersion}. Upgrade Sovereign before starting the runtime.`,
        );
      }
      const migratedLegacyPermissionModel =
        permissionModelVersion < CURRENT_PERMISSION_MODEL_VERSION;
      let permissionWorkspaceRoot = this.#settings.permissionWorkspaceRoot;
      let permissionProfile = this.#settings.permissionProfile;
      let rememberedPermissionProfile =
        this.#settings.rememberedPermissionProfile;
      let permissionBypassGrantEncrypted =
        this.#settings.permissionBypassGrantEncrypted;
      let unattendedWorkspaceRoot = this.#settings.unattendedWorkspaceRoot;

      if (migratedLegacyPermissionModel) {
        permissionModelVersion = CURRENT_PERMISSION_MODEL_VERSION;
        // Version 1 promoted L1 to L2 when workspace restore was enabled. Only
        // migrate bindings that still carry that matching restore evidence; an
        // unbound legacy L2 may have been selected explicitly and is preserved.
        const legacyWorkspaceRestoreMatches = sameWorkspaceRoot(
          workspaceRoot,
          unattendedWorkspaceRoot,
        );
        if (
          legacyWorkspaceRestoreMatches &&
          permissionProfile === "workspace"
        ) {
          permissionProfile = "observe";
        }
        if (
          legacyWorkspaceRestoreMatches &&
          rememberedPermissionProfile === "workspace"
        ) {
          rememberedPermissionProfile = "observe";
        }
        settingsChanged = true;
      }

      if (
        unattendedWorkspaceRoot !== null &&
        !sameWorkspaceRoot(workspaceRoot, unattendedWorkspaceRoot)
      ) {
        unattendedWorkspaceRoot = null;
        settingsChanged = true;
      }
      let unattendedWorkspaceAccess = sameWorkspaceRoot(
        workspaceRoot,
        unattendedWorkspaceRoot,
      );

      if (workspaceRoot === null) {
        permissionWorkspaceRoot = null;
        permissionProfile = "observe";
        rememberedPermissionProfile = "observe";
        permissionBypassGrantEncrypted = null;
        unattendedWorkspaceRoot = null;
        unattendedWorkspaceAccess = false;
      } else if (!sameWorkspaceRoot(workspaceRoot, permissionWorkspaceRoot)) {
        const preserveLegacyWorkspaceRestore =
          migratedLegacyPermissionModel &&
          permissionWorkspaceRoot === null &&
          unattendedWorkspaceAccess;
        permissionWorkspaceRoot = workspaceRoot;
        permissionProfile = "observe";
        rememberedPermissionProfile = "observe";
        permissionBypassGrantEncrypted = null;
        if (!preserveLegacyWorkspaceRestore) {
          unattendedWorkspaceRoot = null;
          unattendedWorkspaceAccess = false;
        }
        settingsChanged = true;
      } else if (permissionProfile === "bypass") {
        const restoredGrant = await restorePermissionBypassGrant(
          this.#shell,
          workspaceRoot,
          permissionBypassGrantEncrypted,
        );
        if (restoredGrant === null) {
          permissionProfile = rememberedPermissionProfile;
          permissionBypassGrantEncrypted = null;
          settingsChanged = true;
        } else if (restoredGrant !== permissionBypassGrantEncrypted) {
          permissionBypassGrantEncrypted = restoredGrant;
          settingsChanged = true;
        }
      } else {
        if (rememberedPermissionProfile !== permissionProfile) {
          rememberedPermissionProfile = permissionProfile;
          settingsChanged = true;
        }
        if (permissionBypassGrantEncrypted !== null) {
          permissionBypassGrantEncrypted = null;
          settingsChanged = true;
        }
      }

      if (
        permissionModelVersion !== this.#settings.permissionModelVersion ||
        permissionWorkspaceRoot !== this.#settings.permissionWorkspaceRoot ||
        permissionProfile !== this.#settings.permissionProfile ||
        rememberedPermissionProfile !==
          this.#settings.rememberedPermissionProfile ||
        permissionBypassGrantEncrypted !==
          this.#settings.permissionBypassGrantEncrypted ||
        unattendedWorkspaceRoot !== this.#settings.unattendedWorkspaceRoot
      ) {
        this.#settings = {
          ...this.#settings,
          permissionModelVersion,
          permissionWorkspaceRoot,
          permissionProfile,
          rememberedPermissionProfile,
          permissionBypassGrantEncrypted,
          unattendedWorkspaceRoot,
        };
        settingsChanged = true;
      }
      this.#permissionProfile = permissionProfile;
      await this.#projectWorkspaces.initialize();
      let restoredRuntimeKey: string | undefined;
      if (this.#settings.secureTunnelRuntimeKeyEncrypted !== null) {
        const restored = await this.#shell.restoreSecret(
          this.#settings.secureTunnelRuntimeKeyEncrypted,
        );
        if (restored === null) {
          this.#settings = {
            ...this.#settings,
            secureTunnelRuntimeKeyEncrypted: null,
          };
          settingsChanged = true;
        } else {
          restoredRuntimeKey = restored.value;
          if (
            restored.encoded !== this.#settings.secureTunnelRuntimeKeyEncrypted
          ) {
            this.#settings = {
              ...this.#settings,
              secureTunnelRuntimeKeyEncrypted: restored.encoded,
            };
            settingsChanged = true;
          }
        }
      }

      let restoredControlPlaneProxyUrl: string | undefined;
      if (this.#settings.secureTunnelControlPlaneProxyEncrypted !== null) {
        const restored = await this.#shell.restoreSecret(
          this.#settings.secureTunnelControlPlaneProxyEncrypted,
        );
        if (restored === null) {
          this.#settings = {
            ...this.#settings,
            secureTunnelControlPlaneProxyEncrypted: null,
          };
          settingsChanged = true;
        } else {
          try {
            restoredControlPlaneProxyUrl =
              normalizeSecureTunnelControlPlaneProxyUrl(restored.value);
            if (
              restored.encoded !==
              this.#settings.secureTunnelControlPlaneProxyEncrypted
            ) {
              this.#settings = {
                ...this.#settings,
                secureTunnelControlPlaneProxyEncrypted: restored.encoded,
              };
              settingsChanged = true;
            }
          } catch {
            this.#settings = {
              ...this.#settings,
              secureTunnelControlPlaneProxyEncrypted: null,
            };
            settingsChanged = true;
          }
        }
      }
      let restoredControlPlaneBackupProxyUrl: string | undefined;
      if (
        this.#settings.secureTunnelControlPlaneBackupProxyEncrypted !== null
      ) {
        const restored = await this.#shell.restoreSecret(
          this.#settings.secureTunnelControlPlaneBackupProxyEncrypted,
        );
        if (restored === null) {
          this.#settings = {
            ...this.#settings,
            secureTunnelControlPlaneBackupProxyEncrypted: null,
          };
          settingsChanged = true;
        } else {
          try {
            restoredControlPlaneBackupProxyUrl =
              normalizeSecureTunnelControlPlaneProxyUrl(restored.value);
            if (
              restored.encoded !==
              this.#settings.secureTunnelControlPlaneBackupProxyEncrypted
            ) {
              this.#settings = {
                ...this.#settings,
                secureTunnelControlPlaneBackupProxyEncrypted: restored.encoded,
              };
              settingsChanged = true;
            }
          } catch {
            this.#settings = {
              ...this.#settings,
              secureTunnelControlPlaneBackupProxyEncrypted: null,
            };
            settingsChanged = true;
          }
        }
      }
      if (
        restoredControlPlaneBackupProxyUrl !== undefined &&
        restoredControlPlaneProxyUrl === undefined
      ) {
        restoredControlPlaneBackupProxyUrl = undefined;
        this.#settings = {
          ...this.#settings,
          secureTunnelControlPlaneBackupProxyEncrypted: null,
          secureTunnelControlPlaneDirectFallback: false,
        };
        settingsChanged = true;
      }
      if (
        restoredControlPlaneProxyUrl !== undefined &&
        restoredControlPlaneBackupProxyUrl !== undefined &&
        sameControlPlaneProxyEndpoint(
          restoredControlPlaneProxyUrl,
          restoredControlPlaneBackupProxyUrl,
        )
      ) {
        restoredControlPlaneBackupProxyUrl = undefined;
        this.#settings = {
          ...this.#settings,
          secureTunnelControlPlaneBackupProxyEncrypted: null,
        };
        settingsChanged = true;
      }
      if (
        restoredControlPlaneProxyUrl === undefined &&
        this.#settings.secureTunnelControlPlaneDirectFallback
      ) {
        this.#settings = {
          ...this.#settings,
          secureTunnelControlPlaneDirectFallback: false,
        };
        settingsChanged = true;
      }
      this.#controlPlaneProxyUrl = restoredControlPlaneProxyUrl ?? null;
      this.#controlPlaneBackupProxyUrl =
        restoredControlPlaneBackupProxyUrl ?? null;
      this.#resetControlPlaneRouting();
      if (settingsChanged) {
        await this.#persistSettings(this.#settings);
      }

      this.#secureTunnel.configure({
        tunnelId: this.#settings.secureTunnelId,
        executablePath: this.#settings.secureTunnelExecutablePath,
        trustedExecutableSha256: this.#settings.secureTunnelExecutableSha256,
        ...(restoredRuntimeKey === undefined
          ? {}
          : { runtimeApiKey: restoredRuntimeKey }),
        controlPlaneProxyUrl: this.#controlPlaneProxyForRoute(
          this.#controlPlaneRoutePolicy.routeOrder[0] ?? "direct",
        ),
      });
      this.#secureTunnel.setAutoReconnect(
        this.#routingEnabled()
          ? false
          : this.#settings.secureTunnelAutoReconnect,
      );
      this.#phase =
        this.#settings.workspaceRoot === null ? "setup-required" : "stopped";
      const shouldStartPrivateGateway =
        this.#settings.workspaceRoot !== null &&
        (this.#passiveCutoverCandidate || this.#settings.autoStart);
      if (shouldStartPrivateGateway) {
        await this.#startNow();
        if (!this.#passiveCutoverCandidate) {
          await this.#startConfiguredTunnel(false);
        }
      } else {
        this.#emit();
      }
    } catch (error) {
      this.#phase = "error";
      this.#errorMessage = messageFrom(error);
      this.#emit();
    }
  }

  state(): DesktopRuntimeState {
    const secureTunnel = this.#secureTunnel.state();
    const runtimeApiKeyStorage = !secureTunnel.hasRuntimeApiKey
      ? ("none" as const)
      : this.#settings.secureTunnelRuntimeKeyEncrypted !== null
        ? ("windows-protected" as const)
        : ("memory-only" as const);
    const controlPlaneProxyStorage =
      this.#controlPlaneProxyUrl === null
        ? ("none" as const)
        : this.#settings.secureTunnelControlPlaneProxyEncrypted !== null
          ? ("windows-protected" as const)
          : ("memory-only" as const);
    const controlPlaneBackupProxyStorage =
      this.#controlPlaneBackupProxyUrl === null
        ? ("none" as const)
        : this.#settings.secureTunnelControlPlaneBackupProxyEncrypted !== null
          ? ("windows-protected" as const)
          : ("memory-only" as const);
    const controlPlaneRouting = this.#controlPlaneRoutingState();
    const routed = controlPlaneRouting.enabled;
    const activeRoute = this.#controlPlaneRouteState.activeRoute;
    const activeRouteState =
      activeRoute === null
        ? null
        : this.#controlPlaneRouteState.routes[activeRoute];
    const routedReconnectAttempt =
      activeRouteState === null
        ? 0
        : activeRouteState.consecutiveTransportFailures +
          activeRouteState.consecutiveConnectorFailures;
    const routedFailureDiagnostic = this.#strongerFailureDiagnostic(
      secureTunnel.failureDiagnostic,
      this.#routeFailureDiagnostic,
    );
    const routedErrorMessage =
      this.#routeErrorMessage ?? secureTunnel.errorMessage;
    const routedPhase =
      routed &&
      ["needs-attention", "circuit-open"].includes(
        controlPlaneRouting.lifecycle,
      )
        ? ("error" as const)
        : secureTunnel.phase;
    return {
      phase: this.#phase,
      runtimeVersion: RUNTIME_VERSION,
      runtimeBuildSource: RUNTIME_BUILD_SOURCE,
      workspaceRoot: this.#settings.workspaceRoot,
      activeDesktopWorkspace: this.#projectWorkspaces?.active() ?? null,
      endpoint: this.#runtime?.endpoint ?? null,
      manifestDigest: this.#runtime?.manifest.digest ?? null,
      toolCount: this.#runtime?.manifest.tools.length ?? 0,
      sessionCount: this.#runtime?.sessionCount() ?? 0,
      capabilities: CAPABILITIES,
      tokenStorage: "main-process-memory",
      credentialGeneration: this.#credentialGeneration,
      autoStart: this.#settings.autoStart,
      unattendedWorkspaceAccess: sameWorkspaceRoot(
        this.#settings.workspaceRoot,
        this.#settings.unattendedWorkspaceRoot,
      ),
      permissionProfile: this.#permissionProfile,
      rememberedPermissionProfile: this.#settings.rememberedPermissionProfile,
      activeToolActivities: [...this.#activeToolActivities.values()].sort(
        (left, right) =>
          Date.parse(right.startedAt) - Date.parse(left.startedAt),
      ),
      webBridgeUrl: this.#settings.webBridgeUrl,
      secureTunnel: {
        ...secureTunnel,
        phase: routedPhase,
        runtimeApiKeyStorage,
        controlPlaneProxyConfigured: this.#controlPlaneProxyUrl !== null,
        controlPlaneProxyDisplay: secureTunnelProxyDisplay(
          this.#controlPlaneProxyUrl,
        ),
        controlPlaneProxyStorage,
        controlPlaneBackupProxyConfigured:
          this.#controlPlaneBackupProxyUrl !== null,
        controlPlaneBackupProxyDisplay: secureTunnelProxyDisplay(
          this.#controlPlaneBackupProxyUrl,
        ),
        controlPlaneBackupProxyStorage,
        controlPlaneDirectFallbackEnabled:
          this.#settings.secureTunnelControlPlaneDirectFallback,
        controlPlaneRouting,
        autoStart: this.#settings.secureTunnelAutoStart,
        autoReconnect: this.#settings.secureTunnelAutoReconnect,
        desiredRunning: routed
          ? this.#routeDesiredRunning
          : secureTunnel.desiredRunning,
        reconnectAttempt: routed
          ? routedReconnectAttempt
          : secureTunnel.reconnectAttempt,
        nextReconnectAt: routed
          ? this.#routeNextLaunchAt
          : secureTunnel.nextReconnectAt,
        errorMessage: routed ? routedErrorMessage : secureTunnel.errorMessage,
        failureDiagnostic: routed
          ? routedFailureDiagnostic
          : secureTunnel.failureDiagnostic,
      },
      errorMessage: this.#errorMessage,
    };
  }

  emitState(): void {
    this.#emit();
  }

  cancelApprovals(reason: ApprovalCancellationReason = "cancelled"): void {
    this.#externalApprovalBroker.cancelAll(reason);
  }

  start(): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      await this.#startNow();
      await this.#startConfiguredTunnel(false);
      return this.state();
    });
  }

  stop(): Promise<DesktopRuntimeState> {
    if (this.#routingEnabled()) {
      this.#routeDesiredRunning = false;
      this.#cancelRouteLaunchTimer();
    }
    return this.#enqueue(async () => {
      await this.#stopNow();
      return this.state();
    });
  }

  chooseWorkspace(): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      const selected = await this.#shell.chooseWorkspace();
      if (selected === null) {
        return this.state();
      }
      const workspaceRoot = resolve(selected);
      if (sameWorkspaceRoot(this.#settings.workspaceRoot, workspaceRoot)) {
        return this.state();
      }
      const permissionProfile = this.#permissionProfile;
      const rememberedPermissionProfile =
        permissionProfile === "bypass"
          ? this.#settings.rememberedPermissionProfile
          : permissionProfile;
      const permissionBypassGrantEncrypted =
        permissionProfile === "bypass"
          ? await protectPermissionBypassGrant(this.#shell, workspaceRoot)
          : null;
      this.#externalApprovalBroker.cancelAll("workspace-change");
      this.#directWorkspaceApprovals.clear();
      await this.#stopNow();
      this.#settings = {
        ...this.#settings,
        workspaceRoot,
        permissionModelVersion: CURRENT_PERMISSION_MODEL_VERSION,
        permissionWorkspaceRoot: workspaceRoot,
        permissionProfile,
        rememberedPermissionProfile,
        permissionBypassGrantEncrypted,
        unattendedWorkspaceRoot: null,
      };
      await this.#persistSettings(this.#settings);
      this.#phase = "stopped";
      this.#errorMessage = null;
      this.#emit();
      await this.#startNow();
      await this.#startConfiguredTunnel(false);
      return this.state();
    });
  }

  readProjectWorkspaces(projectId: string): Promise<DesktopProjectWorkspaces> {
    return this.#enqueue(() => this.#projectWorkspaces.read(projectId));
  }

  chooseProjectWorkspace(projectId: string): Promise<DesktopProjectWorkspaces> {
    return this.#enqueue(async () => {
      const result = await this.#projectWorkspaces.choose(projectId);
      this.#emit();
      return result;
    });
  }

  selectProjectWorkspace(projectId: string, workspaceId: string): Promise<DesktopProjectWorkspaces> {
    return this.#enqueue(async () => {
      const result = await this.#projectWorkspaces.select(projectId, workspaceId);
      this.#emit();
      return result;
    });
  }

  connectionBundle(): ControlPlaneConnectionBundle {
    const runtime = this.#runtime;
    const bearerToken = this.#bearerToken;
    if (runtime === null || bearerToken === null) {
      throw new Error(
        "Start the local Gateway before copying its connection bundle.",
      );
    }
    const endpoint = this.#settings.webBridgeUrl ?? runtime.endpoint;
    const target =
      this.#settings.webBridgeUrl === null ? "local" : "web-bridge";
    return {
      endpoint,
      target,
      serialized: serializeConnectionBundle(endpoint, bearerToken),
    };
  }

  rotateCredentials(): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      if (this.#runtime === null) {
        throw new Error(
          "Start the local Gateway before rotating its credential.",
        );
      }
      const response = await this.#shell.prompt({
        type: "warning",
        title: "Rotate Gateway credential",
        message: "Rotate the active Bearer credential?",
        detail:
          "Existing MCP sessions will be disconnected. Copy a new connection bundle after the Gateway restarts.",
        buttons: ["Rotate credential", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) {
        return this.state();
      }
      this.#gatewayBearerToken = null;
      await this.#stopNow();
      await this.#startNow();
      await this.#startConfiguredTunnel(false);
      return this.state();
    });
  }

  setAutoStart(enabled: boolean): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      if (this.#settings.autoStart === enabled) {
        return this.state();
      }
      this.#settings = { ...this.#settings, autoStart: enabled };
      await this.#persistSettings(this.#settings);
      this.#emit();
      return this.state();
    });
  }

  setWebBridgeUrl(value: string | null): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      const webBridgeUrl =
        value === null || value.trim().length === 0
          ? null
          : normalizeWebBridgeUrl(value);
      if (this.#settings.webBridgeUrl === webBridgeUrl) {
        return this.state();
      }
      this.#settings = { ...this.#settings, webBridgeUrl };
      await this.#persistSettings(this.#settings);
      this.#emit();
      return this.state();
    });
  }

  configureSecureTunnel(
    input: DesktopSecureTunnelConfigurationInput,
  ): Promise<DesktopRuntimeState> {
    if (this.#routingEnabled()) {
      this.#routeDesiredRunning = false;
      this.#cancelRouteLaunchTimer();
    }
    return this.#enqueue(async () => {
      if (
        this.#routingEnabled() &&
        this.#controlPlaneRouteState.lifecycle !== "stopped"
      ) {
        await this.#stopControlPlaneRouting(
          "Secure MCP Tunnel configuration is changing.",
        );
      }
      const tunnelId =
        input.tunnelId === null || input.tunnelId.trim().length === 0
          ? null
          : normalizeSecureTunnelId(input.tunnelId);
      const controlPlaneProxyUrl =
        input.clearControlPlaneProxy === true
          ? null
          : input.controlPlaneProxyUrl === undefined ||
              input.controlPlaneProxyUrl.trim().length === 0
            ? undefined
            : normalizeSecureTunnelControlPlaneProxyUrl(
                input.controlPlaneProxyUrl,
              );
      const controlPlaneBackupProxyUrl =
        input.clearControlPlaneBackupProxy === true
          ? null
          : input.controlPlaneBackupProxyUrl === undefined ||
              input.controlPlaneBackupProxyUrl.trim().length === 0
            ? undefined
            : normalizeSecureTunnelControlPlaneProxyUrl(
                input.controlPlaneBackupProxyUrl,
              );
      const clearingPrimaryProxy = input.clearControlPlaneProxy === true;
      const nextControlPlaneProxyUrl =
        controlPlaneProxyUrl === undefined
          ? this.#controlPlaneProxyUrl
          : controlPlaneProxyUrl;
      const nextControlPlaneBackupProxyUrl = clearingPrimaryProxy
        ? null
        : controlPlaneBackupProxyUrl === undefined
          ? this.#controlPlaneBackupProxyUrl
          : controlPlaneBackupProxyUrl;
      const nextControlPlaneDirectFallback = clearingPrimaryProxy
        ? false
        : (input.controlPlaneDirectFallbackEnabled ??
          this.#settings.secureTunnelControlPlaneDirectFallback);
      if (
        nextControlPlaneBackupProxyUrl !== null &&
        nextControlPlaneProxyUrl === null
      ) {
        throw new Error(
          "Configure a primary control-plane proxy before adding a backup proxy.",
        );
      }
      if (
        nextControlPlaneProxyUrl !== null &&
        nextControlPlaneBackupProxyUrl !== null &&
        sameControlPlaneProxyEndpoint(
          nextControlPlaneProxyUrl,
          nextControlPlaneBackupProxyUrl,
        )
      ) {
        throw new Error(
          "Primary and backup control-plane proxies must use different protocol/host/port endpoints.",
        );
      }
      if (nextControlPlaneDirectFallback && nextControlPlaneProxyUrl === null) {
        throw new Error(
          "Direct fallback requires a configured primary control-plane proxy.",
        );
      }
      this.#secureTunnel.configure({
        tunnelId,
        ...(input.runtimeApiKey === undefined
          ? {}
          : { runtimeApiKey: input.runtimeApiKey }),
        ...(input.clearRuntimeApiKey === undefined
          ? {}
          : { clearRuntimeApiKey: input.clearRuntimeApiKey }),
        controlPlaneProxyUrl: nextControlPlaneProxyUrl,
      });

      let secureTunnelRuntimeKeyEncrypted =
        this.#settings.secureTunnelRuntimeKeyEncrypted;
      if (input.clearRuntimeApiKey === true) {
        secureTunnelRuntimeKeyEncrypted = null;
      } else if (
        input.runtimeApiKey !== undefined &&
        input.runtimeApiKey.trim().length > 0
      ) {
        secureTunnelRuntimeKeyEncrypted = await this.#shell.protectSecret(
          input.runtimeApiKey.trim(),
        );
      }

      let secureTunnelControlPlaneProxyEncrypted =
        this.#settings.secureTunnelControlPlaneProxyEncrypted;
      if (input.clearControlPlaneProxy === true) {
        secureTunnelControlPlaneProxyEncrypted = null;
      } else if (
        controlPlaneProxyUrl !== undefined &&
        controlPlaneProxyUrl !== null
      ) {
        secureTunnelControlPlaneProxyEncrypted =
          await this.#shell.protectSecret(controlPlaneProxyUrl);
      }

      let secureTunnelControlPlaneBackupProxyEncrypted =
        this.#settings.secureTunnelControlPlaneBackupProxyEncrypted;
      if (input.clearControlPlaneBackupProxy === true) {
        secureTunnelControlPlaneBackupProxyEncrypted = null;
      } else if (
        controlPlaneBackupProxyUrl !== undefined &&
        controlPlaneBackupProxyUrl !== null
      ) {
        secureTunnelControlPlaneBackupProxyEncrypted =
          await this.#shell.protectSecret(controlPlaneBackupProxyUrl);
      }
      if (nextControlPlaneProxyUrl === null) {
        secureTunnelControlPlaneProxyEncrypted = null;
        secureTunnelControlPlaneBackupProxyEncrypted = null;
      }
      if (
        this.#settings.secureTunnelId !== tunnelId ||
        this.#settings.secureTunnelRuntimeKeyEncrypted !==
          secureTunnelRuntimeKeyEncrypted ||
        this.#settings.secureTunnelControlPlaneProxyEncrypted !==
          secureTunnelControlPlaneProxyEncrypted ||
        this.#settings.secureTunnelControlPlaneBackupProxyEncrypted !==
          secureTunnelControlPlaneBackupProxyEncrypted ||
        this.#settings.secureTunnelControlPlaneDirectFallback !==
          nextControlPlaneDirectFallback
      ) {
        this.#settings = {
          ...this.#settings,
          secureTunnelId: tunnelId,
          secureTunnelRuntimeKeyEncrypted,
          secureTunnelControlPlaneProxyEncrypted,
          secureTunnelControlPlaneBackupProxyEncrypted,
          secureTunnelControlPlaneDirectFallback:
            nextControlPlaneDirectFallback,
        };
        await this.#persistSettings(this.#settings);
      }
      this.#controlPlaneProxyUrl = nextControlPlaneProxyUrl;
      this.#controlPlaneBackupProxyUrl = nextControlPlaneBackupProxyUrl;
      this.#resetControlPlaneRouting();
      this.#secureTunnel.setAutoReconnect(
        this.#routingEnabled()
          ? false
          : this.#settings.secureTunnelAutoReconnect,
      );
      this.#emit();
      await this.#startConfiguredTunnel(false);
      return this.state();
    });
  }

  setSecureTunnelAutomation(
    input: DesktopSecureTunnelAutomationInput,
  ): Promise<DesktopRuntimeState> {
    const cancelPendingRouteRecovery =
      this.#routingEnabled() &&
      !input.autoReconnect &&
      this.#routeLaunchTimer !== null;
    if (cancelPendingRouteRecovery) {
      this.#routeDesiredRunning = false;
      this.#cancelRouteLaunchTimer();
    }
    return this.#enqueue(async () => {
      if (
        this.#settings.secureTunnelAutoStart !== input.autoStart ||
        this.#settings.secureTunnelAutoReconnect !== input.autoReconnect
      ) {
        this.#settings = {
          ...this.#settings,
          secureTunnelAutoStart: input.autoStart,
          secureTunnelAutoReconnect: input.autoReconnect,
        };
        await this.#persistSettings(this.#settings);
      }
      this.#secureTunnel.setAutoReconnect(
        this.#routingEnabled() ? false : input.autoReconnect,
      );
      if (cancelPendingRouteRecovery) {
        await this.#stopControlPlaneRouting(
          "Automatic control-plane route recovery was disabled.",
        );
      }
      this.#emit();
      await this.#startConfiguredTunnel(false);
      return this.state();
    });
  }

  chooseSecureTunnelExecutable(): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      const tunnelState = this.#secureTunnel.state();
      if (
        this.#routeDesiredRunning ||
        this.#routeLaunchTimer !== null ||
        ["starting", "running", "ready", "stopping"].includes(tunnelState.phase)
      ) {
        throw new Error(
          "Stop Secure MCP Tunnel before changing the connector executable.",
        );
      }
      const selected = await this.#shell.chooseSecureTunnelExecutable();
      if (selected === null) {
        return this.state();
      }
      const executablePath = normalizeSecureTunnelExecutablePath(selected);
      const info = await lstat(executablePath);
      if (!info.isFile()) {
        throw new Error(
          "The selected tunnel-client path is not a regular file.",
        );
      }
      this.#secureTunnel.configure({
        tunnelId: this.#settings.secureTunnelId,
        executablePath,
        trustedExecutableSha256: null,
      });
      this.#settings = {
        ...this.#settings,
        secureTunnelExecutablePath: executablePath,
        secureTunnelExecutableSha256: null,
      };
      await this.#persistSettings(this.#settings);
      this.#emit();
      return this.state();
    });
  }

  startSecureTunnel(): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      await this.#startConfiguredTunnel(true, true);
      return this.state();
    });
  }

  stopSecureTunnel(): Promise<DesktopRuntimeState> {
    if (this.#routingEnabled()) {
      this.#routeDesiredRunning = false;
      this.#cancelRouteLaunchTimer();
    }
    return this.#enqueue(async () => {
      this.#externalApprovalBroker.cancelAll("tunnel-stop");
      if (this.#routingEnabled()) {
        await this.#stopControlPlaneRouting(
          "Operator stopped Secure MCP Tunnel.",
        );
      } else {
        await this.#secureTunnel.stop();
      }
      this.#emit();
      return this.state();
    });
  }

  refreshSecureTunnel(
    options: { readonly networkChanged?: boolean } = {},
  ): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      if (this.#routingEnabled() && this.#routeDesiredRunning &&
          this.#settings.secureTunnelAutoReconnect &&
          (options.networkChanged === true || ["circuit-open", "needs-attention"].includes(this.#controlPlaneRouteState.lifecycle))) {
        const recovery = reduceControlPlaneFailover(this.#controlPlaneRouteState, {
          type: "recover", at: monotonicMilliseconds(),
          networkChanged: options.networkChanged === true,
        }, this.#controlPlaneRoutePolicy);
        if (recovery.effect.kind === "launch") {
          this.#cancelRouteLaunchTimer();
          this.#routeDesiredRunning = true;
          this.#controlPlaneRouteState = recovery.state;
          this.#routeFailureDiagnostic = null;
          this.#routeErrorMessage = null;
          await this.#retireActiveTunnel();
          await this.#launchControlPlaneRoute(recovery.effect, false);
        }
      }
      await this.#secureTunnel.refresh({
        networkChanged: options.networkChanged === true,
      });
      if (this.#routingEnabled()) {
        await this.#evaluateRouteState();
      }
      this.#emit();
      return this.state();
    });
  }

  setPermissionProfile(
    profile: DesktopPermissionProfile,
    workspaceId?: string,
  ): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      if (workspaceId !== undefined) {
        await this.#projectWorkspaces.setPermissionProfile(workspaceId, profile);
        this.#directWorkspaceApprovals.delete(workspaceId);
        this.#emit();
        return this.state();
      }
      const workspaceRoot = this.#settings.workspaceRoot;
      if (profile === "bypass" && workspaceRoot === null) {
        throw new Error(
          "Choose an authorized workspace before enabling L4 Bypass.",
        );
      }
      const permissionBindingMatches =
        workspaceRoot === null
          ? this.#settings.permissionWorkspaceRoot === null
          : sameWorkspaceRoot(
              workspaceRoot,
              this.#settings.permissionWorkspaceRoot,
            );
      const rememberedPermissionProfile: DesktopPermissionLevel =
        profile === "bypass"
          ? this.#permissionProfile === "bypass"
            ? this.#settings.rememberedPermissionProfile
            : this.#permissionProfile
          : profile;
      const settingsAlreadyMatch =
        profile === this.#settings.permissionProfile &&
        rememberedPermissionProfile ===
          this.#settings.rememberedPermissionProfile &&
        permissionBindingMatches &&
        this.#settings.permissionModelVersion ===
          CURRENT_PERMISSION_MODEL_VERSION &&
        (profile !== "bypass" ||
          this.#settings.permissionBypassGrantEncrypted !== null);
      if (profile === this.#permissionProfile && settingsAlreadyMatch) {
        return this.state();
      }

      let permissionBypassGrantEncrypted: string | null = null;
      if (profile === "bypass") {
        if (this.#permissionProfile !== "bypass") {
          const response = await this.#shell.prompt({
            type: "warning",
            title: "Enable and remember L4 Bypass",
            message:
              "Give connected ChatGPT sessions full Sovereign runtime authority for this workspace?",
            detail:
              "L4 Bypass skips Sovereign L2/L3 approval prompts. It can run arbitrary PowerShell, Python, browser and computer-control tools with the current Windows user's rights. Audit receipts, run records, workspace binding and Windows permissions remain enabled. This does not grant administrator elevation. The selection is protected with your Windows account and restored only for this exact authorized workspace until you change it.",
            buttons: ["Enable and remember L4", "Cancel"],
            defaultId: 1,
            cancelId: 1,
          });
          if (response !== 0) {
            return this.state();
          }
        }
        permissionBypassGrantEncrypted =
          await protectPermissionBypassGrant(this.#shell, workspaceRoot as string);
      }

      if (profile !== "consequential") {
        this.#externalApprovalBroker.cancelAll("cancelled");
      }
      this.#settings = {
        ...this.#settings,
        permissionModelVersion: CURRENT_PERMISSION_MODEL_VERSION,
        permissionProfile: profile,
        rememberedPermissionProfile,
        permissionBypassGrantEncrypted,
        permissionWorkspaceRoot: workspaceRoot,
      };
      await this.#persistSettings(this.#settings);
      this.#permissionProfile = profile;
      this.#directWorkspaceApprovals.delete("desktop-workspace");
      this.#runtime?.setExternalPermissionProfile(profile, "desktop-workspace");
      this.#emit();
      return this.state();
    });
  }

  setUnattendedWorkspaceAccess(enabled: boolean, workspaceId?: string): Promise<DesktopRuntimeState> {
    return this.#enqueue(async () => {
      if (workspaceId !== undefined) {
        await this.#projectWorkspaces.setUnattendedWorkspaceAccess(workspaceId, enabled);
        this.#emit();
        return this.state();
      }
      const workspaceRoot = this.#settings.workspaceRoot;
      if (enabled && workspaceRoot === null) {
        throw new Error(
          "Choose an authorized workspace before enabling unattended access.",
        );
      }
      const unattendedWorkspaceRoot = enabled
        ? resolve(workspaceRoot as string)
        : null;
      const settingAlreadyMatches = enabled
        ? sameWorkspaceRoot(
            this.#settings.unattendedWorkspaceRoot,
            unattendedWorkspaceRoot,
          )
        : this.#settings.unattendedWorkspaceRoot === null;
      const permissionBindingMatches =
        workspaceRoot === null
          ? this.#settings.permissionWorkspaceRoot === null
          : sameWorkspaceRoot(
              workspaceRoot,
              this.#settings.permissionWorkspaceRoot,
            );
      if (
        settingAlreadyMatches &&
        permissionBindingMatches &&
        this.#settings.permissionModelVersion ===
          CURRENT_PERMISSION_MODEL_VERSION
      ) {
        return this.state();
      }
      this.#settings = {
        ...this.#settings,
        permissionModelVersion: CURRENT_PERMISSION_MODEL_VERSION,
        unattendedWorkspaceRoot,
        permissionWorkspaceRoot: workspaceRoot,
      };
      await this.#persistSettings(this.#settings);
      this.#emit();
      return this.state();
    });
  }

  manifest(): DesktopManifestView | null {
    const manifest = this.#runtime?.manifest;
    if (manifest === undefined) {
      return null;
    }
    return {
      schemaVersion: manifest.schemaVersion,
      runtimeVersion: manifest.runtimeVersion,
      generatedAt: manifest.generatedAt,
      digest: manifest.digest,
      tools: manifest.tools.map((tool) => ({
        name: tool.name,
        version: tool.version,
        title: tool.title,
        category: tool.category,
        requiredCapabilities: tool.requiredCapabilities,
        sideEffect: tool.sideEffect,
        destructive: tool.destructive,
        permissionLevel: tool.permissionLevel,
        approvalMode: tool.approvalMode,
      })),
    };
  }

  runs(limit: number): readonly DesktopRunSummary[] {
    return this.#runtime?.listRuns(limit) ?? [];
  }

  run(runId: string): DesktopRunRecord {
    const runtime = this.#runtime;
    if (runtime === null) {
      throw new Error("Start the local Gateway before reading run details.");
    }
    return runtime.getRun(runId);
  }

  cancelRun(runId: string): DesktopRunRecord {
    const runtime = this.#runtime;
    if (runtime === null) {
      throw new Error("Start the local Gateway before cancelling a run.");
    }
    return runtime.cancelRun(runId);
  }

  async invokeTool(
    toolName: DesktopDirectToolName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (!isDesktopDirectToolName(toolName)) {
      throw new Error(
        `Desktop tool is not exposed to the renderer: ${toolName}`,
      );
    }
    const runtime = this.#runtime;
    if (runtime === null) {
      throw new Error("Start the local Gateway before using desktop tools.");
    }
    if (!isRecord(input)) {
      throw new Error("Desktop tool input must be an object.");
    }
    const serialized = JSON.stringify(input);
    if (serialized.length > 1_048_576) {
      throw new Error("Desktop tool input exceeds the local size limit.");
    }
    const normalized = JSON.parse(serialized) as Record<string, unknown>;
    delete normalized.workspaceId;
    const workspaceId = runtime.resolveToolWorkspaceId(toolName, normalized);
    const spec = runtime.manifestForWorkspace(workspaceId).tools.find((tool) => tool.name === toolName);
    if (spec === undefined) {
      throw new Error(
        `Desktop tool is unavailable in the active manifest: ${toolName}`,
      );
    }
    const properties = isRecord(spec.inputSchema.properties)
      ? spec.inputSchema.properties
      : null;
    if (properties !== null && "workspaceId" in properties) {
      normalized.workspaceId = workspaceId;
    } else {
      delete normalized.workspaceId;
    }
    const workspace = workspaceId === "desktop-workspace"
      ? { id: workspaceId, root: runtime.workspaces().find((entry) => entry.id === workspaceId)!.root, permissionProfile: this.#permissionProfile }
      : this.#projectWorkspaces.permission(workspaceId);
    if (!(await authorizeDirectWorkspaceTool({ spec, input: normalized, workspace,
      sessionApprovals: this.#directWorkspaceApprovals, shell: this.#shell }))) {
      throw new Error("The local operator denied this desktop tool call.");
    }
    return await runtime.invokeTool(toolName, normalized, workspaceId);
  }

  auditReceipts(limit: number): readonly DesktopAuditReceipt[] {
    const receipts = this.#runtime?.listAuditReceipts(limit) ?? [];
    return receipts.map((receipt) => ({
      id: receipt.id,
      occurredAt: receipt.occurredAt,
      principalId: receipt.principalId,
      toolName: receipt.toolName,
      operation: receipt.operation,
      outcome: receipt.outcome,
      workspaceId: receipt.workspaceId ?? null,
      relativePath: receipt.relativePath ?? null,
      beforeSha256: receipt.beforeSha256 ?? null,
      afterSha256: receipt.afterSha256 ?? null,
      errorCode: receipt.errorCode ?? null,
    }));
  }

  taskWorkspaceSnapshot(offset = 0, limit = 64): DesktopTaskWorkspaceSnapshot {
    return this.#taskRegistry.snapshot(offset, limit);
  }

  taskDetail(taskId: string, messageLimit = 200, beforeSequence?: number): DesktopTaskDetail {
    return this.#taskRegistry.detail(taskId, messageLimit, beforeSequence);
  }

  taskCoordinationInbox(
    taskId: string,
    beforeSequence?: number,
    limit = 50,
  ): TaskCoordinationOperatorInbox {
    return this.#taskRegistry.coordinationInbox(taskId, beforeSequence, limit);
  }

  addTaskUserMessage(taskId: string, content: string): DesktopTaskDetail {
    return this.#taskRegistry.addUserMessage(taskId, content);
  }

  ownedProcesses(): readonly ControlPlaneOwnedProcess[] {
    const tunnelProcessId = this.#secureTunnel.state().processId;
    const runtimeProcesses = this.#runtime?.listOwnedProcesses() ?? [];
    return [
      ...(tunnelProcessId === null
        ? []
        : [
            {
              processId: tunnelProcessId,
              role: "tunnel" as const,
              label: "Secure MCP Tunnel",
            },
          ]),
      ...runtimeProcesses,
    ].filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) => candidate.processId === entry.processId,
        ) === index,
    );
  }

  async shutdown(): Promise<void> {
    if (this.#routingEnabled()) {
      this.#routeDesiredRunning = false;
      this.#cancelRouteLaunchTimer();
    }
    await this.#enqueue(async () => {
      await this.#stopNow();
      await this.#secureTunnel.shutdown();
      this.#taskRegistry.close();
    });
  }

  async #startConfiguredTunnel(
    interactive: boolean,
    force = false,
  ): Promise<void> {
    if (!force && !this.#settings.secureTunnelAutoStart) {
      return;
    }
    const runtime = this.#runtime;
    const bearerToken = this.#bearerToken;
    if (runtime === null || bearerToken === null || this.#phase !== "running") {
      if (interactive) {
        throw new Error(
          "Start the Sovereign Gateway before starting Secure MCP Tunnel.",
        );
      }
      return;
    }

    let tunnelState = this.#secureTunnel.state();
    if (!interactive && ["auth", "identity"].includes(tunnelState.failureDiagnostic?.failureClass ?? "")) return;
    if (!tunnelState.clientAvailable) {
      if (interactive) {
        throw new Error(
          "Choose the official tunnel-client.exe before starting Secure MCP Tunnel.",
        );
      }
      return;
    }
    if (tunnelState.tunnelId === null) {
      if (interactive) {
        throw new Error(
          "Configure a Secure MCP Tunnel ID before starting the tunnel.",
        );
      }
      return;
    }
    if (!tunnelState.hasRuntimeApiKey) {
      if (interactive) {
        throw new Error(
          "Enter a tunnel runtime API key before starting the tunnel.",
        );
      }
      return;
    }

    if (!tunnelState.executableTrusted) {
      if (!interactive) {
        return;
      }
      if (
        tunnelState.executablePath === null ||
        tunnelState.executableSha256 === null
      ) {
        throw new Error(
          "The tunnel-client executable could not be resolved for trust review.",
        );
      }
      const response = await this.#shell.prompt({
        type: "warning",
        title: "Trust tunnel-client executable",
        message:
          "Trust this tunnel-client before giving it the live Gateway credential?",
        detail: `Path:\n${tunnelState.executablePath}\n\nSHA-256:\n${tunnelState.executableSha256}\n\nSovereign will pin this digest. If the executable changes later, the tunnel will refuse to start until you review it again.`,
        buttons: ["Trust and start", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) {
        return;
      }
      const trustedExecutableSha256 =
        this.#secureTunnel.trustCurrentExecutable();
      if (trustedExecutableSha256 === null) {
        throw new Error(
          "The tunnel-client executable disappeared before it could be trusted.",
        );
      }
      this.#settings = {
        ...this.#settings,
        secureTunnelExecutableSha256: trustedExecutableSha256,
      };
      await this.#persistSettings(this.#settings);
      tunnelState = this.#secureTunnel.state();
      if (!tunnelState.executableTrusted) {
        throw new Error("The tunnel-client executable could not be trusted.");
      }
    }

    if (this.#routingEnabled()) {
      await this.#startRoutedTunnel(interactive);
      this.#emit();
      return;
    }

    try {
      await this.#secureTunnel.start({
        gatewayEndpoint: runtime.endpoint,
        gatewayBearerToken: bearerToken,
      });
    } catch (error) {
      this.#emit();
      if (interactive) {
        throw error;
      }
      return;
    }
    this.#emit();
  }

  async #persistSettings(settings: ControlPlaneSettings): Promise<void> {
    if (!this.#settingsLoaded) {
      throw new Error(
        "Runtime settings are unavailable; refusing to overwrite settings.json until they can be read successfully.",
      );
    }
    await writeControlPlaneSettings(this.#settingsPath, settings);
  }

  #emit(): void {
    this.#onStateChanged?.(this.state());
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #authorizeExternalTool(
    request: ExternalToolAuthorizationRequest,
  ): Promise<boolean> {
    if (this.#permissionProfile === "bypass") {
      return true;
    }
    if (this.#permissionProfile !== "consequential") {
      return false;
    }
    const spec = request.spec;
    const decision = await this.#externalApprovalBroker.request({
      toolName: spec.name,
      title: `${permissionLabel(spec)} · ChatGPT Web`,
      message: `Allow connected web agent to run ${spec.name}?`,
      detail: `${spec.description}\n\nThis approval covers exactly this external tool call and expires after 30 seconds.\n\n${boundedJson(request.input)}`,
    });
    if (decision === "drop-to-l1") {
      await this.setPermissionProfile("observe");
      return false;
    }
    return (
      decision === "allow-once" && this.#permissionProfile === "consequential"
    );
  }

  getGatewayTrafficStatus(): GatewayTrafficStatus | null {
    return this.#runtime?.trafficStatus() ?? null;
  }

  quiesceForCutover(): GatewayTrafficStatus | null {
    return this.#runtime?.quiesceTraffic() ?? null;
  }

  async waitForCutoverIdle(
    expectedGeneration: number,
    timeoutMs: number,
  ): Promise<GatewayDrainReport> {
    const runtime = this.#runtime;
    if (runtime === null) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "The Gateway is not running for this Runtime Host.",
        409,
      );
    }
    return await runtime.waitForTrafficIdle(expectedGeneration, timeoutMs);
  }

  resumeGatewayAfterCutover(expectedGeneration: number): GatewayTrafficStatus {
    const runtime = this.#runtime;
    if (runtime === null) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "The Gateway is not running for this Runtime Host.",
        409,
      );
    }
    return runtime.resumeTraffic(expectedGeneration);
  }

  externalRouteDesiredForCutover(): boolean {
    if (this.#cutoverDetachedCheckpointId !== null) {
      return this.#cutoverDetachedRouteDesired;
    }
    return this.#routingEnabled()
      ? this.#routeDesiredRunning
      : this.#secureTunnel.state().desiredRunning;
  }

  async detachExternalTrafficForCutover(checkpointId: string): Promise<void> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u.test(checkpointId)) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Runtime cutover checkpoint ID is invalid.",
        400,
      );
    }
    if (this.#cutoverDetachedCheckpointId !== null) {
      if (this.#cutoverDetachedCheckpointId === checkpointId) {
        return;
      }
      throw new RuntimeError(
        "STALE_HASH",
        "A different Runtime cutover checkpoint already detached external traffic.",
        409,
      );
    }

    const externalRouteDesired = this.externalRouteDesiredForCutover();
    if (this.#routingEnabled()) {
      await this.#stopControlPlaneRouting(
        "Runtime Host traffic is moving to a verified candidate.",
      );
    } else {
      await this.#secureTunnel.stop();
    }
    this.#cutoverDetachedCheckpointId = checkpointId;
    this.#cutoverDetachedRouteDesired = externalRouteDesired;
  }

  async resumeExternalTrafficAfterCutover(
    checkpointId: string,
    externalRouteDesired: boolean,
  ): Promise<void> {
    if (
      this.#cutoverDetachedCheckpointId !== checkpointId ||
      this.#cutoverDetachedRouteDesired !== externalRouteDesired
    ) {
      throw new RuntimeError(
        "STALE_HASH",
        "Runtime cutover route restoration does not match the detached checkpoint.",
        409,
      );
    }

    try {
      if (externalRouteDesired) {
        if (this.#routingEnabled()) {
          await this.#startRoutedTunnel(false);
        } else {
          await this.#startConfiguredTunnel(false, true);
        }
      }
      this.#cutoverDetachedCheckpointId = null;
      this.#cutoverDetachedRouteDesired = false;
    } catch (error) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        `Could not restore external Runtime traffic: ${messageFrom(error)}`,
        503,
      );
    }
  }

  async snapshotForCutover(): Promise<unknown> {
    return {
      schemaVersion: "scr.runtime-cutover-snapshot/v1",
      state: this.state(),
      manifest: this.manifest(),
      tasks: this.taskWorkspaceSnapshot(0, 100),
      gateway: this.getGatewayTrafficStatus(),
      externalRouteDesired: this.externalRouteDesiredForCutover(),
    };
  }

  async promoteCutoverCandidate(
    checkpointId: string,
    externalRouteDesired: boolean,
  ): Promise<void> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u.test(checkpointId)) {
      throw new RuntimeError(
        "INVALID_INPUT",
        "Runtime cutover checkpoint ID is invalid.",
        400,
      );
    }
    if (!this.#passiveCutoverCandidate) {
      if (this.#promotedCutoverCheckpointId === checkpointId) {
        return;
      }
      throw new RuntimeError(
        "POLICY_DENIED",
        "This Runtime Host is not an unpromoted cutover candidate.",
        409,
      );
    }

    this.#passiveCutoverCandidate = false;
    this.#promotedCutoverCheckpointId = checkpointId;
    try {
      const state = this.state();
      if (state.workspaceRoot !== null && state.phase !== "running") {
        await this.#startNow();
      }
      if (externalRouteDesired) {
        if (this.#routingEnabled()) {
          await this.#startRoutedTunnel(false);
        } else {
          await this.#startConfiguredTunnel(false, true);
        }
      }
    } catch (error) {
      this.#passiveCutoverCandidate = true;
      this.#promotedCutoverCheckpointId = null;
      try {
        if (this.#routingEnabled()) {
          await this.#stopControlPlaneRouting(
            "Runtime Host candidate promotion failed.",
          );
        } else {
          await this.#secureTunnel.stop();
        }
      } catch {
        // Preserve the original promotion error; candidate shutdown is the final cleanup.
      }
      throw error;
    }
  }

  async canaryForCutover(): Promise<unknown> {
    const state = this.state();
    const gateway = this.getGatewayTrafficStatus();
    if (state.workspaceRoot !== null && state.phase !== "running") {
      throw new RuntimeError(
        "PROCESS_FAILED",
        `Runtime Host candidate canary observed phase ${state.phase}.`,
        409,
      );
    }
    if (gateway !== null && !gateway.acceptingRequests) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Runtime Host candidate Gateway is not accepting requests.",
        409,
      );
    }
    const externalRouteDesired = this.externalRouteDesiredForCutover();
    const tunnel = this.#secureTunnel.state();
    if (externalRouteDesired && !["running", "ready"].includes(tunnel.phase)) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        `Runtime Host candidate external route is not ready (${tunnel.phase}).`,
        409,
      );
    }
    return {
      schemaVersion: "scr.runtime-cutover-canary-state/v1",
      phase: state.phase,
      workspaceRoot: state.workspaceRoot,
      manifestDigest: state.manifestDigest,
      toolCount: state.toolCount,
      gateway,
      externalRouteDesired,
      externalRoutePhase: tunnel.phase,
      promotedCheckpointId: this.#promotedCutoverCheckpointId,
    };
  }
  async #startNow(): Promise<void> {
    if (this.#runtime !== null) {
      this.#phase = "running";
      this.#errorMessage = null;
      this.#emit();
      return;
    }
    if (this.#settings.workspaceRoot === null) {
      this.#phase = "setup-required";
      this.#errorMessage = null;
      this.#emit();
      return;
    }
    this.#directWorkspaceApprovals.clear();
    this.#phase = "starting";
    this.#errorMessage = null;
    this.#emit();
    const token =
      this.#gatewayBearerToken ?? randomBytes(32).toString("base64url");
    try {
      const runtime = await startGatewayRuntime({
        bearerToken: token,
        workspaceRoot: this.#settings.workspaceRoot,
        host: "127.0.0.1",
        port: 0,
        auditPath: this.#auditPath,
        nativeAgentPath: this.#nativeAgentPath,
        runCompletionNotificationsEnabled:
          this.#runCompletionNotificationsEnabled,
        principalId: "chatgpt-web",
        internalPrincipalId: "desktop-owner",
        capabilities: CAPABILITIES,
        internalCapabilities: CAPABILITIES,
        externalPermissionProfile: this.#permissionProfile,
        authorizeExternalTool: (request) =>
          this.#authorizeExternalTool(request),
        onExternalToolActivity: (event) =>
          this.#handleExternalToolActivity(event),
        normalizeExternalToolInput: (request) => normalizeTaskBoundToolInput(this.#taskRegistry, this.#settings.workspaceRoot, request),
        ...createTaskGatewaySessionCallbacks(this.#taskRegistry),
        onExternalToolRejected: () => this.#signalExternalToolRejection(),
        additionalToolDefinitionsFactory: ({ workspaceId, workspaceRoot }) =>
          createTaskGatewayToolDefinitions(this.#taskRegistry, workspaceRoot, workspaceId),
        additionalToolPackFactories: [
          ({ audit, workspaceId, workspaceRoot }) => {
            const storagePath = join(this.#securityStorageRoot, "security", "workspaces", workspaceId);
            const credentialReferences = new CredentialReferenceStore(
              workspaceId === "desktop-workspace" ? this.#credentialReferencePath : join(storagePath, "credential-refs.json"),
              { storageRoot: this.#securityStorageRoot, workspaceRoot,
                protectReference: (value) => this.#shell.protectSecret(value),
                restoreReference: (encoded) => this.#shell.restoreSecret(encoded) },
            );
            const sandboxes = new SandboxManager({
              workspaceRoot,
              registryPath: workspaceId === "desktop-workspace" ? this.#sandboxRegistryPath : join(storagePath, "sandboxes.json"),
              storageRoot: this.#securityStorageRoot,
              ...(this.#sandboxExecutablePath === undefined ? {} : { executablePath: this.#sandboxExecutablePath }),
              ...(this.#sandboxExpectedVersion === undefined ? {} : { expectedVersion: this.#sandboxExpectedVersion }),
              ...(this.#sandboxExpectedExecutableSha256 === undefined ? {} : { expectedExecutableSha256: this.#sandboxExpectedExecutableSha256 }),
              ...(this.#sandboxRunner === undefined ? {} : { runner: this.#sandboxRunner }),
            });
            return createSecureExecutionToolPack({
              credentialReferences,
              sandboxes,
              audit,
              workspaceId,
            });
          },
        ],
        onToolPacksChanged: () => this.#emit(),
        workspaceId: "desktop-workspace",
        workspaceLabel: "Desktop workspace",
      });
      this.#gatewayBearerToken = token;
      this.#bearerToken = token;
      this.#runtime = runtime;
      this.#credentialGeneration += 1;
      this.#phase = "running";
      this.#errorMessage = await this.#projectWorkspaces.restoreRuntimeSelection(runtime);
    } catch (error) {
      this.#bearerToken = null;
      this.#runtime = null;
      this.#activeToolActivities.clear();
      this.#phase = "error";
      this.#errorMessage = messageFrom(error);
    }
    this.#emit();
  }

  async #stopNow(): Promise<void> {
    this.#externalApprovalBroker.cancelAll("runtime-stop");
    this.#directWorkspaceApprovals.clear();
    this.#activityTaskIds.clear();
    this.#activeActivityCountByTask.clear();
    if (this.#routingEnabled()) {
      await this.#stopControlPlaneRouting("The local Gateway is stopping.");
    } else {
      await this.#secureTunnel.stop();
    }
    if (this.#runtime === null) {
      this.#phase =
        this.#settings.workspaceRoot === null ? "setup-required" : "stopped";
      this.#bearerToken = null;
      this.#activeToolActivities.clear();
      this.#emit();
      return;
    }
    const runtime = this.#runtime;
    this.#phase = "stopping";
    this.#emit();
    try {
      await runtime.stop();
      this.#runtime = null;
      this.#bearerToken = null;
      this.#activeToolActivities.clear();
      this.#phase =
        this.#settings.workspaceRoot === null ? "setup-required" : "stopped";
      this.#errorMessage = null;
    } catch (error) {
      this.#runtime = null;
      this.#bearerToken = null;
      this.#phase = "error";
      this.#errorMessage = messageFrom(error);
    }
    this.#emit();
  }
}
