import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

const DEFAULT_RESTART_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const POLL_INTERVAL_MS = 1_000;
const MAX_JSON_BYTES = 64 * 1024;
const UPDATE_PREFLIGHT_ENVIRONMENT_NAMES = [
  "SCR_UPDATE_PREFLIGHT",
  "SCR_UPDATE_PREFLIGHT_RELEASE_ID",
  "SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE",
  "SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256",
];

function parseArguments(argv) {
  const values = new Map();
  const restartArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid Host Guardian argument near ${key ?? "<end>"}.`);
    }
    index += 1;
    if (key === "--restart-arg") {
      restartArgs.push(value);
    } else if (values.has(key)) {
      throw new Error(`Duplicate Host Guardian argument: ${key}`);
    } else {
      values.set(key, value);
    }
  }
  return { values, restartArgs };
}

function required(values, key) {
  const value = values.get(key);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing Host Guardian argument: ${key}`);
  }
  return value;
}

function boundedPositiveInteger(value, label, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return parsed;
}

function parseDelayProfile(value) {
  if (value === undefined) {
    return DEFAULT_RESTART_DELAYS_MS;
  }
  const parsed = value.split(",").map((entry) => boundedPositiveInteger(entry, "Restart delay", 300_000));
  if (parsed.length === 0 || parsed.length > 16) {
    throw new Error("Restart delay profile must contain 1 through 16 values.");
  }
  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function readBoundedJson(path) {
  try {
    const source = await readFile(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_JSON_BYTES) {
      return null;
    }
    const value = JSON.parse(source);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function readControl(controlPath, token) {
  const value = await readBoundedJson(controlPath);
  if (value?.schemaVersion !== "scr.host-guardian-control/v1" || value.token !== token) {
    return null;
  }
  return value;
}

async function finishIntentionalExit(controlPath, incidentPath, outcome) {
  // Recording the quiet paths is what makes the record's absence meaningful:
  // a stale control file with no incident means the tree was killed from
  // outside and the guardian never got to observe anything.
  await writeJsonAtomic(incidentPath, {
    schemaVersion: "scr.host-guardian-incident/v1",
    occurredAt: new Date().toISOString(),
    outcome,
  });
  await rm(controlPath, { force: true }).catch(() => undefined);
  process.exitCode = 0;
}

async function acknowledgeRestart(controlPath, token, control) {
  const requestId = control?.restartRequestId;
  if (control?.intent !== "restart" || !/^[A-Za-z0-9_-]{32,128}$/u.test(requestId ?? "")) {
    return;
  }
  if (
    control.guardianObservedRequestId === requestId &&
    control.guardianProcessId === process.pid &&
    typeof control.guardianObservedAtUnixMs === "string"
  ) {
    return;
  }
  const latest = await readControl(controlPath, token);
  if (latest?.intent !== "restart" || latest.restartRequestId !== requestId) {
    return;
  }
  await writeJsonAtomic(controlPath, {
    ...latest,
    guardianObservedRequestId: requestId,
    guardianObservedAtUnixMs: String(Date.now()),
    guardianProcessId: process.pid,
  });
}

function sanitizeRestartEnvironment() {
  const environment = { ...process.env };
  for (const key of [
    "SCR_SMOKE_REPORT_PATH",
    "SCR_APPROVAL_SMOKE_REPORT_PATH",
    "SCR_RESOURCE_BENCHMARK_SCENARIO",
    "SCR_RESOURCE_BENCHMARK_OUTPUT",
    "SCR_RESOURCE_BENCHMARK_USER_DATA",
    "SCR_RESOURCE_BENCHMARK_STABILIZE_MS",
    "SCR_HOST_GUARDIAN_SMOKE",
    ...UPDATE_PREFLIGHT_ENVIRONMENT_NAMES,
  ]) {
    delete environment[key];
  }
  return environment;
}

async function main() {
  const updatePreflightObserveOnly = process.env.SCR_UPDATE_PREFLIGHT === "1";
  const { values, restartArgs } = parseArguments(process.argv.slice(2));
  const parentProcessId = boundedPositiveInteger(required(values, "--parent-pid"), "Parent process ID", 0x7fffffff);
  const shellPath = required(values, "--shell");
  const controlPath = required(values, "--control");
  const historyPath = required(values, "--history");
  const incidentPath = required(values, "--incident");
  const token = required(values, "--token");
  const restartDelaysMs = parseDelayProfile(values.get("--restart-delays-ms"));

  if (![shellPath, controlPath, historyPath, incidentPath].every(isAbsolute)) {
    throw new Error("Host Guardian executable and state paths must be absolute.");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token)) {
    throw new Error("Host Guardian session token is invalid.");
  }
  if (restartArgs.length > 16 || restartArgs.some((argument) => argument.length > 4_096 || /[\r\n\0]/u.test(argument))) {
    throw new Error("Host Guardian restart arguments are invalid.");
  }

  while (processExists(parentProcessId)) {
    const control = await readControl(controlPath, token);
    if (control?.intent === "exit") {
      await finishIntentionalExit(controlPath, incidentPath, "intentional-exit");
      return;
    }
    if (control?.intent === "restart") {
      await acknowledgeRestart(controlPath, token, control);
    }
    await delay(POLL_INTERVAL_MS);
  }

  let control = await readControl(controlPath, token);
  if (control?.intent === "exit") {
    await finishIntentionalExit(controlPath, incidentPath, "intentional-exit");
    return;
  }
  if (updatePreflightObserveOnly) {
    await finishIntentionalExit(controlPath, incidentPath, "update-preflight-observed");
    return;
  }

  const now = Date.now();
  const history = await readBoundedJson(historyPath);
  const timestamps = Array.isArray(history?.restartTimestamps)
    ? history.restartTimestamps.filter((entry) => Number.isInteger(entry) && entry > now - RESTART_WINDOW_MS && entry <= now)
    : [];
  const reason = typeof control?.reason === "string" && control.reason.length <= 200
    ? control.reason
    : "shell-process-exited";

  if (timestamps.length >= MAX_RESTARTS_PER_WINDOW) {
    await writeJsonAtomic(incidentPath, {
      schemaVersion: "scr.host-guardian-incident/v1",
      occurredAt: new Date(now).toISOString(),
      outcome: "circuit-open",
      reason,
      shellPath,
      restartCountInWindow: timestamps.length,
      restartWindowMs: RESTART_WINDOW_MS,
    });
    await rm(controlPath, { force: true }).catch(() => undefined);
    process.exitCode = 75;
    return;
  }

  const restartDelayMs = restartDelaysMs[Math.min(timestamps.length, restartDelaysMs.length - 1)];
  await delay(restartDelayMs);
  control = await readControl(controlPath, token);
  if (control?.intent === "exit") {
    await finishIntentionalExit(controlPath, incidentPath, "intentional-exit");
    return;
  }
  if (processExists(parentProcessId)) {
    await rm(controlPath, { force: true }).catch(() => undefined);
    process.exitCode = 0;
    return;
  }

  const nextTimestamps = [...timestamps, now];
  await writeJsonAtomic(historyPath, {
    schemaVersion: "scr.host-guardian-history/v1",
    updatedAt: new Date().toISOString(),
    restartWindowMs: RESTART_WINDOW_MS,
    restartTimestamps: nextTimestamps,
  });

  let child;
  try {
    child = spawn(shellPath, restartArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...sanitizeRestartEnvironment(),
        SCR_GUARDIAN_RESTARTED_AT: new Date().toISOString(),
        SCR_GUARDIAN_RESTART_COUNT: String(nextTimestamps.length),
      },
    });
    child.unref();
  } catch (error) {
    await writeJsonAtomic(incidentPath, {
      schemaVersion: "scr.host-guardian-incident/v1",
      occurredAt: new Date().toISOString(),
      outcome: "restart-failed",
      reason,
      shellPath,
      restartCountInWindow: nextTimestamps.length,
      error: error instanceof Error ? error.message : String(error),
    });
    await rm(controlPath, { force: true }).catch(() => undefined);
    process.exitCode = 76;
    return;
  }

  await writeJsonAtomic(incidentPath, {
    schemaVersion: "scr.host-guardian-incident/v1",
    occurredAt: new Date().toISOString(),
    outcome: "restarted",
    reason,
    shellPath,
    restartedProcessId: child.pid ?? null,
    restartDelayMs,
    restartCountInWindow: nextTimestamps.length,
  });
  await rm(controlPath, { force: true }).catch(() => undefined);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 77;
});
