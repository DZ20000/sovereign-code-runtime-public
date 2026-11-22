import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  IPC_CHANNELS,
  isProtocolRecord,
  type DesktopGeminiConnectionConfigurationInput,
  type SovereignDesktopApi,
} from "./shared.js";

type GeminiController = Pick<SovereignDesktopApi,
  "getGeminiConnection" | "configureGeminiConnection" |
  "startGeminiConnection" | "stopGeminiConnection">;

export function registerGeminiConnectionIpc(
  controller: GeminiController,
  assertTrustedSender: (event: IpcMainInvokeEvent) => void,
): void {
  for (const method of ["getGeminiConnection", "startGeminiConnection", "stopGeminiConnection"] as const) {
    ipcMain.handle(IPC_CHANNELS[method], async (event) => {
      assertTrustedSender(event);
      return await controller[method]();
    });
  }
  ipcMain.handle(IPC_CHANNELS.configureGeminiConnection, async (event, input: unknown) => {
    assertTrustedSender(event);
    if (!isProtocolRecord(input)) throw new Error("Gemini connection configuration must be an object.");
    // The owner manager validates fields and protected-value actions before persistence.
    return await controller.configureGeminiConnection(input as unknown as DesktopGeminiConnectionConfigurationInput);
  });
}
