import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createVisualWorkspace, removeVisualProfile } from "./visual-workspace.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = createVisualWorkspace(resolve(desktopRoot, "../.."));
const { ELECTRON_RUN_AS_NODE: _ignored, SCR_RUNTIME_REGISTERED_CONNECTION_OWNER: _owner, ...baseEnvironment } = process.env;
const env = {
  ...baseEnvironment,
  SCR_VISUAL_OUTPUT: workspace.outputRoot,
  SCR_VISUAL_USER_DATA: workspace.userDataRoot,
  SCR_VISUAL_RUN_ID: workspace.runId,
};

console.log(JSON.stringify({ visualOutput: workspace.outputRoot, phase: "starting" }));
let exitCode = 1;
try {
  const child = spawn(electronPath, ["dist/visual/visual-test.mjs"], {
    cwd: desktopRoot,
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
  await removeVisualProfile(workspace).catch(() => undefined);
}

console.log(JSON.stringify({ visualOutput: workspace.outputRoot, exitCode }));
process.exitCode = exitCode;
