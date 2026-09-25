export interface InstalledRendererRelease {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: string | null;
  readonly manifestSha256: string;
}

export interface InstalledRendererSlotAudit {
  readonly verified: boolean;
  readonly readyRelease: InstalledRendererRelease | null;
  readonly readyMarkerVerified: boolean;
  readonly readyInstalledAtUnixMs: number | null;
  readonly envelopeRelease: InstalledRendererRelease | null;
  readonly entrypoint: string | null;
  readonly entrypointMatched: boolean;
  readonly trustedKeysPath: string;
  readonly signingKeyId: string | null;
  readonly signatureVerified: boolean;
  readonly inventoryVerified: boolean;
  readonly componentCount: number;
  readonly verifiedComponentCount: number;
}

export interface InstalledRendererStateAudit {
  readonly available: boolean;
  readonly consistent: boolean;
  readonly stateFile?: string;
  readonly stateSha256?: string | null;
  readonly stateJournalVerified?: boolean;
  readonly stateRevisionCount?: number;
  readonly stateJournalBytes?: number;
  readonly storageRevision?: number | null;
  readonly updatedAtUnixMs?: number | null;
  readonly activeRelease?: InstalledRendererRelease | null;
  readonly readyRelease?: InstalledRendererRelease | null;
  readonly readyMarkerVerified?: boolean;
  readonly readyInstalledAtUnixMs?: number | null;
  readonly envelopeRelease?: InstalledRendererRelease | null;
  readonly highestReleaseSequence?: number | null;
  readonly pendingActivation?: unknown;
  readonly lastFailure?: string | null;
  readonly lastKnownGoodRelease?: InstalledRendererRelease | null;
  readonly lastKnownGoodSlot?: InstalledRendererSlotAudit | null;
  readonly entrypoint?: string | null;
  readonly entrypointMatched?: boolean;
  readonly trustedKeysPath?: string;
  readonly signingKeyId?: string | null;
  readonly signatureVerified?: boolean;
  readonly inventoryVerified?: boolean;
  readonly componentCount?: number;
  readonly verifiedComponentCount?: number;
  readonly problems: readonly string[];
}

export function readInstalledRendererState(options: {
  readonly appDataPath: string;
  readonly identifier: string;
  readonly trustedKeysPath: string;
}): Promise<InstalledRendererStateAudit>;
