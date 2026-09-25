import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guardianScript = resolve(projectRoot, "host-guardian.mjs");

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function startParent() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function startGuardian({ parentPid, shellArgs, controlPath, historyPath, incidentPath, token, environment = {} }) {
  return spawn(process.execPath, [
    guardianScript,
    "--parent-pid",
    String(parentPid),
    "--shell",
    process.execPath,
    "--control",
    controlPath,
    "--history",
    historyPath,
    "--incident",
    incidentPath,
    "--token",
    token,
    "--restart-delays-ms",
    "50,100,200",
    ...shellArgs.flatMap((argument) => ["--restart-arg", argument]),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill();
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

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Expected file was not created: ${path}`);
}

async function stopParent(parent) {
  if (parent.exitCode === null) {
    parent.kill();
    await waitForExit(parent, 5_000).catch(() => undefined);
  }
}

async function main() {
  const root = await mkdtemp(resolve(tmpdir(), "scr-host-guardian-smoke-"));
  const targetScript = resolve(root, "restart-target.mjs");
  await writeFile(
    targetScript,
    "import { writeFile } from 'node:fs/promises'; const value = { pid: process.pid, updatePreflight: process.env.SCR_UPDATE_PREFLIGHT ?? null, releaseId: process.env.SCR_UPDATE_PREFLIGHT_RELEASE_ID ?? null, releaseSequence: process.env.SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE ?? null, manifestSha256: process.env.SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256 ?? null }; await writeFile(process.argv[2], JSON.stringify(value), 'utf8');\n",
    "utf8",
  );

  const children = [];
  try {
    const restartMarker = resolve(root, "restart.marker");
    const restartControl = resolve(root, "restart-control.json");
    const restartHistory = resolve(root, "restart-history.json");
    const restartIncident = resolve(root, "restart-incident.json");
    const restartToken = randomBytes(32).toString("base64url");
    const restartParent = startParent();
    children.push(restartParent);
    await writeJsonAtomic(restartControl, {
      schemaVersion: "scr.host-guardian-control/v1",
      token: restartToken,
      intent: "running",
      parentPid: restartParent.pid,
    });
    const restartGuardian = startGuardian({
      parentPid: restartParent.pid,
      shellArgs: [targetScript, restartMarker],
      controlPath: restartControl,
      historyPath: restartHistory,
      incidentPath: restartIncident,
      token: restartToken,
      environment: {
        SCR_UPDATE_PREFLIGHT_RELEASE_ID: "stale-release",
        SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE: "999",
        SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256: "a".repeat(64),
      },
    });
    children.push(restartGuardian);
    await delay(150);
    await stopParent(restartParent);
    await waitForFile(restartMarker);
    const restartExit = await waitForExit(restartGuardian);
    if (restartExit !== 0) {
      throw new Error(`Unexpected-restart guardian exited with code ${restartExit}.`);
    }
    const restartIncidentValue = JSON.parse(await readFile(restartIncident, "utf8"));
    if (restartIncidentValue.outcome !== "restarted" || restartIncidentValue.reason !== "shell-process-exited") {
      throw new Error(`Unexpected restart incident: ${JSON.stringify(restartIncidentValue)}`);
    }
    const restartMarkerValue = JSON.parse(await readFile(restartMarker, "utf8"));
    if (
      restartMarkerValue.updatePreflight !== null ||
      restartMarkerValue.releaseId !== null ||
      restartMarkerValue.releaseSequence !== null ||
      restartMarkerValue.manifestSha256 !== null
    ) {
      throw new Error(`Restart leaked candidate-preflight environment: ${JSON.stringify(restartMarkerValue)}`);
    }

    const preflightMarker = resolve(root, "preflight.marker");
    const preflightControl = resolve(root, "preflight-control.json");
    const preflightHistory = resolve(root, "preflight-history.json");
    const preflightIncident = resolve(root, "preflight-incident.json");
    const preflightToken = randomBytes(32).toString("base64url");
    const preflightParent = startParent();
    children.push(preflightParent);
    await writeJsonAtomic(preflightControl, {
      schemaVersion: "scr.host-guardian-control/v1",
      token: preflightToken,
      intent: "running",
      parentPid: preflightParent.pid,
    });
    const preflightGuardian = startGuardian({
      parentPid: preflightParent.pid,
      shellArgs: [targetScript, preflightMarker],
      controlPath: preflightControl,
      historyPath: preflightHistory,
      incidentPath: preflightIncident,
      token: preflightToken,
      environment: {
        SCR_UPDATE_PREFLIGHT: "1",
        SCR_UPDATE_PREFLIGHT_RELEASE_ID: "release-0002",
        SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE: "2",
        SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256: "b".repeat(64),
      },
    });
    children.push(preflightGuardian);
    await delay(150);
    await stopParent(preflightParent);
    const preflightExit = await waitForExit(preflightGuardian);
    if (
      preflightExit !== 0 ||
      existsSync(preflightMarker) ||
      existsSync(preflightHistory) ||
      existsSync(preflightIncident) ||
      existsSync(preflightControl)
    ) {
      throw new Error("Candidate-preflight guardian unexpectedly restarted or persisted recovery state.");
    }

    const intentionalMarker = resolve(root, "intentional.marker");
    const intentionalControl = resolve(root, "intentional-control.json");
    const intentionalHistory = resolve(root, "intentional-history.json");
    const intentionalIncident = resolve(root, "intentional-incident.json");
    const intentionalToken = randomBytes(32).toString("base64url");
    const intentionalParent = startParent();
    children.push(intentionalParent);
    await writeJsonAtomic(intentionalControl, {
      schemaVersion: "scr.host-guardian-control/v1",
      token: intentionalToken,
      intent: "running",
      parentPid: intentionalParent.pid,
    });
    const intentionalGuardian = startGuardian({
      parentPid: intentionalParent.pid,
      shellArgs: [targetScript, intentionalMarker],
      controlPath: intentionalControl,
      historyPath: intentionalHistory,
      incidentPath: intentionalIncident,
      token: intentionalToken,
    });
    children.push(intentionalGuardian);
    await delay(150);
    await writeJsonAtomic(intentionalControl, {
      schemaVersion: "scr.host-guardian-control/v1",
      token: intentionalToken,
      intent: "exit",
      parentPid: intentionalParent.pid,
    });
    await stopParent(intentionalParent);
    const intentionalExit = await waitForExit(intentionalGuardian);
    if (intentionalExit !== 0 || existsSync(intentionalMarker) || existsSync(intentionalIncident)) {
      throw new Error("Intentional exit unexpectedly restarted the shell or wrote an incident.");
    }

    const circuitMarker = resolve(root, "circuit.marker");
    const circuitControl = resolve(root, "circuit-control.json");
    const circuitHistory = resolve(root, "circuit-history.json");
    const circuitIncident = resolve(root, "circuit-incident.json");
    const circuitToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    await writeJsonAtomic(circuitHistory, {
      schemaVersion: "scr.host-guardian-history/v1",
      restartTimestamps: [now - 500, now - 400, now - 300, now - 200, now - 100],
    });
    const circuitParent = startParent();
    children.push(circuitParent);
    await writeJsonAtomic(circuitControl, {
      schemaVersion: "scr.host-guardian-control/v1",
      token: circuitToken,
      intent: "running",
      parentPid: circuitParent.pid,
    });
    const circuitGuardian = startGuardian({
      parentPid: circuitParent.pid,
      shellArgs: [targetScript, circuitMarker],
      controlPath: circuitControl,
      historyPath: circuitHistory,
      incidentPath: circuitIncident,
      token: circuitToken,
    });
    children.push(circuitGuardian);
    await delay(150);
    await stopParent(circuitParent);
    const circuitExit = await waitForExit(circuitGuardian);
    if (circuitExit !== 75 || existsSync(circuitMarker)) {
      throw new Error(`Circuit breaker did not fail closed; exit=${circuitExit}.`);
    }
    const circuitIncidentValue = JSON.parse(await readFile(circuitIncident, "utf8"));
    if (circuitIncidentValue.outcome !== "circuit-open") {
      throw new Error(`Unexpected circuit incident: ${JSON.stringify(circuitIncidentValue)}`);
    }

    console.log("Host Guardian restart, preflight observe-only, intentional-exit, and circuit-breaker smoke passed.");
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill();
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

await main();
