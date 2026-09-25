/**
 * Registers the shell watchdog with Task Scheduler.
 *
 * The Host Guardian shares the shell's job object, so a job or tree kill ends
 * both and nothing is left to restart the shell. Task Scheduler runs outside
 * that job, which is the whole point of putting the watchdog there.
 *
 *   node scripts/install-watchdog-task.mjs [--dry-run] [--remove]
 *
 * The task runs as the current user with no elevation. A GUI-subsystem launcher
 * starts portable Node with CreateNoWindow and forwards its output to a log.
 * The portable Node runtime executes the watchdog script that ships beside
 * the installed shell. It passes no shell arguments of its own: the watchdog
 * decides whether to launch, and launches with --autostart only.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const TASK_NAME = "SovereignShellWatchdog";
const REPEAT_MINUTES = 5;
const ACTION_HELPER = fileURLToPath(new URL("./no-console-task-action.ps1", import.meta.url));
const LAUNCHER_SOURCE = fileURLToPath(new URL("./no-console-task-launcher.cs", import.meta.url));
const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

function systemTool(name) {
  return join(SYSTEM32, name);
}

function installedRoot() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set; cannot locate the installed build.");
  }
  return resolve(localAppData, "Programs", "Sovereign Code Runtime");
}

function userDataRoot() {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("APPDATA is not set; cannot locate the guardian state directory.");
  }
  return resolve(appData, "com.sovereign.runtime");
}

async function requireFile(path, label) {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function runPowerShell(script) {
  const result = spawnSync(
    systemTool("WindowsPowerShell\\v1.0\\powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Task Scheduler command failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function quoteForPowerShell(value) {
  return `'${value.replace(/'/gu, "''")}'`;
}

const remove = process.argv.includes("--remove");
const dryRun = process.argv.includes("--dry-run");

if (remove) {
  const script = `Unregister-ScheduledTask -TaskName ${quoteForPowerShell(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue; 'removed'`;
  if (dryRun) {
    console.log(JSON.stringify({ wouldRemove: TASK_NAME, dryRun: true }, null, 2));
  } else {
    runPowerShell(script);
    console.log(JSON.stringify({ removed: TASK_NAME }, null, 2));
  }
} else {
  const root = installedRoot();
  const nodeExecutable = join(root, "node", "node.exe");
  const watchdogScript = join(root, "shell-watchdog.mjs");
  const shellExecutable = join(root, "sovereign-desktop-tauri.exe");
  const guardianState = join(userDataRoot(), "guardian");
  const reportPath = join(userDataRoot(), "guardian", "last-watchdog.json");

  await requireFile(nodeExecutable, "Portable Node runtime");
  await requireFile(watchdogScript, "Shell watchdog script");
  await requireFile(shellExecutable, "Installed Sovereign shell");
  await requireFile(ACTION_HELPER, "No-console task action helper");
  await requireFile(LAUNCHER_SOURCE, "No-console launcher source");
  const launcherRoot = resolve(process.env.LOCALAPPDATA, "Sovereign Code Runtime", "background-tasks");
  const launcherHash = createHash("sha256").update(await readFile(LAUNCHER_SOURCE)).digest("hex").slice(0, 16);
  const launcherExecutable = join(launcherRoot, `NoConsoleTaskLauncher-${launcherHash}.exe`);
  const launcherLog = join(guardianState, "watchdog-launcher.log");

  const argumentLine = [
    `"${watchdogScript}"`,
    "--shell",
    `"${shellExecutable}"`,
    "--guardian-state",
    `"${guardianState}"`,
    "--report",
    `"${reportPath}"`,
  ].join(" ");

  const plan = {
    taskName: TASK_NAME,
    execute: launcherExecutable,
    targetExecutable: nodeExecutable,
    targetArgument: argumentLine,
    launchMode: "WindowsApplication + CreateNoWindow",
    launcherLog,
    repeatMinutes: REPEAT_MINUTES,
    triggers: ["at logon (current user)", `every ${REPEAT_MINUTES} minutes`],
    runLevel: "limited (no elevation)",
  };

  if (dryRun) {
    console.log(JSON.stringify({ ...plan, dryRun: true }, null, 2));
  } else {
    const script = [
      `$ErrorActionPreference = "Stop"`,
      `. ${quoteForPowerShell(ACTION_HELPER)}`,
      `$action = New-NoConsoleTaskAction -TaskName ${quoteForPowerShell(TASK_NAME)} -StorageRoot ${quoteForPowerShell(launcherRoot)} -Executable ${quoteForPowerShell(nodeExecutable)} -Arguments ${quoteForPowerShell(argumentLine)} -LogPath ${quoteForPowerShell(launcherLog)}`,
      `$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
      `$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${REPEAT_MINUTES})`,
      `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited`,
      `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)`,
      `Register-ScheduledTask -TaskName ${quoteForPowerShell(TASK_NAME)} -Action $action -Trigger @($logon, $repeat) -Principal $principal -Settings $settings -Force | Out-Null`,
      `'registered'`,
    ].join("; ");
    runPowerShell(script);
    console.log(JSON.stringify({ ...plan, registered: true }, null, 2));
  }
}
