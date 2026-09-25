import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPortablePackage } from "./release-metadata.mjs";

const SMOKE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

const SYSTEM32 = join(process.env.SystemRoot ?? "C:" + String.fromCharCode(92) + "Windows", "System32");

/**
 * Windows tools by absolute path: a PATH that prefers POSIX shims (Git Bash,
 * MSYS) resolves bare names to a different program with different flags.
 */
function systemTool(name) {
  return join(SYSTEM32, name);
}

function currentProcessHasHighIntegrity() {
  if (process.platform !== "win32") {
    return false;
  }
  const probe = spawnSync(systemTool("whoami.exe"), ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1_048_576,
  });
  if (probe.error !== undefined) {
    throw new Error(`Could not inspect the smoke-test integrity level: ${probe.error.message}`);
  }
  if (probe.status !== 0) {
    throw new Error(
      `Could not inspect the smoke-test integrity level (exit ${String(probe.status)}).`,
    );
  }
  return /S-1-16-(?:12288|16384)\b/u.test(`${probe.stdout}\n${probe.stderr}`);
}

function escapeVbsString(value) {
  return value.replaceAll('"', '""');
}

async function launchDirect(executable, environment) {
  const child = spawn(executable, [], {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
    env: {
      ...process.env,
      ...environment,
    },
  });

  let timer;
  return await new Promise((resolveExit, rejectExit) => {
    timer = setTimeout(() => {
      child.kill();
      rejectExit(new Error("Portable Tauri smoke timed out after 30 seconds."));
    }, SMOKE_TIMEOUT_MS);
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  }).finally(() => clearTimeout(timer));
}

async function launchAtMediumIntegrity(executable, environment, userData) {
  const launcherPath = resolve(userData, "portable-smoke-launch.vbs");
  const exitPath = resolve(userData, "portable-smoke-exit.txt");
  const launcherErrorPath = resolve(userData, "portable-smoke-launch-error.txt");
  const environmentAssignments = Object.entries(environment)
    .map(([name, value]) => `env("${escapeVbsString(name)}") = "${escapeVbsString(value)}"`)
    .join("\r\n");
  const launcherSource = [
    "On Error Resume Next",
    'Set shell = CreateObject("WScript.Shell")',
    'Set env = shell.Environment("PROCESS")',
    environmentAssignments,
    `code = shell.Run(Chr(34) & "${escapeVbsString(executable)}" & Chr(34), 0, True)`,
    "errorNumber = Err.Number",
    "errorDescription = Err.Description",
    "On Error GoTo 0",
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `Set exitFile = fso.CreateTextFile("${escapeVbsString(exitPath)}", True)`,
    "If errorNumber = 0 Then",
    "  exitFile.Write CStr(code)",
    "Else",
    '  exitFile.Write "255"',
    "End If",
    "exitFile.Close",
    "If errorNumber <> 0 Then",
    `  Set errorFile = fso.CreateTextFile("${escapeVbsString(launcherErrorPath)}", True)`,
    '  errorFile.Write CStr(errorNumber) & ": " & errorDescription',
    "  errorFile.Close",
    "End If",
    "",
  ].join("\r\n");
  await writeFile(launcherPath, `\uFEFF${launcherSource}`, "utf16le");

  const explorer = spawn("explorer.exe", [launcherPath], {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    explorer.once("error", rejectSpawn);
    explorer.once("spawn", resolveSpawn);
  });
  explorer.unref();

  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await readFile(exitPath, "utf8").catch(() => null);
    if (value !== null) {
      const code = Number.parseInt(value.trim(), 10);
      if (!Number.isInteger(code)) {
        throw new Error(`Medium-integrity smoke launcher returned an invalid exit code: ${value}`);
      }
      if (code === 255) {
        const detail = await readFile(launcherErrorPath, "utf8").catch(() => "unknown error");
        throw new Error(`Medium-integrity smoke launcher failed: ${detail}`);
      }
      return { code, signal: null };
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS));
  }
  throw new Error(
    "Portable Tauri smoke timed out while waiting for the medium-integrity launcher.",
  );
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const artifactsRoot = resolve(projectRoot, "artifacts");
const latestPath = (await readFile(resolve(artifactsRoot, "latest-portable.txt"), "utf8")).trim();
if (latestPath.length === 0) {
  throw new Error("No portable Tauri package has been recorded.");
}
const executable = resolve(latestPath, "SovereignCodeRuntime.exe");
const executableInfo = await stat(executable).catch(() => null);
if (executableInfo === null || !executableInfo.isFile()) {
  throw new Error(`Portable Tauri executable is missing: ${executable}`);
}
const packageVerification = await verifyPortablePackage(latestPath);
if (!packageVerification.passed) {
  throw new Error(
    `Portable package verification failed before launch: ${packageVerification.problems.join("; ")}`,
  );
}

