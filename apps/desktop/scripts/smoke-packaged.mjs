import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(currentDirectory, "..");
const artifactsRoot = join(desktopRoot, "artifacts");
const expectedWindowTitle = "Sovereign Code Runtime";
const startupTimeoutMs = 15_000;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function latestPackagedExecutable() {
  const entries = await readdir(artifactsRoot, { withFileTypes: true });
  const builds = entries
    .filter((entry) => entry.isDirectory() && /^build-\d{4}-\d{2}-\d{2}T/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  const latest = builds[0];
  if (latest === undefined) {
    throw new Error("No packaged build directory exists for startup smoke testing.");
  }
  const executable = join(
    artifactsRoot,
    latest,
    "Sovereign Code Runtime-win32-x64",
    "SovereignCodeRuntime.exe",
  );
  await access(executable);
  return executable;
}

function mainWindowTitle(processId) {
  const escapedCommand = [
    `$process = Get-Process -Id ${processId} -ErrorAction SilentlyContinue`,
    "if ($null -ne $process) { [Console]::Out.Write($process.MainWindowTitle) }",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", escapedCommand],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
    },
  );
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  await new Promise((resolveStop) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      resolveStop();
    }, 3_000);
    killer.once("error", () => {
      clearTimeout(timer);
      child.kill();
      resolveStop();
    });
    killer.once("close", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

async function run() {
  if (process.platform !== "win32") {
    console.log("Packaged startup smoke skipped outside Windows.");
    return;
  }

  const executable = await latestPackagedExecutable();
  const userData = await mkdtemp(join(tmpdir(), "scr-packaged-smoke-"));
  const environment = { ...process.env };
  delete environment.SCR_WORKSPACE_ROOT;
  delete environment.SCR_TUNNEL_CLIENT_PATH;

  const child = spawn(executable, [`--user-data-dir=${userData}`], {
    cwd: dirname(executable),
    env: environment,
    windowsHide: false,
    shell: false,
    stdio: "ignore",
  });

  try {
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Packaged desktop exited during startup with code ${child.exitCode}.`);
      }
      const title = child.pid === undefined ? "" : mainWindowTitle(child.pid);
      if (title === expectedWindowTitle) {
        console.log(`Packaged startup smoke passed: ${executable}`);
        return;
      }
      if (/javascript error|uncaught exception|^error$/iu.test(title)) {
        throw new Error(`Packaged desktop opened an error window during startup: ${title}`);
      }
      await delay(250);
    }
    throw new Error(`Packaged desktop did not open '${expectedWindowTitle}' within ${startupTimeoutMs} ms.`);
  } finally {
    await terminateProcessTree(child);
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await run();
