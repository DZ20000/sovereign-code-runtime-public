export type RuntimePhase =
  | "setup-required"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type DesktopPermissionLevel = "observe" | "workspace" | "consequential";
export type DesktopPermissionProfile = DesktopPermissionLevel | "bypass";
export type DesktopApprovalMode = "none" | "session" | "single-use";
export type DesktopApprovalDecision = "allow-once" | "deny" | "drop-to-l1";

export interface DesktopApprovalView {
  readonly id: string;
  readonly toolName: string;
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly burstDetected: boolean;
}

export interface SovereignApprovalApi {
  readonly getCurrent: () => Promise<DesktopApprovalView | null>;
  readonly resolve: (requestId: string, decision: DesktopApprovalDecision) => Promise<void>;
}

export type DesktopSecureTunnelPhase =
  | "unavailable"
  | "stopped"
  | "starting"
  | "running"
  | "ready"
  | "stopping"
  | "error";

export type DesktopTunnelFailureClass =
  | "transport"
  | "auth"
  | "identity"
  | "local-mcp"
  | "connector"
  | "unknown";
export type DesktopTunnelFailureSource =
  | "readyz"
  | "connector-log"
  | "spawn"
  | "process"
  | "health-file"
  | "health-probe"
  | "readiness-timeout"
  | "control-plane-poll";
export type DesktopTunnelFailureConfidence = "low" | "medium" | "high";

export interface DesktopTunnelFailureDiagnostic {
  readonly schemaVersion: "scr.tunnel-failure/v1";
  readonly failureClass: DesktopTunnelFailureClass;
  readonly source: DesktopTunnelFailureSource;
  readonly confidence: DesktopTunnelFailureConfidence;
  readonly routeSwitchEligible: boolean;
  readonly evidenceCode: string;
  readonly summary: string;
  readonly detail: string;
  readonly statusCode: number | null;
  readonly observedAt: string;
}

export type DesktopControlPlaneRouteId = "primary" | "backup" | "direct";
export type DesktopControlPlaneRouteStatus =
  | "disabled"
  | "untested"
  | "probing"
  | "ready"
  | "cooling-down"
  | "failed";
export type DesktopControlPlaneRoutingLifecycle =
  | "stopped"
  | "running"
  | "needs-attention"
  | "circuit-open";

export interface DesktopControlPlaneRouteView {
  readonly configured: boolean;
  readonly display: string;
  readonly status: DesktopControlPlaneRouteStatus;
}

export interface DesktopControlPlaneRoutingState {
  readonly schemaVersion: "scr.control-plane-routing/v1";
  readonly enabled: boolean;
  readonly lifecycle: DesktopControlPlaneRoutingLifecycle;
  readonly routeOrder: readonly DesktopControlPlaneRouteId[];
  readonly activeRoute: DesktopControlPlaneRouteId | null;
  readonly activeRouteDisplay: string | null;
  readonly switchCount: number;
  readonly lastSwitchAt: string | null;
  readonly circuitReason: string | null;
  readonly routes: Readonly<Record<DesktopControlPlaneRouteId, DesktopControlPlaneRouteView>>;
}

export interface DesktopSecureTunnelState {
  readonly phase: DesktopSecureTunnelPhase;
  readonly clientAvailable: boolean;
  readonly executablePath: string | null;
  readonly executableSha256: string | null;
  readonly executableTrusted: boolean;
  readonly tunnelId: string | null;
  readonly processId: number | null;
  readonly hasRuntimeApiKey: boolean;
  readonly runtimeApiKeyStorage: "none" | "windows-protected" | "memory-only";
  readonly controlPlaneProxyConfigured: boolean;
  readonly controlPlaneProxyDisplay: string | null;
  readonly controlPlaneProxyStorage: "none" | "windows-protected" | "memory-only";
  readonly controlPlaneBackupProxyConfigured: boolean;
  readonly controlPlaneBackupProxyDisplay: string | null;
  readonly controlPlaneBackupProxyStorage: "none" | "windows-protected" | "memory-only";
  readonly controlPlaneDirectFallbackEnabled: boolean;
  readonly controlPlaneRouting: DesktopControlPlaneRoutingState;
  readonly autoStart: boolean;
  readonly autoReconnect: boolean;
  readonly desiredRunning: boolean;
  readonly reconnectAttempt: number;
  readonly nextReconnectAt: string | null;
  readonly lastReadyAt: string | null;
  readonly healthUrl: string | null;
  readonly errorMessage: string | null;
  readonly failureDiagnostic: DesktopTunnelFailureDiagnostic | null;
  readonly logTail: string;
}

