export const RUNTIME_CANDIDATE_UPDATE_STATUS_SCHEMA_VERSION =
  "scr.runtime-candidate-update-status/v1" as const;
export const RUNTIME_CANDIDATE_INSTALL_RECEIPT_SCHEMA_VERSION =
  "scr.runtime-candidate-install-receipt/v1" as const;
export const RUNTIME_CANDIDATE_ACTIVATION_RECEIPT_SCHEMA_VERSION =
  "scr.runtime-candidate-activation-receipt/v1" as const;

export interface RuntimeCandidateUpdateStatus {
  readonly schemaVersion: typeof RUNTIME_CANDIDATE_UPDATE_STATUS_SCHEMA_VERSION;
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly trustedKeyCount: number;
  readonly highestReleaseSequence: number;
  readonly activeReleaseId: string | null;
  readonly installedReleaseIds: readonly string[];
  readonly inboxReleaseIds: readonly string[];
  readonly lastFailure: string | null;
}

export interface RuntimeCandidateInstallReceipt {
  readonly schemaVersion: typeof RUNTIME_CANDIDATE_INSTALL_RECEIPT_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly runtimeHostBytes: number;
  readonly installedAtUnixMs: number;
  readonly idempotent: boolean;
}

export interface RuntimeCandidateActivationReceipt {
  readonly schemaVersion: typeof RUNTIME_CANDIDATE_ACTIVATION_RECEIPT_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly outcome: "activated";
  readonly activatedAtUnixMs: number;
}
