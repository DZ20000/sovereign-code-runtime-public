import type {
  RendererCutoverInput,
  RendererCutoverReceipt,
} from "./renderer-cutover.js";
import type {
  RuntimeCutoverInput,
  RuntimeCutoverReceipt,
} from "./runtime-cutover.js";
import {
  planComponentUpdate,
  type ComponentUpdatePlan,
  type ComponentUpdatePolicy,
  type UpdateComponentChange,
} from "./update-plan.js";

export const LAYERED_UPDATE_OUTCOMES = [
  "committed",
  "rolled-back",
  "restart-required",
  "maintenance-required",
  "failed",
  "no-op",
] as const;

export type LayeredUpdateOutcome = (typeof LAYERED_UPDATE_OUTCOMES)[number];

export interface VerifiedLayeredUpdateCandidate {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly manifestSha256: string;
  readonly signingKeyId: string;
  readonly verifiedAt: number;
  readonly changes: readonly UpdateComponentChange[];
  readonly policy?: ComponentUpdatePolicy;
  readonly renderer?: Omit<RendererCutoverInput, "cutoverId">;
  readonly runtime?: Omit<RuntimeCutoverInput, "cutoverId">;
}

export interface RestartUpdateRequest {
  readonly operationId: string;
  readonly candidate: VerifiedLayeredUpdateCandidate;
  readonly plan: ComponentUpdatePlan;
  readonly maintenance: boolean;
  readonly signal: AbortSignal;
}

export interface RestartUpdateReceipt {
  readonly outcome: "committed" | "rolled-back" | "restart-required" | "failed";
  readonly failureReason: string | null;
  readonly receiptId: string | null;
}

export interface LayeredUpdateAdapter {
  readonly renderer?: {
    cutover(input: RendererCutoverInput): Promise<RendererCutoverReceipt>;
  };
  readonly runtime?: {
    cutover(input: RuntimeCutoverInput): Promise<RuntimeCutoverReceipt>;
  };
  executeRestart(request: RestartUpdateRequest): Promise<RestartUpdateReceipt>;
}

export interface LayeredUpdateTransition {
  readonly operationId: string;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly phase:
    | "planned"
    | "delegated"
    | "committed"
    | "rolled-back"
    | "restart-required"
    | "maintenance-required"
    | "failed"
    | "no-op";
  readonly strategy: ComponentUpdatePlan["mode"];
  readonly at: number;
}

export interface LayeredUpdateReceipt {
  readonly operationId: string;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly manifestSha256: string;
  readonly signingKeyId: string;
  readonly strategy: ComponentUpdatePlan["mode"];
  readonly plan: ComponentUpdatePlan;
  readonly outcome: LayeredUpdateOutcome;
  readonly delegatedReceipt:
    | RendererCutoverReceipt
    | RuntimeCutoverReceipt
    | RestartUpdateReceipt
    | null;
  readonly failureReason: string | null;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly transitions: readonly LayeredUpdateTransition[];
}

export interface LayeredUpdateCoordinatorOptions {
  readonly adapter: LayeredUpdateAdapter;
  readonly now?: () => number;
  readonly onTransition?: (transition: LayeredUpdateTransition) => void;
}

export interface LayeredUpdateExecutionOptions {
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_COMPONENT_CHANGES = 10_000;
const MAX_VERIFICATION_AGE_MS = 24 * 60 * 60_000;

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertCandidate(
  candidate: VerifiedLayeredUpdateCandidate,
  now: number,
): void {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Verified layered update candidate is required.");
  }
  assertIdentifier(candidate.releaseId, "Layered update release ID");
  assertIdentifier(candidate.signingKeyId, "Layered update signing key ID");
  if (
    !Number.isSafeInteger(candidate.releaseSequence) ||
    candidate.releaseSequence < 1
  ) {
    throw new Error("Layered update release sequence is invalid.");
  }
  if (
    typeof candidate.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.manifestSha256)
  ) {
    throw new Error("Layered update manifest digest is invalid.");
  }
  if (
    !Number.isSafeInteger(candidate.verifiedAt) ||
    candidate.verifiedAt < 0 ||
    candidate.verifiedAt > now + 5 * 60_000 ||
    now - candidate.verifiedAt > MAX_VERIFICATION_AGE_MS
  ) {
    throw new Error(
      "Layered update verification timestamp is stale or invalid.",
    );
  }
  if (
    !Array.isArray(candidate.changes) ||
    candidate.changes.length > MAX_COMPONENT_CHANGES
  ) {
    throw new Error("Layered update component diff exceeds its bounded limit.");
  }
}

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (
    normalized.length === 0 ? "Layered update failed." : normalized
  ).slice(0, 1_024);
}

function outcomeForDelegated(
  strategy: ComponentUpdatePlan["mode"],
  receipt:
    RendererCutoverReceipt | RuntimeCutoverReceipt | RestartUpdateReceipt,
): LayeredUpdateOutcome {
  if (receipt.outcome === "committed") return "committed";
  if (receipt.outcome === "rolled-back") return "rolled-back";
  if (receipt.outcome === "failed") return "failed";
  if (receipt.outcome === "restart-required") {
    return strategy === "maintenance"
      ? "maintenance-required"
      : "restart-required";
  }
  return "failed";
}

function phaseForOutcome(
  outcome: LayeredUpdateOutcome,
): LayeredUpdateTransition["phase"] {
  if (outcome === "no-op") return "no-op";
  if (outcome === "committed") return "committed";
  if (outcome === "rolled-back") return "rolled-back";
  if (outcome === "restart-required") return "restart-required";
  if (outcome === "maintenance-required") return "maintenance-required";
  return "failed";
}

