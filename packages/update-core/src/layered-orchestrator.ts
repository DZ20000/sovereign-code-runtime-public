import type { ReleaseManifest } from "./manifest.js";
import type {
  RendererCutoverOutcome,
  RendererCutoverReceipt,
} from "./renderer-cutover.js";
import type {
  RuntimeCutoverOutcome,
  RuntimeCutoverReceipt,
} from "./runtime-cutover.js";
import {
  planVerifiedReleaseUpdate,
  type VerifiedReleaseUpdatePlan,
} from "./release-diff.js";
import type {
  ComponentUpdateMode,
  ComponentUpdatePolicy,
} from "./update-plan.js";

export type LayeredUpdateOutcome =
  "no-op" | "committed" | "rolled-back" | "failed";

export type LayeredReleasePlan = VerifiedReleaseUpdatePlan;

export interface LayeredUpdateContext {
  readonly updateId: string;
  readonly plan: LayeredReleasePlan;
  readonly current: ReleaseManifest;
  readonly candidate: ReleaseManifest;
  readonly startedAt: number;
  readonly signal: AbortSignal;
}

export interface RestartUpdateReceipt {
  readonly updateId: string;
  readonly outcome: Exclude<LayeredUpdateOutcome, "no-op">;
  readonly currentReleaseId: string;
  readonly candidateReleaseId: string;
  readonly failureReason: string | null;
  readonly cleanupFailures: readonly string[];
}

export interface LayeredUpdateHandlers {
  readonly rendererReload: (
    context: LayeredUpdateContext,
  ) => Promise<RendererCutoverReceipt>;
  readonly runtimeRolling: (
    context: LayeredUpdateContext,
  ) => Promise<RuntimeCutoverReceipt>;
  readonly applicationRestart: (
    context: LayeredUpdateContext,
  ) => Promise<RestartUpdateReceipt>;
  readonly maintenance: (
    context: LayeredUpdateContext,
  ) => Promise<RestartUpdateReceipt>;
}

export interface LayeredUpdateExecutionInput {
  readonly updateId: string;
  readonly current: ReleaseManifest;
  readonly candidate: ReleaseManifest;
  readonly policy?: ComponentUpdatePolicy;
  readonly expectedMode?: ComponentUpdateMode;
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}

export type LayeredUpdateRequest = LayeredUpdateExecutionInput;

export type LayeredUpdateDetail =
  RendererCutoverReceipt | RuntimeCutoverReceipt | RestartUpdateReceipt;

export interface LayeredUpdateReceipt {
  readonly updateId: string;
  readonly mode: ComponentUpdateMode;
  readonly outcome: LayeredUpdateOutcome;
  readonly currentReleaseId: string;
  readonly candidateReleaseId: string;
  readonly plan: LayeredReleasePlan;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly failureReason: string | null;
  readonly cleanupFailures: readonly string[];
  readonly detail: LayeredUpdateDetail | null;
}

export interface LayeredUpdateOrchestratorOptions {
  readonly handlers: LayeredUpdateHandlers;
  readonly now?: () => number;
  readonly onPlan?: (plan: LayeredReleasePlan) => void;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function boundedFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (
    normalized.length === 0 ? "Layered update failed." : normalized
  ).slice(0, 1_024);
}

function planFor(
  current: ReleaseManifest,
  candidate: ReleaseManifest,
  policy: ComponentUpdatePolicy | undefined,
): LayeredReleasePlan {
  return planVerifiedReleaseUpdate(current, candidate, policy);
}

function delegatedOutcome(
  outcome: RendererCutoverOutcome | RuntimeCutoverOutcome,
): LayeredUpdateOutcome {
  return outcome;
}

function validateRendererReceipt(
  receipt: RendererCutoverReceipt,
  context: LayeredUpdateContext,
): void {
  if (
    receipt.cutoverId !== context.updateId ||
    receipt.previousReleaseId !== context.plan.currentReleaseId ||
    receipt.candidateReleaseId !== context.plan.candidateReleaseId
  ) {
    throw new Error(
      "Renderer handler returned a receipt for another candidate or cutover.",
    );
  }
}

function validateRuntimeReceipt(
  receipt: RuntimeCutoverReceipt,
  context: LayeredUpdateContext,
): void {
  if (
    receipt.cutoverId !== context.updateId ||
    receipt.activeReleaseId !== context.plan.currentReleaseId ||
    receipt.candidateReleaseId !== context.plan.candidateReleaseId
  ) {
    throw new Error(
      "Runtime handler returned a receipt for another candidate or cutover.",
    );
  }
}

