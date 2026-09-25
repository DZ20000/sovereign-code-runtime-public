export interface GitSourceMetadata {
  readonly commit: string;
  readonly shortCommit: string;
  readonly branch: string | null;
  readonly committedAt: string;
  readonly dirty: boolean;
  readonly changeCount: number;
}

export interface ProductMetadata {
  readonly name: string;
  readonly version: string;
  readonly identifier: string;
  readonly platform: string;
  readonly architecture: string;
}

export interface ReleaseFileDescription {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PortableComponentCheck {
  readonly path: string;
  readonly expectedBytes?: number;
  readonly actualBytes?: number;
  readonly expectedSha256?: string;
  readonly actualSha256?: string;
  readonly matched: boolean;
  readonly error?: string;
}

export interface PortablePackageVerification {
  readonly passed: boolean;
  readonly portableRoot: string;
  readonly manifestPath: string;
  readonly manifestSha256: string | null;
  readonly sourceCommit: string | null;
  readonly sourceDirty: boolean | null;
  readonly productVersion: string | null;
  readonly totalBytes: number;
  readonly componentChecks: readonly PortableComponentCheck[];
  readonly problems: readonly string[];
}

export function sha256File(path: string): Promise<string>;
export function describeFile(
  path: string,
  relativePath: string,
): Promise<ReleaseFileDescription>;
export function parseGitStatus(source: string): {
  readonly dirty: boolean;
  readonly changeCount: number;
};
export function readGitSource(workspaceRoot: string): Promise<GitSourceMetadata>;
export function readProductMetadata(
  workspaceRoot: string,
  projectRoot: string,
): Promise<ProductMetadata>;
export function assertPortableRelativePath(value: string): string;
export function verifyPortablePackage(
  portableRoot: string,
  manifestValue?: unknown,
): Promise<PortablePackageVerification>;
export function writeJsonAtomic(path: string, value: unknown): Promise<void>;
