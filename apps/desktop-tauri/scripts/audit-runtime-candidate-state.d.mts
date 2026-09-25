export interface AuditManagedRuntimeCandidateStateOptions {
  readonly managedRoot: string;
  readonly runtimeTrustedKeysPath: string;
  readonly shellVersion: string;
  readonly runtimeProtocolVersion: number;
}

export interface AuditManagedRuntimeCandidateStateResult {
  readonly schemaVersion: "scr.runtime-candidate-managed-audit/v1";
  readonly consistent: true;
  readonly highestReleaseSequence: number;
  readonly activeReleaseId: string | null;
  readonly installedReleaseIds: readonly string[];
  readonly inboxReleaseIds: readonly string[];
  readonly stateBackupPresent: boolean;
}

export function auditManagedRuntimeCandidateState(
  options: AuditManagedRuntimeCandidateStateOptions,
): Promise<AuditManagedRuntimeCandidateStateResult>;

export function runAuditRuntimeCandidateStateCli(
  argv: readonly string[],
): Promise<AuditManagedRuntimeCandidateStateResult>;
