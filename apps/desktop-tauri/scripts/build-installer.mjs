import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  acquireInstallerBuildLock,
  releaseInstallerBuildLock,
} from "./installer-build-lock.mjs";
import { readGitSource } from "./release-metadata.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const targetRoot = resolve(projectRoot, "src-tauri", "target");
const installerRoot = resolve(targetRoot, "release", "bundle", "nsis");
const lockPath = resolve(targetRoot, ".installer-build.lock");
const packageScript = resolve(projectRoot, "scripts", "package-installer.mjs");
const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
const dryRun = process.argv.slice(2).includes("--dry-run");

function assertSourceUnchanged(expected, actual, phase) {
  const fields = [
    "commit",
    "shortCommit",
    "branch",
    "committedAt",
    "dirty",
    "changeCount",
  ];
  const changed = fields.filter((field) => expected[field] !== actual[field]);
  if (changed.length > 0 || actual.dirty || actual.changeCount !== 0) {
    throw new Error(
      `Installer source changed during ${phase}: ${changed.join(", ") || "dirty state"}.`,
    );
  }
}

function run(executable, argumentsValue, environment = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, argumentsValue, {
      cwd: projectRoot,
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `${executable} ${argumentsValue.join(" ")} exited with code ${String(code)} and signal ${String(signal)}.`,
      ));
    });
  });
}

const source = await readGitSource(workspaceRoot);
if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    source,
    lockPath,
    installerRoot,
    buildCommand: [process.execPath, tauriCli, "build"],
    packageCommand: [process.execPath, packageScript],
  }, null, 2));
  process.exit(0);
}
if (source.dirty) {
  throw new Error(
    `Installer builds require a clean Git worktree, but ${source.changeCount} change(s) are present.`,
  );
}

let lock = null;
let completed = false;
try {
  lock = await acquireInstallerBuildLock(lockPath, { cwd: projectRoot });
  if (lock.recoveredLock !== null) {
    const recovered = lock.recoveredLock;
    console.log(
      `Recovered candidate-local installer build lock ${recovered.token} for ${recovered.cwd} from exited owner PID ${String(recovered.processId)} (started ${recovered.startedAt}); starting build transaction ${lock.token}.`,
    );
  }
  await rm(installerRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 150,
  });
  const environment = {
    ...process.env,
    SCR_REQUIRE_CLEAN_PACKAGE: "1",
  };
  await run(process.execPath, [tauriCli, "build"], environment);
  assertSourceUnchanged(source, await readGitSource(workspaceRoot), "Tauri build");
  await run(process.execPath, [packageScript], environment);
  assertSourceUnchanged(source, await readGitSource(workspaceRoot), "installer packaging");
  completed = true;
} catch (error) {
  await rm(installerRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 150,
  }).catch(() => undefined);
  throw error;
} finally {
  if (lock !== null) {
    await releaseInstallerBuildLock(lock);
  }
}
if (!completed) {
  throw new Error("Installer build did not complete.");
}