function validateRestartReceipt(
  receipt: RestartUpdateReceipt,
  context: LayeredUpdateContext,
): void {
  if (
    receipt.updateId !== context.updateId ||
    receipt.currentReleaseId !== context.plan.currentReleaseId ||
    receipt.candidateReleaseId !== context.plan.candidateReleaseId
  ) {
    throw new Error(
      "Restart handler returned a receipt for another candidate or update.",
    );
  }
  if (
    receipt.outcome !== "committed" &&
    receipt.outcome !== "rolled-back" &&
    receipt.outcome !== "failed"
  ) {
    throw new Error("Restart handler returned an invalid outcome.");
  }
}

export class LayeredUpdateBusyError extends Error {
  constructor() {
    super("Another layered update is already active.");
    this.name = "LayeredUpdateBusyError";
  }
}

export class LayeredUpdateOrchestrator {
  readonly #handlers: LayeredUpdateHandlers;
  readonly #now: () => number;
  readonly #onPlan: ((plan: LayeredReleasePlan) => void) | undefined;
  #busy = false;

  constructor(options: LayeredUpdateOrchestratorOptions) {
    if (typeof options.handlers !== "object" || options.handlers === null) {
      throw new Error("Layered update handlers are required.");
    }
    this.#handlers = options.handlers;
    this.#now = options.now ?? Date.now;
    this.#onPlan = options.onPlan;
  }

  get busy(): boolean {
    return this.#busy;
  }

  async execute(
    input: LayeredUpdateExecutionInput,
  ): Promise<LayeredUpdateReceipt> {
    if (this.#busy) throw new LayeredUpdateBusyError();
    if (input.signal?.aborted === true) {
      throw new Error("Layered update was aborted before planning.");
    }
    assertIdentifier(input.updateId, "Layered update ID");
    this.#busy = true;
    try {
      const startedAt = this.#now();
      const plan = planFor(input.current, input.candidate, input.policy);
      if (
        input.expectedMode !== undefined &&
        input.expectedMode !== plan.plan.mode
      ) {
        throw new Error(
          `Layered update mode changed from ${input.expectedMode} to ${plan.plan.mode}.`,
        );
      }
      try {
        this.#onPlan?.(plan);
      } catch {
        // Planning telemetry cannot change update authority.
      }
      const base = {
        updateId: input.updateId,
        mode: plan.plan.mode,
        currentReleaseId: plan.currentReleaseId,
        candidateReleaseId: plan.candidateReleaseId,
        plan,
        startedAt,
      } as const;
      if (plan.plan.mode === "no-op" || input.dryRun === true) {
        return {
          ...base,
          outcome: "no-op",
          completedAt: this.#now(),
          failureReason: null,
          cleanupFailures: [],
          detail: null,
        };
      }
      const controller = new AbortController();
      const relayAbort = (): void => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", relayAbort, { once: true });
      const context: LayeredUpdateContext = {
        updateId: input.updateId,
        plan,
        current: input.current,
        candidate: input.candidate,
        startedAt,
        signal: controller.signal,
      };
      try {
        let detail: LayeredUpdateDetail;
        let outcome: LayeredUpdateOutcome;
        let failureReason: string | null;
        let cleanupFailures: readonly string[];
        switch (plan.plan.mode) {
          case "renderer-reload": {
            const receipt = await this.#handlers.rendererReload(context);
            validateRendererReceipt(receipt, context);
            detail = receipt;
            outcome = delegatedOutcome(receipt.outcome);
            failureReason = receipt.failureReason;
            cleanupFailures = receipt.cleanupFailures;
            break;
          }
          case "runtime-rolling": {
            const receipt = await this.#handlers.runtimeRolling(context);
            validateRuntimeReceipt(receipt, context);
            detail = receipt;
            outcome = delegatedOutcome(receipt.outcome);
            failureReason = receipt.failureReason;
            cleanupFailures = receipt.cleanupFailures;
            break;
          }
          case "application-restart":
          case "maintenance": {
            const receipt =
              plan.plan.mode === "application-restart"
                ? await this.#handlers.applicationRestart(context)
                : await this.#handlers.maintenance(context);
            validateRestartReceipt(receipt, context);
            detail = receipt;
            outcome = receipt.outcome;
            failureReason = receipt.failureReason;
            cleanupFailures = receipt.cleanupFailures;
            break;
          }
          default:
            throw new Error(
              `Unsupported layered update mode ${plan.plan.mode}.`,
            );
        }
        return {
          ...base,
          outcome,
          completedAt: this.#now(),
          failureReason,
          cleanupFailures,
          detail,
        };
      } catch (error) {
        return {
          ...base,
          outcome: "failed",
          completedAt: this.#now(),
          failureReason: boundedFailure(error),
          cleanupFailures: [],
          detail: null,
        };
      } finally {
        input.signal?.removeEventListener("abort", relayAbort);
      }
    } finally {
      this.#busy = false;
    }
  }
}
