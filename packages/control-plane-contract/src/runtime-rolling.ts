export const DESKTOP_RUNTIME_ROLLING_STATUS_SCHEMA_VERSION =
  "scr.runtime-rolling-service-status/v1" as const;

export interface DesktopRuntimeEndpointIdentity {
  readonly instanceId: string;
  readonly releaseId: string;
}

export interface DesktopRuntimeRouterSnapshot {
  readonly generation: number;
  readonly active: DesktopRuntimeEndpointIdentity;
  readonly fencingTokenSha256: string | null;
}

export interface DesktopRuntimeRollingStatus {
  readonly schemaVersion: typeof DESKTOP_RUNTIME_ROLLING_STATUS_SCHEMA_VERSION;
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly active: DesktopRuntimeRouterSnapshot;
  readonly disabledReason: string | null;
}
