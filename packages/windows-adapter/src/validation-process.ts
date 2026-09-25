import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import { RuntimeError } from "@sovereign/runtime-core";

let resolvedPackageManager: string | undefined;

function packageManagerPath(): string {
  if (resolvedPackageManager !== undefined) return resolvedPackageManager;
  // where.exe normally searches the current directory too; only PATH is trusted.
  const located = spawnSync(
    win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
    ["$PATH:pnpm.cmd"],
    { encoding: "utf8", windowsHide: true },
  );
  const first = located.stdout?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => win32.isAbsolute(line));
  if (located.status !== 0 || first === undefined) {
    throw new RuntimeError("PROCESS_FAILED", "pnpm.cmd was not found on PATH.", 500);
  }
  resolvedPackageManager = first;
  return first;
}

export function validationProcess(task: "typecheck" | "test" | "build"): {
  readonly command: string;
  readonly args: readonly string[];
  readonly label: string;
  readonly windowsVerbatimArguments: boolean;
} {
  const label = `pnpm ${task}`;
  if (process.platform === "win32") {
    // cmd /s removes the outer pair; the inner pair protects spaces and '&'.
    // Node must not backslash-escape these cmd quotes as C-runtime arguments.
    return {
      command: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `""${packageManagerPath()}" ${task}"`],
      label,
      windowsVerbatimArguments: true,
    };
  }
  return { command: "pnpm", args: [task], label, windowsVerbatimArguments: false };
}
