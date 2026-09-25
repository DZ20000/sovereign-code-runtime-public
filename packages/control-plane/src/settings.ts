import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type {
  DesktopPermissionLevel,
  DesktopPermissionProfile,
} from "@sovereign/control-plane-contract";
import {
  EMPTY_PROJECT_WORKSPACES,
  normalizeProjectWorkspaceSettings,
  type ProjectWorkspaceSettings,
} from "./project-workspaces.js";

export const CURRENT_PERMISSION_MODEL_VERSION = 2;

export interface ControlPlaneSettings {
  readonly workspaceRoot: string | null;
  readonly projectWorkspaces: ProjectWorkspaceSettings;
  readonly permissionModelVersion: number;
  readonly permissionWorkspaceRoot: string | null;
  readonly permissionProfile: DesktopPermissionProfile;
  readonly rememberedPermissionProfile: DesktopPermissionLevel;
  readonly permissionBypassGrantEncrypted: string | null;
  readonly unattendedWorkspaceRoot: string | null;
  readonly autoStart: boolean;
  readonly webBridgeUrl: string | null;
  readonly secureTunnelId: string | null;
  readonly secureTunnelExecutablePath: string | null;
  readonly secureTunnelExecutableSha256: string | null;
  readonly secureTunnelRuntimeKeyEncrypted: string | null;
  readonly secureTunnelControlPlaneProxyEncrypted: string | null;
  readonly secureTunnelControlPlaneBackupProxyEncrypted: string | null;
  readonly secureTunnelControlPlaneDirectFallback: boolean;
  readonly secureTunnelAutoStart: boolean;
  readonly secureTunnelAutoReconnect: boolean;
}

export const DEFAULT_CONTROL_PLANE_SETTINGS: ControlPlaneSettings = {
  workspaceRoot: null,
  projectWorkspaces: EMPTY_PROJECT_WORKSPACES,
  permissionModelVersion: CURRENT_PERMISSION_MODEL_VERSION,
  permissionWorkspaceRoot: null,
  permissionProfile: "observe",
  rememberedPermissionProfile: "observe",
  permissionBypassGrantEncrypted: null,
  unattendedWorkspaceRoot: null,
  autoStart: true,
  webBridgeUrl: null,
  secureTunnelId: null,
  secureTunnelExecutablePath: null,
  secureTunnelExecutableSha256: null,
  secureTunnelRuntimeKeyEncrypted: null,
  secureTunnelControlPlaneProxyEncrypted: null,
  secureTunnelControlPlaneBackupProxyEncrypted: null,
  secureTunnelControlPlaneDirectFallback: false,
  secureTunnelAutoStart: false,
  secureTunnelAutoReconnect: true,
};

export function normalizeWebBridgeUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) {
    throw new Error("Web bridge URL must contain 1 through 2048 characters.");
  }
  const url = new URL(trimmed);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:") {
    throw new Error("Web bridge URL must use HTTPS.");
  }
  if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error("Web bridge URL must be remotely reachable rather than loopback.");
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error("Web bridge URL may not contain credentials, query strings, or fragments.");
  }
  if (!url.pathname.endsWith("/mcp")) {
    throw new Error("Web bridge URL path must end with /mcp.");
  }
  return url.toString();
}

export function normalizeSecureTunnelId(value: string): string {
  const normalized = value.trim();
  if (!/^tunnel_[a-f0-9]{32}$/u.test(normalized)) {
    throw new Error("Secure MCP Tunnel ID must match tunnel_ followed by 32 lowercase hexadecimal characters.");
  }
  return normalized;
}

export function normalizeSecureTunnelExecutablePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 4_096 || /[\r\n\0]/u.test(trimmed)) {
    throw new Error("Tunnel connector path is invalid.");
  }
  const normalized = resolve(trimmed);
  if (basename(normalized).toLowerCase() !== "tunnel-client.exe") {
    throw new Error("Choose the official tunnel-client.exe executable.");
  }
  return normalized;
}

export function normalizeSecureTunnelControlPlaneProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048 || /[\r\n\0]/u.test(trimmed)) {
    throw new Error("Tunnel control-plane proxy URL must contain 1 through 2048 valid characters.");
  }
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Tunnel control-plane proxy must use HTTP or HTTPS.");
  }
  if (url.hostname.length === 0) {
    throw new Error("Tunnel control-plane proxy must include a hostname.");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search.length > 0 || url.hash.length > 0) {
    throw new Error("Tunnel control-plane proxy may not contain a path, query string, or fragment.");
  }
  return url.toString();
}

