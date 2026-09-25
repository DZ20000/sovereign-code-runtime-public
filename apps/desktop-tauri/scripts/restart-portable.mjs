import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { findInstalledApplications } from "./installed-application.mjs";
import { describeFile } from "./release-metadata.mjs";
import {
  escapePowerShellLiteral,
  launchPortable,
  resolveLatestPortableExecutable,
  runPowerShell,
} from "./portable-launcher.mjs";
import { requestGracefulRestartExit } from "./restart-exit-request.mjs";

const SHELL_NAMES = new Set(["sovereigncoderuntime.exe", "sovereign-desktop-tauri.exe"]);
const GRACEFUL_WAIT_MS = 12_000;

export function listRestartProcesses({ allSessions = false } = {}) {
  return JSON.parse(runPowerShell(String.raw`
$sessionId = (Get-Process -Id $PID).SessionId
$processes = @(Get-CimInstance Win32_Process | Where-Object { ${allSessions ? "$true" : "$_.SessionId -eq $sessionId"} } |
  Select-Object ProcessId, ParentProcessId, SessionId, Name, ExecutablePath,
    @{ Name = 'StartedAt'; Expression = { $_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') } })
[pscustomobject]@{ sessionId = $sessionId; processes = $processes } | ConvertTo-Json -Depth 4 -Compress
`));
}

function sessionProcesses(snapshot) {
  return snapshot.processes.filter((item) => item.SessionId === snapshot.sessionId);
}

function shellsIn(snapshot) {
  return sessionProcesses(snapshot).filter((item) => SHELL_NAMES.has(item.Name.toLowerCase()));
}

export function selectRestartTarget(snapshot, installedApplications, latestPortable = null) {
  const shells = shellsIn(snapshot);
  if (shells.length > 1) {
    throw new Error("Several Sovereign instances are running in this Windows session; close the extra instances before restarting.");
  }
  const shell = shells[0] ?? null;
  if (shell !== null && (!shell.ExecutablePath || !shell.StartedAt)) {
    throw new Error("Cannot identify the running Sovereign executable safely.");
  }
  if (latestPortable !== null) return { ...latestPortable, mode: "latest-portable", shell };
  if (shell !== null) return { executable: shell.ExecutablePath, mode: "running", shell };
  if (installedApplications.length !== 1) {
    throw new Error(installedApplications.length === 0
      ? "No running or installed Sovereign application was found. To switch to a portable build, use pnpm restart:portable."
      : "Several Sovereign installations were found; start the intended installation before restarting.");
  }
  return { ...installedApplications[0], mode: "installed", shell: null };
}

export async function resolveRestartTarget(snapshot, { latestPortable = false } = {}) {
  // Resolve before stopping anything: a missing portable or ambiguous installation must leave SO running.
  const installed = shellsIn(snapshot).length === 0 && !latestPortable ? await findInstalledApplications() : [];
  const portable = latestPortable ? await resolveLatestPortableExecutable() : null;
  return selectRestartTarget(snapshot, installed, portable);
}

function sameProcess(left, right) {
  return left.ProcessId === right.ProcessId && left.SessionId === right.SessionId &&
    left.StartedAt === right.StartedAt && typeof left.ExecutablePath === "string" &&
    left.ExecutablePath.toLowerCase() === right.ExecutablePath?.toLowerCase();
}

export function assertRestartTargetUnchanged(snapshot, target) {
  const shells = shellsIn(snapshot);
  if (target.shell === null ? shells.length !== 0 : shells.length !== 1 || !sameProcess(shells[0], target.shell)) {
    throw new Error("The running Sovereign instance changed while preparing the restart; no shutdown was requested.");
  }
}

export function trackRestartTree(snapshot, known) {
  const current = sessionProcesses(snapshot);
  const selected = new Map(current.filter((item) =>
    known.some((previous) => sameProcess(item, previous))).map((item) => [item.ProcessId, item]));
  let changed;
  do {
    changed = false;
    for (const item of current) {
      const parent = selected.get(item.ParentProcessId);
      if (!selected.has(item.ProcessId) && parent && item.ExecutablePath && item.StartedAt >= parent.StartedAt) {
        selected.set(item.ProcessId, item);
        changed = true;
      }
    }
  } while (changed);
  return [...selected.values()];
}

