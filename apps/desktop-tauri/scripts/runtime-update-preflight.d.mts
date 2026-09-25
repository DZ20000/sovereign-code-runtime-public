import type { AuditManagedRuntimeCandidateStateResult } from "./audit-runtime-candidate-state.mjs";
import type {
  AuditManagedRuntimeHostReleaseIndexOptions,
  AuditManagedRuntimeHostReleaseIndexResult,
} from "./stage-runtime-host-release-index.mjs";

export type RuntimeManagedUpdateOperation = "audit" | "install" | "activate";

export interface RuntimeManagedUpdatePreflightOptions extends AuditManagedRuntimeHostReleaseIndexOptions {
  readonly operation?: RuntimeManagedUpdateOperation;
  readonly releaseId?: string | null;
}

export interface RuntimeManagedUpdateReadiness {
  readonly operation: RuntimeManagedUpdateOperation;
  readonly releaseId: string | null;
  readonly ready: true;
}

export interface RuntimeManagedUpdatePreflightResult extends RuntimeManagedUpdateReadiness {
  readonly schemaVersion: "scr.runtime-managed-update-preflight/v1";
  readonly consistent: true;
  readonly releaseIndex: AuditManagedRuntimeHostReleaseIndexResult;
  readonly candidate: AuditManagedRuntimeCandidateStateResult;
}

export function assessRuntimeUpdateReadiness(options: {
  readonly operation: RuntimeManagedUpdateOperation;
  readonly releaseId: string | null;
  readonly releaseIndex: AuditManagedRuntimeHostReleaseIndexResult;
  readonly candidate: AuditManagedRuntimeCandidateStateResult;
}): RuntimeManagedUpdateReadiness;

export function parseRuntimeManagedUpdatePreflightArguments(
  argv: readonly string[],
): Required<RuntimeManagedUpdatePreflightOptions>;

export function runRuntimeManagedUpdatePreflight(
  options: RuntimeManagedUpdatePreflightOptions,
): Promise<RuntimeManagedUpdatePreflightResult>;

export function runRuntimeManagedUpdatePreflightCli(
  argv: readonly string[],
): Promise<RuntimeManagedUpdatePreflightResult>;
