import type { VerifiedRendererReleaseReference } from "./installed-renderer-state-journal.mjs";

export interface VerifiedInstalledRendererReadyMarker {
  readonly schemaVersion: "scr.renderer-slot-ready/v1";
  readonly installedAtUnixMs: number;
  readonly release: VerifiedRendererReleaseReference;
}

export const RENDERER_READY_SCHEMA_VERSION: "scr.renderer-slot-ready/v1";

export function verifyInstalledRendererReadyMarker(
  value: unknown,
): VerifiedInstalledRendererReadyMarker;
