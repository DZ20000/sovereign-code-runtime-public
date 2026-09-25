import type { Principal } from "@sovereign/runtime-core";

export interface ToolExecutionContext {
  readonly principal: Principal;
  readonly sessionId?: string | null;
}

export type ToolExecutionActivityPhase = "started" | "completed";

export type ToolExecutionActivityOutcome = "succeeded" | "failed";

export interface ToolExecutionActivityEvent {
  readonly id: string;
  readonly phase: ToolExecutionActivityPhase;
  readonly principalId: string;
  readonly sessionId: string | null;
  readonly toolName: string;
  readonly title: string;
  readonly category: string;
  readonly workspaceId: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: ToolExecutionActivityOutcome | null;
  readonly errorCode: string | null;
  readonly receiptId: string | null;
}

export type ToolExecutionActivityHook = (
  event: ToolExecutionActivityEvent,
) => Promise<void> | void;
