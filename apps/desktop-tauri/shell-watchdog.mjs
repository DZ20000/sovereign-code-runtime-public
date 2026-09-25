/**
 * Shell watchdog.
 *
 * The Host Guardian is spawned by the shell and joins its job object, so a job
 * or tree kill takes the supervisor down with the thing it supervises and the
 * shell stays dead. This runs from Task Scheduler instead, outside that blast
 * radius, and restores the one case the guardian cannot observe.
 *
 * It restarts the shell only when there is evidence the shell died without
 * completing its shutdown: a guardian control file whose process is gone. A
 * clean exit deletes that file, so quitting Sovereign on purpose stays quiet.
 */

import { spawn, spawnSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const MAX_CONTROL_BYTES = 64 * 1024;

/** A PATH that prefers POSIX shims resolves bare names to a different program. */
function systemTool(name) {
  return join(SYSTEM32, name);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid shell watchdog argument near ${key ?? "<end>"}.`);
    }
    index += 1;
    if (values.has(key)) {
      throw new Error(`Duplicate shell watchdog argument: ${key}`);
    }
    values.set(key, value);
  }
  return values;
}

function required(values, key) {
  const value = values.get(key);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing shell watchdog argument: ${key}`);
  }
  return value;
}

/**
 * Task Scheduler gives no console, so a run that decides nothing still has to
 * leave a trace; otherwise "it did not restart" and "it never ran" look alike.
 */
async function writeReport(path, report) {
  const payload = {
    schemaVersion: "scr.shell-watchdog-report/v1",
    observedAt: new Date().toISOString(),
    ...report,
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8").catch(() => undefined);
  return payload;
}

/**
 * Matching the image name as well as the id keeps a recycled process id from
 * reading as a live shell.
 */
export function processMatches(processId, imageName, runTasklist) {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  const result = runTasklist(processId);
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return false;
  }
  const firstField = result.stdout.trim().split("\n")[0]?.split('","')[0] ?? "";
  return firstField.replace(/^"/u, "").toLocaleLowerCase("en-US") === imageName.toLocaleLowerCase("en-US");
}

function tasklist(filter) {
  return spawnSync(systemTool("tasklist.exe"), ["/FI", filter, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
}

/** Injected so the decisions can be tested without the machine's real process list. */
const systemProbes = {
  byProcessId: (processId) => tasklist(`PID eq ${processId}`),
  byImageName: (imageName) => tasklist(`IMAGENAME eq ${imageName}`),
  launch: async (shellPath) => {
    const child = spawn(shellPath, ["--autostart"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
    await delay(1_500);
    return child.exitCode === null && child.signalCode === null ? child.pid ?? null : null;
  },
};

export function shellIsRunning(imageName, runTasklistByImage) {
  const result = runTasklistByImage(imageName);
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return false;
  }
  return result.stdout.toLocaleLowerCase("en-US").includes(imageName.toLocaleLowerCase("en-US"));
}

async function readControl(path) {
  const bytes = await readFile(path).catch(() => null);
  if (bytes === null || bytes.length > MAX_CONTROL_BYTES) {
    return null;
  }
  try {
    const value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
    return value?.schemaVersion === "scr.host-guardian-control/v1" ? value : null;
  } catch {
    return null;
  }
}

/**
 * A control file outlives its shell only when the shell never ran its shutdown
 * path, which is exactly the kill the guardian cannot survive either.
 */
async function findAbandonedControls(guardianRoot, imageName, runTasklist) {
  const entries = await readdir(guardianRoot).catch(() => []);
  const abandoned = [];
  for (const entry of entries) {
    if (!entry.startsWith("control-") || !entry.endsWith(".json")) {
      continue;
    }
    const path = join(guardianRoot, entry);
    const control = await readControl(path);
    if (control === null) {
      continue;
    }
    if (!processMatches(control.parentPid, imageName, runTasklist)) {
      abandoned.push(path);
    }
  }
  return abandoned;
}

export async function run(argv, probes = systemProbes) {
  const values = parseArguments(argv);
  const shellPath = required(values, "--shell");
  const guardianRoot = required(values, "--guardian-state");
  const reportPath = required(values, "--report");
  const imageName = shellPath.split(/[\\/]/u).pop() ?? "";

  const abandoned = await findAbandonedControls(guardianRoot, imageName, probes.byProcessId);
  const clearAbandoned = () =>
    Promise.all(abandoned.map((path) => rm(path, { force: true }).catch(() => undefined)));

  if (shellIsRunning(imageName, probes.byImageName)) {
    // Clearing the leftovers here keeps them from accumulating across sessions.
    await clearAbandoned();
    return writeReport(reportPath, { outcome: "already-running", clearedControls: abandoned.length });
  }

  if (abandoned.length === 0) {
    return writeReport(reportPath, { outcome: "no-evidence-of-an-unclean-exit", clearedControls: 0 });
  }

  // --autostart starts hidden, and the single-instance handler makes it a no-op
  // if the shell came back on its own between the check and this launch.
  let restartedProcessId;
  try {
    restartedProcessId = await probes.launch(shellPath);
    if (!processMatches(restartedProcessId, imageName, probes.byProcessId)) {
      throw new Error("The replacement shell did not remain running.");
    }
  } catch (error) {
    return writeReport(reportPath, {
      outcome: "restart-failed", clearedControls: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await clearAbandoned();
  return writeReport(reportPath, {
    outcome: "restarted",
    clearedControls: abandoned.length,
    restartedProcessId,
  });
}

if (process.argv[1]?.endsWith("shell-watchdog.mjs")) {
  const report = await run(process.argv.slice(2));
  console.log(JSON.stringify(report, null, 2));
}
