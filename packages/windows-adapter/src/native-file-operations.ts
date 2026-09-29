import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

import { RuntimeError, type RuntimeErrorCode } from "@sovereign/runtime-core";
import { sanitizedChildEnvironment } from "./process-environment.js";

export interface NativeFileOperationResult {
  readonly bytes: number;
  readonly sha256: string;
}

export type NativeFileOperationRunner = (
  executable: string,
  args: readonly string[],
  input: Buffer | null,
  timeoutMs: number,
) => Promise<readonly string[]>;

const MAXIMUM_OUTPUT_BYTES = 65_536;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUNTIME_ERROR_CODES = new Set<RuntimeErrorCode>([
  "POLICY_DENIED", "PATH_REJECTED", "PATH_ESCAPE", "PATH_SYMLINK", "PATH_NOT_FOUND",
  "PATH_CHANGED", "FILE_EXISTS", "FILE_LINKED", "FILE_NOT_REGULAR", "FILE_TOO_LARGE",
  "STALE_HASH", "INVALID_INPUT", "PROCESS_FAILED", "PROCESS_TIMEOUT",
]);

function runtimeCode(value: string): RuntimeErrorCode {
  return RUNTIME_ERROR_CODES.has(value as RuntimeErrorCode)
    ? value as RuntimeErrorCode
    : "PROCESS_FAILED";
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function decode(value: string | undefined): string {
  if (value === undefined) return "";
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function statusFor(code: string): number {
  switch (code) {
    case "PATH_NOT_FOUND": return 404;
    case "FILE_EXISTS":
    case "PATH_CHANGED":
    case "STALE_HASH": return 409;
    case "PATH_ESCAPE":
    case "PATH_SYMLINK":
    case "FILE_LINKED":
    case "POLICY_DENIED": return 403;
    case "INVALID_INPUT":
    case "PATH_REJECTED":
    case "FILE_NOT_REGULAR": return 400;
    case "FILE_TOO_LARGE": return 413;
    default: return 500;
  }
}

function appendBounded(chunks: Buffer[], chunk: Buffer, accepted: { value: number }): void {
  const remaining = MAXIMUM_OUTPUT_BYTES - accepted.value;
  if (remaining <= 0) return;
  const part = chunk.subarray(0, remaining);
  chunks.push(part);
  accepted.value += part.byteLength;
}

export const runNativeFileOperation: NativeFileOperationRunner = async (
  executable,
  args,
  input,
  timeoutMs,
): Promise<readonly string[]> => await new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], {
    env: sanitizedChildEnvironment(),
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
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
      reject(new RuntimeError("PROCESS_TIMEOUT", "The native file operation timed out.", 408));
    }
  }, timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, stdoutBytes));
  child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, stderrBytes));
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new RuntimeError("PROCESS_FAILED", "The native file helper could not start.", 500, {
      cause: error.message,
    }));
  });
  child.once("close", (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const lines = Buffer.concat(stdout).toString("utf8").split(/\r?\n/u).filter(Boolean);
    const nativeError = lines.find((line) => line.startsWith("FILE_ERROR\t"));
    if (nativeError !== undefined) {
      const [, encodedCode, encodedMessage] = nativeError.split("\t");
      const code = runtimeCode(decode(encodedCode) || "PROCESS_FAILED");
      reject(new RuntimeError(code, decode(encodedMessage) || "The native file operation failed.", statusFor(code)));
      return;
    }
    const genericError = lines.find((line) => line.startsWith("ERROR\t"));
    if (exitCode !== 0 || genericError !== undefined) {
      const message = genericError === undefined
        ? Buffer.concat(stderr).toString("utf8").trim() || "The native file operation failed."
        : decode(genericError.split("\t")[1]);
      reject(new RuntimeError("PROCESS_FAILED", message, 500));
      return;
    }
    resolve(lines);
  });

  child.stdin.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.kill();
    reject(new RuntimeError("PROCESS_FAILED", "The native file helper input failed.", 500, {
      cause: error.message,
    }));
  });
  child.stdin.end(input ?? undefined);
});

export interface NativeFileOperationsOptions {
  readonly runner?: NativeFileOperationRunner;
  readonly pathExists?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
}

export class NativeFileOperations {
  readonly #nativeAgentPath: string | null;
  readonly #runner: NativeFileOperationRunner;
  readonly #pathExists: (path: string) => boolean;
  readonly #platform: NodeJS.Platform;
  readonly #timeoutMs: number;

  constructor(nativeAgentPath: string | undefined, options: NativeFileOperationsOptions = {}) {
    this.#nativeAgentPath = nativeAgentPath?.trim() || null;
    this.#runner = options.runner ?? runNativeFileOperation;
    this.#pathExists = options.pathExists ?? existsSync;
    this.#platform = options.platform ?? process.platform;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  available(): boolean {
    return this.#platform === "win32" && this.#nativeAgentPath !== null && this.#pathExists(this.#nativeAgentPath);
  }

  async #execute(args: readonly string[], input: Buffer | null): Promise<NativeFileOperationResult> {
    if (!this.available() || this.#nativeAgentPath === null) {
      throw new RuntimeError(
        "PROCESS_FAILED",
        "Handle-bound Windows file operations require the packaged native agent.",
        503,
      );
    }
    const lines = await this.#runner(this.#nativeAgentPath, args, input, this.#timeoutMs);
    const result = lines.find((line) => line.startsWith("FILE_OK\t"));
    if (result === undefined) {
      throw new RuntimeError("PROCESS_FAILED", "The native file helper returned no result.", 500);
    }
    const [, bytesText, sha256] = result.split("\t");
    const bytes = Number(bytesText);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || sha256 === undefined || !SHA256_PATTERN.test(sha256)) {
      throw new RuntimeError("PROCESS_FAILED", "The native file helper returned an invalid result.", 500);
    }
    return { bytes, sha256 };
  }

  async create(
    root: string,
    absolutePath: string,
    data: Buffer,
    maximumBytes = 1_048_576,
  ): Promise<NativeFileOperationResult> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 2_147_483_647) {
      throw new RuntimeError("INVALID_INPUT", "maximumBytes must be a non-negative 32-bit integer.", 400);
    }
    return await this.#execute([
      "file-create",
      encode(root),
      encode(win32.dirname(absolutePath)),
      encode(win32.basename(absolutePath)),
      String(data.byteLength),
      String(maximumBytes),
    ], data);
  }

  async move(
    root: string,
    sourcePath: string,
    destinationPath: string,
    expectedSha256: string,
    maximumBytes = 262_144,
  ): Promise<NativeFileOperationResult> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 2_147_483_647) {
      throw new RuntimeError("INVALID_INPUT", "maximumBytes must be a non-negative 32-bit integer.", 400);
    }
    return await this.#execute([
      "file-move",
      encode(root),
      encode(sourcePath),
      encode(win32.dirname(destinationPath)),
      encode(win32.basename(destinationPath)),
      expectedSha256,
      String(maximumBytes),
    ], null);
  }

  async delete(
    root: string,
    absolutePath: string,
    expectedSha256: string,
    maximumBytes = 262_144,
  ): Promise<NativeFileOperationResult> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 2_147_483_647) {
      throw new RuntimeError("INVALID_INPUT", "maximumBytes must be a non-negative 32-bit integer.", 400);
    }
    return await this.#execute([
      "file-delete",
      encode(root),
      encode(absolutePath),
      expectedSha256,
      String(maximumBytes),
    ], null);
  }
}
