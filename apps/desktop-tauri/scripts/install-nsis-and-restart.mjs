import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sha256InstallerFile,
  verifyInstalledExecutable,
  verifyInstallerPackage,
} from "./installer-package.mjs";
import {
  buildPreservedRuntimeDataPaths,
  capturePreservedFiles,
  preservedFilesMatched,
  readVerifiedPreservedFile,
  restorePreservedFiles,
  verifyPreservedFiles,
} from "./installer-preservation.mjs";
import { assertInstalledExecutableReplaceable } from "./installer-replaceability.mjs";
import {
  cleanupInstallerWorkerLauncher,
  createInstallerWorkerLauncher,
} from "./installer-worker-launcher.mjs";
import {
  escapePowerShellLiteral,
  runPowerShell,
} from "./portable-launcher.mjs";
import { installerProcessSnapshot, stopInstalledApplication } from "./installer-processes.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = resolve(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  "installer-package.json",
);
const STARTUP_WAIT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

function parseArguments(argv) {
  const result = {
    dryRun: false,
    worker: false,
    manifestPath: defaultManifestPath,
    taskName: null,
    logPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      result.dryRun = true;
    } else if (value === "--worker") {
      result.worker = true;
    } else if (value === "--manifest" || value === "--task-name" || value === "--log") {
      const next = argv[index + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new Error(`${value} requires a value.`);
      }
      index += 1;
      if (value === "--manifest") result.manifestPath = resolve(next);
      if (value === "--task-name") result.taskName = next;
      if (value === "--log") result.logPath = resolve(next);
    } else {
      throw new Error(`Unknown installer cutover argument: ${value}`);
    }
  }
  return result;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function launchDetached(executable, args = []) {
  const child = spawn(executable, args, {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
    shell: false,
  });
  if (child.pid === undefined) {
    throw new Error(`Could not launch Sovereign executable: ${executable}`);
  }
  child.unref();
  return child.pid;
}

function processAtPathIsRunning(executable) {
  const escaped = escapePowerShellLiteral(resolve(executable));
  return runPowerShell(String.raw`
$target = [IO.Path]::GetFullPath(${escaped})
$match = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -in @('SovereignCodeRuntime.exe', 'sovereign-desktop-tauri.exe') -and
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
    [IO.Path]::GetFullPath($_.ExecutablePath).Equals($target, [StringComparison]::OrdinalIgnoreCase)
  } |
  Select-Object -First 1
[Console]::Out.Write([bool]($null -ne $match))
`).trim().toLocaleLowerCase("en-US") === "true";
}

async function waitForRunningExecutable(executable, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processAtPathIsRunning(executable)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return processAtPathIsRunning(executable);
}

function sameExecutablePath(left, right) {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return process.platform === "win32"
    ? leftPath.toLocaleLowerCase("en-US") === rightPath.toLocaleLowerCase("en-US")
    : leftPath === rightPath;
}

async function lstatExecutableIfPresent(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
      throw new Error(`Recovery executable must be one unshared direct regular file: ${path}`);
    }
    return info;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function captureRecoveryExecutable(path) {
  const executable = resolve(path);
  const before = await lstatExecutableIfPresent(executable);
  if (before === null) {
    throw new Error(`Running recovery executable is missing: ${executable}`);
  }
  const sha256 = await sha256InstallerFile(executable);
  const after = await lstatExecutableIfPresent(executable);
  if (
    after === null ||
    (before.dev !== 0 && before.ino !== 0 && after.dev !== 0 && after.ino !== 0 &&
      (before.dev !== after.dev || before.ino !== after.ino)) ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`Recovery executable changed while it was being verified: ${executable}`);
  }
  return { path: executable, bytes: before.size, sha256 };
}

async function verifyRecoveryExecutable(descriptor) {
  const before = await lstatExecutableIfPresent(descriptor.path);
  if (before === null || before.size !== descriptor.bytes) return false;
  const sha256 = await sha256InstallerFile(descriptor.path);
  const after = await lstatExecutableIfPresent(descriptor.path);
  return after !== null &&
    (before.dev === 0 || before.ino === 0 || after.dev === 0 || after.ino === 0 ||
      (before.dev === after.dev && before.ino === after.ino)) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    sha256 === descriptor.sha256;
}

