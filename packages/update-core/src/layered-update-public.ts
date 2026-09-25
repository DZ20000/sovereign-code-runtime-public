import type {
  LayeredUpdateHealth,
  LayeredUpdateRecentCutover,
  LayeredUpdateRecoverySummary,
  LayeredUpdateStatus,
} from "./layered-update-status.js";

export const PUBLIC_LAYERED_UPDATE_STATUS_SCHEMA_VERSION =
  "scr.public-layered-update-status/v1" as const;

export interface PublicRuntimeRouteTarget {
  readonly instanceId: string;
  readonly releaseId: string;
}

export interface PublicRuntimeRouteStatus {
  readonly generation: number;
  readonly operation: string;
  readonly active: PublicRuntimeRouteTarget;
  readonly previous: PublicRuntimeRouteTarget | null;
}

export interface PublicRendererUpdateStatus {
  readonly generation: number;
  readonly activeReleaseId: string;
  readonly previousReleaseId: string | null;
  readonly activeManifestSha256: string;
}

export interface PublicLayeredUpdateStatus {
  readonly schemaVersion: typeof PUBLIC_LAYERED_UPDATE_STATUS_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly health: LayeredUpdateHealth;
  readonly ledgerHeadSequence: number;
  readonly ledgerHeadSha256: string | null;
  readonly runtimeRoute: PublicRuntimeRouteStatus | null;
  readonly renderer: PublicRendererUpdateStatus | null;
  readonly recoveries: readonly LayeredUpdateRecoverySummary[];
  readonly recentCutovers: readonly LayeredUpdateRecentCutover[];
}

export function publicLayeredUpdateStatus(
  status: LayeredUpdateStatus,
): PublicLayeredUpdateStatus {
  return {
    schemaVersion: PUBLIC_LAYERED_UPDATE_STATUS_SCHEMA_VERSION,
    generatedAt: status.generatedAt,
    health: status.health,
    ledgerHeadSequence: status.ledgerHeadSequence,
    ledgerHeadSha256: status.ledgerHeadSha256,
    runtimeRoute:
      status.runtimeRoute === null
        ? null
        : {
            generation: status.runtimeRoute.generation,
            operation: status.runtimeRoute.operation,
            active: {
              instanceId: status.runtimeRoute.active.instanceId,
              releaseId: status.runtimeRoute.active.releaseId,
            },
            previous:
              status.runtimeRoute.previous === null
                ? null
                : {
                    instanceId: status.runtimeRoute.previous.instanceId,
                    releaseId: status.runtimeRoute.previous.releaseId,
                  },
          },
    renderer:
      status.renderer === null
        ? null
        : {
            generation: status.renderer.generation,
            activeReleaseId: status.renderer.activeReleaseId,
            previousReleaseId: status.renderer.previousReleaseId,
            activeManifestSha256: status.renderer.activeManifestSha256,
          },
    recoveries: status.recoveries.map((recovery) => ({
      ...recovery,
      evidence: [...recovery.evidence],
    })),
    recentCutovers: status.recentCutovers.map((cutover) => ({
      ...cutover,
      cleanupFailures: [...cutover.cleanupFailures],
    })),
  };
}
