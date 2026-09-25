import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const artifactsRoot = resolve(projectRoot, "artifacts");

const SYSTEM32 = join(process.env.SystemRoot ?? "C:" + String.fromCharCode(92) + "Windows", "System32");

/**
 * Windows tools by absolute path: a PATH that prefers POSIX shims (Git Bash,
 * MSYS) resolves bare names to a different program with different flags.
 */
function systemTool(name) {
  return join(SYSTEM32, name);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function escapePowerShellLiteral(value) {
  return value.replaceAll("'", "''");
}

function runPowerShell(command, timeoutMs = 30_000) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`PowerShell failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function listPortableProcesses(portableRoot) {
  const escapedRoot = escapePowerShellLiteral(portableRoot);
  const output = runPowerShell(`
    $root = '${escapedRoot}'
    $items = @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
    $items | ConvertTo-Json -Compress
  `);
  if (output.length === 0) {
    return [];
  }
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function killProcess(processId, includeTree = false) {
  const args = ["/pid", String(processId), ...(includeTree ? ["/t"] : []), "/f"];
  const result = spawnSync(systemTool("taskkill.exe"), args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.status !== 0 && !`${result.stdout}${result.stderr}`.includes("not found")) {
    throw new Error(`taskkill failed for PID ${processId}: ${result.stderr || result.stdout}`);
  }
}

async function waitForJson(path, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (predicate(value)) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}${lastError === null ? "" : `: ${lastError.message}`}`);
}

async function waitForExit(child, timeoutMs = 45_000) {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error(`Process ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code ?? -1);
    });
  });
}

async function waitForNoPortableProcesses(portableRoot, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let remaining = [];
  while (Date.now() < deadline) {
    remaining = listPortableProcesses(portableRoot);
    if (remaining.length === 0) {
      return;
    }
    await delay(200);
  }
  throw new Error(`Packaged Host Guardian left processes running: ${JSON.stringify(remaining)}`);
}

async function main() {
  const latestPointer = (await readFile(resolve(artifactsRoot, "latest-portable.txt"), "utf8")).trim();
  const portableRoot = resolve(latestPointer);
  const executable = resolve(portableRoot, "SovereignCodeRuntime.exe");
  const existing = listPortableProcesses(portableRoot);
  if (existing.length > 0) {
    throw new Error(`Latest portable is already running; refusing destructive Guardian smoke: ${JSON.stringify(existing)}`);
  }

  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "scr-packaged-guardian-"));
  const userDataRoot = resolve(temporaryRoot, "user-data");
  const reportDirectory = resolve(temporaryRoot, "reports");
  const initialReportPath = resolve(reportDirectory, "initial.json");
  const recoveredReportPath = resolve(reportDirectory, "recovered.json");
  const incidentPath = resolve(userDataRoot, "guardian", "last-incident.json");
  let initialShell = null;
  let initialReport = null;
  let recoveredReport = null;

  try {
    const environment = {
      ...process.env,
      SCR_USER_DATA_PATH: userDataRoot,
      SCR_WORKSPACE_ROOT: workspaceRoot,
      SCR_HOST_GUARDIAN_INTEGRATION_DIR: reportDirectory,
    };
    for (const key of [
      "ELECTRON_RUN_AS_NODE",
      "SCR_SMOKE_REPORT_PATH",
      "SCR_APPROVAL_SMOKE_REPORT_PATH",
      "SCR_RESOURCE_BENCHMARK_SCENARIO",
      "SCR_RESOURCE_BENCHMARK_OUTPUT",
      "SCR_RESOURCE_BENCHMARK_USER_DATA",
      "SCR_RESOURCE_BENCHMARK_STABILIZE_MS",
      "SCR_GUARDIAN_RESTARTED_AT",
      "SCR_GUARDIAN_RESTART_COUNT",
    ]) {
      delete environment[key];
    }

    initialShell = spawn(executable, [], {
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    const initialExitPromise = waitForExit(initialShell, 45_000);
    initialReport = await waitForJson(
      initialReportPath,
      (value) => value?.schemaVersion === "scr.host-guardian-integration/v1" && value.recovered === false,
    );
    if (
      initialReport.ok !== true ||
      initialReport.shellProcessId !== initialShell.pid ||
      !Number.isInteger(initialReport.runtimeHostProcessId) ||
      !Number.isInteger(initialReport.guardianProcessId) ||
      initialReport.state?.phase !== "running" ||
      initialReport.availability?.schemaVersion !== "scr.host-availability/v1" ||
      initialReport.availability?.available !== true ||
      initialReport.availability?.eventStorage !== "persistent" ||
      typeof initialReport.availability?.sampledAt !== "string"
    ) {
      throw new Error(`Initial packaged Guardian report is invalid: ${JSON.stringify(initialReport)}`);
    }

    killProcess(initialReport.runtimeHostProcessId, false);
    const initialExitCode = await initialExitPromise;
    if (!Number.isInteger(initialExitCode)) {
      throw new Error(`Initial shell did not exit cleanly enough for Guardian recovery: ${initialExitCode}`);
    }

    recoveredReport = await waitForJson(
      recoveredReportPath,
      (value) => value?.schemaVersion === "scr.host-guardian-integration/v1" && value.recovered === true,
      75_000,
    );
    if (
      recoveredReport.ok !== true ||
      recoveredReport.state?.phase !== "running" ||
      recoveredReport.shellProcessId === initialReport.shellProcessId ||
      recoveredReport.runtimeHostProcessId === initialReport.runtimeHostProcessId ||
      recoveredReport.restartCount < 1 ||
      recoveredReport.availability?.schemaVersion !== "scr.host-availability/v1" ||
      recoveredReport.availability?.available !== true ||
      recoveredReport.availability?.eventStorage !== "persistent" ||
      typeof recoveredReport.availability?.sampledAt !== "string"
    ) {
      throw new Error(`Recovered packaged Guardian report is invalid: ${JSON.stringify(recoveredReport)}`);
    }

    const incident = await waitForJson(
      incidentPath,
      (value) => value?.schemaVersion === "scr.host-guardian-incident/v1" && value.outcome === "restarted",
      30_000,
    );
    if (!String(incident.reason).startsWith("runtime-host-")) {
      throw new Error(`Guardian incident did not identify Runtime Host failure: ${JSON.stringify(incident)}`);
    }

    await waitForNoPortableProcesses(portableRoot, 30_000);
    console.log(JSON.stringify({
      schemaVersion: "scr.host-guardian-packaged-smoke/v1",
      passed: true,
      portableRoot,
      initialShellProcessId: initialReport.shellProcessId,
      recoveredShellProcessId: recoveredReport.shellProcessId,
      initialRuntimeHostProcessId: initialReport.runtimeHostProcessId,
      recoveredRuntimeHostProcessId: recoveredReport.runtimeHostProcessId,
      incident,
    }, null, 2));
  } finally {
    const knownProcessIds = new Set([
      initialShell?.pid,
      initialReport?.runtimeHostProcessId,
      initialReport?.guardianProcessId,
      recoveredReport?.shellProcessId,
      recoveredReport?.runtimeHostProcessId,
      recoveredReport?.guardianProcessId,
    ].filter(Number.isInteger));
    for (const processId of knownProcessIds) {
      try {
        killProcess(processId, true);
      } catch {
        // The success path exits every test process before cleanup.
      }
    }
    for (const process of listPortableProcesses(portableRoot)) {
      try {
        killProcess(process.ProcessId, true);
      } catch {
        // Best-effort cleanup follows unique-path preflight isolation.
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
}

await main();
