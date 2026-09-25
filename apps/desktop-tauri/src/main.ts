import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { DesktopRendererHandoff } from "@sovereign/control-plane-contract";

import { installTauriSovereignBridge } from "./bridge.js";

const RENDERER_BRIDGE_API_VERSION = 1;

type UiStartupStage = "zoom" | "bridge" | "handoff" | "renderer" | "ready";

function rendererReleaseIdFromLocation(): string | null {
  const match = /^\/release\/([a-z0-9][a-z0-9._-]{0,127})\//u.exec(
    window.location.pathname,
  );
  return match?.[1] ?? null;
}

function rendererActivationIdFromLocation(): string | null {
  return new URL(window.location.href).searchParams.get("rendererActivation");
}

let startupStage: UiStartupStage = "zoom";
let startupError: string | null = null;
const currentWindow = getCurrentWindow();
const rendererReleaseId = rendererReleaseIdFromLocation();
const rendererActivationId = rendererActivationIdFromLocation();
try {
  await getCurrentWebview().setZoom(1.1);
  startupStage = "bridge";
  installTauriSovereignBridge();
  startupStage = "handoff";
  const rendererHandoff =
    currentWindow.label === "main"
      ? await invoke<DesktopRendererHandoff | null>(
          "renderer_update_take_handoff",
        ).catch(() => null)
      : null;
  Object.defineProperty(window, "__SOVEREIGN_RENDERER_HANDOFF__", {
    value: rendererHandoff,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  startupStage = "renderer";
  await import("../../desktop/src/renderer/main.js");
  startupStage = "ready";
} catch (error) {
  startupError = (error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error)).slice(0, 1_024);
  console.error("Sovereign UI startup failed.", error);
}

const appRoot = document.querySelector<HTMLDivElement>("#app");
await invoke("ui_ready", {
  payload: {
    href: window.location.href,
    title: document.title,
    readyState: document.readyState,
    appChildCount: startupError === null ? appRoot?.childElementCount ?? 0 : 0,
    startupStage,
    startupError,
    windowLabel: currentWindow.label,
    rendererReleaseId,
    rendererActivationId,
    rendererBridgeApiVersion: RENDERER_BRIDGE_API_VERSION,
  },
});

if (rendererActivationId !== null) {
  const settledUrl = new URL(window.location.href);
  settledUrl.searchParams.delete("rendererActivation");
  window.history.replaceState(window.history.state, "", settledUrl);
}

if (startupError !== null) {
  throw new Error(`Sovereign UI startup failed during ${startupStage}: ${startupError}`);
}
