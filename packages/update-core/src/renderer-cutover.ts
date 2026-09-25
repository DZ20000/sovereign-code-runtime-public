import type { LayeredCutoverJournal } from "./layered-cutover-journal.js";
import {
  RendererSlotStore,
  type RendererSlotPointer,
  type RendererSlotStatus,
} from "./renderer-slot.js";

export const RENDERER_CUTOVER_PHASES = [
  "verify-candidate",
  "preflight-candidate",
  "capture-view-state",
  "activate-candidate",
  "reload-candidate",
  "candidate-ready",
  "restore-view-state",
  "observe-candidate",
  "rollback-pointer",
  "reload-previous",
  "previous-ready",
  "restore-previous-state",
  "committed",
  "rolled-back",
  "failed",
] as const;

export type RendererCutoverPhase = (typeof RENDERER_CUTOVER_PHASES)[number];
export type RendererCutoverOutcome = "committed" | "rolled-back" | "failed";

export interface RendererTarget {
  readonly releaseId: string;
  readonly entrypoint: string;
  readonly manifestSha256: string;
  readonly generation: number;
}

export interface RendererCutoverContext {
  readonly cutoverId: string;
  readonly phase: RendererCutoverPhase;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface RendererCutoverAdapter {
  preflight(
    target: RendererTarget,
    context: RendererCutoverContext,
  ): Promise<void>;
  captureState(context: RendererCutoverContext): Promise<unknown>;
  reload(
    target: RendererTarget,
    state: unknown,
    context: RendererCutoverContext,
  ): Promise<void>;
  waitUntilReady(
    target: RendererTarget,
    context: RendererCutoverContext,
  ): Promise<void>;
  restoreState(state: unknown, context: RendererCutoverContext): Promise<void>;
  observe(
    target: RendererTarget,
    context: RendererCutoverContext,
  ): Promise<void>;
}

export interface RendererCutoverTransition {
  readonly cutoverId: string;
  readonly phase: RendererCutoverPhase;
  readonly at: number;
  readonly previousReleaseId: string;
  readonly candidateReleaseId: string;
  readonly generation: number;
}

export interface RendererCutoverPolicy {
  readonly verifyTimeoutMs?: number;
  readonly preflightTimeoutMs?: number;
  readonly captureTimeoutMs?: number;
  readonly activationTimeoutMs?: number;
  readonly reloadTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly restoreTimeoutMs?: number;
  readonly observeTimeoutMs?: number;
  readonly rollbackTimeoutMs?: number;
  readonly maxStateBytes?: number;
}

export interface RendererCutoverInput {
  readonly cutoverId: string;
  readonly candidateReleaseId: string;
  readonly expectedGeneration?: number;
  readonly signal?: AbortSignal;
}

export interface RendererCutoverReceipt {
  readonly cutoverId: string;
  readonly outcome: RendererCutoverOutcome;
  readonly previousReleaseId: string;
  readonly candidateReleaseId: string;
  readonly previousGeneration: number;
  readonly finalGeneration: number;
  readonly stateBytes: number;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly failureReason: string | null;
  readonly cleanupFailures: readonly string[];
  readonly phases: readonly RendererCutoverTransition[];
}

export interface RendererCutoverCoordinatorOptions {
  readonly slots: RendererSlotStore;
  readonly adapter: RendererCutoverAdapter;
  readonly policy?: RendererCutoverPolicy;
  readonly now?: () => number;
  readonly onTransition?: (transition: RendererCutoverTransition) => void;
  readonly journal?: LayeredCutoverJournal;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
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

type ResolvedRendererPolicy = {
  readonly [Key in keyof typeof DEFAULT_POLICY]: number;
};

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function resolvePolicy(
  policy: RendererCutoverPolicy = {},
): ResolvedRendererPolicy {
  const resolved = { ...DEFAULT_POLICY, ...policy };
  for (const [name, value] of Object.entries(resolved)) {
    const upper = name === "maxStateBytes" ? 4 * 1_024 * 1_024 : 10 * 60_000;
    if (!Number.isSafeInteger(value) || value < 1 || value > upper) {
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

export class RendererCutoverBusyError extends Error {
  constructor() {
    super("Another renderer cutover is already active.");
    this.name = "RendererCutoverBusyError";
  }
}

export class RendererCutoverCoordinator {
  readonly #slots: RendererSlotStore;
  readonly #adapter: RendererCutoverAdapter;
  readonly #policy: ResolvedRendererPolicy;
  readonly #now: () => number;
  readonly #onTransition:
    ((transition: RendererCutoverTransition) => void) | undefined;
  readonly #journal: LayeredCutoverJournal | undefined;
  #busy = false;

  constructor(options: RendererCutoverCoordinatorOptions) {
    if (!(options.slots instanceof RendererSlotStore)) {
      throw new Error("Renderer slot store is required.");
    }
    if (typeof options.adapter !== "object" || options.adapter === null) {
      throw new Error("Renderer cutover adapter is required.");
    }
    this.#slots = options.slots;
    this.#adapter = options.adapter;
    this.#policy = resolvePolicy(options.policy);
    this.#now = options.now ?? Date.now;
    this.#onTransition = options.onTransition;
    this.#journal = options.journal;
  }

  get busy(): boolean {
    return this.#busy;
  }

  async cutover(input: RendererCutoverInput): Promise<RendererCutoverReceipt> {
    if (this.#busy) throw new RendererCutoverBusyError();
    this.#busy = true;
    try {
      return await this.#execute(input);
    } finally {
      this.#busy = false;
    }
  }

  async #execute(input: RendererCutoverInput): Promise<RendererCutoverReceipt> {
    assertIdentifier(input.cutoverId, "Renderer cutover ID");
    assertIdentifier(input.candidateReleaseId, "Renderer candidate release ID");
    if (input.signal?.aborted === true) {
      throw new Error("Renderer cutover was aborted before it started.");
    }

    const previousPointer = await this.#slots.readPointer();
    if (previousPointer === null) {
      throw new Error(
        "Renderer cutover requires an already active rollback slot.",
      );
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

    await this.#journal?.begin(
      {
        cutoverId: input.cutoverId,
        kind: "renderer",
        activeReleaseId: previousPointer.activeReleaseId,
        candidateReleaseId: input.candidateReleaseId,
      },
      { generation: previousPointer.generation },
    );

    const startedAt = this.#now();
    const transitions: RendererCutoverTransition[] = [];
    const cleanupFailures: string[] = [];
    let activatedPointer: RendererSlotPointer | null = null;
    let normalizedState: unknown = null;
    let stateBytes = 0;

    const transition = async (
      phase: RendererCutoverPhase,
      generation: number,
    ): Promise<void> => {
      const value: RendererCutoverTransition = {
        cutoverId: input.cutoverId,
        phase,
        at: this.#now(),
        previousReleaseId: previousPointer.activeReleaseId,
        candidateReleaseId: input.candidateReleaseId,
        generation,
      };
      await this.#journal?.transition(input.cutoverId, {
        phase,
        details: { generation },
      });
      transitions.push(value);
      try {
        this.#onTransition?.(value);
      } catch {
        // UI telemetry cannot change an accepted renderer outcome.
      }
    };

    const previousSlot = await this.#phase(
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
      releaseId: previousSlot.releaseId,
      entrypoint: previousSlot.entrypoint,
      manifestSha256: previousSlot.manifestSha256,
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
      const captured = await this.#phase(
        input,
        "capture-view-state",
        this.#policy.captureTimeoutMs,
        previousPointer.generation,
        transition,
        (context) => this.#adapter.captureState(context),
      );
      const normalized = normalizeState(captured, this.#policy.maxStateBytes);
      normalizedState = normalized.value;
      stateBytes = normalized.bytes;

      activatedPointer = await this.#phase(
        input,
        "activate-candidate",
        this.#policy.activationTimeoutMs,
        previousPointer.generation,
        transition,
        () =>
          this.#slots.activate(input.candidateReleaseId, {
            expectedGeneration: previousPointer.generation,
          }),
      );
      const candidateTarget = targetFrom(previousSlot, activatedPointer);
      await this.#phase(
        input,
        "reload-candidate",
        this.#policy.reloadTimeoutMs,
        activatedPointer.generation,
        transition,
        (context) =>
          this.#adapter.reload(candidateTarget, normalizedState, context),
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
        (context) => this.#adapter.restoreState(normalizedState, context),
      );
      await this.#phase(
        input,
        "observe-candidate",
        this.#policy.observeTimeoutMs,
        activatedPointer.generation,
        transition,
        (context) => this.#adapter.observe(candidateTarget, context),
      );
      try {
        await transition("committed", activatedPointer.generation);
      } catch (error) {
        cleanupFailures.push(`journal-transition: ${boundedReason(error)}`);
      }
      await this.#completeJournal(
        input.cutoverId,
        "committed",
        null,
        cleanupFailures,
        {
          generation: activatedPointer.generation,
          stateBytes,
        },
      );
      return {
        cutoverId: input.cutoverId,
        outcome: "committed",
        previousReleaseId: previousPointer.activeReleaseId,
        candidateReleaseId: input.candidateReleaseId,
        previousGeneration: previousPointer.generation,
        finalGeneration: activatedPointer.generation,
        stateBytes,
        startedAt,
        completedAt: this.#now(),
        failureReason: null,
        cleanupFailures,
        phases: transitions,
      };
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
          () =>
            this.#slots.rollback({
              expectedGeneration: activatedPointer!.generation,
            }),
        );
        if (rollbackPointer === null) {
          restored = false;
        } else {
          finalGeneration = rollbackPointer.generation;
          const previous = await this.#safePhase(
            input,
            "reload-previous",
            this.#policy.rollbackTimeoutMs,
            rollbackPointer.generation,
            transition,
            cleanupFailures,
            async (context) => {
              const slot = await this.#slots.verifySlot(
                previousPointer.activeReleaseId,
              );
              const target = targetFrom(slot, rollbackPointer);
              await this.#adapter.reload(target, normalizedState, context);
              return target;
            },
          );
          if (previous === null) {
            restored = false;
          } else {
            const ready = await this.#safePhase(
              input,
              "previous-ready",
              this.#policy.rollbackTimeoutMs,
              rollbackPointer.generation,
              transition,
              cleanupFailures,
              (context) => this.#adapter.waitUntilReady(previous, context),
            );
            restored &&= ready !== null;
            const stateRestored = await this.#safePhase(
              input,
              "restore-previous-state",
              this.#policy.rollbackTimeoutMs,
              rollbackPointer.generation,
              transition,
              cleanupFailures,
              (context) => this.#adapter.restoreState(normalizedState, context),
            );
            restored &&= stateRestored !== null;
          }
        }
      }

      const outcome = restored ? "rolled-back" : "failed";
      try {
        await transition(outcome, finalGeneration);
      } catch (journalError) {
        cleanupFailures.push(
          `journal-transition: ${boundedReason(journalError)}`,
        );
      }
      await this.#completeJournal(
        input.cutoverId,
        outcome,
        failureReason,
        cleanupFailures,
        { generation: finalGeneration, stateBytes },
      );
      return {
        cutoverId: input.cutoverId,
        outcome,
        previousReleaseId: previousPointer.activeReleaseId,
        candidateReleaseId: input.candidateReleaseId,
        previousGeneration: previousPointer.generation,
        finalGeneration,
        stateBytes,
        startedAt,
        completedAt: this.#now(),
        failureReason,
        cleanupFailures,
        phases: transitions,
      };
    }
  }

  async #completeJournal(
    cutoverId: string,
    outcome: "committed" | "rolled-back" | "failed",
    failureReason: string | null,
    cleanupFailures: string[],
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.#journal?.complete(cutoverId, {
        outcome,
        phase: outcome,
        failureReason,
        details,
      });
    } catch (error) {
      cleanupFailures.push(`journal-complete: ${boundedReason(error)}`);
    }
  }
  async #phase<T>(
    input: RendererCutoverInput,
    phase: RendererCutoverPhase,
    timeoutMs: number,
    generation: number,
    transition: (
      phase: RendererCutoverPhase,
      generation: number,
    ) => Promise<void>,
    operation: (context: RendererCutoverContext) => Promise<T>,
  ): Promise<T> {
    await transition(phase, generation);
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

  async #safePhase<T>(
    input: RendererCutoverInput,
    phase: RendererCutoverPhase,
    timeoutMs: number,
    generation: number,
    transition: (
      phase: RendererCutoverPhase,
      generation: number,
    ) => Promise<void>,
    failures: string[],
    operation: (context: RendererCutoverContext) => Promise<T>,
  ): Promise<T | null> {
    const cleanupInput: RendererCutoverInput =
      input.expectedGeneration === undefined
        ? {
            cutoverId: input.cutoverId,
            candidateReleaseId: input.candidateReleaseId,
          }
        : {
            cutoverId: input.cutoverId,
            candidateReleaseId: input.candidateReleaseId,
            expectedGeneration: input.expectedGeneration,
          };
    const cleanupTransition = async (
      cleanupPhase: RendererCutoverPhase,
      cleanupGeneration: number,
    ): Promise<void> => {
      try {
        await transition(cleanupPhase, cleanupGeneration);
      } catch (error) {
        failures.push(
          `journal-transition:${cleanupPhase}: ${boundedReason(error)}`.slice(
            0,
            1_024,
          ),
        );
      }
    };
    try {
      return await this.#phase(
        cleanupInput,
        phase,
        timeoutMs,
        generation,
        cleanupTransition,
        operation,
      );
    } catch (error) {
      failures.push(`${phase}: ${boundedReason(error)}`.slice(0, 1_024));
      return null;
    }
  }
}
