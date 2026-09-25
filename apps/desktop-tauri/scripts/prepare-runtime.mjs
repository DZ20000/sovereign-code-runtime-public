import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.release.name !== "node") {
  throw new Error("Tauri runtime staging currently supports Windows Node builds only.");
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const stagingRoot = resolve(projectRoot, "runtime-resources");
const nodeDirectory = resolve(stagingRoot, "node");
const stagedNode = resolve(nodeDirectory, "node.exe");
const stagedGuardian = resolve(stagingRoot, "host-guardian.mjs");
const guardianSource = resolve(projectRoot, "host-guardian.mjs");
const stagedWatchdog = resolve(stagingRoot, "shell-watchdog.mjs");
const watchdogSource = resolve(projectRoot, "shell-watchdog.mjs");
const runtimeHost = resolve(workspaceRoot, "apps", "runtime-host", "dist", "bundle", "runtime-host.cjs");
const nativeAgent = resolve(workspaceRoot, "apps", "desktop", "native", "bin", "SovereignNativeAgent.exe");

async function requireFile(path, label) {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

await requireFile(process.execPath, "Node executable");
await requireFile(runtimeHost, "Runtime Host bundle");
await requireFile(nativeAgent, "Native agent");
await requireFile(guardianSource, "Host Guardian script");
await requireFile(watchdogSource, "Shell watchdog script");

await rm(stagingRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
await mkdir(nodeDirectory, { recursive: true });
await Promise.all([
  copyFile(process.execPath, stagedNode),
  copyFile(guardianSource, stagedGuardian),
  copyFile(watchdogSource, stagedWatchdog),
]);

const manifest = {
  schemaVersion: "scr.runtime-resources/v1",
  generatedAt: new Date().toISOString(),
  node: {
    version: process.version,
    executable: "node/node.exe",
    sha256: await sha256(stagedNode),
  },
  runtimeHost: {
    path: "runtime-host.cjs",
    sha256: await sha256(runtimeHost),
  },
  hostGuardian: {
    path: "host-guardian.mjs",
    sha256: await sha256(stagedGuardian),
    restartWindowMs: 600_000,
    maximumRestartsPerWindow: 5,
  },
  shellWatchdog: {
    path: "shell-watchdog.mjs",
    sha256: await sha256(stagedWatchdog),
  },
  nativeAgent: {
    path: "native/bin/SovereignNativeAgent.exe",
    sha256: await sha256(nativeAgent),
  },
  tunnelClientBundled: false,
};

await writeFile(
  resolve(stagingRoot, "runtime-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`Prepared Tauri runtime resources with ${process.version}.`);
