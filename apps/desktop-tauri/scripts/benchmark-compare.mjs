import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const desktopArtifacts = resolve(workspaceRoot, "apps", "desktop", "artifacts");
const tauriArtifacts = resolve(projectRoot, "artifacts");
const stabilizationMs = Number(process.env.SCR_BENCHMARK_STABILIZE_MS ?? "10000");
const scenarios = [
  { id: "R0-shell", workspace: false },
  { id: "R1-runtime", workspace: true },
];

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function newestElectronExecutable() {
  const entries = await readdir(desktopArtifacts, { withFileTypes: true });
  const builds = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("build-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const build of builds) {
    const candidate = join(
      desktopArtifacts,
      build,
      "Sovereign Code Runtime-win32-x64",
      "SovereignCodeRuntime.exe",
    );
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  throw new Error("No packaged Electron executable was found.");
}

async function latestTauriExecutable() {
  const portableRoot = (await readFile(resolve(tauriArtifacts, "latest-portable.txt"), "utf8")).trim();
  const candidate = resolve(portableRoot, "SovereignCodeRuntime.exe");
  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile()) throw new Error(`Latest Tauri portable executable is missing: ${candidate}`);
  return candidate;
}

async function runScenario(product, executable, outputRoot, scenario) {
  const productRoot = resolve(outputRoot, product);
  const outputPath = resolve(productRoot, `${scenario.id}.json`);
  const userDataPath = resolve(productRoot, "user-data", scenario.id);
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  await mkdir(userDataPath, { recursive: true });
  const env = {
    ...process.env,
    SCR_RESOURCE_BENCHMARK_SCENARIO: scenario.id,
    SCR_RESOURCE_BENCHMARK_OUTPUT: outputPath,
    SCR_RESOURCE_BENCHMARK_USER_DATA: userDataPath,
    SCR_RESOURCE_BENCHMARK_STABILIZE_MS: String(stabilizationMs),
  };
  delete env.SCR_USER_DATA_PATH;
  delete env.SCR_SMOKE_REPORT_PATH;
  if (scenario.workspace) env.SCR_WORKSPACE_ROOT = workspaceRoot;
  else delete env.SCR_WORKSPACE_ROOT;

  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, [], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`${product} ${scenario.id} timed out.`));
    }, Math.max(90_000, stabilizationMs + 45_000));
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("close", (exitCode, signal) => finish({
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });

  if (result.exitCode !== 0) {
    const failure = await readFile(`${outputPath}.failure.txt`, "utf8").catch(() => "");
    throw new Error(
      `${product} ${scenario.id} failed (exit ${String(result.exitCode)}, signal ${String(result.signal)}).\n${failure || result.stderr || result.stdout}`,
    );
  }
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
  return report;
}

function metrics(electron, tauri) {
  const e = electron.summary;
  const t = tauri.summary;
  const reduction = (electronBytes, tauriBytes) =>
    electronBytes > 0 ? ((electronBytes - tauriBytes) / electronBytes) * 100 : 0;
  return {
    electron: {
      productPrivateMedianBytes: e.productPrivateMedianBytes,
      shellPrivateMedianBytes: e.shellPrivateMedianBytes,
      productWorkingSetMedianBytes: e.productWorkingSetMedianBytes,
      startupReadyMs: electron.startupReadyMs,
    },
    tauri: {
      productPrivateMedianBytes: t.productPrivateMedianBytes,
      shellPrivateMedianBytes: t.shellPrivateMedianBytes,
      productWorkingSetMedianBytes: t.productWorkingSetMedianBytes,
      startupReadyMs: tauri.startupReadyMs,
    },
    improvement: {
      productPrivateBytesSaved: e.productPrivateMedianBytes - t.productPrivateMedianBytes,
      productPrivateReductionPercent: reduction(e.productPrivateMedianBytes, t.productPrivateMedianBytes),
      shellPrivateBytesSaved: e.shellPrivateMedianBytes - t.shellPrivateMedianBytes,
      shellPrivateReductionPercent: reduction(e.shellPrivateMedianBytes, t.shellPrivateMedianBytes),
      productWorkingSetBytesSaved: e.productWorkingSetMedianBytes - t.productWorkingSetMedianBytes,
      productWorkingSetReductionPercent: reduction(e.productWorkingSetMedianBytes, t.productWorkingSetMedianBytes),
    },
  };
}

if (!Number.isFinite(stabilizationMs) || stabilizationMs < 1_000 || stabilizationMs > 120_000) {
  throw new Error("SCR_BENCHMARK_STABILIZE_MS must be between 1000 and 120000.");
}

const electronExecutable = await newestElectronExecutable();
const tauriExecutable = await latestTauriExecutable();
const outputRoot = resolve(tauriArtifacts, "benchmarks", `comparison-${timestampId()}`);
await mkdir(outputRoot, { recursive: true });
const reports = { electron: {}, tauri: {} };
for (const product of ["electron", "tauri"]) {
  const executable = product === "electron" ? electronExecutable : tauriExecutable;
  for (const scenario of scenarios) {
    process.stdout.write(`${product} ${scenario.id}...\n`);
    reports[product][scenario.id] = await runScenario(product, executable, outputRoot, scenario);
  }
}

const comparison = {
  schemaVersion: "scr.shell-comparison/v1",
  generatedAt: new Date().toISOString(),
  stabilizationMs,
  workspaceRoot,
  executables: { electron: electronExecutable, tauri: tauriExecutable },
  scenarios: {
    "R0-shell": metrics(reports.electron["R0-shell"], reports.tauri["R0-shell"]),
    "R1-runtime": metrics(reports.electron["R1-runtime"], reports.tauri["R1-runtime"]),
  },
  raw: reports,
};
const reportPath = resolve(outputRoot, "report.json");
await writeFile(reportPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
console.log(`Shell comparison written: ${reportPath}`);
