export const MAX_SCHEDULED_TASK_COMMAND_LENGTH: 261;

export interface InstallerWorkerLauncher {
  readonly root: string;
  readonly runnerPath: string;
  readonly command: string;
  readonly workerArguments: readonly string[];
}

export function buildScheduledTaskCommand(nodePath: string, runnerPath: string): string;
export function createInstallerWorkerLauncher(options: {
  readonly localAppData: string;
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly manifestPath: string;
  readonly taskName: string;
  readonly logPath: string;
}): Promise<InstallerWorkerLauncher>;
export function cleanupInstallerWorkerLauncher(
  launcher: Pick<InstallerWorkerLauncher, "root"> | null | undefined,
): Promise<void>;
