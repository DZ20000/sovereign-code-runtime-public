import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnvironment } = process.env;
const temporaryUserData = await mkdtemp(join(tmpdir(), "sovereign-electron-visual-"));
const env = {
  ...baseEnvironment,
  SCR_VISUAL_USER_DATA: temporaryUserData,
};

let exitCode = 1;
try {
  const child = spawn(electronPath, ["dist/visual/visual-test.mjs"], {
    cwd: process.cwd(),
    env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });

  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      reject(new Error(`Electron visual test exited by signal ${String(signal)}.`));
    });
  });
} finally {
  await rm(temporaryUserData, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 150,
  }).catch(() => undefined);
}

process.exitCode = exitCode;
