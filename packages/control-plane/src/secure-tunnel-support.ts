/**
 * Option validation and connector process primitives for the Secure MCP Tunnel.
 * These are pure or process-local helpers with no controller state, kept apart
 * so the supervisor file stays within its reviewed size.
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RuntimeError } from "@sovereign/runtime-core";
export const TUNNEL_ID_PATTERN = /^tunnel_[a-f0-9]{32}$/u;

export const MAX_LOG_CHARACTERS = 32_768;

export const MAX_READINESS_BODY_BYTES = 4_096;

const TRAILING_SLASH = /\/$/u;

export function boundedAppend(current: string, next: string): string {
  const combined = `${current}${next}`;
  return combined.length <= MAX_LOG_CHARACTERS
    ? combined
    : combined.slice(combined.length - MAX_LOG_CHARACTERS);
}

export function validateTunnelId(value: string): string {
  const normalized = value.trim();
  if (!TUNNEL_ID_PATTERN.test(normalized)) {
    throw new Error("Tunnel ID must match tunnel_ followed by 32 lowercase hexadecimal characters.");
  }
  return normalized;
}

export function validateRuntimeApiKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 16 || normalized.length > 4_096 || /[\r\n\0]/u.test(normalized)) {
    throw new Error("Tunnel runtime API key is invalid.");
  }
  return normalized;
}

export function validateGatewayEndpoint(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname) ||
    !url.pathname.endsWith("/mcp") ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("Secure MCP Tunnel may only target the active loopback Sovereign /mcp endpoint.");
  }
  return url.toString();
}

export function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < 10 || candidate > 3_600_000) {
    throw new Error(`${label} must be an integer from 10 through 3600000 milliseconds.`);
  }
  return candidate;
}

const DEFAULT_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000] as const;

export function normalizeReconnectDelays(value: readonly number[] | undefined): readonly number[] {
  const candidate = value ?? DEFAULT_RECONNECT_DELAYS_MS;
  if (
    candidate.length === 0 ||
    candidate.length > 32 ||
    candidate.some((delay) => !Number.isInteger(delay) || delay < 10 || delay > 3_600_000)
  ) {
    throw new Error("Tunnel reconnect delays must contain 1 through 32 bounded millisecond values.");
  }
  return [...candidate];
}

export function resolveTunnelClient(
  configuredExecutablePath: string | null | undefined,
  packagedExecutablePath: string | undefined,
): string | null {
  const explicit = process.env.SCR_TUNNEL_CLIENT_PATH?.trim();
  const candidates = [explicit, configuredExecutablePath ?? undefined, packagedExecutablePath]
    .filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
    .map((candidate) => resolve(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  if (process.platform !== "win32") {
    return null;
  }
  const lookup = spawnSync("where.exe", ["tunnel-client.exe"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000,
  });
  if (lookup.status !== 0 || typeof lookup.stdout !== "string") {
    return null;
  }
  const first = lookup.stdout
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return first !== undefined && existsSync(first) ? resolve(first) : null;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function normalizeAttemptInstanceId(value: string | undefined): string {
  const candidate = value ?? `${process.pid}-${randomBytes(12).toString("hex")}`;
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(candidate)) {
    throw new Error("Tunnel attempt instance ID is invalid.");
  }
  return candidate;
}

export function spawnConnectorProcess(
  executablePath: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(executablePath, [...args], options);
}

export async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolveExit(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("close", onClose);
  });
}

export async function readBoundedResponseBody(
  response: Response,
  maximumBytes = MAX_READINESS_BODY_BYTES,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;
  try {
    while (byteLength < maximumBytes) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const remaining = maximumBytes - byteLength;
      const accepted = chunk.value.byteLength <= remaining
        ? chunk.value
        : chunk.value.subarray(0, remaining);
      chunks.push(accepted);
      byteLength += accepted.byteLength;
      if (accepted.byteLength < chunk.value.byteLength) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (byteLength >= maximumBytes && !truncated) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return `${new TextDecoder().decode(bytes)}${truncated ? "…" : ""}`;
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolveStop) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        killer.kill();
        resolveStop();
      }, 3_000);
      killer.once("error", () => {
        clearTimeout(timer);
        resolveStop();
      });
      killer.once("close", () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
  } else {
    child.kill();
  }
  if (await waitForChildExit(child, 5_000)) {
    return;
  }
  child.kill();
  await waitForChildExit(child, 2_000);
}

/**
 * Reads the connector's health URL from its handshake file. The file must be
 * written by this attempt, and the URL must be plain loopback HTTP with no
 * credentials, query or fragment, because readiness is decided by what it says.
 */
export async function readLoopbackHealthUrl(
  healthUrlFile: string,
  startedAtMs: number,
): Promise<string> {
  const metadata = await stat(healthUrlFile);
  if (!metadata.isFile() || metadata.mtimeMs + 2_000 < startedAtMs) {
    throw new Error("tunnel-client health URL file is stale.");
  }
  const url = new URL((await readFile(healthUrlFile, "utf8")).trim());
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase()) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("tunnel-client health URL is not loopback HTTP.");
  }
  return url.toString().replace(TRAILING_SLASH, "");
}
