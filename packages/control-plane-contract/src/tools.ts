export type DesktopDirectToolName =
  | "terminal.session.list"
  | "terminal.session.read"
  | "terminal.session.create"
  | "terminal.session.write"
  | "terminal.session.resize"
  | "terminal.session.close"
  | "python.capabilities"
  | "python.start"
  | "browser.capabilities"
  | "browser.session.list"
  | "browser.session.create"
  | "browser.navigate"
  | "browser.observe"
  | "browser.click"
  | "browser.type"
  | "browser.evaluate"
  | "browser.session.close"
  | "workflow.templates"
  | "workflow.start"
  | "computer.capabilities"
  | "computer.observe"
  | "computer.action";

export interface DesktopTerminalSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly relativeCwd: string;
  readonly state: "starting" | "running" | "exited" | "closed" | "failed";
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly processId: number | null;
  readonly exitCode: number | null;
  readonly columns: number;
  readonly rows: number;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly error: string | null;
  readonly receiptId?: string;
}

export interface DesktopPythonCapabilities {
  readonly available: boolean;
  readonly launcher: string | null;
  readonly version: string | null;
  readonly implementation: string | null;
  readonly isolatedMode: true;
  readonly networkIsolation: false;
}

export interface DesktopBrowserSession {
  readonly id: string;
  readonly state: "starting" | "ready" | "closed" | "failed";
  readonly createdAt: string;
  readonly processId: number | null;
  readonly url: string;
  readonly title: string;
  readonly allowedDomains: readonly string[];
  readonly blockedRequestCount: number;
  readonly error: string | null;
  readonly receiptId?: string;
}

export interface DesktopBrowserElement {
  readonly ref: string;
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly text: string;
  readonly type: string | null;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly sensitive: boolean;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface DesktopBrowserObservation extends DesktopBrowserSession {
  readonly revision: string;
  readonly text: string;
  readonly accessibility: readonly {
    readonly role: string;
    readonly name: string;
  }[];
  readonly elements: readonly DesktopBrowserElement[];
  readonly screenshotBase64?: string;
  readonly screenshotMediaType?: "image/jpeg";
}

export type DesktopWorkflowStep =
  | { readonly kind: "validation"; readonly task: "typecheck" | "test" | "build" }
  | { readonly kind: "terminal"; readonly command: string }
  | { readonly kind: "python"; readonly code: string };

export interface DesktopComputerWindow {
  readonly id: string;
  readonly processId: number;
  readonly title: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface DesktopComputerObservation {
  readonly revision: string;
  readonly capturedAt: string;
  readonly virtualScreen: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly windows: readonly DesktopComputerWindow[];
  readonly screenshotSha256: string;
  readonly screenshotBytes: number;
  readonly screenshotBase64?: string;
  readonly screenshotMediaType?: "image/jpeg";
  readonly receiptId?: string;
}
