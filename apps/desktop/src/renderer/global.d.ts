import type {
  SovereignApprovalApi,
  DesktopRendererHandoff,
  SovereignDesktopApi,
} from "../shared.js";

declare global {
  interface Window {
    readonly sovereign: SovereignDesktopApi;
    readonly sovereignApproval: SovereignApprovalApi;
    readonly __SOVEREIGN_RENDERER_HANDOFF__?: DesktopRendererHandoff | null;
  }
}

export {};
