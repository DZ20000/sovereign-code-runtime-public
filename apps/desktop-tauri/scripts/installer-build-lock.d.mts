export interface InstallerBuildLock {
  readonly path: string;
  readonly token: string;
  readonly record: {
    readonly schemaVersion: "scr.installer-build-lock/v1";
    readonly token: string;
    readonly processId: number;
    readonly startedAt: string;
    readonly cwd: string;
  };
  readonly recoveredLock: InstallerBuildLock["record"] | null;
}

export function acquireInstallerBuildLock(
  lockPath: string,
  options?: {
    readonly processId?: number;
    readonly now?: number;
    readonly cwd?: string;
  },
): Promise<InstallerBuildLock>;

export function releaseInstallerBuildLock(
  lock: InstallerBuildLock | null | undefined,
): Promise<void>;
