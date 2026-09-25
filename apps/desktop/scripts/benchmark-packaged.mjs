import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(currentDirectory, "..");
const workspaceRoot = resolve(desktopRoot, "..", "..");
const artifactsRoot = join(desktopRoot, "artifacts");
const scenarios = [
  { id: "R0-shell", workspace: false },
  { id: "R1-runtime", workspace: true },
  { id: "R3-navigation", workspace: true },
  { id: "R4-codemirror", workspace: true },
];
const stabilizationMs = Number(process.env.SCR_BENCHMARK_STABILIZE_MS ?? "30000");

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function newestPackagedExecutable() {
  const entries = await readdir(artifactsRoot, { withFileTypes: true });
  const builds = entries
    .filter((entry) => entry.isDirectory() && /^build-/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const build of builds.reverse()) {
    const candidate = join(
      artifactsRoot,
      build,
      "Sovereign Code Runtime-win32-x64",
      "SovereignCodeRuntime.exe",
    );
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next retained build.
    }
  }
  throw new Error("No packaged SovereignCodeRuntime.exe was found under artifacts/build-*.");
}

async function runScenario(executable, benchmarkRoot, scenario) {
  const outputPath = join(benchmarkRoot, `${scenario.id}.json`);
  const userDataPath = join(benchmarkRoot, "user-data", scenario.id);
  await rm(userDataPath, { recursive: true, force: true });
  await mkdir(userDataPath, { recursive: true });

  const env = {
    ...process.env,
    SCR_RESOURCE_BENCHMARK_SCENARIO: scenario.id,
    SCR_RESOURCE_BENCHMARK_OUTPUT: outputPath,
    SCR_RESOURCE_BENCHMARK_USER_DATA: userDataPath,
    SCR_RESOURCE_BENCHMARK_STABILIZE_MS: String(stabilizationMs),
  };
  if (scenario.workspace) {
    env.SCR_WORKSPACE_ROOT = workspaceRoot;
  } else {
    delete env.SCR_WORKSPACE_ROOT;
  }

  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, [], {
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
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
      rejectRun(new Error(`Packaged resource benchmark timed out: ${scenario.id}`));
    }, Math.max(120_000, stabilizationMs + 60_000));
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

  if (result.exitCode !== 0) {
    let failure = "";
    try {
      failure = await readFile(`${outputPath}.failure.txt`, "utf8");
    } catch {
      // The app may have failed before it could persist the benchmark error.
    }
    throw new Error(
      `Packaged resource benchmark failed: ${scenario.id} (exit ${String(result.exitCode)}, signal ${String(result.signal)})\n${failure || result.stderr || result.stdout}`,
    );
  }

  const parsed = JSON.parse(await readFile(outputPath, "utf8"));
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  return parsed;
}

const executable = await newestPackagedExecutable();
const benchmarkRoot = join(artifactsRoot, "benchmarks", `benchmark-${timestampId()}`);
await mkdir(benchmarkRoot, { recursive: true });

const reports = [];
for (const scenario of scenarios) {
  process.stdout.write(`Benchmark ${scenario.id}...\n`);
  reports.push(await runScenario(executable, benchmarkRoot, scenario));
}

const byScenario = new Map(reports.map((report) => [report.scenario, report]));
const shell = byScenario.get("R0-shell")?.summary.productPrivateMedianBytes ?? 0;
const runtime = byScenario.get("R1-runtime")?.summary.productPrivateMedianBytes ?? 0;
const navigation = byScenario.get("R3-navigation")?.summary.productPrivateMedianBytes ?? 0;
const codemirror = byScenario.get("R4-codemirror")?.summary.productPrivateMedianBytes ?? 0;
const suite = {
  schemaVersion: "scr.resource-benchmark-suite/v1",
  generatedAt: new Date().toISOString(),
  executable,
  workspaceRoot,
  stabilizationMs,
  scenarios: reports,
  deltas: {
    runtimeVsShellPrivateBytes: runtime - shell,
    navigationVsRuntimePrivateBytes: navigation - runtime,
    codemirrorVsRuntimePrivateBytes: codemirror - runtime,
  },
};
const reportPath = join(benchmarkRoot, "report.json");
await writeFile(reportPath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
console.log(`Packaged resource benchmark written: ${reportPath}`);
