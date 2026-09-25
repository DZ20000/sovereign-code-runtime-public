import type { LayeredCutoverJournal } from "./layered-cutover-journal.js";

export const RUNTIME_CUTOVER_PHASES = [
  "start-candidate",
  "candidate-health",
  "quiesce-active",
  "drain-active",
  "checkpoint-active",
  "switch-traffic",
  "candidate-canary",
  "commit-candidate",
  "rollback-traffic",
  "resume-active",
  "stop-candidate",
  "stop-previous",
  "committed",
  "rolled-back",
  "failed",
] as const;

export type RuntimeCutoverPhase = (typeof RUNTIME_CUTOVER_PHASES)[number];
export type RuntimeCutoverOutcome = "committed" | "rolled-back" | "failed";

export interface RuntimeReleaseCandidate {
  readonly releaseId: string;
  readonly directory: string;
  readonly manifestSha256: string;
}

export interface RuntimeHostHandle {
  readonly instanceId: string;
  readonly releaseId: string;
}

export interface RuntimeDrainReport {
  readonly inFlight: number;
  readonly cancelled: number;
  readonly unknown: number;
}

export interface RuntimeCheckpoint {
  readonly checkpointId: string;
  readonly fencingToken: string;
}

export interface RuntimeCutoverContext {
  readonly cutoverId: string;
  readonly phase: RuntimeCutoverPhase;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface RuntimeTrafficSwitch {
  readonly cutoverId: string;
  readonly from: RuntimeHostHandle;
  readonly to: RuntimeHostHandle;
  readonly checkpoint: RuntimeCheckpoint;
  readonly rollback: boolean;
}

export interface RuntimeCutoverAdapter {
  startCandidate(
    candidate: RuntimeReleaseCandidate,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeHostHandle>;
  waitUntilHealthy(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  quiesce(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  drain(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeDrainReport>;
  checkpoint(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeCheckpoint>;
  switchTraffic(
    change: RuntimeTrafficSwitch,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  runCanary(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  commitCandidate(
    candidate: RuntimeHostHandle,
    checkpoint: RuntimeCheckpoint,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  resume(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  stop(
    host: RuntimeHostHandle,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
    context: RuntimeCutoverContext,
  ): Promise<void>;
}

export interface RuntimeCutoverTransition {
  readonly cutoverId: string;
  readonly phase: RuntimeCutoverPhase;
  readonly at: number;
  readonly activeInstanceId: string;
  readonly candidateInstanceId: string | null;
}

export interface RuntimeCutoverPolicy {
  readonly startTimeoutMs?: number;
  readonly healthTimeoutMs?: number;
  readonly quiesceTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly checkpointTimeoutMs?: number;
  readonly switchTimeoutMs?: number;
  readonly canaryTimeoutMs?: number;
  readonly commitTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}

export interface RuntimeCutoverInput {
  readonly cutoverId: string;
  readonly active: RuntimeHostHandle;
  readonly candidate: RuntimeReleaseCandidate;
  readonly signal?: AbortSignal;
}

export interface RuntimeCutoverReceipt {
  readonly cutoverId: string;
  readonly outcome: RuntimeCutoverOutcome;
  readonly activeReleaseId: string;
  readonly candidateReleaseId: string;
  readonly previousInstanceId: string;
  readonly candidateInstanceId: string | null;
  readonly checkpointId: string | null;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly failureReason: string | null;
  readonly cleanupFailures: readonly string[];
  readonly phases: readonly RuntimeCutoverTransition[];
}

export interface RuntimeCutoverCoordinatorOptions {
  readonly adapter: RuntimeCutoverAdapter;
  readonly policy?: RuntimeCutoverPolicy;
  readonly now?: () => number;
  readonly onTransition?: (transition: RuntimeCutoverTransition) => void;
  readonly journal?: LayeredCutoverJournal;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_POLICY = {
  startTimeoutMs: 20_000,
  healthTimeoutMs: 30_000,
  quiesceTimeoutMs: 10_000,
  drainTimeoutMs: 30_000,
  checkpointTimeoutMs: 15_000,
  switchTimeoutMs: 10_000,
  canaryTimeoutMs: 60_000,
  commitTimeoutMs: 15_000,
  cleanupTimeoutMs: 15_000,
} as const;

type ResolvedPolicy = {
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

function assertHostHandle(value: RuntimeHostHandle, label: string): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} is invalid.`);
  }
  assertIdentifier(value.instanceId, `${label} instance ID`);
  assertIdentifier(value.releaseId, `${label} release ID`);
}

function assertCandidate(value: RuntimeReleaseCandidate): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("Runtime release candidate is invalid.");
  }
  assertIdentifier(value.releaseId, "Runtime candidate release ID");
  if (
    typeof value.directory !== "string" ||
    value.directory.trim().length === 0 ||
    value.directory.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value.directory)
  ) {
    throw new Error("Runtime candidate directory is invalid.");
  }
  if (
    typeof value.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.manifestSha256)
  ) {
    throw new Error("Runtime candidate manifest digest is invalid.");
  }
}

function resolvePolicy(policy: RuntimeCutoverPolicy = {}): ResolvedPolicy {
  const resolved = { ...DEFAULT_POLICY, ...policy };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
      throw new Error(`Runtime cutover ${name} is invalid.`);
    }
  }
  return resolved;
}

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (
    normalized.length === 0 ? "Runtime cutover failed." : normalized
  ).slice(0, 1_024);
}

function assertDrainReport(report: RuntimeDrainReport): void {
  for (const [name, value] of Object.entries(report)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Runtime drain report ${name} is invalid.`);
    }
  }
  if (report.inFlight !== 0 || report.unknown !== 0) {
    throw new Error(
      `Runtime drain did not reach a safe point: inFlight=${report.inFlight}, unknown=${report.unknown}.`,
    );
  }
}

function assertCheckpoint(checkpoint: RuntimeCheckpoint): void {
  assertIdentifier(checkpoint.checkpointId, "Runtime checkpoint ID");
  assertIdentifier(checkpoint.fencingToken, "Runtime checkpoint fencing token");
}

export class RuntimeCutoverBusyError extends Error {
  constructor() {
    super("Another Runtime Host cutover is already active.");
    this.name = "RuntimeCutoverBusyError";
  }
}

export class RuntimeCutoverCoordinator {
  readonly #adapter: RuntimeCutoverAdapter;
  readonly #policy: ResolvedPolicy;
  readonly #now: () => number;
  readonly #onTransition:
    ((transition: RuntimeCutoverTransition) => void) | undefined;
  readonly #journal: LayeredCutoverJournal | undefined;
  #busy = false;

  constructor(options: RuntimeCutoverCoordinatorOptions) {
    if (typeof options.adapter !== "object" || options.adapter === null) {
      throw new Error("Runtime cutover adapter is required.");
    }
    this.#adapter = options.adapter;
    this.#policy = resolvePolicy(options.policy);
    this.#now = options.now ?? Date.now;
    this.#onTransition = options.onTransition;
    this.#journal = options.journal;
  }

  get busy(): boolean {
    return this.#busy;
  }

  async cutover(input: RuntimeCutoverInput): Promise<RuntimeCutoverReceipt> {
    if (this.#busy) throw new RuntimeCutoverBusyError();
    this.#busy = true;
    try {
      return await this.#execute(input);
    } finally {
      this.#busy = false;
    }
  }

  async #execute(input: RuntimeCutoverInput): Promise<RuntimeCutoverReceipt> {
    assertIdentifier(input.cutoverId, "Runtime cutover ID");
    assertHostHandle(input.active, "Active Runtime Host");
    assertCandidate(input.candidate);
    if (input.active.releaseId === input.candidate.releaseId) {
      throw new Error("Runtime candidate must differ from the active release.");
    }
    if (input.signal?.aborted === true) {
      throw new Error("Runtime cutover was aborted before it started.");
    }

    await this.#journal?.begin(
      {
        cutoverId: input.cutoverId,
        kind: "runtime",
        activeReleaseId: input.active.releaseId,
        candidateReleaseId: input.candidate.releaseId,
      },
      { manifestSha256: input.candidate.manifestSha256 },
    );

    const startedAt = this.#now();
    const transitions: RuntimeCutoverTransition[] = [];
    const cleanupFailures: string[] = [];
    let candidate: RuntimeHostHandle | null = null;
    let checkpoint: RuntimeCheckpoint | null = null;
    let activeQuiesced = false;
    let trafficSwitched = false;

    const transition = async (phase: RuntimeCutoverPhase): Promise<void> => {
      const value: RuntimeCutoverTransition = {
        cutoverId: input.cutoverId,
        phase,
        at: this.#now(),
        activeInstanceId: input.active.instanceId,
        candidateInstanceId: candidate?.instanceId ?? null,
      };
      await this.#journal?.transition(input.cutoverId, {
        phase,
        details: {
          activeInstanceId: value.activeInstanceId,
          candidateInstanceId: value.candidateInstanceId,
        },
      });
      transitions.push(value);
      try {
        this.#onTransition?.(value);
      } catch {
        // Observability must never change a cutover outcome.
      }
    };

    try {
      candidate = await this.#phase(
        input,
        "start-candidate",
        this.#policy.startTimeoutMs,
        transition,
        (context) => this.#adapter.startCandidate(input.candidate, context),
      );
      assertHostHandle(candidate, "Candidate Runtime Host");
      if (candidate.releaseId !== input.candidate.releaseId) {
        throw new Error("Candidate Runtime Host started the wrong release.");
      }
      if (candidate.instanceId === input.active.instanceId) {
        throw new Error(
          "Candidate Runtime Host reused the active instance ID.",
        );
      }

      await this.#phase(
        input,
        "candidate-health",
        this.#policy.healthTimeoutMs,
        transition,
        (context) => this.#adapter.waitUntilHealthy(candidate!, context),
      );
      await this.#phase(
        input,
        "quiesce-active",
        this.#policy.quiesceTimeoutMs,
        transition,
        async (context) => {
          await this.#adapter.quiesce(input.active, context);
          activeQuiesced = true;
        },
      );
      const drain = await this.#phase(
        input,
        "drain-active",
        this.#policy.drainTimeoutMs,
        transition,
        (context) => this.#adapter.drain(input.active, context),
      );
      assertDrainReport(drain);
      checkpoint = await this.#phase(
        input,
        "checkpoint-active",
        this.#policy.checkpointTimeoutMs,
        transition,
        (context) => this.#adapter.checkpoint(input.active, context),
      );
      assertCheckpoint(checkpoint);
      await this.#phase(
        input,
        "switch-traffic",
        this.#policy.switchTimeoutMs,
        transition,
        async (context) => {
          await this.#adapter.switchTraffic(
            {
              cutoverId: input.cutoverId,
              from: input.active,
              to: candidate!,
              checkpoint: checkpoint!,
              rollback: false,
            },
            context,
          );
          trafficSwitched = true;
        },
      );
      await this.#phase(
        input,
        "candidate-canary",
        this.#policy.canaryTimeoutMs,
        transition,
        (context) => this.#adapter.runCanary(candidate!, context),
      );
      await this.#phase(
        input,
        "commit-candidate",
        this.#policy.commitTimeoutMs,
        transition,
        (context) =>
          this.#adapter.commitCandidate(candidate!, checkpoint!, context),
      );

      await this.#safeCleanupPhase(
        input,
        "stop-previous",
        transition,
        cleanupFailures,
        (context) =>
          this.#adapter.stop(input.active, "cutover-committed", context),
      );
      try {
        await transition("committed");
      } catch (error) {
        cleanupFailures.push(`journal-transition: ${boundedReason(error)}`);
      }
      await this.#completeJournal(
        input.cutoverId,
        "committed",
        null,
        cleanupFailures,
        {
          candidateInstanceId: candidate.instanceId,
          checkpointId: checkpoint.checkpointId,
        },
      );
      return {
        cutoverId: input.cutoverId,
        outcome: "committed",
        activeReleaseId: input.active.releaseId,
        candidateReleaseId: input.candidate.releaseId,
        previousInstanceId: input.active.instanceId,
        candidateInstanceId: candidate.instanceId,
        checkpointId: checkpoint.checkpointId,
        startedAt,
        completedAt: this.#now(),
        failureReason: null,
        cleanupFailures,
        phases: transitions,
      };
    } catch (error) {
      const failureReason = boundedReason(error);
      let restored = true;

      if (trafficSwitched && candidate !== null && checkpoint !== null) {
        const rolledBack = await this.#safeCleanupPhase(
          input,
          "rollback-traffic",
          transition,
          cleanupFailures,
          (context) =>
            this.#adapter.switchTraffic(
              {
                cutoverId: input.cutoverId,
                from: candidate!,
                to: input.active,
                checkpoint: checkpoint!,
                rollback: true,
              },
              context,
            ),
        );
        restored &&= rolledBack;
      }

      if (activeQuiesced) {
        const resumed = await this.#safeCleanupPhase(
          input,
          "resume-active",
          transition,
          cleanupFailures,
          (context) => this.#adapter.resume(input.active, context),
        );
        restored &&= resumed;
      }

      if (candidate !== null) {
        const stopped = await this.#safeCleanupPhase(
          input,
          "stop-candidate",
          transition,
          cleanupFailures,
          (context) =>
            this.#adapter.stop(
              candidate!,
              trafficSwitched ? "cutover-rolled-back" : "candidate-rejected",
              context,
            ),
        );
        restored &&= stopped;
      }

      const outcome = restored ? "rolled-back" : "failed";
      try {
        await transition(outcome);
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
        {
          candidateInstanceId: candidate?.instanceId ?? null,
          checkpointId: checkpoint?.checkpointId ?? null,
        },
      );
      return {
        cutoverId: input.cutoverId,
        outcome,
        activeReleaseId: input.active.releaseId,
        candidateReleaseId: input.candidate.releaseId,
        previousInstanceId: input.active.instanceId,
        candidateInstanceId: candidate?.instanceId ?? null,
        checkpointId: checkpoint?.checkpointId ?? null,
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
    input: RuntimeCutoverInput,
    phase: RuntimeCutoverPhase,
    timeoutMs: number,
    transition: (phase: RuntimeCutoverPhase) => Promise<void>,
    operation: (context: RuntimeCutoverContext) => Promise<T>,
  ): Promise<T> {
    await transition(phase);
    const controller = new AbortController();

    const startedAt = this.#now();
    const context: RuntimeCutoverContext = {
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
        controller.abort(
          new Error(`Runtime cutover phase ${phase} timed out.`),
        );
        reject(
          new Error(
            `Runtime cutover phase ${phase} timed out after ${timeoutMs} ms.`,
          ),
        );
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
              : new Error(`Runtime cutover phase ${phase} was aborted.`),
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

  async #safeCleanupPhase(
    input: RuntimeCutoverInput,
    phase: RuntimeCutoverPhase,
    transition: (phase: RuntimeCutoverPhase) => Promise<void>,
    failures: string[],
    operation: (context: RuntimeCutoverContext) => Promise<void>,
  ): Promise<boolean> {
    const cleanupInput: RuntimeCutoverInput = {
      cutoverId: input.cutoverId,
      active: input.active,
      candidate: input.candidate,
    };
    const cleanupTransition = async (
      cleanupPhase: RuntimeCutoverPhase,
    ): Promise<void> => {
      try {
        await transition(cleanupPhase);
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
      await this.#phase(
        cleanupInput,
        phase,
        this.#policy.cleanupTimeoutMs,
        cleanupTransition,
        operation,
      );
      return true;
    } catch (error) {
      failures.push(`${phase}: ${boundedReason(error)}`.slice(0, 1_024));
      return false;
    }
  }
}
