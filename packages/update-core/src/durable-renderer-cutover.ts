import {
  RendererCutoverBusyError,
  type RendererCutoverAdapter,
  type RendererCutoverContext,
  type RendererCutoverInput,
  type RendererCutoverOutcome,
  type RendererCutoverPhase,
  type RendererCutoverPolicy,
  type RendererCutoverReceipt,
  type RendererCutoverTransition,
  type RendererTarget,
} from "./renderer-cutover.js";
import { CutoverLedger, ledgerFailureReason } from "./cutover-ledger.js";
import {
  RendererSlotStore,
  type RendererSlotPointer,
  type RendererSlotStatus,
} from "./renderer-slot.js";

export interface DurableRendererCutoverCoordinatorOptions {
  readonly adapter: RendererCutoverAdapter;
  readonly ledger: CutoverLedger;
  readonly slots: RendererSlotStore;
  readonly policy?: RendererCutoverPolicy;
  readonly now?: () => number;
  readonly onTransition?: (transition: RendererCutoverTransition) => void;
}

export class DurableRendererCutoverRecordingError extends Error {
  readonly receipt: RendererCutoverReceipt;

  constructor(receipt: RendererCutoverReceipt, cause: unknown) {
    super(
      `Renderer cutover completed with outcome ${receipt.outcome}, but its durable receipt could not be recorded: ${ledgerFailureReason(cause)}`,
      { cause },
    );
    this.name = "DurableRendererCutoverRecordingError";
    this.receipt = receipt;
  }
}

const DEFAULT_POLICY = {
  verifyTimeoutMs: 30_000,
  preflightTimeoutMs: 30_000,
  captureTimeoutMs: 5_000,
  activationTimeoutMs: 10_000,
  reloadTimeoutMs: 15_000,
  readyTimeoutMs: 30_000,
  restoreTimeoutMs: 10_000,
  observeTimeoutMs: 30_000,
  rollbackTimeoutMs: 30_000,
  maxStateBytes: 256 * 1_024,
} as const;

type ResolvedPolicy = {
  readonly [Key in keyof typeof DEFAULT_POLICY]: number;
};

const CLEANUP_PHASES = new Set<RendererCutoverPhase>([
  "rollback-pointer",
  "reload-previous",
  "previous-ready",
  "restore-previous-state",
]);

function resolvePolicy(policy: RendererCutoverPolicy = {}): ResolvedPolicy {
  const resolved = { ...DEFAULT_POLICY, ...policy };
  for (const [name, value] of Object.entries(resolved)) {
    const maximum = name === "maxStateBytes" ? 4 * 1_024 * 1_024 : 10 * 60_000;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`Renderer cutover ${name} is invalid.`);
    }
  }
  return resolved;
}

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (
    normalized.length === 0 ? "Renderer cutover failed." : normalized
  ).slice(0, 1_024);
}

function normalizeState(
  value: unknown,
  maxBytes: number,
): { readonly value: unknown; readonly bytes: number } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `Renderer state is not JSON-serializable: ${boundedReason(error)}`,
    );
  }
  if (json === undefined) {
    throw new Error("Renderer state must have a JSON representation.");
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `Renderer state exceeds the ${maxBytes}-byte handoff limit.`,
    );
  }
  return { value: JSON.parse(json) as unknown, bytes };
}

function targetFrom(
  slot: RendererSlotStatus,
  pointer: RendererSlotPointer,
): RendererTarget {
  return {
    releaseId: slot.releaseId,
    entrypoint: slot.entrypoint,
    manifestSha256: slot.manifestSha256,
    generation: pointer.generation,
  };
}

export class DurableRendererCutoverCoordinator {
  readonly #adapter: RendererCutoverAdapter;
  readonly #ledger: CutoverLedger;
  readonly #slots: RendererSlotStore;
  readonly #policy: ResolvedPolicy;
  readonly #now: () => number;
  readonly #onTransition:
    ((transition: RendererCutoverTransition) => void) | undefined;
  #busy = false;
  #ledgerFailure: unknown = null;

  constructor(options: DurableRendererCutoverCoordinatorOptions) {
    this.#adapter = options.adapter;
    this.#ledger = options.ledger;
    this.#slots = options.slots;
    this.#policy = resolvePolicy(options.policy);
    this.#now = options.now ?? Date.now;
    this.#onTransition = options.onTransition;
  }

  get busy(): boolean {
    return this.#busy;
  }

