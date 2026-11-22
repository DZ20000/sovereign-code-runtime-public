import type { SovereignDesktopApi } from "@sovereign/control-plane-contract";
import type { DesktopRuntimeState } from "../shared.js";
import { createChatGptConnectionView } from "./chatgpt-connection-state.js";
import { requiredElement, secureTunnelPhaseLabels } from "./connection-presentation.js";

export function createChatGptConnectionController(options: {
  api: SovereignDesktopApi;
  notify: (message: string, isError?: boolean) => void;
  onStateChanged: (state: DesktopRuntimeState) => void;
  formatTimestamp: (value: string) => string;
  renderPermissions: (state: DesktopRuntimeState) => void;
  copyConnectionBundle: () => Promise<void>;
  openConfiguration: (provider: "chatgpt" | "advanced") => void;
}) {
  const { api, notify: showToast, onStateChanged: renderState, copyConnectionBundle } = options;
  const view = createChatGptConnectionView(options);
  const { draft, updateAvailability: updateTunnelStartAvailability } = view;
  let currentState: DesktopRuntimeState | null = null;
  let pending = false;

  async function perform(operation: () => Promise<void>): Promise<void> {
    if (pending) return;
    pending = true;
    view.setPending(true);
    try { await operation(); }
    finally { pending = false; view.setPending(false); }
  }
  function managed(): boolean {
    const tunnel = currentState?.secureTunnel;
    return tunnel !== undefined && (tunnel.desiredRunning || ["starting", "running", "ready", "stopping"].includes(tunnel.phase));
  }
  function canStart(): boolean {
    if (currentState?.phase !== "running") { options.openConfiguration("advanced"); return false; }
    if (!currentState.secureTunnel.clientAvailable) { options.openConfiguration("chatgpt"); return false; }
    return !managed();
  }
  async function startSavedTunnel(): Promise<void> {
    if (!canStart()) return;
    const tunnel = currentState!.secureTunnel;
    if (!/^tunnel_[a-f0-9]{32}$/u.test(tunnel.tunnelId ?? "") || !tunnel.hasRuntimeApiKey) {
      options.openConfiguration("chatgpt");
      return;
    }
    try {
      const state = await api.startSecureTunnel();
      renderState(state);
      showToast(state.secureTunnel.phase === "ready" ? "Secure MCP Tunnel is ready for ChatGPT Web."
        : (state.secureTunnel.errorMessage ?? "Secure MCP Tunnel started; readiness is still pending."),
      state.secureTunnel.phase === "error" || state.secureTunnel.phase === "unavailable");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not start Secure MCP Tunnel.", true);
    }
  }

  async function updateWebBridgeUrl(value: string | null): Promise<void> {
    const save = requiredElement<HTMLButtonElement>("#web-save-bridge");
    const clear = requiredElement<HTMLButtonElement>("#web-clear-bridge");
    save.disabled = true;
    clear.disabled = true;
    try {
      const state = await api.setWebBridgeUrl(value);
      draft.webBridgeUrl = state.webBridgeUrl ?? "";
      draft.webBridgeDirty = false;
      renderState(state);
      showToast(
        state.webBridgeUrl === null
          ? "Fallback MCP bridge cleared."
          : "Fallback MCP bridge saved.",
      );
    } catch (error) {
      if (currentState !== null) {
        renderState(currentState);
      }
      showToast(
        error instanceof Error
          ? error.message
          : "Could not update the web bridge URL.",
        true,
      );
    } finally {
      save.disabled = false;
      clear.disabled = false;
    }
  }

  async function chooseSecureTunnelExecutable(): Promise<void> {
    try {
      const previousPath = currentState?.secureTunnel.executablePath ?? null;
      const state = await api.chooseSecureTunnelExecutable();
      renderState(state);
      const nextPath = state.secureTunnel.executablePath;
      showToast(
        nextPath !== null && nextPath !== previousPath
          ? "Connector selected. Start the tunnel to review and trust its SHA-256."
          : "Connector selection cancelled.",
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not choose the tunnel connector.",
        true,
      );
    }
  }

  async function startSecureTunnel(): Promise<void> {
    if (!canStart()) return;
    const tunnelId =
      requiredElement<HTMLInputElement>("#secure-tunnel-id").value.trim();
    const apiKeyInput = requiredElement<HTMLInputElement>(
      "#secure-tunnel-api-key",
    );
    const runtimeApiKey = apiKeyInput.value.trim();
    const proxyInput = requiredElement<HTMLInputElement>("#secure-tunnel-proxy");
    const controlPlaneProxyUrl = proxyInput.value.trim();
    const backupProxyInput = requiredElement<HTMLInputElement>(
      "#secure-tunnel-backup-proxy",
    );
    const controlPlaneBackupProxyUrl = backupProxyInput.value.trim();
    const controlPlaneDirectFallbackEnabled = requiredElement<HTMLInputElement>(
      "#secure-tunnel-direct-fallback",
    ).checked;
    if (!/^tunnel_[a-f0-9]{32}$/u.test(tunnelId)) {
      showToast(
        "Paste the actual Tunnel ID from OpenAI Platform. The gray example text is not a configured tunnel.",
        true,
      );
      return;
    }
    if (
      runtimeApiKey.length === 0 &&
      currentState?.secureTunnel.hasRuntimeApiKey !== true
    ) {
      showToast(
        "Paste a Tunnel runtime API key before starting. Sovereign will protect it with your Windows account for reuse.",
        true,
      );
      return;
    }
    try {
      let state = await api.configureSecureTunnel({
        tunnelId,
        ...(runtimeApiKey.length === 0 ? {} : { runtimeApiKey }),
        ...(controlPlaneProxyUrl.length === 0 ? {} : { controlPlaneProxyUrl }),
        ...(controlPlaneBackupProxyUrl.length === 0
          ? {}
          : { controlPlaneBackupProxyUrl }),
        controlPlaneDirectFallbackEnabled,
      });
      draft.tunnelId = state.secureTunnel.tunnelId ?? "";
      draft.tunnelIdDirty = false;
      renderState(state);
      state = await api.startSecureTunnel();
      apiKeyInput.value = "";
      proxyInput.value = "";
      backupProxyInput.value = "";
      renderState(state);
      showToast(
        state.secureTunnel.phase === "ready"
          ? "Secure MCP Tunnel is ready for ChatGPT Web."
          : (state.secureTunnel.errorMessage ??
              "Secure MCP Tunnel started; readiness is still pending."),
        state.secureTunnel.phase === "error" ||
          state.secureTunnel.phase === "unavailable",
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not start Secure MCP Tunnel.",
        true,
      );
    }
  }

  async function stopSecureTunnel(): Promise<void> {
    try {
      const state = await api.stopSecureTunnel();
      renderState(state);
      showToast("Secure MCP Tunnel stopped.");
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not stop Secure MCP Tunnel.",
        true,
      );
    }
  }

  async function refreshSecureTunnel(): Promise<void> {
    try {
      const state = await api.refreshSecureTunnel();
      renderState(state);
      showToast(
        `Secure MCP Tunnel · ${secureTunnelPhaseLabels[state.secureTunnel.phase]}.`,
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not refresh Secure MCP Tunnel.",
        true,
      );
    }
  }

  async function clearSecureTunnelKey(): Promise<void> {
    try {
      const tunnelId = currentState?.secureTunnel.tunnelId ?? null;
      const state = await api.configureSecureTunnel({
        tunnelId,
        clearRuntimeApiKey: true,
      });
      requiredElement<HTMLInputElement>("#secure-tunnel-api-key").value = "";
      renderState(state);
      showToast(
        "Tunnel runtime API key forgotten from Windows-protected storage and memory.",
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not clear the tunnel runtime key.",
        true,
      );
    }
  }

  function configuredTunnelIdDraft(): string | null {
    const tunnelIdDraft =
      requiredElement<HTMLInputElement>("#secure-tunnel-id").value.trim();
    if (tunnelIdDraft.length === 0) {
      return currentState?.secureTunnel.tunnelId ?? null;
    }
    return /^tunnel_[a-f0-9]{32}$/u.test(tunnelIdDraft) ? tunnelIdDraft : null;
  }

  async function saveSecureTunnelProxy(): Promise<void> {
    const input = requiredElement<HTMLInputElement>("#secure-tunnel-proxy");
    const value = input.value.trim();
    if (value.length === 0) {
      showToast(
        "Enter an HTTP or HTTPS control-plane proxy URL before saving.",
        true,
      );
      return;
    }
    const tunnelId = configuredTunnelIdDraft();
    if (tunnelId === null) {
      showToast("Fix the Tunnel ID before saving the control-plane proxy.", true);
      return;
    }
    try {
      const state = await api.configureSecureTunnel({
        tunnelId,
        controlPlaneProxyUrl: value,
      });
      input.value = "";
      renderState(state);
      showToast(
        state.secureTunnel.controlPlaneProxyStorage === "windows-protected"
          ? "Control-plane proxy saved with Windows protection."
          : "Control-plane proxy is available for this session only.",
        state.secureTunnel.controlPlaneProxyStorage === "memory-only",
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not save the control-plane proxy.",
        true,
      );
    }
  }

  async function clearSecureTunnelProxy(): Promise<void> {
    const tunnelId = currentState?.secureTunnel.tunnelId ?? null;
    try {
      const state = await api.configureSecureTunnel({
        tunnelId,
        clearControlPlaneProxy: true,
      });
      requiredElement<HTMLInputElement>("#secure-tunnel-proxy").value = "";
      renderState(state);
      showToast(
        "Control-plane proxy forgotten from Windows-protected storage and memory.",
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not clear the control-plane proxy.",
        true,
      );
    }
  }

  async function saveSecureTunnelBackupProxy(): Promise<void> {
    const input = requiredElement<HTMLInputElement>(
      "#secure-tunnel-backup-proxy",
    );
    const value = input.value.trim();
    if (value.length === 0) {
      showToast("Enter an HTTP or HTTPS backup proxy URL before saving.", true);
      return;
    }
    const tunnelId = configuredTunnelIdDraft();
    if (tunnelId === null) {
      showToast("Fix the Tunnel ID before saving the backup proxy.", true);
      return;
    }
    const primaryDraft = requiredElement<HTMLInputElement>(
      "#secure-tunnel-proxy",
    ).value.trim();
    if (
      primaryDraft.length === 0 &&
      currentState?.secureTunnel.controlPlaneProxyConfigured !== true
    ) {
      showToast(
        "Save the primary control-plane proxy before adding a backup.",
        true,
      );
      return;
    }
    try {
      const state = await api.configureSecureTunnel({
        tunnelId,
        ...(primaryDraft.length === 0
          ? {}
          : { controlPlaneProxyUrl: primaryDraft }),
        controlPlaneBackupProxyUrl: value,
      });
      input.value = "";
      if (primaryDraft.length > 0) {
        requiredElement<HTMLInputElement>("#secure-tunnel-proxy").value = "";
      }
      renderState(state);
      showToast(
        state.secureTunnel.controlPlaneBackupProxyStorage === "windows-protected"
          ? "Backup control-plane proxy saved with Windows protection."
          : "Backup control-plane proxy is available for this session only.",
        state.secureTunnel.controlPlaneBackupProxyStorage === "memory-only",
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not save the backup proxy.",
        true,
      );
    }
  }

  async function clearSecureTunnelBackupProxy(): Promise<void> {
    const tunnelId = currentState?.secureTunnel.tunnelId ?? null;
    try {
      const state = await api.configureSecureTunnel({
        tunnelId,
        clearControlPlaneBackupProxy: true,
      });
      requiredElement<HTMLInputElement>("#secure-tunnel-backup-proxy").value = "";
      renderState(state);
      showToast(
        "Backup control-plane proxy forgotten from Windows-protected storage and memory.",
      );
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Could not clear the backup proxy.",
        true,
      );
    }
  }

  async function updateSecureTunnelDirectFallback(
    enabled: boolean,
  ): Promise<void> {
    const toggle = requiredElement<HTMLInputElement>(
      "#secure-tunnel-direct-fallback",
    );
    toggle.disabled = true;
    const tunnelId = configuredTunnelIdDraft();
    if (tunnelId === null) {
      if (currentState !== null) {
        renderState(currentState);
      }
      showToast("Fix the Tunnel ID before changing direct fallback.", true);
      return;
    }
    const primaryDraft = requiredElement<HTMLInputElement>(
      "#secure-tunnel-proxy",
    ).value.trim();
    if (
      enabled &&
      primaryDraft.length === 0 &&
      currentState?.secureTunnel.controlPlaneProxyConfigured !== true
    ) {
      if (currentState !== null) {
        renderState(currentState);
      }
      showToast("Direct fallback requires a configured primary proxy.", true);
      return;
    }
    try {
      const state = await api.configureSecureTunnel({
        tunnelId,
        ...(primaryDraft.length === 0
          ? {}
          : { controlPlaneProxyUrl: primaryDraft }),
        controlPlaneDirectFallbackEnabled: enabled,
      });
      if (primaryDraft.length > 0) {
        requiredElement<HTMLInputElement>("#secure-tunnel-proxy").value = "";
      }
      renderState(state);
      showToast(
        enabled ? "Direct fallback enabled." : "Direct fallback disabled.",
      );
    } catch (error) {
      if (currentState !== null) {
        renderState(currentState);
      }
      showToast(
        error instanceof Error
          ? error.message
          : "Could not update direct fallback.",
        true,
      );
    }
  }

  requiredElement<HTMLButtonElement>("#web-copy-connection").addEventListener("click", () => { void copyConnectionBundle(); });
  requiredElement<HTMLButtonElement>("#v2-chatgpt-copy").addEventListener("click", () => {
    const tunnelId = currentState?.secureTunnel.tunnelId;
    if (!tunnelId || !/^tunnel_[a-f0-9]{32}$/u.test(tunnelId)) return;
    void navigator.clipboard.writeText(tunnelId).then(() => showToast("Tunnel ID copied."))
      .catch(() => showToast("Could not copy the Tunnel ID.", true));
  });
  requiredElement<HTMLInputElement>("#secure-tunnel-id").addEventListener("input", event => {
    draft.tunnelId = (event.currentTarget as HTMLInputElement).value;
    draft.tunnelIdDirty = true;
    updateTunnelStartAvailability();
  });
  const actions: readonly (readonly [string, () => Promise<void>])[] = [
    ["#secure-tunnel-choose", chooseSecureTunnelExecutable],
    ["#secure-tunnel-start", startSavedTunnel],
    ["#v2-chatgpt-drawer-start", startSecureTunnel],
    ["#secure-tunnel-stop", stopSecureTunnel],
    ["#v2-chatgpt-drawer-stop", stopSecureTunnel],
    ["#secure-tunnel-refresh", refreshSecureTunnel],
    ["#secure-tunnel-retry", refreshSecureTunnel],
    ["#secure-tunnel-clear-key", clearSecureTunnelKey],
    ["#secure-tunnel-save-proxy", saveSecureTunnelProxy],
    ["#secure-tunnel-clear-proxy", clearSecureTunnelProxy],
    ["#secure-tunnel-save-backup-proxy", saveSecureTunnelBackupProxy],
    ["#secure-tunnel-clear-backup-proxy", clearSecureTunnelBackupProxy],
    ["#web-save-bridge", () => updateWebBridgeUrl(requiredElement<HTMLInputElement>("#web-bridge-url").value.trim() || null)],
    ["#web-clear-bridge", () => updateWebBridgeUrl(null)],
  ];
  for (const [selector, operation] of actions) {
    requiredElement<HTMLButtonElement>(selector).addEventListener("click", () => { void perform(operation); });
  }
  requiredElement<HTMLInputElement>("#secure-tunnel-api-key").addEventListener("input", updateTunnelStartAvailability);
  const enterActions: readonly (readonly [string, () => Promise<void>])[] = [
    ["#secure-tunnel-api-key", startSecureTunnel],
    ["#secure-tunnel-proxy", saveSecureTunnelProxy],
    ["#secure-tunnel-backup-proxy", saveSecureTunnelBackupProxy],
    ["#web-bridge-url", () => updateWebBridgeUrl(requiredElement<HTMLInputElement>("#web-bridge-url").value.trim() || null)],
  ];
  for (const [selector, operation] of enterActions) {
    requiredElement<HTMLInputElement>(selector).addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); void perform(operation); }
    });
  }
  requiredElement<HTMLInputElement>("#secure-tunnel-direct-fallback").addEventListener("change", event => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void perform(() => updateSecureTunnelDirectFallback(enabled));
  });
  requiredElement<HTMLInputElement>("#web-bridge-url").addEventListener("input", event => {
    draft.webBridgeUrl = (event.currentTarget as HTMLInputElement).value;
    draft.webBridgeDirty = true;
  });
  return { render(state: DesktopRuntimeState) { currentState = state; view.render(state); } };
}
