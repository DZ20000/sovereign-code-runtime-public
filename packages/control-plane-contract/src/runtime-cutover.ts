export const DESKTOP_RUNTIME_CUTOVER_STATUS_SCHEMA_VERSION =
  "scr.runtime-cutover-status/v1" as const;
export const DESKTOP_RUNTIME_CUTOVER_DRAIN_SCHEMA_VERSION =
  "scr.runtime-cutover-drain/v1" as const;
export const DESKTOP_RUNTIME_CUTOVER_CHECKPOINT_SCHEMA_VERSION =
  "scr.runtime-cutover-checkpoint/v1" as const;
export const DESKTOP_RUNTIME_CUTOVER_CANARY_SCHEMA_VERSION =
  "scr.runtime-cutover-canary/v1" as const;

export type DesktopRuntimeCutoverRole = "active" | "candidate";

export interface DesktopRuntimeTrafficStatus {
  readonly generation: number;
  readonly acceptingRequests: boolean;
  readonly activeRequestCount: number;
  readonly sessionCount: number;
  readonly pendingSessionInitializations: number;
}

export interface DesktopRuntimeCutoverStatus {
  readonly schemaVersion: typeof DESKTOP_RUNTIME_CUTOVER_STATUS_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly releaseId: string;
  readonly role: DesktopRuntimeCutoverRole;
  readonly promoted: boolean;
  readonly promotedCheckpointId: string | null;
  readonly controlQuiesced: boolean;
  readonly controlGeneration: number;
  readonly activeControlRequestCount: number;
  readonly gateway: DesktopRuntimeTrafficStatus | null;
  readonly checkpointId: string | null;
  readonly externalRouteDesired: boolean;
  readonly trafficDetached: boolean;
  readonly startedAtUnixMs: number;
}

export interface DesktopRuntimeCutoverDrainReport {
  readonly schemaVersion: typeof DESKTOP_RUNTIME_CUTOVER_DRAIN_SCHEMA_VERSION;
  readonly controlGeneration: number;
  readonly gatewayGeneration: number | null;
  readonly drained: boolean;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly waitedMs: number;
  readonly activeControlRequestCount: number;
  readonly activeGatewayRequestCount: number;
  readonly unknownOutcomeCount: number;
}

export interface DesktopRuntimeCutoverCheckpoint {
  readonly schemaVersion: typeof DESKTOP_RUNTIME_CUTOVER_CHECKPOINT_SCHEMA_VERSION;
  readonly checkpointId: string;
  readonly fencingToken: string;
  readonly instanceId: string;
  readonly releaseId: string;
  readonly controlGeneration: number;
  readonly gatewayGeneration: number | null;
  readonly stateSha256: string;
  readonly externalRouteDesired: boolean;
  readonly createdAtUnixMs: number;
}

export interface DesktopRuntimeCutoverCanary {
  readonly schemaVersion: typeof DESKTOP_RUNTIME_CUTOVER_CANARY_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly releaseId: string;
  readonly promoted: boolean;
  readonly promotedCheckpointId: string | null;
  readonly externalRouteDesired: boolean;
  readonly stateSha256: string;
  readonly checkedAtUnixMs: number;
}

export interface DesktopRuntimeCutoverDrainInput {
  readonly controlGeneration: number;
  readonly gatewayGeneration: number | null;
  readonly timeoutMs: number;
}

export interface DesktopRuntimeCutoverCheckpointInput {
  readonly controlGeneration: number;
  readonly gatewayGeneration: number | null;
  readonly fencingToken: string;
}

export interface DesktopRuntimeCutoverDetachInput {
  readonly controlGeneration: number;
  readonly gatewayGeneration: number | null;
  readonly checkpointId: string;
  readonly fencingToken: string;
}

export interface DesktopRuntimeCutoverResumeInput {
  readonly controlGeneration: number;
  readonly gatewayGeneration: number | null;
}

export interface DesktopRuntimeCutoverPromoteInput {
  readonly checkpointId: string;
  readonly fencingToken: string;
  readonly externalRouteDesired: boolean;
}
