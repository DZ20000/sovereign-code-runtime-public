export const DESKTOP_LAYERED_UPDATE_STATUS_SCHEMA_VERSION =
  "scr.public-layered-update-status/v1" as const;

export type DesktopLayeredUpdateHealth =
  "uninitialized" | "ready" | "recovery-required" | "manual-intervention";

export type DesktopCutoverKind = "runtime" | "renderer";

export type DesktopCutoverRecoveryAction =
  | "none"
  | "stop-candidate"
  | "resume-active-and-stop-candidate"
  | "rollback-traffic-resume-active-stop-candidate"
  | "finish-commit-cleanup"
  | "rollback-renderer"
  | "finish-renderer-rollback"
  | "verify-terminal-state"
  | "manual-intervention";

export interface DesktopLayeredRuntimeTarget {
  readonly instanceId: string;
  readonly releaseId: string;
}

export interface DesktopLayeredRuntimeRouteStatus {
  readonly generation: number;
  readonly operation: string;
  readonly active: DesktopLayeredRuntimeTarget;
  readonly previous: DesktopLayeredRuntimeTarget | null;
}

export interface DesktopLayeredRendererStatus {
  readonly generation: number;
  readonly activeReleaseId: string;
  readonly previousReleaseId: string | null;
  readonly activeManifestSha256: string;
}

export interface DesktopLayeredUpdateRecoverySummary {
  readonly cutoverId: string;
  readonly kind: DesktopCutoverKind;
  readonly action: DesktopCutoverRecoveryAction;
  readonly safeToAutomate: boolean;
  readonly reason: string;
  readonly authoritativeReleaseId: string | null;
  readonly rollbackReleaseId: string | null;
  readonly authorityGeneration: number | null;
  readonly evidence: readonly string[];
}

export interface DesktopLayeredUpdateRecentCutover {
  readonly cutoverId: string;
  readonly kind: DesktopCutoverKind;
  readonly outcome: "committed" | "rolled-back" | "failed";
  readonly activeReleaseId: string;
  readonly candidateReleaseId: string;
  readonly failureReason: string | null;
  readonly cleanupFailures: readonly string[];
  readonly completedSequence: number;
  readonly completedAt: number;
}

export interface DesktopLayeredUpdateStatus {
  readonly schemaVersion: typeof DESKTOP_LAYERED_UPDATE_STATUS_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly health: DesktopLayeredUpdateHealth;
  readonly ledgerHeadSequence: number;
  readonly ledgerHeadSha256: string | null;
  readonly runtimeRoute: DesktopLayeredRuntimeRouteStatus | null;
  readonly renderer: DesktopLayeredRendererStatus | null;
  readonly recoveries: readonly DesktopLayeredUpdateRecoverySummary[];
  readonly recentCutovers: readonly DesktopLayeredUpdateRecentCutover[];
}

export interface DesktopLayeredUpdateRecoveryReceipt {
  readonly recoveryId: string;
  readonly cutoverId: string;
  readonly kind: DesktopCutoverKind;
  readonly action: DesktopCutoverRecoveryAction;
  readonly outcome: "committed" | "rolled-back";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly authorityGeneration: number | null;
  readonly authoritativeReleaseId: string;
  readonly candidateReleaseId: string;
}

export interface DesktopLayeredUpdateRecoveryBatchReceipt {
  readonly attempted: number;
  readonly completed: readonly DesktopLayeredUpdateRecoveryReceipt[];
  readonly finalStatus: DesktopLayeredUpdateStatus;
}

export interface SovereignLayeredUpdateApi {
  readonly getLayeredUpdateStatus: () => Promise<DesktopLayeredUpdateStatus>;
  readonly recoverLayeredUpdate: (
    cutoverId: string,
  ) => Promise<DesktopLayeredUpdateRecoveryReceipt>;
  readonly recoverAllSafeLayeredUpdates: () => Promise<DesktopLayeredUpdateRecoveryBatchReceipt>;
}
