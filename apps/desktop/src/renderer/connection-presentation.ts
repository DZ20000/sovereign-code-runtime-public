import type { DesktopPermissionProfile, DesktopRuntimeState } from "../shared.js";

export const phaseLabels: Readonly<Record<DesktopRuntimeState["phase"], string>> = {
  "setup-required": "Setup required",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  error: "Error",
};

export const permissionProfileLabels: Readonly<
  Record<DesktopPermissionProfile, string>
> = {
  observe: "Read only",
  workspace: "Work in this folder",
  consequential: "Ask for high-risk actions",
  bypass: "Bypass confirmations",
};

export const permissionProfileCodes: Readonly<
  Record<DesktopPermissionProfile, string>
> = {
  observe: "L1",
  workspace: "L2",
  consequential: "L3",
  bypass: "L4",
};

export function permissionProfileDisplay(profile: DesktopPermissionProfile): string {
  return `${permissionProfileLabels[profile]} · ${permissionProfileCodes[profile]}`;
}

export const permissionProfileDescriptions: Readonly<
  Record<DesktopPermissionProfile, string>
> = {
  observe: "Read-only access",
  workspace: "Can work inside this folder",
  consequential: "High-risk actions ask every time",
  bypass: "Per-action confirmation is off",
};

export const secureTunnelPhaseLabels: Readonly<
  Record<DesktopRuntimeState["secureTunnel"]["phase"], string>
> = {
  unavailable: "Not installed",
  stopped: "Stopped",
  starting: "Starting",
  running: "Connecting",
  ready: "Ready",
  stopping: "Stopping",
  error: "Error",
};

export function tunnelDisplayState(state: DesktopRuntimeState): {
  readonly label: string;
  readonly tone: "neutral" | "pending" | "success" | "error";
} {
  const tunnel = state.secureTunnel;
  if (!tunnel.clientAvailable) {
    return {
      label:
        tunnel.tunnelId === null
          ? "Connector not installed"
          : "Connector missing",
      tone: tunnel.tunnelId === null ? "neutral" : "pending",
    };
  }
  if (tunnel.controlPlaneRouting.lifecycle === "circuit-open") {
    return { label: "Route circuit open", tone: "error" };
  }
  if (tunnel.controlPlaneRouting.lifecycle === "needs-attention") {
    return { label: "Connection needs attention", tone: "error" };
  }
  if (tunnel.nextReconnectAt !== null) {
    return { label: "Route retry scheduled", tone: "pending" };
  }
  if (tunnel.errorMessage !== null || tunnel.phase === "error") {
    return { label: "Connector error", tone: "error" };
  }
  if (!tunnel.executableTrusted) {
    return { label: "Connector trust required", tone: "pending" };
  }
  if (tunnel.tunnelId === null) {
    return { label: "Tunnel not configured", tone: "neutral" };
  }
  if (!tunnel.hasRuntimeApiKey && tunnel.phase === "stopped") {
    return { label: "Runtime key missing", tone: "pending" };
  }
  if (tunnel.phase === "ready") {
    return { label: "Tunnel ready", tone: "success" };
  }
  if (tunnel.phase === "starting") {
    return { label: "Tunnel starting", tone: "pending" };
  }
  if (tunnel.phase === "running") {
    return { label: "Tunnel connecting", tone: "pending" };
  }
  if (tunnel.phase === "stopping") {
    return { label: "Tunnel stopping", tone: "pending" };
  }
  return { label: "Tunnel stopped", tone: "neutral" };
}

export function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Required UI element is missing: ${selector}`);
  return element;
}