export class LayeredUpdateBusyError extends Error {
  constructor() {
    super("Another layered update operation is already active.");
    this.name = "LayeredUpdateBusyError";
  }
}

/**
 * Routes an already authenticated and inventory-verified release candidate to
 * the narrowest proven-safe update mechanism. Tool-pack hot reload is outside
 * this coordinator and remains owned by the separate tool catalog subsystem.
 */
export class LayeredUpdateCoordinator {
  readonly #adapter: LayeredUpdateAdapter;
  readonly #now: () => number;
  readonly #onTransition:
    ((transition: LayeredUpdateTransition) => void) | undefined;
  #busy = false;

  constructor(options: LayeredUpdateCoordinatorOptions) {
    if (typeof options.adapter !== "object" || options.adapter === null) {
      throw new Error("Layered update adapter is required.");
    }
    if (typeof options.adapter.executeRestart !== "function") {
      throw new Error("Layered update restart adapter is required.");
    }
    this.#adapter = options.adapter;
    this.#now = options.now ?? Date.now;
    this.#onTransition = options.onTransition;
  }

  get busy(): boolean {
    return this.#busy;
  }

  async execute(
    candidate: VerifiedLayeredUpdateCandidate,
    options: LayeredUpdateExecutionOptions = {},
  ): Promise<LayeredUpdateReceipt> {
    if (this.#busy) throw new LayeredUpdateBusyError();
    const now = this.#now();
    assertCandidate(candidate, now);
    if (options.signal?.aborted === true) {
      throw new Error("Layered update was aborted before planning.");
    }
    const operationId =
      options.operationId ??
      `update:${candidate.releaseId}:${candidate.releaseSequence}`;
    assertIdentifier(operationId, "Layered update operation ID");

    this.#busy = true;
    try {
      return await this.#execute(candidate, operationId, options.signal);
    } finally {
      this.#busy = false;
    }
  }

  async #execute(
    candidate: VerifiedLayeredUpdateCandidate,
    operationId: string,
    signal: AbortSignal | undefined,
  ): Promise<LayeredUpdateReceipt> {
    const startedAt = this.#now();
    const transitions: LayeredUpdateTransition[] = [];
    const plan = planComponentUpdate(candidate.changes, candidate.policy);

    const transition = (phase: LayeredUpdateTransition["phase"]): void => {
      const value: LayeredUpdateTransition = {
        operationId,
        releaseId: candidate.releaseId,
        releaseSequence: candidate.releaseSequence,
        phase,
        strategy: plan.mode,
        at: this.#now(),
      };
      transitions.push(value);
      try {
        this.#onTransition?.(value);
      } catch {
        // Audit/UI observers cannot change update authority.
      }
    };

    transition("planned");
    if (plan.mode === "no-op") {
      transition("no-op");
      return {
        operationId,
        releaseId: candidate.releaseId,
        releaseSequence: candidate.releaseSequence,
        manifestSha256: candidate.manifestSha256,
        signingKeyId: candidate.signingKeyId,
        strategy: plan.mode,
        plan,
        outcome: "no-op",
        delegatedReceipt: null,
        failureReason: null,
        startedAt,
        completedAt: this.#now(),
        transitions,
      };
    }

    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();

    try {
      transition("delegated");
      let delegated:
        RendererCutoverReceipt | RuntimeCutoverReceipt | RestartUpdateReceipt;

      if (plan.mode === "renderer-reload") {
        if (
          candidate.renderer === undefined ||
          this.#adapter.renderer === undefined
        ) {
          throw new Error(
            "Renderer-only update is missing a renderer candidate or renderer cutover adapter.",
          );
        }
        delegated = await this.#adapter.renderer.cutover({
          ...candidate.renderer,
          cutoverId: operationId,
          signal: abortController.signal,
        });
      } else if (plan.mode === "runtime-rolling") {
        if (
          candidate.runtime === undefined ||
          this.#adapter.runtime === undefined
        ) {
          throw new Error(
            "Runtime rolling update is missing a Runtime Host candidate or cutover adapter.",
          );
        }
        delegated = await this.#adapter.runtime.cutover({
          ...candidate.runtime,
          cutoverId: operationId,
          signal: abortController.signal,
        });
      } else {
        delegated = await this.#adapter.executeRestart({
          operationId,
          candidate,
          plan,
          maintenance: plan.mode === "maintenance",
          signal: abortController.signal,
        });
      }

      const outcome = outcomeForDelegated(plan.mode, delegated);
      transition(phaseForOutcome(outcome));
      return {
        operationId,
        releaseId: candidate.releaseId,
        releaseSequence: candidate.releaseSequence,
        manifestSha256: candidate.manifestSha256,
        signingKeyId: candidate.signingKeyId,
        strategy: plan.mode,
        plan,
        outcome,
        delegatedReceipt: delegated,
        failureReason: delegated.failureReason,
        startedAt,
        completedAt: this.#now(),
        transitions,
      };
    } catch (error) {
      const failureReason = boundedReason(error);
      transition("failed");
      return {
        operationId,
        releaseId: candidate.releaseId,
        releaseSequence: candidate.releaseSequence,
        manifestSha256: candidate.manifestSha256,
        signingKeyId: candidate.signingKeyId,
        strategy: plan.mode,
        plan,
        outcome: "failed",
        delegatedReceipt: null,
        failureReason,
        startedAt,
        completedAt: this.#now(),
        transitions,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
