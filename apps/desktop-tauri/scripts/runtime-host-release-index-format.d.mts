import type { KeyObject } from "node:crypto";

export interface TrustedReleaseKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly minimum: number;
  readonly maximum: number | null;
}

export interface DirectDirectory {
  readonly path: string;
  readonly canonical: string;
}

export interface ReleaseIndexEntry {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly packagePath: string;
  readonly envelopeSha256: string;
  readonly runtimeHostSha256: string;
}

export interface VerifiedReleaseIndex {
  readonly path: string;
  readonly canonical: string;
  readonly rawBytes: Buffer;
  readonly envelopeSha256: string;
  readonly keyId: string;
  readonly indexSha256: string;
  readonly indexSequence: number;
  readonly generatedAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly releases: readonly ReleaseIndexEntry[];
}

export interface VerifiedRuntimeCandidatePackage {
  readonly packageRoot: string;
  readonly canonicalPackageRoot: string;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly signingKeyId: string;
  readonly manifestSha256: string;
  readonly envelopeSha256: string;
  readonly runtimeHostSha256: string;
  readonly runtimeHostBytes: number;
}

export const RELEASE_INDEX_ENVELOPE_SCHEMA_VERSION: string;
export const RELEASE_INDEX_SCHEMA_VERSION: string;
export const RELEASE_INDEX_SIGNATURE_PAYLOAD_SCHEMA_VERSION: string;
export const RELEASE_INDEX_TRUST_SCHEMA_VERSION: string;
export const RUNTIME_TRUST_SCHEMA_VERSION: string;
export const RUNTIME_ENVELOPE_SCHEMA_VERSION: string;
export const RUNTIME_MANIFEST_SCHEMA_VERSION: string;
export const RUNTIME_SIGNATURE_PAYLOAD_SCHEMA_VERSION: string;

export function canonicalJson(value: unknown): string;
export function sha256(value: string | NodeJS.ArrayBufferView): string;
export function fail(message: unknown): never;
export function isVolumeRoot(candidate: string): boolean;
export function isContained(root: string, candidate: string): boolean;
export function portableRelativePath(
  value: unknown,
  label: string,
  options?: { readonly extension?: string | null },
): string;
export function directDirectory(
  candidate: string,
  label: string,
  options?: {
    readonly shallow?: boolean;
    readonly requireCanonicalPath?: boolean;
  },
): Promise<DirectDirectory>;
export function directFile(
  candidate: string,
  label: string,
  maximumBytes: number,
): Promise<{
  readonly path: string;
  readonly canonical: string;
  readonly bytes: Buffer;
}>;
export function containedPath(
  root: DirectDirectory,
  relativePath: string,
  label: string,
  kind: "file" | "directory",
  maximumBytes?: number | null,
): Promise<{
  readonly path: string;
  readonly canonical: string;
  readonly portable: string;
  readonly bytes?: Buffer;
}>;
export function readCanonicalJsonFile(
  candidate: string,
  label: string,
  maximumBytes: number,
): Promise<{
  readonly path: string;
  readonly canonical: string;
  readonly bytes: Buffer;
  readonly document: unknown;
  readonly text: string;
}>;
export function loadReleaseIndexTrustedKeys(
  path: string,
  forbiddenRoot?: DirectDirectory | null,
): Promise<ReadonlyMap<string, TrustedReleaseKey>>;
export function loadRuntimeCandidateTrustedKeys(
  path: string,
  forbiddenRoot?: DirectDirectory | null,
): Promise<ReadonlyMap<string, TrustedReleaseKey>>;
export function verifyRuntimeHostReleaseIndex(options: {
  readonly indexPath: string;
  readonly trustedKeys: ReadonlyMap<string, TrustedReleaseKey>;
  readonly nowUnixMs?: number;
}): Promise<VerifiedReleaseIndex>;
export function verifyRuntimeCandidatePackage(options: {
  readonly packageRoot: string;
  readonly trustedKeys: ReadonlyMap<string, TrustedReleaseKey>;
  readonly shellVersion: string;
  readonly runtimeProtocolVersion: number;
  readonly expected?: ReleaseIndexEntry | null;
  readonly requireDirectoryName?: boolean;
}): Promise<VerifiedRuntimeCandidatePackage>;
