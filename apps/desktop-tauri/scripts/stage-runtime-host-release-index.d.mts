export interface StageRuntimeHostReleaseIndexOptions {
  readonly sourceRoot: string;
  readonly indexPath: string;
  readonly indexTrustedKeysPath: string;
  readonly runtimeTrustedKeysPath: string;
  readonly managedRoot: string;
  readonly shellVersion: string;
  readonly runtimeProtocolVersion: number;
  readonly nowUnixMs?: number;
}

export interface StageRuntimeHostReleaseIndexResult {
  readonly schemaVersion: "scr.runtime-host-release-index-import-receipt/v1";
  readonly receiptId: string;
  readonly indexSequence: number;
  readonly indexSha256: string;
  readonly idempotent: boolean;
  readonly importedReleaseIds: readonly string[];
  readonly retainedReleaseIds: readonly string[];
}

export interface AuditManagedRuntimeHostReleaseIndexOptions {
  readonly managedRoot: string;
  readonly runtimeTrustedKeysPath: string;
  readonly shellVersion: string;
  readonly runtimeProtocolVersion: number;
}

export interface AuditManagedRuntimeHostReleaseIndexResult {
  readonly schemaVersion: "scr.runtime-host-release-index-managed-audit/v1";
  readonly consistent: true;
  readonly receiptCount: number;
  readonly latestIndexSequence: number | null;
  readonly highestReleaseSequence: number;
  readonly releaseIds: readonly string[];
}

export function auditManagedRuntimeHostReleaseIndex(
  options: AuditManagedRuntimeHostReleaseIndexOptions,
): Promise<AuditManagedRuntimeHostReleaseIndexResult>;

export function stageRuntimeHostReleaseIndex(
  options: StageRuntimeHostReleaseIndexOptions,
): Promise<StageRuntimeHostReleaseIndexResult>;

export function parseStageRuntimeHostReleaseIndexArguments(
  argv: readonly string[],
): StageRuntimeHostReleaseIndexOptions;

export function runStageRuntimeHostReleaseIndexCli(
  argv: readonly string[],
): Promise<StageRuntimeHostReleaseIndexResult>;
