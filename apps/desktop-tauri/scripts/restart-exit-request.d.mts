export interface GracefulRestartExitRequest {
  readonly executable: string;
  readonly requested: boolean;
  readonly processId: number | null;
  readonly error: string | null;
  readonly exited?: boolean;
}

export function requestGracefulRestartExit(
  executable: string,
  options?: {
    readonly argument?: string;
    readonly argumentsPrefix?: readonly string[];
    readonly environment?: NodeJS.ProcessEnv;
    readonly spawnTimeoutMs?: number;
    readonly waitForExitMs?: number;
  },
): Promise<GracefulRestartExitRequest>;
