import type { DesktopRuntimeState, SovereignDesktopApi } from "../shared.js";
import { createChatGptConnectionController } from "./chatgpt-connection-controller.js";
import { createGeminiConnectionController } from "./gemini-connection-controller.js";
import { requiredElement, tunnelDisplayState } from "./connection-presentation.js";

export type ConnectionProvider = "chatgpt" | "gemini" | "advanced";

export function createConnectionsController(options: {
  api: SovereignDesktopApi;
  notify: (message: string, isError?: boolean) => void;
  onStateChanged: (state: DesktopRuntimeState) => void;
  onConnectionsChanged: () => void;
  formatTimestamp: (value: string) => string;
  renderPermissions: (state: DesktopRuntimeState) => void;
  copyConnectionBundle: () => Promise<void>;
}) {
  let provider: ConnectionProvider = "chatgpt";
  let returnFocus: HTMLElement | null = null;
  const drawer = requiredElement<HTMLDialogElement>("#connection-drawer");
  const events = new AbortController();
  const chatgpt = createChatGptConnectionController({ ...options, openConfiguration: open });
  const gemini = createGeminiConnectionController({
    api: options.api,
    notify: options.notify,
    openConfiguration: open,
    onStatusChanged: () => options.onConnectionsChanged(),
  });

  function open(next: ConnectionProvider): void {
    if (!drawer.open) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (next !== provider) gemini.cancelDialogs();
    provider = next;
    drawer.dataset.provider = provider;
    for (const panel of drawer.querySelectorAll<HTMLElement>("[data-connection-panel]")) {
      panel.hidden = panel.dataset.connectionPanel !== provider;
    }
    requiredElement<HTMLElement>("#connection-drawer-title").textContent = provider === "chatgpt"
      ? "Connect ChatGPT" : provider === "gemini" ? "Connect Gemini" : "Advanced connections & host";
    if (!drawer.open) drawer.showModal();
    requiredElement<HTMLButtonElement>("#connection-drawer-close").focus();
    if (provider === "gemini") void gemini.refresh();
  }

  function close(): void {
    gemini.cancelDialogs();
    if (drawer.open) drawer.close();
  }

  drawer.addEventListener("close", () => {
    gemini.cancelDialogs();
    if (returnFocus?.isConnected && !(returnFocus instanceof HTMLButtonElement && returnFocus.disabled)) returnFocus.focus();
    else document.querySelector<HTMLButtonElement>('[data-open-connection="' + provider + '"]')?.focus();
    returnFocus = null;
  }, { signal: events.signal });
  drawer.addEventListener("cancel", (event) => {
    if (event.target !== drawer) return;
    event.preventDefault();
    close();
  }, { signal: events.signal });
  requiredElement<HTMLButtonElement>("#connection-drawer-close").addEventListener("click", close, { signal: events.signal });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close-connection]")) {
    button.addEventListener("click", close, { signal: events.signal });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-open-connection]")) {
    button.addEventListener("click", () => {
      const next = button.dataset.openConnection;
      if (next === "chatgpt" || next === "gemini" || next === "advanced") open(next);
    }, { signal: events.signal });
  }

  function summary(current: DesktopRuntimeState): { label: string; tone: "neutral" | "pending" | "success" | "error" } {
    if (current.phase !== "running") return { label: "Host offline", tone: current.phase === "error" ? "error" : "neutral" };
    // This host-wide summary never attributes total sessions to a provider.
    if (current.sessionCount > 0) return { label: "MCP active", tone: "success" };
    if (gemini.status?.phase === "listening") return { label: "Gemini listening", tone: "success" };
    if (current.secureTunnel.phase === "ready") return { label: "Tunnel ready", tone: "success" };
    if (gemini.status?.phase === "error") return { label: "Connection needs attention", tone: "error" };
    if (gemini.status?.configuration) return { label: "Connection saved", tone: "neutral" };
    return tunnelDisplayState(current);
  }

  return {
    open,
    close,
    render(current: DesktopRuntimeState) {
      chatgpt.render(current);
      gemini.setHostRunning(current.phase === "running");
      requiredElement<HTMLElement>("#connections-session-count").textContent = String(current.sessionCount);
    },
    refresh: gemini.refresh,
    summary,
    get geminiConfigured() {
      return gemini.status?.configuration != null && gemini.status.hasOwnerSubject && gemini.status.hasIntrospectionAuthorization;
    },
    get geminiListening() { return gemini.status?.phase === "listening"; },
    dispose() { events.abort(); gemini.cancelDialogs(); },
  };
}
