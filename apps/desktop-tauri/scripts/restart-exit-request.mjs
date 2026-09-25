import { spawn } from "node:child_process";
import { resolve } from "node:path";

export async function requestGracefulRestartExit(
  executable,
  {
    argument = "--exit-for-restart",
    argumentsPrefix = [],
    environment = process.env,
    spawnTimeoutMs = 2_000,
    waitForExitMs = 0,
  } = {},
) {
  const path = resolve(executable);
  return await new Promise((resolveRequest) => {
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.unref();
      resolveRequest(waitForExitMs > 0 ? { ...value, exited: value.exited ?? false } : value);
    };
    let timer = setTimeout(() => {
      finish({
        executable: path,
        requested: child?.pid !== undefined,
        processId: child?.pid ?? null,
        error: child?.pid === undefined ? "Restart-exit request did not spawn in time." : null,
      });
    }, spawnTimeoutMs);
    try {
      child = spawn(path, [...argumentsPrefix, argument], {
        windowsHide: true,
        shell: false,
        detached: true,
        stdio: "ignore",
        env: environment,
      });
      child.once("spawn", () => {
        if (waitForExitMs > 0) {
          clearTimeout(timer);
          timer = setTimeout(() => finish({
            executable: path,
            requested: true,
            processId: child.pid,
            error: "Restart-exit control process did not exit in time.",
          }), waitForExitMs);
          return;
        }
        finish({
          executable: path,
          requested: true,
          processId: child.pid ?? null,
          error: null,
        });
      });
      child.once("exit", (code, signal) => {
        if (waitForExitMs <= 0) return;
        finish({
          executable: path,
          requested: true,
          processId: child.pid,
          exited: true,
          error: code === 0 ? null : `Restart-exit control process ended with code ${code}, signal ${signal}.`,
        });
      });
      child.once("error", (error) => {
        finish({
          executable: path,
          requested: false,
          processId: null,
          error: error.message,
        });
      });
    } catch (error) {
      finish({
        executable: path,
        requested: false,
        processId: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
