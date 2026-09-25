export interface RendererActiveRelease {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: "stable" | "beta" | "development";
  readonly manifestSha256: string;
}

export interface RendererStateRecord {
  readonly schemaVersion: "scr.renderer-state/v1";
  readonly storageRevision: number;
  readonly previousStateSha256: string | null;
  readonly highestReleaseSequence: number;
  readonly activeRelease: RendererActiveRelease | null;
  readonly lastKnownGoodRelease: RendererActiveRelease | null;
  readonly lastFailure: string | null;
  readonly updatedAtUnixMs: number;
}

export interface LatestRendererState {
  readonly filePath: string;
  readonly revision: number;
  readonly state: RendererStateRecord;
}

export interface RendererReleaseLease {
  readonly schemaVersion: "scr.renderer-activation-lease/v1";
  readonly leaseId: string;
  readonly status: "held" | "completed" | "failed";
  readonly ownerPrincipal: string;
  readonly originTaskId: string;
  readonly targetReleaseId: string;
  readonly targetReleaseSequence: number;
  readonly sourceCommit: string;
  readonly manifestSha256: string;
  readonly previousActiveReleaseId: string | null;
  readonly previousActiveSequence: number | null;
  readonly shellPid: number | null;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly completedAt?: string;
  readonly result?: unknown;
  readonly policy: Readonly<{
    allowShellRestart: false;
    requireCommittedSnapshot: true;
    requireMonotonicSequence: true;
    requireOriginTask: true;
    quarantineOlderCandidates: boolean;
  }>;
}

export interface RendererQuarantineEntry {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly from: string;
  readonly to: string;
}

export interface AcquireRendererReleaseLeaseOptions {
  readonly stateRoot: string;
  readonly releaseId?: string;
  readonly candidateDirectory?: string;
  readonly originTaskId: string;
  readonly sourceCommit: string;
  readonly ownerPrincipal: string;
  readonly shellPid: number;
  readonly ttlMs?: number;
  readonly now?: string | number | Date;
  readonly quarantineOlderCandidates?: boolean;
}

export interface AcquireRendererReleaseLeaseResult {
  readonly lease: RendererReleaseLease;
  readonly leasePath: string;
  readonly provenancePath: string;
  readonly quarantineRoot: string | null;
  readonly quarantined: readonly RendererQuarantineEntry[];
  readonly stateRevision: number;
}

export interface VerifyRendererReleaseOptions {
  readonly stateRoot: string;
  readonly releaseId: string;
  readonly releaseSequence: number;
}

export interface VerifyRendererReleaseResult {
  readonly latest: LatestRendererState;
  readonly activeRelease: RendererActiveRelease;
}

export interface CompleteRendererReleaseLeaseOptions {
  readonly stateRoot: string;
  readonly leaseId?: string;
  readonly status?: "completed" | "failed";
  readonly shellPid?: number;
  readonly now?: string | number | Date;
  readonly result?: unknown;
}

export function readLatestRendererState(
  stateRoot: string,
): Promise<LatestRendererState>;

export function acquireRendererReleaseLease(
  options: AcquireRendererReleaseLeaseOptions,
): Promise<AcquireRendererReleaseLeaseResult>;

export function verifyRendererRelease(
  options: VerifyRendererReleaseOptions,
): Promise<VerifyRendererReleaseResult>;

export function completeRendererReleaseLease(
  options: CompleteRendererReleaseLeaseOptions,
): Promise<RendererReleaseLease>;
