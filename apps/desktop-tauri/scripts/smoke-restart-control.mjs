import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.includes("--debug") ? "debug" : "release";
const executable = resolve(
  projectRoot,
  "src-tauri",
  "target",
  profile,
  "sovereign-desktop-tauri.exe",
);
const info = await stat(executable).catch(() => null);
if (info === null || !info.isFile()) {
  throw new Error(`Restart-control smoke executable is missing: ${executable}`);
}
const root = await mkdtemp(resolve(tmpdir(), "scr-restart-control-smoke-"));
const reportPath = resolve(root, "must-not-be-written.json");
try {
  const startedAt = Date.now();
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, ["--exit-for-restart"], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SCR_SMOKE_REPORT_PATH: reportPath,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      rejectResult(new Error("Restart-control primary instance did not exit within five seconds."));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`Restart-control process exited unexpectedly: ${JSON.stringify(result)}`);
  }
  const reportExists = await stat(reportPath).then(() => true, () => false);
  if (reportExists) {
    throw new Error("Restart-control process entered normal smoke startup instead of exiting immediately.");
  }
  console.log(JSON.stringify({
    passed: true,
    profile,
    executable,
    elapsedMs: Date.now() - startedAt,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
