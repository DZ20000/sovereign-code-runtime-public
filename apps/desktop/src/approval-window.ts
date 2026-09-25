import {
  BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";

import type {
  ApprovalDecision,
  ApprovalPresentation,
  ApprovalSurface,
} from "./approval-broker.js";
import type {
  DesktopApprovalDecision,
  DesktopApprovalView,
} from "./shared.js";

export interface ApprovalWindowControllerOptions {
  readonly parentWindow: () => BrowserWindow | null;
  readonly preloadPath: string;
  readonly rendererUrl: string;
  readonly devTools: boolean;
}

export class ApprovalWindowController implements ApprovalSurface {
  readonly #parentWindow: () => BrowserWindow | null;
  readonly #preloadPath: string;
  readonly #rendererUrl: string;
  readonly #devTools: boolean;
  #window: BrowserWindow | null = null;
  #pending: ApprovalPresentation | null = null;
  #finish: ((decision: ApprovalDecision) => void) | null = null;

  constructor(options: ApprovalWindowControllerOptions) {
    this.#parentWindow = options.parentWindow;
    this.#preloadPath = options.preloadPath;
    this.#rendererUrl = options.rendererUrl;
    this.#devTools = options.devTools;
  }

  present(
    request: ApprovalPresentation,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (this.#window !== null || this.#pending !== null || this.#finish !== null) {
      return Promise.resolve("deny");
    }
    if (signal.aborted) {
      return Promise.resolve("deny");
    }

    return new Promise<ApprovalDecision>((resolveDecision) => {
      const parent = this.#parentWindow();
      const window = new BrowserWindow({
        width: 560,
        height: 430,
        center: true,
        show: false,
        ...(parent === null || parent.isDestroyed() ? {} : { parent }),
        modal: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        autoHideMenuBar: true,
        backgroundColor: "#1e1f22",
        title: "Sovereign approval",
        webPreferences: {
          preload: this.#preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          devTools: this.#devTools,
        },
      });

      let settled = false;
      const finish = (decision: ApprovalDecision): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.#finish = null;
        this.#pending = null;
        this.#window = null;
        if (!window.isDestroyed()) {
          window.destroy();
        }
        resolveDecision(decision);
      };
      const onAbort = (): void => finish("deny");

      this.#window = window;
      this.#pending = request;
      this.#finish = finish;
      signal.addEventListener("abort", onAbort, { once: true });

      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false);
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, targetUrl) => {
        if (targetUrl !== this.#rendererUrl) {
          event.preventDefault();
        }
      });
      window.webContents.on("will-attach-webview", (event) => {
        event.preventDefault();
      });
      window.on("closed", () => finish("deny"));
      window.once("ready-to-show", () => {
        if (!signal.aborted && !window.isDestroyed()) {
          window.show();
          window.focus();
        }
      });

      void window.loadURL(this.#rendererUrl).catch(() => finish("deny"));
    });
  }

  current(event: IpcMainInvokeEvent): DesktopApprovalView | null {
    this.#assertSender(event);
    const pending = this.#pending;
    return pending === null ? null : { ...pending };
  }

  resolve(
    event: IpcMainInvokeEvent,
    requestId: unknown,
    decision: unknown,
  ): void {
    this.#assertSender(event);
    const pending = this.#pending;
    const finish = this.#finish;
    if (pending === null || finish === null) {
      throw new Error("No approval request is currently pending.");
    }
    if (typeof requestId !== "string" || requestId !== pending.id) {
      throw new Error("Approval request id is stale or invalid.");
    }
    if (
      decision !== "allow-once" &&
      decision !== "deny" &&
      decision !== "drop-to-l1"
    ) {
      throw new Error("Approval decision is invalid.");
    }
    if (decision === "drop-to-l1" && !pending.burstDetected) {
      throw new Error("Drop-to-L1 is only available during approval flood handling.");
    }
    finish(decision satisfies DesktopApprovalDecision);
  }

  destroy(): void {
    this.#finish?.("deny");
  }

  #assertSender(event: IpcMainInvokeEvent): void {
    const window = this.#window;
    if (
      window === null ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame === null ||
      event.senderFrame.url !== this.#rendererUrl
    ) {
      throw new Error("Approval IPC request rejected because its sender is not the active approval window.");
    }
  }
}
