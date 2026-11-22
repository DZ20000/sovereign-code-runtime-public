import type { DesktopRuntimeState } from "../shared.js";
import { requiredElement, tunnelDisplayState } from "./connection-presentation.js";

export interface ChatGptConnectionDraft {
  tunnelId: string | null;
  tunnelIdDirty: boolean;
  webBridgeUrl: string | null;
  webBridgeDirty: boolean;
}

export function createChatGptConnectionView(options: {
  formatTimestamp: (value: string) => string;
  renderPermissions: (state: DesktopRuntimeState) => void;
}) {
  const { formatTimestamp, renderPermissions: renderPermissionChoiceState } = options;
  let currentState: DesktopRuntimeState | null = null;
  let pending = false;
  const draft: ChatGptConnectionDraft = { tunnelId: null, tunnelIdDirty: false, webBridgeUrl: null, webBridgeDirty: false };

  const ROUTE_STATUS_LABELS: Readonly<Record<string, string>> = {
    ready: "Ready",
    failed: "Failed",
    probing: "Probing",
    "cooling-down": "Cooling down",
    untested: "Untested",
    disabled: "Disabled",
  };

  /**
   * Every configured control-plane route in priority order, kept with the
   * detailed proxy diagnostics in the advanced connection fold.
   */
  type ControlPlaneRoutingView =
    DesktopRuntimeState["secureTunnel"]["controlPlaneRouting"];

  function renderRouteStrip(routing: ControlPlaneRoutingView): void {
    const strip = requiredElement<HTMLUListElement>("#agent-route-strip");
    strip.replaceChildren();
    for (const id of routing.routeOrder) {
      const route = routing.routes[id];
      if (route === undefined) {
        continue;
      }
      const row = document.createElement("li");
      row.className = "agent-route-row";
      row.dataset["routeStatus"] = route.status;
      if (routing.activeRoute === id) {
        row.classList.add("is-active");
      }
      const target = document.createElement("span");
      target.className = "agent-route-target";
      target.textContent = route.display;
      const status = document.createElement("span");
      status.className = "agent-route-status";
      status.textContent = ROUTE_STATUS_LABELS[route.status] ?? route.status;
      row.append(target, status);
      strip.append(row);
    }
    strip.hidden = routing.routeOrder.length === 0;
  }

  function renderControlPlaneRouting(
    tunnel: DesktopRuntimeState["secureTunnel"],
    tunnelLocked: boolean,
  ): void {
    const routing = tunnel.controlPlaneRouting;
    const backupInput = requiredElement<HTMLInputElement>(
      "#secure-tunnel-backup-proxy",
    );
    backupInput.disabled = tunnelLocked || !tunnel.controlPlaneProxyConfigured;
    backupInput.placeholder = tunnel.controlPlaneBackupProxyConfigured
      ? "Saved securely · leave blank to reuse"
      : "http://independent-backup:port";

    const backupStorage = requiredElement<HTMLElement>(
      "#secure-tunnel-backup-proxy-storage",
    );
    backupStorage.textContent =
      tunnel.controlPlaneBackupProxyStorage === "windows-protected"
        ? `Saved with Windows DPAPI · ${tunnel.controlPlaneBackupProxyDisplay ?? "backup proxy configured"}. Use an independent service or exit when possible.`
        : tunnel.controlPlaneBackupProxyStorage === "memory-only"
          ? `Available for this session only · ${tunnel.controlPlaneBackupProxyDisplay ?? "backup proxy configured"}. Re-enter it after restart.`
          : tunnel.controlPlaneProxyConfigured
            ? "Not configured · use an endpoint with an independent service or exit when possible."
            : "Save the primary proxy before configuring a backup route.";
    backupStorage.classList.toggle(
      "is-warning",
      tunnel.controlPlaneBackupProxyStorage === "memory-only",
    );
    requiredElement<HTMLButtonElement>(
      "#secure-tunnel-save-backup-proxy",
    ).disabled = tunnelLocked || !tunnel.controlPlaneProxyConfigured;
    requiredElement<HTMLButtonElement>(
      "#secure-tunnel-clear-backup-proxy",
    ).disabled = !tunnel.controlPlaneBackupProxyConfigured || tunnelLocked;

    const directFallback = requiredElement<HTMLInputElement>(
      "#secure-tunnel-direct-fallback",
    );
    directFallback.checked = tunnel.controlPlaneDirectFallbackEnabled;
    directFallback.disabled = tunnelLocked || !tunnel.controlPlaneProxyConfigured;
    requiredElement<HTMLElement>(
      "#secure-tunnel-direct-fallback-label",
    ).textContent = tunnel.controlPlaneDirectFallbackEnabled ? "On" : "Off";

    renderRouteStrip(routing);

    const routeState = requiredElement<HTMLElement>("#secure-tunnel-route-state");
    const activeRoute = routing.activeRoute;
    routeState.className = "agent-route-state";
    if (routing.lifecycle === "circuit-open") {
      routeState.textContent = "Circuit open";
      routeState.classList.add("is-danger");
    } else if (routing.lifecycle === "needs-attention") {
      routeState.textContent = "Needs attention";
      routeState.classList.add("is-danger");
    } else if (!routing.enabled) {
      routeState.textContent = "Single route";
    } else if (activeRoute === null) {
      routeState.textContent = "Waiting";
      routeState.classList.add("is-pending");
    } else {
      routeState.textContent = routing.activeRouteDisplay ?? activeRoute;
      const activeStatus = routing.routes[activeRoute].status;
      if (activeStatus === "ready") {
        routeState.classList.add("is-ready");
      } else if (activeStatus === "failed") {
        routeState.classList.add("is-danger");
      } else {
        routeState.classList.add("is-pending");
      }
    }

    const routeList = requiredElement<HTMLDivElement>(
      "#secure-tunnel-route-list",
    );
    routeList.replaceChildren();
    const routeLabels = {
      primary: "Primary proxy",
      backup: "Backup proxy",
      direct: "Direct fallback",
    } as const;
    const statusLabels = {
      disabled: "Disabled",
      untested: "Untested",
      probing: "Connecting",
      ready: "Ready",
      "cooling-down": "Cooling down",
      failed: "Failed",
    } as const;
    for (const route of ["primary", "backup", "direct"] as const) {
      const routeView = routing.routes[route];
      const row = document.createElement("div");
      row.className = `agent-route-row route-status-${routeView.status}`;
      const identity = document.createElement("div");
      const label = document.createElement("strong");
      label.textContent = routeLabels[route];
      const display = document.createElement("span");
      display.textContent = routeView.display;
      identity.append(label, display);
      const status = document.createElement("b");
      status.textContent = routeView.configured
        ? statusLabels[routeView.status]
        : "Not configured";
      row.classList.toggle("is-active", route === activeRoute);
      row.append(identity, status);
      routeList.append(row);
    }

    const routeDetail = requiredElement<HTMLElement>(
      "#secure-tunnel-route-detail",
    );
    if (routing.circuitReason !== null) {
      routeDetail.textContent = routing.circuitReason;
    } else if (tunnel.failureDiagnostic !== null) {
      routeDetail.textContent = `${tunnel.failureDiagnostic.summary} ${tunnel.failureDiagnostic.detail}`;
    } else if (tunnel.nextReconnectAt !== null) {
      routeDetail.textContent = `Recovery attempt ${tunnel.reconnectAttempt} is scheduled for ${formatTimestamp(tunnel.nextReconnectAt)}.`;
    } else if (!routing.enabled) {
      routeDetail.textContent = tunnel.controlPlaneProxyConfigured
        ? "Single proxy route active. Configure a backup proxy to enable classified failover."
        : "Direct control-plane route active. Configure a primary proxy when the network requires one.";
    } else {
      routeDetail.textContent = `${routing.activeRouteDisplay ?? "No route active"} · ${routing.switchCount} switch${routing.switchCount === 1 ? "" : "es"}${routing.lastSwitchAt === null ? "" : ` · last ${formatTimestamp(routing.lastSwitchAt)}`}.`;
    }
  }

  function updateTunnelStartAvailability(): void {
    const state = currentState;
    if (state === null) {
      return;
    }
    const tunnel = state.secureTunnel;
    const tunnelId =
      requiredElement<HTMLInputElement>("#secure-tunnel-id").value.trim();
    const keyDraft = requiredElement<HTMLInputElement>(
      "#secure-tunnel-api-key",
    ).value.trim();
    const hasValidTunnelId = /^tunnel_[a-f0-9]{32}$/u.test(tunnelId);
    const hasRuntimeKey = tunnel.hasRuntimeApiKey || keyDraft.length > 0;
    const tunnelActive = ["starting", "running", "ready", "stopping"].includes(
      tunnel.phase,
    );
    const tunnelManaged = tunnelActive || tunnel.desiredRunning;
    const start = requiredElement<HTMLButtonElement>("#v2-chatgpt-drawer-start");
    start.disabled =
      pending ||
      state.phase !== "running" ||
      !tunnel.clientAvailable ||
      tunnelManaged ||
      !hasValidTunnelId ||
      !hasRuntimeKey;

    const cardStart = requiredElement<HTMLButtonElement>("#secure-tunnel-start");
    cardStart.disabled = pending || tunnelManaged;
    cardStart.textContent = pending ? "Working…" : state.phase !== "running" ? "Open host"
      : !tunnel.clientAvailable || !/^tunnel_[a-f0-9]{32}$/u.test(tunnel.tunnelId ?? "") || !tunnel.hasRuntimeApiKey ? "Configure" : "Start";
    requiredElement<HTMLButtonElement>("#v2-chatgpt-copy").disabled =
      !/^tunnel_[a-f0-9]{32}$/u.test(tunnel.tunnelId ?? "");

    const instructions = requiredElement<HTMLElement>(
      "#secure-tunnel-instructions",
    );
    if (state.phase !== "running") {
      instructions.textContent = "Start the local Gateway first.";
    } else if (!tunnel.clientAvailable) {
      instructions.textContent =
        "Choose the installed tunnel-client.exe, or make it available on PATH.";
    } else if (!hasValidTunnelId) {
      instructions.textContent =
        "Paste the actual Tunnel ID from OpenAI Platform.";
    } else if (!hasRuntimeKey) {
      instructions.textContent =
        "Paste the Tunnel runtime key. Sovereign will protect it with your Windows account for reuse.";
    } else if (!tunnel.executableTrusted) {
      instructions.textContent =
        "Start will show the resolved client path and SHA-256 for local trust confirmation.";
    } else if (tunnel.controlPlaneRouting.lifecycle === "circuit-open") {
      instructions.textContent =
        "All configured control-plane routes failed. Review the route evidence, then Start to reset the route circuit.";
    } else if (tunnel.controlPlaneRouting.lifecycle === "needs-attention") {
      instructions.textContent =
        tunnel.failureDiagnostic?.summary ??
        "The connection needs local attention before it can restart.";
    } else if (tunnel.nextReconnectAt !== null) {
      instructions.textContent = `Connector restart attempt ${tunnel.reconnectAttempt} is scheduled for ${formatTimestamp(tunnel.nextReconnectAt)}. Stop the tunnel to cancel supervision.`;
    } else if (tunnel.phase === "ready") {
      instructions.textContent = "Tunnel is ready. Connect the Sovereign app from ChatGPT.";
    } else if (tunnel.phase === "running" || tunnel.phase === "starting") {
      instructions.textContent = "Tunnel connection is being established.";
    } else {
      instructions.textContent = "Ready to start the Secure MCP Tunnel.";
    }
  }

  function renderWebAgentState(state: DesktopRuntimeState): void {
    currentState = state;
    renderPermissionChoiceState(state);
    requiredElement<HTMLElement>("#web-agent-endpoint").textContent =
      state.endpoint ?? "Start the runtime to create an endpoint.";
    const tunnel = state.secureTunnel;
    requiredElement<HTMLElement>("#secure-tunnel-path").textContent =
      tunnel.executablePath ?? "Not detected";
    const tunnelDisplay = tunnelDisplayState(state);


    const tunnelIdInput = requiredElement<HTMLInputElement>("#secure-tunnel-id");
    if (draft.tunnelId === null) {
      draft.tunnelId = tunnel.tunnelId ?? "";
    } else if (
      !draft.tunnelIdDirty &&
      tunnel.tunnelId !== null &&
      tunnel.tunnelId !== draft.tunnelId
    ) {
      draft.tunnelId = tunnel.tunnelId;
    }
    if (document.activeElement !== tunnelIdInput) {
      tunnelIdInput.value = draft.tunnelId;
    }
    const tunnelStatus = requiredElement<HTMLElement>("#secure-tunnel-status");
    tunnelStatus.textContent =
      tunnel.errorMessage ??
      tunnel.failureDiagnostic?.summary ??
      tunnelDisplay.label;
    tunnelStatus.title =
      tunnel.failureDiagnostic === null
        ? ""
        : `${tunnel.failureDiagnostic.failureClass} · ${tunnel.failureDiagnostic.source} · ${tunnel.failureDiagnostic.detail}`;
    tunnelStatus.className = "connection-feedback";
    requiredElement<HTMLButtonElement>("#secure-tunnel-retry").hidden =
      tunnel.clientAvailable;
    const tunnelActive = ["starting", "running", "ready", "stopping"].includes(
      tunnel.phase,
    );
    const tunnelManaged = tunnelActive || tunnel.desiredRunning;
    const tunnelLocked = tunnelManaged || pending;
    for (const selector of ["#secure-tunnel-start", "#v2-chatgpt-drawer-start"]) {
      requiredElement<HTMLButtonElement>(selector).hidden = tunnelManaged;
    }
    for (const selector of ["#secure-tunnel-stop", "#v2-chatgpt-drawer-stop"]) {
      const button = requiredElement<HTMLButtonElement>(selector);
      button.hidden = !tunnelManaged;
      button.disabled = pending || !tunnelManaged || tunnel.phase === "stopping";
      button.classList.remove("button-primary");
      button.classList.add("button-secondary");
    }
    tunnelIdInput.disabled = tunnelLocked;
    requiredElement<HTMLButtonElement>("#secure-tunnel-choose").disabled = tunnelLocked;
    requiredElement<HTMLButtonElement>("#secure-tunnel-refresh").disabled = pending || tunnel.phase === "stopping";
    requiredElement<HTMLButtonElement>("#secure-tunnel-retry").disabled = pending;
    const runtimeKeyInput = requiredElement<HTMLInputElement>(
      "#secure-tunnel-api-key",
    );
    runtimeKeyInput.disabled = tunnelLocked;
    runtimeKeyInput.placeholder = tunnel.hasRuntimeApiKey
      ? "Saved securely · leave blank to reuse"
      : "Paste runtime key";
    const runtimeKeyStorage = requiredElement<HTMLElement>(
      "#secure-tunnel-key-storage",
    );
    runtimeKeyStorage.textContent =
      tunnel.runtimeApiKeyStorage === "windows-protected"
        ? "Saved with Windows DPAPI · leave this field blank to reuse it after restart."
        : tunnel.runtimeApiKeyStorage === "memory-only"
          ? "Available for this session only · Windows protection failed, so re-enter it after restart."
          : "Not saved · paste once and Sovereign will protect it with your Windows account.";
    runtimeKeyStorage.classList.toggle(
      "is-warning",
      tunnel.runtimeApiKeyStorage === "memory-only",
    );
    requiredElement<HTMLButtonElement>("#secure-tunnel-clear-key").disabled =
      !tunnel.hasRuntimeApiKey || tunnelLocked;

    const proxyInput = requiredElement<HTMLInputElement>("#secure-tunnel-proxy");
    proxyInput.disabled = tunnelLocked;
    proxyInput.placeholder = tunnel.controlPlaneProxyConfigured
      ? "Saved securely · leave blank to reuse"
      : "http://proxy-host:port";
    const proxyStorage = requiredElement<HTMLElement>(
      "#secure-tunnel-proxy-storage",
    );
    proxyStorage.textContent =
      tunnel.controlPlaneProxyStorage === "windows-protected"
        ? `Saved with Windows DPAPI · ${tunnel.controlPlaneProxyDisplay ?? "proxy configured"}. Only OpenAI control-plane requests use it; local MCP remains direct.`
        : tunnel.controlPlaneProxyStorage === "memory-only"
          ? `Available for this session only · ${tunnel.controlPlaneProxyDisplay ?? "proxy configured"}. Re-enter it after restart; local MCP remains direct.`
          : "Not configured · only OpenAI control-plane requests use this proxy; the local MCP endpoint remains direct on 127.0.0.1.";
    proxyStorage.classList.toggle(
      "is-warning",
      tunnel.controlPlaneProxyStorage === "memory-only",
    );
    requiredElement<HTMLButtonElement>("#secure-tunnel-save-proxy").disabled =
      tunnelLocked;
    requiredElement<HTMLButtonElement>("#secure-tunnel-clear-proxy").disabled =
      !tunnel.controlPlaneProxyConfigured || tunnelLocked;
    renderControlPlaneRouting(tunnel, tunnelLocked);

    const bridgeInput = requiredElement<HTMLInputElement>("#web-bridge-url");
    bridgeInput.disabled = pending;
    requiredElement<HTMLButtonElement>("#web-save-bridge").disabled = pending;
    requiredElement<HTMLButtonElement>("#web-clear-bridge").disabled = pending;
    if (draft.webBridgeUrl === null || !draft.webBridgeDirty) draft.webBridgeUrl = state.webBridgeUrl ?? "";
    if (document.activeElement !== bridgeInput) bridgeInput.value = draft.webBridgeUrl;
    requiredElement<HTMLElement>("#web-bridge-status").textContent =
      state.webBridgeUrl === null
        ? "No remote bridge configured. Local MCP remains available to local clients."
        : `Saved bridge · ${state.webBridgeUrl}`;
    requiredElement<HTMLElement>("#web-connection-target").textContent =
      tunnel.phase === "ready"
        ? "Secure MCP Tunnel is ready; use its tunnel ID in ChatGPT. This bundle remains for local/fallback connections."
        : state.webBridgeUrl === null
          ? "Current bundle targets the local Gateway only. Configure the Secure MCP Tunnel above or a fallback HTTPS bridge."
          : `Fallback MCP bundle target · ${state.webBridgeUrl}`;

    const clientBadge = requiredElement<HTMLElement>("#web-agent-client");
    clientBadge.textContent = tunnelDisplay.label;
    clientBadge.className = `connection-status state-${tunnelDisplay.tone}`;
    requiredElement<HTMLButtonElement>("#web-copy-connection").disabled =
      state.phase !== "running";
    updateTunnelStartAvailability();
  }

  return {
    draft, render: renderWebAgentState, updateAvailability: updateTunnelStartAvailability,
    setPending(value: boolean) { pending = value; if (currentState !== null) renderWebAgentState(currentState); },
  };
}
