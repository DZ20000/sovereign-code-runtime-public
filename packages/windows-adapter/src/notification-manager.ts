import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { RuntimeError } from "@sovereign/runtime-core";
import { sanitizedChildEnvironment } from "./process-environment.js";

export type DesktopNotificationSeverity = "info" | "success" | "warning" | "error";

export interface DesktopNotificationInput {
  readonly title: string;
  readonly message: string;
  readonly severity?: DesktopNotificationSeverity;
  readonly durationMs?: number;
}

export interface NormalizedDesktopNotification {
  readonly title: string;
  readonly message: string;
  readonly severity: DesktopNotificationSeverity;
  readonly durationMs: number;
}

export interface DesktopNotificationResult extends NormalizedDesktopNotification {
  readonly accepted: true;
  readonly acceptedAt: string;
  readonly mechanism: "windows-notify-icon";
}

export type NativeNotificationRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<readonly string[]>;

export interface NativeNotificationManagerOptions {
  readonly runner?: NativeNotificationRunner;
  readonly now?: () => number;
  readonly pathExists?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
}

const TITLE_MAX_CHARACTERS = 64;
const MESSAGE_MAX_CHARACTERS = 512;
const MINIMUM_DURATION_MS = 3_000;
const MAXIMUM_DURATION_MS = 15_000;
const DEFAULT_DURATION_MS = 6_000;
const MAXIMUM_HELPER_OUTPUT_BYTES = 65_536;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const WHITESPACE = /\s+/gu;

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

function normalizeVisibleText(value: string, maximumCharacters: number, label: string): string {
  const normalized = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(WHITESPACE, " ")
    .trim();
  if (normalized.length === 0 || normalized.length > maximumCharacters) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `${label} must contain from 1 through ${maximumCharacters} visible characters.`,
      400,
    );
  }
  return normalized;
}

export function normalizeDesktopNotification(
  input: DesktopNotificationInput,
): NormalizedDesktopNotification {
  const severity = input.severity ?? "info";
  const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
  if (
    !Number.isInteger(durationMs) ||
    durationMs < MINIMUM_DURATION_MS ||
    durationMs > MAXIMUM_DURATION_MS
  ) {
    throw new RuntimeError(
      "INVALID_INPUT",
      `Notification duration must be from ${MINIMUM_DURATION_MS} through ${MAXIMUM_DURATION_MS} milliseconds.`,
      400,
    );
  }
  return {
    title: normalizeVisibleText(input.title, TITLE_MAX_CHARACTERS, "Notification title"),
    message: normalizeVisibleText(input.message, MESSAGE_MAX_CHARACTERS, "Notification message"),
    severity,
    durationMs,
  };
}

function appendBounded(chunks: Buffer[], chunk: Buffer, acceptedBytes: { value: number }): void {
  const remaining = MAXIMUM_HELPER_OUTPUT_BYTES - acceptedBytes.value;
  if (remaining <= 0) {
    return;
  }
  const accepted = chunk.subarray(0, remaining);
  chunks.push(accepted);
  acceptedBytes.value += accepted.byteLength;
}

export const runNativeNotification: NativeNotificationRunner = async (
  executable,
  args,
  timeoutMs,
): Promise<readonly string[]> => await new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], {
    env: sanitizedChildEnvironment(),
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutBytes = { value: 0 };
  const stderrBytes = { value: 0 };
  let settled = false;
  const timer = setTimeout(() => {
    child.kill();
    if (!settled) {
      settled = true;
      reject(new RuntimeError("PROCESS_TIMEOUT", "Windows notification timed out.", 408));
    }
  }, timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, stdoutBytes));
  child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, stderrBytes));
  child.once("error", (error) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    reject(new RuntimeError("PROCESS_FAILED", "Windows notification helper could not start.", 500, {
      cause: error.message,
    }));
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
        ? Buffer.concat(stderr).toString("utf8").trim() || "Windows notification helper failed."
        : decode(errorLine.split("\t")[1]);
      reject(new RuntimeError("PROCESS_FAILED", message, 500));
      return;
    }
    if (!lines.includes("NOTIFIED")) {
      reject(new RuntimeError(
        "PROCESS_FAILED",
        "Windows notification helper did not confirm acceptance.",
        500,
      ));
      return;
    }
    resolve(lines);
  });
});

export class NativeNotificationManager {
  readonly #nativeAgentPath: string | null;
  readonly #runner: NativeNotificationRunner;
  readonly #now: () => number;
  readonly #pathExists: (path: string) => boolean;
  readonly #platform: NodeJS.Platform;
  #closed = false;

  constructor(
    nativeAgentPath: string | undefined,
    options: NativeNotificationManagerOptions = {},
  ) {
    this.#nativeAgentPath = nativeAgentPath?.trim() || null;
    this.#runner = options.runner ?? runNativeNotification;
    this.#now = options.now ?? Date.now;
    this.#pathExists = options.pathExists ?? existsSync;
    this.#platform = options.platform ?? process.platform;
  }

  available(): boolean {
    return (
      !this.#closed &&
      this.#platform === "win32" &&
      this.#nativeAgentPath !== null &&
      this.#pathExists(this.#nativeAgentPath)
    );
  }

  async notify(input: DesktopNotificationInput): Promise<DesktopNotificationResult> {
    if (this.#closed) {
      throw new RuntimeError("PROCESS_FAILED", "The Windows notification manager is closed.", 503);
    }
    if (!this.available() || this.#nativeAgentPath === null) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Windows notifications are unavailable. Rebuild and run the packaged desktop application.",
        503,
      );
    }

    const normalized = normalizeDesktopNotification(input);
    const now = this.#now();
    await this.#runner(
      this.#nativeAgentPath,
      [
        "notify",
        encode(normalized.title),
        encode(normalized.message),
        normalized.severity,
        String(normalized.durationMs),
      ],
      normalized.durationMs + 5_000,
    );
    return {
      ...normalized,
      accepted: true,
      acceptedAt: new Date(now).toISOString(),
      mechanism: "windows-notify-icon",
    };
  }

  close(): void {
    this.#closed = true;
  }
}
