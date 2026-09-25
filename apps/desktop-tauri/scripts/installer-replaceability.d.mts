export interface InstalledExecutableReplaceabilityResult {
  path: string;
  existed: boolean;
  replaceable: true;
}

export type InstallerReplaceabilityPowerShellRunner = (
  script: string,
  timeoutMs?: number,
) => string;

export declare function assertInstalledExecutableReplaceable(
  path: string,
  runPowerShellImpl?: InstallerReplaceabilityPowerShellRunner,
): InstalledExecutableReplaceabilityResult;
