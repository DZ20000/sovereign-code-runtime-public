import type { DesktopApprovalView, DesktopPermissionLevel } from "./runtime.js";

export interface DesktopApprovalContext {
  /** Runtime principal identifier; this is not a verified account display name. */
  readonly requesterId: string | null;
  readonly workspaceId: string | null;
  readonly permissionLevel: DesktopPermissionLevel;
  readonly destructive: boolean;
  readonly sideEffect: string;
  readonly target: {
    readonly kind: "path" | "command" | "url" | "tool";
    readonly value: string;
  };
  /** Only an explicit trusted capability result may set this flag. */
  readonly administratorRequired?: true;
}

export interface DesktopPendingApproval extends DesktopApprovalView {
  readonly phase: "active" | "queued";
}

export type DesktopApprovalOpenResult = "opened" | "queued" | "unavailable";
