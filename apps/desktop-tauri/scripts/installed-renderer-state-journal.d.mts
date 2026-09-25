export interface VerifiedRendererReleaseReference {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: "stable" | "beta" | "development";
  readonly manifestSha256: string;
}

export interface RendererStateJournalEntry {
  readonly fileName: string;
  readonly content: Uint8Array;
}

export interface VerifiedRendererStateJournal {
  readonly latestState: {
    readonly schemaVersion: "scr.renderer-state/v1";
    readonly storageRevision: number;
    readonly previousStateSha256: string | null;
    readonly highestReleaseSequence: number;
    readonly activeRelease: VerifiedRendererReleaseReference | null;
    readonly lastKnownGoodRelease: VerifiedRendererReleaseReference | null;
    readonly lastFailure: string | null;
    readonly updatedAtUnixMs: number;
  };
  readonly latestFileName: string;
  readonly latestSha256: string;
  readonly revisionCount: number;
  readonly journalBytes: number;
}

export const RENDERER_STATE_SCHEMA_VERSION: "scr.renderer-state/v1";
export const MAX_RENDERER_STATE_REVISIONS: number;
export const MAX_RENDERER_STATE_BYTES: number;
export const MAX_RENDERER_STATE_JOURNAL_BYTES: number;

export function rendererStateRevisionName(revision: number): string;
export function verifyRendererReleaseReference(
  value: unknown,
  label?: string,
): VerifiedRendererReleaseReference | null;
export function verifyRendererStateJournal(
  entries: readonly RendererStateJournalEntry[],
): VerifiedRendererStateJournal;
