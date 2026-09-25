export interface RuntimeCandidateCreateOptions {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly runtimeHostPath: string;
  readonly privateKeyPath: string;
  readonly keyId: string;
  readonly outputPath: string;
  readonly minimumShellVersion: string;
  readonly runtimeProtocolVersion: number;
  readonly createdAtUnixMs?: number;
}

export interface RuntimeCandidateCreateResult {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly outputPath: string;
  readonly runtimeHostBytes: number;
  readonly manifestSha256: string;
}

export function createRuntimeCandidate(
  options: RuntimeCandidateCreateOptions,
): Promise<RuntimeCandidateCreateResult>;
