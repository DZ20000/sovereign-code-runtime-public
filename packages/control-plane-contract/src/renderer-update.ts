export const DESKTOP_RENDERER_HANDOFF_SCHEMA_VERSION = "scr.renderer-handoff/v1" as const;
export const DESKTOP_RENDERER_UPDATE_STATUS_SCHEMA_VERSION =
  "scr.renderer-update-status/v1" as const;

export interface DesktopRendererReleaseView {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: "stable" | "beta" | "development";
  readonly manifestSha256: string;
}

export interface DesktopRendererActivationView {
  readonly releaseId: string | null;
  readonly builtIn: boolean;
  readonly phase: "activating" | "startup" | "rollback" | string;
  readonly startedAtUnixMs: number;
}

export interface DesktopRendererUpdateStatus {
  readonly schemaVersion: typeof DESKTOP_RENDERER_UPDATE_STATUS_SCHEMA_VERSION;
  readonly enabled: boolean;
  readonly shellVersion: string;
  readonly bridgeApiVersion: number;
  readonly trustedKeyCount: number;
  readonly highestReleaseSequence: number;
  readonly activeRelease: DesktopRendererReleaseView | null;
  readonly builtInActive: boolean;
  readonly lastKnownGoodRelease: DesktopRendererReleaseView | null;
  readonly installedReleases: readonly DesktopRendererReleaseView[];
  readonly inboxReleaseIds: readonly string[];
  readonly preflightedReleaseIds: readonly string[];
  readonly pendingActivation: DesktopRendererActivationView | null;
  readonly lastFailure: string | null;
}

export interface DesktopRendererHandoff {
  readonly schemaVersion: typeof DESKTOP_RENDERER_HANDOFF_SCHEMA_VERSION;
  readonly view: string | null;
  readonly settingsTab: "appearance" | "host" | "security" | "diagnostics" | null;
  readonly scrollTop: number;
}