const userData = await mkdtemp(resolve(tmpdir(), "sovereign-tauri-smoke-"));
const reportPath = resolve(latestPath, "smoke-report.json");
await rm(reportPath, { force: true });

const environment = {
  SCR_WORKSPACE_ROOT: workspaceRoot,
  SCR_USER_DATA_PATH: userData,
  SCR_SMOKE_REPORT_PATH: reportPath,
};
const highIntegrity = currentProcessHasHighIntegrity();
const launchMode = highIntegrity ? "medium-integrity-via-explorer" : "direct";
const exit = highIntegrity
  ? await launchAtMediumIntegrity(executable, environment, userData)
  : await launchDirect(executable, environment);

try {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const phase = report?.state?.phase;
  const endpoint = report?.state?.endpoint;
  const toolCount = report?.state?.toolCount;
  const manifestTools = report?.manifest?.tools;
  const processes = report?.resources?.processes;
  const totals = report?.resources?.totals;
  const ui = report?.ui;
  const tasks = report?.tasks;
  const availability = report?.availability;
  const roles = Array.isArray(processes) ? new Set(processes.map((entry) => entry?.role)) : new Set();
  const checks = {
    packageManifestVerified: packageVerification.passed,
    packageSourceRecorded:
      typeof packageVerification.sourceCommit === "string" &&
      /^[a-f0-9]{40}$/u.test(packageVerification.sourceCommit) &&
      typeof packageVerification.sourceDirty === "boolean" &&
      typeof packageVerification.productVersion === "string",
    processExit: exit.code === 0,
    reportOk: report?.ok === true,
    runtimeRunning: phase === "running",
    loopbackEndpoint: typeof endpoint === "string" && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u.test(endpoint),
    toolsLoaded: Number.isInteger(toolCount) && toolCount > 0 && Array.isArray(manifestTools) && manifestTools.length === toolCount,
    taskWorkspaceReadable:
      tasks?.schemaVersion === "scr.task-workspace/v1"
      && Number.isInteger(tasks?.totalProjectCount)
      && Number.isInteger(tasks?.totalTaskCount)
      && Array.isArray(tasks?.projects),
    runtimeHostObserved: roles.has("runtime-host"),
    shellObserved: roles.has("desktop-main"),
    realMemoryObserved: Number.isFinite(totals?.productPrivateBytes) && totals.productPrivateBytes > 0,
    availabilityObserved:
      availability?.schemaVersion === "scr.host-availability/v1"
      && availability?.available === true
      && availability?.eventStorage === "persistent"
      && typeof availability?.sampledAt === "string"
      && Number.isFinite(availability?.systemUptimeMs)
      && availability.systemUptimeMs > 0
      && ["ac", "battery", "unknown"].includes(availability?.powerSource),
    uiReady:
      report?.uiReady === true
      && typeof ui?.href === "string"
      && /^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)\//u.test(ui.href)
      && ui?.title === "Sovereign Code Runtime"
      && Number.isInteger(ui?.appChildCount)
      && ui.appChildCount > 0,
  };
  const passed = Object.values(checks).every(Boolean);
  const finalReport = {
    ...report,
    packageVerification,
    portableSmoke: {
      passed,
      launchMode,
      exit,
      checks,
    },
  };
  await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
  if (!passed) {
    throw new Error(`Portable Tauri smoke failed: ${JSON.stringify(checks)}`);
  }
  console.log(`Portable Tauri smoke passed (${launchMode}): ${reportPath}`);
} finally {
  await rm(userData, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
}