async function firstVerifiedPreviousRecoveryExecutable(
  descriptors,
  installedExecutable,
  { allowInstalledExecutablePath = false } = {},
) {
  for (const descriptor of descriptors) {
    if (
      !allowInstalledExecutablePath &&
      sameExecutablePath(descriptor.path, installedExecutable)
    ) {
      continue;
    }
    if (await verifyRecoveryExecutable(descriptor)) return descriptor.path;
  }
  return null;
}

async function stageVerifiedInstaller(verification, localAppData) {
  const stagingParent = resolve(
    localAppData,
    "Sovereign Code Runtime",
    "install-staging",
  );
  await mkdir(stagingParent, { recursive: true });
  const stagingRoot = resolve(
    stagingParent,
    `install-${Date.now()}-${randomUUID()}`,
  );
  await mkdir(stagingRoot);
  const installerPath = resolve(stagingRoot, "SovereignCodeRuntime-setup.exe");
  try {
    await copyFile(verification.installerPath, installerPath);
    const info = await lstatExecutableIfPresent(installerPath);
    const check = await verifyInstalledExecutable(
      installerPath,
      verification.manifest.installer,
    );
    if (info === null || !check.matched) {
      throw new Error(
        `Staged installer does not match its immutable manifest. Expected ${verification.manifest.installer.sha256}, got ${String(check.actualSha256)}.`,
      );
    }
    return { root: stagingRoot, path: installerPath, check };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function cleanupInstallerStaging(stagedInstaller, logPath) {
  if (stagedInstaller === null) return;
  try {
    await rm(stagedInstaller.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch (error) {
    await appendLogLine(
      logPath,
      `installer staging cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runInstaller(installerPath) {
  const result = spawnSync(installerPath, ["/S", "/UPDATE"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `NSIS installer exited with code ${String(result.status)}.`,
    );
  }
  return result.status;
}

function updateLoginStartup(installedExecutable, enabled) {
  const escapedExecutable = escapePowerShellLiteral(installedExecutable);
  runPowerShell(String.raw`
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = 'Sovereign Code Runtime'
if (${enabled ? "$true" : "$false"}) {
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -LiteralPath $key -Name $name -Value ('"' + ${escapedExecutable} + '" --autostart') -Type String
} else {
  Remove-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue
}
`);
}

function deleteScheduledTask(taskName) {
  if (taskName === null) return;
  const executable = resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");
  spawnSync(executable, ["/Delete", "/TN", taskName, "/F"], {
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  });
}

async function appendLogLine(logPath, message) {
  if (logPath === null) return;
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

async function scheduleWorker(options, verification) {
  const taskName = `Sovereign-OneShot-Install-${Date.now()}`;
  const localAppData = process.env.LOCALAPPDATA ?? projectRoot;
  const logPath = options.logPath ?? resolve(
    localAppData,
    "Sovereign Code Runtime",
    "install-logs",
    `${taskName}.log`,
  );
  const launcher = await createInstallerWorkerLauncher({
    localAppData,
    nodePath: process.execPath,
    scriptPath: fileURLToPath(import.meta.url),
    manifestPath: verification.manifestPath,
    taskName,
    logPath,
  });
  const executable = resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");
  const start = new Date(Date.now() + 5 * 60_000);
  const startTime = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
  spawnSync(executable, ["/Delete", "/TN", taskName, "/F"], {
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  });
  const created = spawnSync(executable, [
    "/Create",
    "/TN", taskName,
    "/SC", "ONCE",
    "/ST", startTime,
    "/TR", launcher.command,
    "/RL", "LIMITED",
    "/IT",
    "/F",
  ], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: 512 * 1024,
  });
  if (created.error !== undefined) {
    await cleanupInstallerWorkerLauncher(launcher).catch(() => undefined);
    throw created.error;
  }
  if (created.status !== 0) {
    await cleanupInstallerWorkerLauncher(launcher).catch(() => undefined);
    throw new Error(created.stderr?.trim() || created.stdout?.trim() || "Could not create installer task.");
  }
  const started = spawnSync(executable, ["/Run", "/TN", taskName], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: 512 * 1024,
  });
  if (started.error !== undefined) {
    deleteScheduledTask(taskName);
    await cleanupInstallerWorkerLauncher(launcher).catch(() => undefined);
    throw started.error;
  }
  if (started.status !== 0) {
    deleteScheduledTask(taskName);
    await cleanupInstallerWorkerLauncher(launcher).catch(() => undefined);
    throw new Error(started.stderr?.trim() || started.stdout?.trim() || "Could not start installer task.");
  }
  return {
    taskName,
    logPath,
    command: launcher.command,
    launcherPath: launcher.runnerPath,
  };
}

async function workerCutover(options, verification) {
  deleteScheduledTask(options.taskName);
  const manifest = verification.manifest;
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  if (typeof localAppData !== "string" || localAppData.length === 0) {
    throw new Error("LOCALAPPDATA is unavailable.");
  }
  if (typeof appData !== "string" || appData.length === 0) {
    throw new Error("APPDATA is unavailable.");
  }
  const installRoot = resolve(localAppData, "Programs", manifest.product.name);
  const installedExecutable = resolve(
    installRoot,
    ...manifest.installedExecutable.path.split("/"),
  );
  const userDataRoot = resolve(appData, manifest.product.identifier);
  const settingsPath = resolve(userDataRoot, "settings.json");
  const preservationRoot = resolve(
    appData,
    `${manifest.product.identifier}.install-backups`,
    `install-${Date.now()}`,
  );
  const preservedPaths = buildPreservedRuntimeDataPaths(userDataRoot);
  const initialProcesses = installerProcessSnapshot(installedExecutable);
  const previousShellExecutables = initialProcesses.target.shell === null ? [] : [installedExecutable];
  const previousRecoveryExecutables = [];
  for (const executable of previousShellExecutables) {
    previousRecoveryExecutables.push(await captureRecoveryExecutable(executable));
  }

  let stagedInstaller = null;
  let preservedSnapshots = null;
  let settingsBytes = null;
  let shutdownStarted = false;
  let launched = false;
  let recovery = null;
  let preservationRecoveryError = null;
  let installerMutationStarted = false;
  try {
    stagedInstaller = await stageVerifiedInstaller(verification, localAppData);
    await appendLogLine(
      options.logPath,
      `staged immutable installer ${stagedInstaller.path} with SHA-256 ${stagedInstaller.check.actualSha256}`,
    );
    shutdownStarted = initialProcesses.target.shell !== null;
    const stopped = await stopInstalledApplication(installedExecutable, initialProcesses);
    await appendLogLine(options.logPath, `guarded shutdown: ${JSON.stringify(stopped)}`);

    preservedSnapshots = await capturePreservedFiles(preservedPaths, preservationRoot);
    const preInstallChecks = await verifyPreservedFiles(preservedSnapshots);
    if (!preservedFilesMatched(preInstallChecks)) {
      throw new Error("User-data files changed while the verified install backup was being captured.");
    }
    const settingsSnapshot = preservedSnapshots.find((entry) => entry.path === settingsPath);
    if (settingsSnapshot === undefined) {
      throw new Error("Settings preservation snapshot is missing.");
    }
    settingsBytes = await readVerifiedPreservedFile(settingsSnapshot);
    await appendLogLine(options.logPath, `verified immutable installer manifest ${verification.manifestSha256}`);
    await appendLogLine(options.logPath, `installer source ${manifest.source.commit}, dirty=${String(manifest.source.dirty)}`);
    await appendLogLine(
      options.logPath,
      `preserved ${preservedSnapshots.length} settings/database paths under ${preservationRoot}`,
    );

    const stagedInstallerCheck = await verifyInstalledExecutable(
      stagedInstaller.path,
      manifest.installer,
    );
    if (!stagedInstallerCheck.matched) {
      throw new Error("Staged installer changed before execution.");
    }
    if (installerProcessSnapshot(installedExecutable).target.shell !== null) {
      throw new Error("The installed application restarted before installation; leave it running and retry later.");
    }
    const replaceabilityCheck = assertInstalledExecutableReplaceable(installedExecutable);
    await appendLogLine(
      options.logPath,
      `installed executable replaceability gate: ${JSON.stringify(replaceabilityCheck)}`,
    );
    await appendLogLine(options.logPath, `running staged immutable installer ${stagedInstaller.path}`);
    installerMutationStarted = true;
    runInstaller(stagedInstaller.path);
    const installedCheck = await verifyInstalledExecutable(
      installedExecutable,
      manifest.installedExecutable,
    );
    await appendLogLine(options.logPath, `installed executable check: ${JSON.stringify(installedCheck)}`);
    if (!installedCheck.matched) {
      throw new Error(
        `Installed executable does not match the installer-time manifest. Expected ${manifest.installedExecutable.sha256}, got ${String(installedCheck.actualSha256)}.`,
      );
    }

    const postInstallChecks = await verifyPreservedFiles(preservedSnapshots);
    if (!preservedFilesMatched(postInstallChecks)) {
      await restorePreservedFiles(preservedSnapshots);
      await appendLogLine(options.logPath, "restored settings and SQLite data after unexpected installer mutation");
      throw new Error("Settings or persistent SQLite data changed during installation.");
    }

    let autoStart = false;
    if (settingsBytes !== null) {
      const settings = JSON.parse(settingsBytes.toString("utf8"));
      autoStart = settings?.autoStart === true;
    }
    updateLoginStartup(installedExecutable, autoStart);

    const processId = launchDetached(installedExecutable);
    launched = await waitForRunningExecutable(installedExecutable, STARTUP_WAIT_MS);
    if (!launched) {
      throw new Error(`Installed Sovereign process exited during startup: ${processId}`);
    }
    await appendLogLine(options.logPath, `installed Sovereign launched successfully as PID ${processId}`);
    await cleanupInstallerStaging(stagedInstaller, options.logPath);
    stagedInstaller = null;
    let preservationBackupCleaned = false;
    try {
      await rm(preservationRoot, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150,
      });
      preservationBackupCleaned = await lstat(preservationRoot).then(
        () => false,
        (error) => error?.code === "ENOENT",
      );
      await appendLogLine(
        options.logPath,
        preservationBackupCleaned
          ? "removed verified preservation backup after successful relaunch"
          : `preservation backup remains after cleanup attempt: ${preservationRoot}`,
      );
    } catch (cleanupError) {
      await appendLogLine(
        options.logPath,
        `preservation backup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    return {
      installed: true,
      recovered: false,
      manifestPath: verification.manifestPath,
      manifestSha256: verification.manifestSha256,
      sourceCommit: manifest.source.commit,
      installedExecutable,
      userDataPreserved: true,
      preservedFileCount: preservedSnapshots.length,
      preservationBackupCleaned,
      preservationRoot: preservationBackupCleaned ? null : preservationRoot,
      processId,
      logPath: options.logPath,
    };
  } catch (error) {
    await appendLogLine(
      options.logPath,
      `cutover failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
    if (preservedSnapshots !== null) {
      try {
        const checks = await verifyPreservedFiles(preservedSnapshots);
        if (!preservedFilesMatched(checks)) {
          await restorePreservedFiles(preservedSnapshots);
          await appendLogLine(options.logPath, "restored preserved settings and SQLite data during failure recovery");
        }
      } catch (preservationError) {
        preservationRecoveryError = preservationError instanceof Error
          ? preservationError.message
          : String(preservationError);
        await appendLogLine(
          options.logPath,
          `preserved user-data recovery failed: ${preservationRecoveryError}`,
        );
      }
    }
    if (shutdownStarted && !launched && preservationRecoveryError === null) {
      let recoveryExecutable = null;
      try {
        const installedRecoveryCheck = await verifyInstalledExecutable(
          installedExecutable,
          manifest.installedExecutable,
        );
        await appendLogLine(
          options.logPath,
          `recovery installed-executable check: ${JSON.stringify(installedRecoveryCheck)}`,
        );
        recoveryExecutable = installedRecoveryCheck.matched
          ? installedExecutable
          : await firstVerifiedPreviousRecoveryExecutable(
              previousRecoveryExecutables,
              installedExecutable,
              { allowInstalledExecutablePath: !installerMutationStarted },
            );
      } catch (recoveryVerificationError) {
        await appendLogLine(
          options.logPath,
          `recovery executable verification failed: ${recoveryVerificationError instanceof Error ? recoveryVerificationError.message : String(recoveryVerificationError)}`,
        );
      }
      if (recoveryExecutable !== null) {
        try {
          const processId = launchDetached(recoveryExecutable);
          const running = await waitForRunningExecutable(recoveryExecutable, STARTUP_WAIT_MS);
          recovery = { executable: recoveryExecutable, processId, running };
          await appendLogLine(options.logPath, `recovery launch: ${JSON.stringify(recovery)}`);
        } catch (recoveryError) {
          recovery = {
            executable: recoveryExecutable,
            running: false,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          };
          await appendLogLine(options.logPath, `recovery launch failed: ${JSON.stringify(recovery)}`);
        }
      }
    }
    await cleanupInstallerStaging(stagedInstaller, options.logPath);
    stagedInstaller = null;
    const message = error instanceof Error ? error.message : String(error);
    const preservationSuffix = preservationRecoveryError === null
      ? ""
      : ` Preserved user-data recovery also failed: ${preservationRecoveryError}`;
    throw new Error(
      recovery?.running === true
        ? `${message}${preservationSuffix} Sovereign was relaunched from ${recovery.executable}.`
        : `${message}${preservationSuffix} Automatic Sovereign recovery did not complete.`,
      { cause: error },
    );
  }
}

const options = parseArguments(process.argv.slice(2));
if (process.platform !== "win32") {
  throw new Error("NSIS installation cutover is Windows-only.");
}
const verification = await verifyInstallerPackage(options.manifestPath);
if (!verification.passed) {
  throw new Error(
    `Installer package failed immutable verification: ${verification.problems.join("; ")}`,
  );
}
if (verification.manifest.source.dirty) {
  throw new Error("Refusing to install a package produced from a dirty Git worktree.");
}
const installedExecutable = resolve(
  process.env.LOCALAPPDATA ?? projectRoot,
  "Programs",
  verification.manifest.product.name,
  ...verification.manifest.installedExecutable.path.split("/"),
);
const expectedUserDataRoot = resolve(
  process.env.APPDATA ?? projectRoot,
  verification.manifest.product.identifier,
);
const preservedUserDataPaths = buildPreservedRuntimeDataPaths(expectedUserDataRoot);

if (options.dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    manifestPath: verification.manifestPath,
    manifestSha256: verification.manifestSha256,
    installerPath: verification.installerPath,
    installerSha256: verification.manifest.installer.sha256,
    expectedInstalledExecutable: installedExecutable,
    expectedInstalledSha256: verification.manifest.installedExecutable.sha256,
    sourceCommit: verification.manifest.source.commit,
    sourceDirty: verification.manifest.source.dirty,
    currentProcesses: installerProcessSnapshot(installedExecutable).processes,
    preservedUserDataPaths,
    preservationPolicy: "stage and re-verify the installer before shutdown; after shutdown, capture and verify settings plus task, audit and run SQLite databases with WAL/SHM/journal sidecars; restore on mutation before recovery",
    recoveryPolicy: "restore preserved user data; before NSIS mutation a hash-verified previous shell may recover from the installed path; after mutation recover only from a manifest-verified installed executable or a hash-verified previous shell from a different path",
  }, null, 2));
} else if (!options.worker) {
  const scheduled = await scheduleWorker(options, verification);
  console.log(JSON.stringify({
    scheduled: true,
    ...scheduled,
    manifestPath: verification.manifestPath,
    manifestSha256: verification.manifestSha256,
    installerPath: verification.installerPath,
    expectedInstalledExecutable: installedExecutable,
  }, null, 2));
} else {
  const result = await workerCutover(options, verification);
  console.log(JSON.stringify(result, null, 2));
}