export function stopRestartTree(processes) {
  // Hold each verified process handle through Kill(). Never kill by name, path, or a recycled PID.
  const output = runPowerShell(String.raw`
$targets = @(ConvertFrom-Json ${escapePowerShellLiteral(JSON.stringify(processes))})
$sessionId = (Get-Process -Id $PID).SessionId
$stopped = @()
foreach ($target in ($targets | Sort-Object @{Expression = { if ($_.Name -ieq 'node.exe') { 0 } else { 1 } } })) {
  $process = $null
  try {
    $process = [Diagnostics.Process]::GetProcessById([int]$target.ProcessId)
    $null = $process.Handle
    if ($target.SessionId -ne $sessionId -or $process.SessionId -ne $sessionId -or
        $process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -ne $target.StartedAt -or
        $process.MainModule.FileName -ine $target.ExecutablePath) { continue }
    $process.Kill()
    $stopped += $target.ProcessId
  } catch [ArgumentException] { continue }
    catch [InvalidOperationException] { continue }
  finally { if ($null -ne $process) { $process.Dispose() } }
}
ConvertTo-Json -InputObject @($stopped) -Compress
`);
  return JSON.parse(output);
}

export async function waitForTreeExit(known, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot;
  do {
    snapshot = listRestartProcesses();
    known = trackRestartTree(snapshot, known);
    if (known.length === 0) break;
    await delay(200);
  } while (Date.now() < deadline);
  return { processes: known, snapshot };
}

async function describeExecutable(executable) {
  const info = await lstat(executable);
  if (info.nlink > 1) throw new Error(`Restart executable is shared by hard links: ${executable}`);
  return describeFile(executable, "executable");
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some((item) => !["--dry-run", "--latest-portable"].includes(item))) {
    throw new Error("Supported restart options: --dry-run, --latest-portable.");
  }
  const before = listRestartProcesses();
  const target = await resolveRestartTarget(before, { latestPortable: argv.includes("--latest-portable") });
  const descriptor = await describeExecutable(target.executable);
  let tree = trackRestartTree(before, target.shell === null ? [] : [target.shell]);
  if (argv.includes("--dry-run")) {
    console.log(JSON.stringify({ dryRun: true, target, processes: tree, executableSha256: descriptor.sha256,
      fallback: "stop only the identified process tree in this Windows session" }, null, 2));
    return;
  }

  const ready = listRestartProcesses();
  assertRestartTargetUnchanged(ready, target);
  tree = trackRestartTree(ready, tree);
  const gracefulRequest = target.shell === null ? null : await requestGracefulRestartExit(target.shell.ExecutablePath, {
    waitForExitMs: GRACEFUL_WAIT_MS,
  });
  if (gracefulRequest?.requested && !gracefulRequest.exited) {
    throw new Error("The restart control process did not exit; no replacement was launched.");
  }
  let remaining = await waitForTreeExit(tree, GRACEFUL_WAIT_MS);
  let forced = [];
  if (remaining.processes.length > 0) {
    forced = stopRestartTree(remaining.processes);
    remaining = await waitForTreeExit(remaining.processes, 8_000);
  }
  if (remaining.processes.length > 0 || shellsIn(remaining.snapshot).length > 0) {
    throw new Error("A Sovereign instance or an identified child is still running; no replacement was launched.");
  }
  const after = await describeExecutable(target.executable);
  if (after.bytes !== descriptor.bytes || after.sha256 !== descriptor.sha256) {
    throw new Error("The restart executable changed during shutdown; no replacement was launched.");
  }
  const processId = launchPortable(target.executable);
  await delay(1_500);
  const started = sessionProcesses(listRestartProcesses()).find((item) =>
    item.ProcessId === processId && item.ExecutablePath?.toLowerCase() === target.executable.toLowerCase());
  if (!started) throw new Error(`The requested Sovereign executable exited during startup: ${processId}`);
  console.log(JSON.stringify({ restarted: true, target, gracefulRequest, forced, processId }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
