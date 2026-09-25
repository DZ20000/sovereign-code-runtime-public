import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeError, sha256 } from "@sovereign/runtime-core";
import { sanitizedChildEnvironment } from "./process-environment.js";

export interface ComputerWindowSummary {
  readonly id: string;
  readonly processId: number;
  readonly title: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface ComputerObservation {
  readonly revision: string;
  readonly capturedAt: string;
  readonly virtualScreen: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly windows: readonly ComputerWindowSummary[];
  readonly screenshotSha256: string;
  readonly screenshotBytes: number;
  readonly screenshotBase64?: string;
  readonly screenshotMediaType?: "image/jpeg";
}

export type ComputerAction =
  | { readonly operation: "focus_window"; readonly windowId: string }
  | { readonly operation: "click"; readonly x: number; readonly y: number }
  | { readonly operation: "type_text"; readonly text: string }
  | { readonly operation: "press_key"; readonly key: string }
  | { readonly operation: "launch_application"; readonly absolutePath: string };

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function decode(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function integer(value: string | undefined, label: string): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new RuntimeError("PROCESS_FAILED", `Native computer output contains invalid ${label}.`, 500);
  }
  return parsed;
}

async function runNativeHelper(
  executable: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<readonly string[]> {
  return await new Promise<readonly string[]>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: sanitizedChildEnvironment(),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new RuntimeError("PROCESS_TIMEOUT", "Native computer operation timed out.", 408));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new RuntimeError("PROCESS_FAILED", error.message, 500));
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const lines = Buffer.concat(stdout)
        .toString("utf8")
        .split(/\r?\n/u)
        .filter((line) => line.length > 0);
      const errorLine = lines.find((line) => line.startsWith("ERROR\t"));
      if (exitCode !== 0 || errorLine !== undefined) {
        const message = errorLine === undefined
          ? Buffer.concat(stderr).toString("utf8").trim() || `Native helper exited with ${exitCode}.`
          : decode(errorLine.split("\t")[1]);
        reject(new RuntimeError("PROCESS_FAILED", message, 500));
        return;
      }
      resolve(lines);
    });
  });
}

export class NativeComputerManager {
  readonly #nativeAgentPath: string | null;
  #latestRevision: string | null = null;
  #closed = false;

  constructor(nativeAgentPath: string | undefined) {
    this.#nativeAgentPath = nativeAgentPath?.trim() || null;
  }

  available(): boolean {
    return process.platform === "win32" && this.#nativeAgentPath !== null && existsSync(this.#nativeAgentPath);
  }

  latestRevision(): string | null {
    return this.#latestRevision;
  }

  async observe(includeScreenshot: boolean): Promise<ComputerObservation> {
    if (this.#closed) {
      throw new RuntimeError("PROCESS_FAILED", "The native computer manager is closed.", 503);
    }
    if (!this.available() || this.#nativeAgentPath === null) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "The native computer-use helper is unavailable. Rebuild the desktop application on Windows.",
        503,
      );
    }
    const artifactDirectory = join(tmpdir(), "sovereign-code-runtime", "computer");
    await mkdir(artifactDirectory, { recursive: true });
    const screenshotPath = join(artifactDirectory, `${randomUUID()}.jpg`);
    try {
      const lines = await runNativeHelper(
        this.#nativeAgentPath,
        ["computer-observe", encode(screenshotPath)],
      );
      const screenLine = lines.find((line) => line.startsWith("SCREEN\t"));
      if (screenLine === undefined) {
        throw new RuntimeError("PROCESS_FAILED", "Native computer observation omitted screen bounds.", 500);
      }
      const screenFields = screenLine.split("\t");
      const virtualScreen = {
        x: integer(screenFields[1], "screen x"),
        y: integer(screenFields[2], "screen y"),
        width: integer(screenFields[3], "screen width"),
        height: integer(screenFields[4], "screen height"),
      };
      const windows = lines
        .filter((line) => line.startsWith("WINDOW\t"))
        .slice(0, 500)
        .map((line): ComputerWindowSummary => {
          const fields = line.split("\t");
          return {
            id: fields[1] ?? "",
            processId: integer(fields[2], "window process id"),
            bounds: {
              x: integer(fields[3], "window x"),
              y: integer(fields[4], "window y"),
              width: integer(fields[5], "window width"),
              height: integer(fields[6], "window height"),
            },
            title: decode(fields[7]),
          };
        });
      const screenshot = await readFile(screenshotPath);
      if (screenshot.byteLength > 8_000_000) {
        throw new RuntimeError("FILE_TOO_LARGE", "Computer screenshot exceeded the local limit.", 413);
      }
      const capturedAt = new Date().toISOString();
      const screenshotSha256 = sha256(screenshot);
      const revision = sha256(
        JSON.stringify({ capturedAt, virtualScreen, windows, screenshotSha256 }),
      );
      this.#latestRevision = revision;
      return {
        revision,
        capturedAt,
        virtualScreen,
        windows,
        screenshotSha256,
        screenshotBytes: screenshot.byteLength,
        ...(includeScreenshot
          ? {
              screenshotBase64: screenshot.toString("base64"),
              screenshotMediaType: "image/jpeg" as const,
            }
          : {}),
      };
    } finally {
      await rm(screenshotPath, { force: true }).catch(() => undefined);
    }
  }

  async act(expectedRevision: string, action: ComputerAction): Promise<ComputerObservation> {
    if (expectedRevision.length !== 64 || !/^[a-f0-9]{64}$/u.test(expectedRevision)) {
      throw new RuntimeError("INVALID_INPUT", "Computer action requires a valid observation revision.", 400);
    }
    if (this.#latestRevision === null || expectedRevision !== this.#latestRevision) {
      throw new RuntimeError(
        "STALE_HASH",
        "Computer observation is stale. Observe again before acting.",
        409,
        { expectedRevision, latestRevision: this.#latestRevision },
      );
    }
    if (!this.available() || this.#nativeAgentPath === null) {
      throw new RuntimeError("PROCESS_FAILED", "The native computer-use helper is unavailable.", 503);
    }

    let args: readonly string[];
    switch (action.operation) {
      case "focus_window": {
        if (!/^[A-Fa-f0-9]{1,16}$/u.test(action.windowId)) {
          throw new RuntimeError("INVALID_INPUT", "Computer window id is invalid.", 400);
        }
        args = ["computer-action", "focus", action.windowId];
        break;
      }
      case "click": {
        if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) {
          throw new RuntimeError("INVALID_INPUT", "Computer click coordinates must be integers.", 400);
        }
        args = ["computer-action", "click", String(action.x), String(action.y)];
        break;
      }
      case "type_text": {
        if (action.text.length === 0 || action.text.length > 32_768 || action.text.includes("\0")) {
          throw new RuntimeError("INVALID_INPUT", "Computer text must contain 1 through 32768 characters.", 400);
        }
        args = ["computer-action", "type", encode(action.text)];
        break;
      }
      case "press_key": {
        if (action.key.length === 0 || action.key.length > 32) {
          throw new RuntimeError("INVALID_INPUT", "Computer key name must contain 1 through 32 characters.", 400);
        }
        args = ["computer-action", "key", action.key];
        break;
      }
      case "launch_application": {
        args = ["computer-action", "launch", encode(action.absolutePath)];
        break;
      }
    }
    await runNativeHelper(this.#nativeAgentPath, args);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    return await this.observe(false);
  }

  close(): void {
    this.#closed = true;
    this.#latestRevision = null;
  }
}