export function secureTunnelProxyDisplay(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

function normalizePermissionModelVersion(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : 1;
}

function normalizePermissionLevel(value: unknown): DesktopPermissionLevel {
  return value === "observe" || value === "workspace" || value === "consequential"
    ? value
    : DEFAULT_CONTROL_PLANE_SETTINGS.rememberedPermissionProfile;
}

function normalizePermissionProfile(value: unknown): DesktopPermissionProfile {
  return value === "observe" ||
    value === "workspace" ||
    value === "consequential" ||
    value === "bypass"
    ? value
    : DEFAULT_CONTROL_PLANE_SETTINGS.permissionProfile;
}

export async function readControlPlaneSettings(settingsPath: string): Promise<ControlPlaneSettings> {
  try {
    const source = await readFile(settingsPath, "utf8");
    const jsonSource = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    const parsed: unknown = JSON.parse(jsonSource);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULT_CONTROL_PLANE_SETTINGS;
    }
    const candidate = parsed as Partial<ControlPlaneSettings>;
    let webBridgeUrl: string | null = null;
    if (typeof candidate.webBridgeUrl === "string" && candidate.webBridgeUrl.trim().length > 0) {
      try {
        webBridgeUrl = normalizeWebBridgeUrl(candidate.webBridgeUrl);
      } catch {
        webBridgeUrl = null;
      }
    }
    let secureTunnelId: string | null = null;
    if (typeof candidate.secureTunnelId === "string" && candidate.secureTunnelId.trim().length > 0) {
      try {
        secureTunnelId = normalizeSecureTunnelId(candidate.secureTunnelId);
      } catch {
        secureTunnelId = null;
      }
    }
    let secureTunnelExecutablePath: string | null = null;
    if (
      typeof candidate.secureTunnelExecutablePath === "string" &&
      candidate.secureTunnelExecutablePath.trim().length > 0
    ) {
      try {
        secureTunnelExecutablePath = normalizeSecureTunnelExecutablePath(candidate.secureTunnelExecutablePath);
      } catch {
        secureTunnelExecutablePath = null;
      }
    }
    const secureTunnelExecutableSha256 =
      typeof candidate.secureTunnelExecutableSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(candidate.secureTunnelExecutableSha256)
        ? candidate.secureTunnelExecutableSha256
        : null;
    const secureTunnelRuntimeKeyEncrypted =
      typeof candidate.secureTunnelRuntimeKeyEncrypted === "string" &&
      candidate.secureTunnelRuntimeKeyEncrypted.length > 0 &&
      candidate.secureTunnelRuntimeKeyEncrypted.length <= 16_384
        ? candidate.secureTunnelRuntimeKeyEncrypted
        : null;
    const secureTunnelControlPlaneProxyEncrypted =
      typeof candidate.secureTunnelControlPlaneProxyEncrypted === "string" &&
      candidate.secureTunnelControlPlaneProxyEncrypted.length > 0 &&
      candidate.secureTunnelControlPlaneProxyEncrypted.length <= 16_384
        ? candidate.secureTunnelControlPlaneProxyEncrypted
        : null;
    const secureTunnelControlPlaneBackupProxyEncrypted =
      typeof candidate.secureTunnelControlPlaneBackupProxyEncrypted === "string" &&
      candidate.secureTunnelControlPlaneBackupProxyEncrypted.length > 0 &&
      candidate.secureTunnelControlPlaneBackupProxyEncrypted.length <= 16_384
        ? candidate.secureTunnelControlPlaneBackupProxyEncrypted
        : null;
    const permissionProfile = normalizePermissionProfile(candidate.permissionProfile);
    const rememberedPermissionProfile = normalizePermissionLevel(
      candidate.rememberedPermissionProfile ??
        (permissionProfile === "bypass" ? undefined : permissionProfile),
    );
    const permissionBypassGrantEncrypted =
      typeof candidate.permissionBypassGrantEncrypted === "string" &&
      candidate.permissionBypassGrantEncrypted.length > 0 &&
      candidate.permissionBypassGrantEncrypted.length <= 16_384
        ? candidate.permissionBypassGrantEncrypted
        : null;
    return {
      projectWorkspaces: normalizeProjectWorkspaceSettings(candidate.projectWorkspaces),
      workspaceRoot:
        typeof candidate.workspaceRoot === "string" && candidate.workspaceRoot.trim().length > 0
          ? resolve(candidate.workspaceRoot)
          : null,
      permissionModelVersion: normalizePermissionModelVersion(candidate.permissionModelVersion),
      permissionWorkspaceRoot:
        typeof candidate.permissionWorkspaceRoot === "string" &&
        candidate.permissionWorkspaceRoot.trim().length > 0
          ? resolve(candidate.permissionWorkspaceRoot)
          : null,
      permissionProfile,
      rememberedPermissionProfile,
      permissionBypassGrantEncrypted,
      unattendedWorkspaceRoot:
        typeof candidate.unattendedWorkspaceRoot === "string" &&
        candidate.unattendedWorkspaceRoot.trim().length > 0
          ? resolve(candidate.unattendedWorkspaceRoot)
          : null,
      autoStart: typeof candidate.autoStart === "boolean"
        ? candidate.autoStart
        : DEFAULT_CONTROL_PLANE_SETTINGS.autoStart,
      webBridgeUrl,
      secureTunnelId,
      secureTunnelExecutablePath,
      secureTunnelExecutableSha256,
      secureTunnelRuntimeKeyEncrypted,
      secureTunnelControlPlaneProxyEncrypted,
      secureTunnelControlPlaneBackupProxyEncrypted,
      secureTunnelControlPlaneDirectFallback:
        typeof candidate.secureTunnelControlPlaneDirectFallback === "boolean"
          ? candidate.secureTunnelControlPlaneDirectFallback
          : DEFAULT_CONTROL_PLANE_SETTINGS.secureTunnelControlPlaneDirectFallback,
      secureTunnelAutoStart: typeof candidate.secureTunnelAutoStart === "boolean"
        ? candidate.secureTunnelAutoStart
        : DEFAULT_CONTROL_PLANE_SETTINGS.secureTunnelAutoStart,
      secureTunnelAutoReconnect: typeof candidate.secureTunnelAutoReconnect === "boolean"
        ? candidate.secureTunnelAutoReconnect
        : DEFAULT_CONTROL_PLANE_SETTINGS.secureTunnelAutoReconnect,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_CONTROL_PLANE_SETTINGS;
    }
    throw error;
  }
}

export async function writeControlPlaneSettings(
  settingsPath: string,
  settings: ControlPlaneSettings,
): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, settingsPath);
}
