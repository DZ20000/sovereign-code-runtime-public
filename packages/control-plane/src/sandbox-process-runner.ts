import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";

import { RuntimeError } from "@sovereign/runtime-core";

export interface SandboxProcessResult {
  readonly commandLabel: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
}

export type SandboxProcessRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly environment?: NodeJS.ProcessEnv;
  },
) => Promise<SandboxProcessResult>;

const SAFE_HOST_ENVIRONMENT_NAMES = new Set([
  "appdata",
  "comspec",
  "home",
  "homedrive",
  "homepath",
  "localappdata",
  "path",
  "pathext",
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "systemdrive",
  "systemroot",
  "temp",
  "tmp",
  "userdomain",
  "username",
  "userprofile",
  "windir",
  "xdg_config_home",
  "xdg_data_home",
]);

export function sandboxHostEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
    TERM: "dumb",
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      SAFE_HOST_ENVIRONMENT_NAMES.has(name.toLocaleLowerCase("en-US"))
    ) {
      environment[name] = value;
    }
  }
  return { ...environment, ...overrides };
}

function safeProcessText(value: unknown, maximum = 1_000): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/[\0\r\n]+/gu, " ")
    .slice(0, maximum);
}

function commandLabel(executable: string, args: readonly string[]): string {
  return [basename(executable), ...args]
    .map((value) => JSON.stringify(value))
    .join(" ")
    .slice(0, 2_000);
}

function terminateProcessTree(child: ChildProcess): void {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill();
    return;
  }
  const taskkillPath = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  const killer = spawn(taskkillPath, ["/pid", String(child.pid), "/t", "/f"], {
    windowsHide: true,
    stdio: "ignore",
  });
  killer.once("error", () => child.kill());
  killer.once("close", (exitCode) => {
    if (exitCode !== 0) child.kill();
  });
}

export async function defaultSandboxProcessRunner(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly environment?: NodeJS.ProcessEnv;
  },
): Promise<SandboxProcessResult> {
  const startedAt = Date.now();
  return await new Promise<SandboxProcessResult>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.environment ?? sandboxHostEnvironment(),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let retainedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;

    const append = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, options.maxOutputBytes - retainedBytes);
      if (remaining > 0) {
        const accepted =
          chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        target.push(accepted);
        retainedBytes += accepted.byteLength;
      }
      if (chunk.byteLength > remaining) outputTruncated = true;
    };
    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, options.timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(
        new RuntimeError(
          "PROCESS_FAILED",
          `Could not start ${basename(command)}: ${safeProcessText(error)}`,
          503,
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        commandLabel: commandLabel(command, args),
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputTruncated,
        timedOut,
      });
    });
  });
}
