import type {
  GitSourceMetadata,
  ProductMetadata,
  ReleaseFileDescription,
} from "./release-metadata.mjs";

export const INSTALLER_PACKAGE_SCHEMA_VERSION: "scr.installer-package/v1";

export interface InstallerPackageManifest {
  readonly schemaVersion: typeof INSTALLER_PACKAGE_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly product: ProductMetadata;
  readonly source: GitSourceMetadata;
  readonly installer: ReleaseFileDescription;
  readonly installedExecutable: ReleaseFileDescription;
}

export interface InstallerPackageVerification {
  readonly passed: boolean;
  readonly manifest: InstallerPackageManifest;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly packageRoot: string;
  readonly installerPath: string;
  readonly installerCheck: {
    readonly path: string;
    readonly expectedBytes: number;
    readonly actualBytes: number;
    readonly expectedSha256: string;
    readonly actualSha256: string;
    readonly matched: boolean;
  };
  readonly problems: readonly string[];
}

export function assertSafeInstallerRelativePath(value: string, label?: string): string;
export function parseInstallerPackage(value: unknown): InstallerPackageManifest;
export function sha256InstallerFile(path: string): Promise<string>;
export function verifyInstallerPackage(manifestPath: string): Promise<InstallerPackageVerification>;
export function buildRecoveryExecutableOrder(
  installedExecutable: string,
  previousShellExecutables?: readonly string[],
): readonly string[];
export function verifyInstalledExecutable(
  installedExecutable: string,
  descriptor: ReleaseFileDescription,
): Promise<{
  readonly path: string;
  readonly exists: boolean;
  readonly matched: boolean;
  readonly expectedBytes: number;
  readonly actualBytes: number | null;
  readonly expectedSha256: string;
  readonly actualSha256: string | null;
}>;
