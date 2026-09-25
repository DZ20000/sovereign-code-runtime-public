export interface PreservedFileSnapshot {
  readonly path: string;
  readonly backupPath: string;
  readonly existed: boolean;
  readonly bytes: number | null;
  readonly sha256: string | null;
}

export interface PreservedFileCheck extends PreservedFileSnapshot {
  readonly actualExists: boolean;
  readonly actualBytes: number | null;
  readonly actualSha256: string | null;
  readonly matched: boolean;
}

export function buildPreservedRuntimeDataPaths(userDataRoot: string): readonly string[];
export function capturePreservedFiles(
  paths: readonly string[],
  backupRoot: string,
): Promise<readonly PreservedFileSnapshot[]>;
export function verifyPreservedFiles(
  snapshots: readonly PreservedFileSnapshot[],
): Promise<readonly PreservedFileCheck[]>;
export function preservedFilesMatched(checks: readonly PreservedFileCheck[]): boolean;
export function readVerifiedPreservedFile(
  snapshot: PreservedFileSnapshot,
): Promise<Buffer | null>;
export function restorePreservedFiles(
  snapshots: readonly PreservedFileSnapshot[],
): Promise<readonly PreservedFileCheck[]>;