  async cutover(input: RendererCutoverInput): Promise<RendererCutoverReceipt> {
    if (this.#busy) throw new RendererCutoverBusyError();
    this.#busy = true;
    this.#ledgerFailure = null;
    try {
      const receipt = await this.#execute(input);
      try {
        await this.#ledger.appendRendererReceipt(receipt);
        if (this.#ledgerFailure !== null) throw this.#ledgerFailure;
      } catch (error) {
        throw new DurableRendererCutoverRecordingError(receipt, error);
      }
      return receipt;
    } finally {
      this.#busy = false;
    }
  }

  async #execute(input: RendererCutoverInput): Promise<RendererCutoverReceipt> {
    if (
      typeof input.cutoverId !== "string" ||
      input.cutoverId.length === 0 ||
      input.cutoverId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(input.cutoverId)
    ) {
      throw new Error("Renderer cutover ID is invalid.");
    }
    if (
      typeof input.candidateReleaseId !== "string" ||
      input.candidateReleaseId.length === 0 ||
      input.candidateReleaseId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(input.candidateReleaseId)
    ) {
      throw new Error("Renderer candidate release ID is invalid.");
    }
    if (input.signal?.aborted === true) {
      throw new Error("Renderer cutover was aborted before it started.");
    }

    const previousPointer = await this.#slots.readPointer();
    if (previousPointer === null) {
      throw new Error("Renderer cutover requires an active rollback slot.");
    }
    if (
      input.expectedGeneration !== undefined &&
      input.expectedGeneration !== previousPointer.generation
    ) {
      throw new Error(
        `Renderer pointer generation changed: expected ${input.expectedGeneration}, observed ${previousPointer.generation}.`,
      );
    }
    if (previousPointer.activeReleaseId === input.candidateReleaseId) {
      throw new Error("Renderer candidate is already active.");
    }

    const startedAt = this.#now();
    const transitions: RendererCutoverTransition[] = [];
    const cleanupFailures: string[] = [];
    let activatedPointer: RendererSlotPointer | null = null;
    let capturedState: unknown = null;
    let stateBytes = 0;

    const transition = async (
      phase: RendererCutoverPhase,
      generation: number,
      cleanup: boolean,
    ): Promise<void> => {
      const value: RendererCutoverTransition = {
        cutoverId: input.cutoverId,
        phase,
        at: this.#now(),
        previousReleaseId: previousPointer.activeReleaseId,
        candidateReleaseId: input.candidateReleaseId,
        generation,
      };
      try {
        await this.#ledger.appendRendererTransition(value);
      } catch (error) {
        this.#ledgerFailure ??= error;
        if (!cleanup) throw error;
      }
      transitions.push(value);
      try {
        this.#onTransition?.(value);
      } catch {
        // Observability cannot change the update outcome.
      }
    };

    const candidateSlot = await this.#phase(
      input,
      "verify-candidate",
      this.#policy.verifyTimeoutMs,
      previousPointer.generation,
      transition,
      async () => {
        await this.#slots.verifySlot(previousPointer.activeReleaseId);
        return await this.#slots.verifySlot(input.candidateReleaseId);
      },
    );
    const candidateBeforeActivation: RendererTarget = {
      releaseId: candidateSlot.releaseId,
      entrypoint: candidateSlot.entrypoint,
      manifestSha256: candidateSlot.manifestSha256,
      generation: previousPointer.generation + 1,
    };

    try {
      await this.#phase(
        input,
        "preflight-candidate",
        this.#policy.preflightTimeoutMs,
        previousPointer.generation,
        transition,
        (context) =>
          this.#adapter.preflight(candidateBeforeActivation, context),
      );
      const state = await this.#phase(
        input,
        "capture-view-state",
        this.#policy.captureTimeoutMs,
        previousPointer.generation,
        transition,
        (context) => this.#adapter.captureState(context),
      );
      const normalized = normalizeState(state, this.#policy.maxStateBytes);
      capturedState = normalized.value;
      stateBytes = normalized.bytes;

      activatedPointer = await this.#phase(
        input,
        "activate-candidate",
        this.#policy.activationTimeoutMs,
        previousPointer.generation,
        transition,
        async () =>
          await this.#slots.activate(input.candidateReleaseId, {
            expectedGeneration: previousPointer.generation,
          }),
      );
      const candidateTarget = targetFrom(candidateSlot, activatedPointer);
      await this.#phase(
        input,
        "reload-candidate",
        this.#policy.reloadTimeoutMs,
        activatedPointer.generation,
        transition,
        (context) =>
          this.#adapter.reload(candidateTarget, capturedState, context),
      );
      await this.#phase(
        input,
        "candidate-ready",
        this.#policy.readyTimeoutMs,
        activatedPointer.generation,
        transition,
        (context) => this.#adapter.waitUntilReady(candidateTarget, context),
      );
      await this.#phase(
        input,
        "restore-view-state",
        this.#policy.restoreTimeoutMs,
        activatedPointer.generation,
        transition,
        (context) => this.#adapter.restoreState(capturedState, context),
      );
      await this.#phase(
        input,
        "observe-candidate",
        this.#policy.observeTimeoutMs,
        activatedPointer.generation,
        transition,
        (context) => this.#adapter.observe(candidateTarget, context),
      );
      await transition("committed", activatedPointer.generation, false);
      return this.#receipt({
        input,
        outcome: "committed",
        previousPointer,
        finalGeneration: activatedPointer.generation,
        stateBytes,
        startedAt,
        failureReason: null,
        cleanupFailures,
        transitions,
      });
    } catch (error) {
      const failureReason = boundedReason(error);
      let restored = true;
      let finalGeneration = previousPointer.generation;

      if (activatedPointer !== null) {
        const rollbackPointer = await this.#safePhase(
          input,
          "rollback-pointer",
          this.#policy.rollbackTimeoutMs,
          activatedPointer.generation,
          transition,
          cleanupFailures,
          async () =>
            await this.#slots.rollback({
              expectedGeneration: activatedPointer!.generation,
            }),
        );
        if (rollbackPointer === null) {
          restored = false;
        } else {
          finalGeneration = rollbackPointer.generation;
          const previousTarget = await this.#safePhase(
            input,
            "reload-previous",
            this.#policy.rollbackTimeoutMs,
            rollbackPointer.generation,
            transition,
            cleanupFailures,
            async (context) => {
              const previousSlot = await this.#slots.verifySlot(
                previousPointer.activeReleaseId,
              );
              const target = targetFrom(previousSlot, rollbackPointer);
              await this.#adapter.reload(target, capturedState, context);
              return target;
            },
          );
          if (previousTarget === null) {
            restored = false;
          } else {
            const previousReady = await this.#safePhase(
              input,
              "previous-ready",
              this.#policy.rollbackTimeoutMs,
              rollbackPointer.generation,
              transition,
              cleanupFailures,
              (context) =>
                this.#adapter.waitUntilReady(previousTarget, context),
            );
            restored &&= previousReady !== null;
            const stateRestored = await this.#safePhase(
              input,
              "restore-previous-state",
              this.#policy.rollbackTimeoutMs,
              rollbackPointer.generation,
              transition,
              cleanupFailures,
              (context) => this.#adapter.restoreState(capturedState, context),
            );
            restored &&= stateRestored !== null;
          }
        }
      }

      const outcome: RendererCutoverOutcome = restored
        ? "rolled-back"
        : "failed";
      await transition(outcome, finalGeneration, true);
      return this.#receipt({
        input,
        outcome,
        previousPointer,
        finalGeneration,
        stateBytes,
        startedAt,
        failureReason,
        cleanupFailures,
        transitions,
      });
    }
  }

  #receipt(input: {
    readonly input: RendererCutoverInput;
    readonly outcome: RendererCutoverOutcome;
    readonly previousPointer: RendererSlotPointer;
    readonly finalGeneration: number;
    readonly stateBytes: number;
    readonly startedAt: number;
    readonly failureReason: string | null;
    readonly cleanupFailures: readonly string[];
    readonly transitions: readonly RendererCutoverTransition[];
  }): RendererCutoverReceipt {
    return {
      cutoverId: input.input.cutoverId,
      outcome: input.outcome,
      previousReleaseId: input.previousPointer.activeReleaseId,
      candidateReleaseId: input.input.candidateReleaseId,
      previousGeneration: input.previousPointer.generation,
      finalGeneration: input.finalGeneration,
      stateBytes: input.stateBytes,
      startedAt: input.startedAt,
      completedAt: this.#now(),
      failureReason: input.failureReason,
      cleanupFailures: [...input.cleanupFailures],
      phases: [...input.transitions],
    };
  }

  async #phase<T>(
    input: RendererCutoverInput,
    phase: RendererCutoverPhase,
    timeoutMs: number,
    generation: number,
    transition: (
      phase: RendererCutoverPhase,
      generation: number,
      cleanup: boolean,
    ) => Promise<void>,
    operation: (context: RendererCutoverContext) => Promise<T>,
  ): Promise<T> {
    await transition(phase, generation, false);
    return await this.#boundedOperation(input, phase, timeoutMs, operation);
  }

  async #safePhase<T>(
    input: RendererCutoverInput,
    phase: RendererCutoverPhase,
    timeoutMs: number,
    generation: number,
    transition: (
      phase: RendererCutoverPhase,
      generation: number,
      cleanup: boolean,
    ) => Promise<void>,
    failures: string[],
    operation: (context: RendererCutoverContext) => Promise<T>,
  ): Promise<T | null> {
    try {
      await transition(phase, generation, CLEANUP_PHASES.has(phase));
      return await this.#boundedOperation(
        {
          cutoverId: input.cutoverId,
          candidateReleaseId: input.candidateReleaseId,
          ...(input.expectedGeneration === undefined
            ? {}
            : { expectedGeneration: input.expectedGeneration }),
        },
        phase,
        timeoutMs,
        operation,
      );
    } catch (error) {
      failures.push(`${phase}: ${boundedReason(error)}`.slice(0, 1_024));
      return null;
    }
  }

  async #boundedOperation<T>(
    input: RendererCutoverInput,
    phase: RendererCutoverPhase,
    timeoutMs: number,
    operation: (context: RendererCutoverContext) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const startedAt = this.#now();
    const context: RendererCutoverContext = {
      cutoverId: input.cutoverId,
      phase,
      startedAt,
      deadlineAt: startedAt + timeoutMs,
      signal: controller.signal,
    };
    const onAbort = (): void => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Renderer cutover phase ${phase} timed out after ${timeoutMs} ms.`,
        );
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          const reason = controller.signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error(`Renderer cutover phase ${phase} was aborted.`),
          );
        },
        { once: true },
      );
    });
    try {
      if (input.signal?.aborted === true) onAbort();
      return await Promise.race([operation(context), timeout, aborted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}
