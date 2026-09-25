import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("Tauri approval smoke is currently Windows-only.");
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = resolve(projectRoot, "artifacts");
const portableRoot = (await readFile(resolve(artifactsRoot, "latest-portable.txt"), "utf8")).trim();
const executable = resolve(portableRoot, "SovereignCodeRuntime.exe");
const info = await stat(executable).catch(() => null);
if (info === null || !info.isFile()) {
  throw new Error(`Latest Tauri portable executable is missing: ${executable}`);
}

const userData = await mkdtemp(resolve(tmpdir(), "sovereign-tauri-approval-smoke-"));
const reportPath = resolve(portableRoot, "approval-smoke-report.json");
await rm(reportPath, { force: true });

const child = spawn(executable, [], {
  windowsHide: false,
  shell: false,
  stdio: "ignore",
  env: {
    ...process.env,
    SCR_USER_DATA_PATH: userData,
    SCR_APPROVAL_SMOKE_REPORT_PATH: reportPath,
  },
});
console.log(JSON.stringify({ processId: child.pid, reportPath }));

const started = Date.now();
let report = null;
try {
  while (Date.now() - started < 40_000) {
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
      break;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  if (report === null) {
    throw new Error("Tauri approval smoke did not produce a report within 40 seconds.");
  }
  if (report.passed !== true || report.decision !== "allow-once") {
    throw new Error(`Tauri approval smoke failed: ${JSON.stringify(report)}`);
  }
  console.log(`Tauri approval smoke passed: ${reportPath}`);
} finally {
  if (Number.isInteger(child.pid) && child.pid > 0) {
    const taskkill = resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      shell: false,
      timeout: 10_000,
    });
  }
  await rm(userData, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
}