export interface DesktopSecureTunnelConfigurationInput {
  readonly tunnelId: string | null;
  readonly runtimeApiKey?: string;
  readonly clearRuntimeApiKey?: boolean;
  readonly trustedExecutableSha256?: string | null;
  readonly controlPlaneProxyUrl?: string;
  readonly clearControlPlaneProxy?: boolean;
  readonly controlPlaneBackupProxyUrl?: string;
  readonly clearControlPlaneBackupProxy?: boolean;
  readonly controlPlaneDirectFallbackEnabled?: boolean;
}

export interface DesktopSecureTunnelAutomationInput {
  readonly autoStart: boolean;
  readonly autoReconnect: boolean;
}

export type DesktopHostGuardianOutcome = "restarted" | "restart-failed" | "circuit-open";

export interface DesktopHostGuardianIncident {
  readonly occurredAt: string;
  readonly outcome: DesktopHostGuardianOutcome;
  readonly reason: string;
  readonly restartCountInWindow: number | null;
}

export interface DesktopHostGuardianState {
  readonly available: boolean;
  readonly processId: number | null;
  readonly closeToTray: boolean;
  readonly circuitOpen: boolean;
  readonly lastIncident: DesktopHostGuardianIncident | null;
}

export type DesktopHostPowerSource = "ac" | "battery" | "unknown";
export type DesktopHostNetworkState =
  | "not-configured"
  | "offline"
  | "connecting"
  | "retrying"
  | "ready"
  | "degraded";
export type DesktopHostAvailabilityEventKind =
  | "possible-suspend-or-stall"
  | "power-source-changed"
  | "network-loss"
  | "network-recovered";

export interface DesktopHostAvailabilityEvent {
  readonly occurredAt: string;
  readonly kind: DesktopHostAvailabilityEventKind;
  readonly detail: string;
  readonly durationMs: number | null;
}

export interface DesktopHostAvailabilityState {
  readonly schemaVersion: "scr.host-availability/v1";
  readonly available: boolean;
  readonly monitorStartedAt: string;
  readonly sampledAt: string | null;
  readonly monitorIntervalMs: number;
  readonly possibleSuspendGapThresholdMs: number;
  readonly eventStorage: "persistent" | "memory-only";
  readonly systemUptimeMs: number | null;
  readonly powerSource: DesktopHostPowerSource;
  readonly batteryPercent: number | null;
  readonly batterySaver: boolean | null;
  readonly possibleSuspendCount: number;
  readonly lastPossibleSuspendAt: string | null;
  readonly lastPossibleSuspendDurationMs: number | null;
  readonly networkState: DesktopHostNetworkState;
  readonly networkDesired: boolean;
  readonly lastNetworkCheckAt: string | null;
  readonly lastNetworkReadyAt: string | null;
  readonly lastNetworkLossAt: string | null;
  readonly lastNetworkRecoveryAt: string | null;
  readonly lastNetworkOutageDurationMs: number | null;
  readonly reconnectAttempt: number;
  readonly nextReconnectAt: string | null;
  readonly detail: string | null;
  readonly recentEvents: readonly DesktopHostAvailabilityEvent[];
}

export interface DesktopHostStartupState {
  readonly schemaVersion: "scr.host-startup/v1";
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly executablePath: string;
  readonly launchKind: "portable" | "installed" | "development" | "legacy-electron" | "unknown";
  readonly registeredCommand: string | null;
  readonly warning: string | null;
  readonly guardian: DesktopHostGuardianState;
  readonly availability: DesktopHostAvailabilityState;
}

export interface DesktopToolSummary {
  readonly name: string;
  readonly version: string;
  readonly title: string;
  readonly category: string;
  readonly requiredCapabilities: readonly string[];
  readonly sideEffect: string;
  readonly destructive: boolean;
  readonly permissionLevel: DesktopPermissionLevel;
  readonly approvalMode: DesktopApprovalMode;
}

