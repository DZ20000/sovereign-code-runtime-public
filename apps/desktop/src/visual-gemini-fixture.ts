import { ipcMain } from "electron";
import type { DesktopGeminiConnectionConfigurationInput, DesktopGeminiConnectionStatus } from "@sovereign/control-plane-contract";
import { IPC_CHANNELS } from "./shared.js";

// This fixture holds synthetic values only and never opens a listener or writes settings.
export const geminiFixture = {
  status: {
    phase: "unconfigured", configuration: null, hasOwnerSubject: false,
    hasIntrospectionAuthorization: false, listenEndpoint: null, lastError: null,
  } as DesktopGeminiConnectionStatus,
  requests: [] as DesktopGeminiConnectionConfigurationInput[],
  starts: 0,
  stops: 0,
  failNextSave: false,
};

export function registerGeminiConnectionFixture(): void {
  ipcMain.handle(IPC_CHANNELS.getGeminiConnection, () => structuredClone(geminiFixture.status));
  ipcMain.handle(IPC_CHANNELS.configureGeminiConnection, (_event, input: DesktopGeminiConnectionConfigurationInput) => {
    geminiFixture.requests.push(structuredClone(input));
    if (geminiFixture.failNextSave) {
      geminiFixture.failNextSave = false;
      throw new Error("visual-credential-must-not-appear");
    }
    const { ownerSubject, introspectionAuthorization, ...configuration } = input;
    const hasValue = (update: DesktopGeminiConnectionConfigurationInput["ownerSubject"], previous: boolean) =>
      update.action === "replace" || (update.action === "keep" && previous);
    const hasOwnerSubject = hasValue(ownerSubject, geminiFixture.status.hasOwnerSubject);
    const hasIntrospectionAuthorization = hasValue(introspectionAuthorization, geminiFixture.status.hasIntrospectionAuthorization);
    const listening = geminiFixture.status.phase === "listening" && hasOwnerSubject && hasIntrospectionAuthorization;
    geminiFixture.status = {
      phase: !hasOwnerSubject || !hasIntrospectionAuthorization ? "unconfigured" : listening ? "listening" : "saved",
      configuration, hasOwnerSubject, hasIntrospectionAuthorization,
      listenEndpoint: listening ? "http://127.0.0.1:24831/mcp" : null, lastError: null,
    };
    return structuredClone(geminiFixture.status);
  });
  ipcMain.handle(IPC_CHANNELS.startGeminiConnection, () => {
    geminiFixture.starts++;
    geminiFixture.status = { ...geminiFixture.status, phase: "listening", listenEndpoint: "http://127.0.0.1:24831/mcp", lastError: null };
    return structuredClone(geminiFixture.status);
  });
  ipcMain.handle(IPC_CHANNELS.stopGeminiConnection, () => {
    geminiFixture.stops++;
    geminiFixture.status = { ...geminiFixture.status, phase: "saved", listenEndpoint: null, lastError: null };
    return structuredClone(geminiFixture.status);
  });
}