export interface DesktopManifestView {
  readonly schemaVersion: string;
  readonly runtimeVersion: string;
  readonly generatedAt: string;
  readonly digest: string;
  readonly tools: readonly DesktopToolSummary[];
}

export interface DesktopAuditReceipt {
  readonly id: string;
  readonly occurredAt: string;
  readonly principalId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly outcome: string;
  readonly workspaceId: string | null;
  readonly relativePath: string | null;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly errorCode: string | null;
}

export type DesktopResourceProcessRole =
  | "desktop-main"
  | "renderer"
  | "gpu"
  | "utility"
  | "runtime-host"
  | "tunnel"
  | "managed-run"
  | "terminal"
  | "browser"
  | "other-owned";

export interface DesktopResourceProcess {
  readonly processId: number;
  readonly role: DesktopResourceProcessRole;
  readonly label: string;
  readonly workingSetBytes: number;
  readonly privateBytes: number | null;
  readonly cpuPercent: number | null;
}

export interface DesktopResourceTotals {
  readonly shellWorkingSetBytes: number;
  readonly shellPrivateBytes: number;
  readonly runtimeWorkingSetBytes: number;
  readonly runtimePrivateBytes: number;
  readonly serviceWorkingSetBytes: number;
  readonly servicePrivateBytes: number;
  readonly productWorkingSetBytes: number;
  readonly productPrivateBytes: number;
  readonly processCount: number;
}

export interface DesktopResourceSnapshot {
  readonly schemaVersion: "scr.resources/v1";
  readonly capturedAt: string;
  readonly uptimeMs: number;
  readonly runtimePlacement: "embedded-main" | "sidecar";
  readonly shellExecutablePath: string;
  readonly shellLaunchKind: "portable" | "installed" | "development" | "legacy-electron" | "unknown";
  readonly processes: readonly DesktopResourceProcess[];
  readonly totals: DesktopResourceTotals;
}

export type DesktopRunKind = "validation" | "terminal" | "python" | "workflow";
export type DesktopRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "interrupted";

export interface DesktopRunBase {
  readonly schemaVersion: "scr.run/v1";
  readonly id: string;
  readonly kind: DesktopRunKind;
  readonly label: string;
  readonly workspaceId: string;
  readonly state: DesktopRunState;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly outputTruncated: boolean;
  readonly cancelRequested: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DesktopRunSummary extends DesktopRunBase {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export interface DesktopRunRecord extends DesktopRunBase {
  readonly stdout: string;
  readonly stderr: string;
}

export interface DesktopActiveToolActivity {
  readonly id: string;
  readonly toolName: string;
  readonly title: string;
  readonly category: string;
  readonly workspaceId: string | null;
  readonly startedAt: string;
}

export interface DesktopProjectWorkspace {
  readonly id: string;
  readonly root: string;
  readonly permissionProfile: DesktopPermissionProfile;
  readonly rememberedPermissionProfile: DesktopPermissionLevel;
  readonly unattendedWorkspaceAccess: boolean;
}

export interface DesktopProjectWorkspaces {
  readonly projectId: string;
  readonly selectedWorkspaceId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly workspaces: readonly DesktopProjectWorkspace[];
}

export interface DesktopRuntimeState {
  readonly phase: RuntimePhase;
  readonly runtimeVersion: string;
  readonly runtimeBuildSource?: { readonly commit: string; readonly dirty: boolean } | null;
  readonly workspaceRoot: string | null;
  readonly activeDesktopWorkspace?: (DesktopProjectWorkspace & { readonly projectId: string }) | null;
  readonly endpoint: string | null;
  readonly manifestDigest: string | null;
  readonly toolCount: number;
  readonly sessionCount: number;
  readonly capabilities: readonly string[];
  readonly tokenStorage: "main-process-memory";
  readonly credentialGeneration: number;
  readonly autoStart: boolean;
  readonly unattendedWorkspaceAccess: boolean;
  readonly permissionProfile: DesktopPermissionProfile;
  readonly rememberedPermissionProfile: DesktopPermissionLevel;
  readonly activeToolActivities: readonly DesktopActiveToolActivity[];
  readonly webBridgeUrl: string | null;
  readonly secureTunnel: DesktopSecureTunnelState;
  readonly errorMessage: string | null;
}
