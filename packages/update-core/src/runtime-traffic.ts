import type {
  RuntimeCheckpoint,
  RuntimeDrainReport,
  RuntimeHostHandle,
} from "./runtime-cutover.js";

export const RUNTIME_OPERATION_KINDS = ["read", "consequential"] as const;
export type RuntimeOperationKind = (typeof RUNTIME_OPERATION_KINDS)[number];

export const RUNTIME_OPERATION_OUTCOMES = [
  "completed",
  "cancelled",
  "unknown",
] as const;
export type RuntimeOperationOutcome =
  (typeof RUNTIME_OPERATION_OUTCOMES)[number];

export interface RuntimeTrafficSnapshot {
  readonly generation: number;
  readonly active: RuntimeHostHandle;
  readonly quiescedInstanceIds: readonly string[];
  readonly inFlight: Readonly<Record<string, number>>;
  readonly unknown: Readonly<Record<string, number>>;
  readonly cancelled: Readonly<Record<string, number>>;
  readonly fencingToken: string | null;
}

export interface RuntimeTrafficLease {
  readonly leaseId: string;
  readonly instanceId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly kind: RuntimeOperationKind;
  readonly startedAt: number;
  finish(outcome?: RuntimeOperationOutcome): boolean;
}

export interface BeginRuntimeTrafficOptions {
  readonly kind: RuntimeOperationKind;
  readonly expectedGeneration?: number;
  readonly leaseId?: string;
}

export interface RuntimeDrainOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeTrafficSwitchInput {
  readonly expectedGeneration: number;
  readonly from: RuntimeHostHandle;
  readonly to: RuntimeHostHandle;
  readonly checkpoint: RuntimeCheckpoint;
}

export interface RuntimeUnknownResolution {
  readonly leaseId: string;
  readonly resolution: "completed" | "not-applied";
}

export interface RuntimeTrafficRegistryOptions {
  readonly active: RuntimeHostHandle;
  readonly generation?: number;
  readonly now?: () => number;
  readonly onChange?: (snapshot: RuntimeTrafficSnapshot) => void;
}

interface InFlightOperation {
  readonly leaseId: string;
  readonly instanceId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly kind: RuntimeOperationKind;
  readonly startedAt: number;
}

interface UnknownOperation extends InFlightOperation {
  readonly unknownAt: number;
}

interface DrainWaiter {
  readonly instanceId: string;
  readonly resolve: () => void;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const MAX_TRACKED_OPERATIONS = 100_000;

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertHost(value: RuntimeHostHandle, label: string): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} is invalid.`);
  }
  assertIdentifier(value.instanceId, `${label} instance ID`);
  assertIdentifier(value.releaseId, `${label} release ID`);
}

function assertCheckpoint(value: RuntimeCheckpoint): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("Runtime checkpoint is invalid.");
  }
  assertIdentifier(value.checkpointId, "Runtime checkpoint ID");
  assertIdentifier(value.fencingToken, "Runtime checkpoint fencing token");
}

function countByInstance<T extends { readonly instanceId: string }>(
  values: Iterable<T>,
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value.instanceId, (counts.get(value.instanceId) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function boundedTimeout(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 10 * 60_000
  ) {
    throw new Error("Runtime drain timeout is invalid.");
  }
  return value;
}

export class RuntimeTrafficQuiescedError extends Error {
  constructor(instanceId: string) {
    super(
      `Runtime Host ${instanceId} is quiesced and is not accepting new calls.`,
    );
    this.name = "RuntimeTrafficQuiescedError";
  }
}

export class RuntimeTrafficGenerationError extends Error {
  constructor(expected: number, observed: number) {
    super(
      `Runtime traffic generation changed: expected ${expected}, observed ${observed}.`,
    );
    this.name = "RuntimeTrafficGenerationError";
  }
}

/**
 * Tracks the authoritative Runtime Host route and the exact in-flight/unknown
 * operation boundary used by a rolling cutover adapter. This registry is
 * process-local; the cutover checkpoint and signed update journal remain the
 * durable authority across shell restarts.
 */
export class RuntimeTrafficRegistry {
  #active: RuntimeHostHandle;
  #generation: number;
  #fencingToken: string | null = null;
  readonly #now: () => number;
  readonly #onChange: ((snapshot: RuntimeTrafficSnapshot) => void) | undefined;
  readonly #quiesced = new Set<string>();
  readonly #inFlight = new Map<string, InFlightOperation>();
  readonly #unknown = new Map<string, UnknownOperation>();
  readonly #cancelled = new Map<string, number>();
  readonly #waiters = new Set<DrainWaiter>();
  #leaseSequence = 0;

  constructor(options: RuntimeTrafficRegistryOptions) {
    assertHost(options.active, "Active Runtime Host");
    const generation = options.generation ?? 1;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Runtime traffic generation is invalid.");
    }
    this.#active = { ...options.active };
    this.#generation = generation;
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange;
  }

  snapshot(): RuntimeTrafficSnapshot {
    return {
      generation: this.#generation,
      active: { ...this.#active },
      quiescedInstanceIds: [...this.#quiesced].sort(),
      inFlight: countByInstance(this.#inFlight.values()),
      unknown: countByInstance(this.#unknown.values()),
      cancelled: Object.fromEntries(
        [...this.#cancelled.entries()].sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
      fencingToken: this.#fencingToken,
    };
  }

  begin(options: BeginRuntimeTrafficOptions): RuntimeTrafficLease {
    if (!RUNTIME_OPERATION_KINDS.includes(options.kind)) {
      throw new Error("Runtime operation kind is invalid.");
    }
    if (
      options.expectedGeneration !== undefined &&
      options.expectedGeneration !== this.#generation
    ) {
      throw new RuntimeTrafficGenerationError(
        options.expectedGeneration,
        this.#generation,
      );
    }
    if (this.#quiesced.has(this.#active.instanceId)) {
      throw new RuntimeTrafficQuiescedError(this.#active.instanceId);
    }
    if (this.#inFlight.size + this.#unknown.size >= MAX_TRACKED_OPERATIONS) {
      throw new Error("Runtime traffic registry reached its operation limit.");
    }

    const leaseId =
      options.leaseId ??
      `runtime-call:${this.#generation}:${++this.#leaseSequence}`;
    assertIdentifier(leaseId, "Runtime traffic lease ID");
    if (this.#inFlight.has(leaseId) || this.#unknown.has(leaseId)) {
      throw new Error(
        `Runtime traffic lease ID is already tracked: ${leaseId}.`,
      );
    }
    const operation: InFlightOperation = {
      leaseId,
      instanceId: this.#active.instanceId,
      releaseId: this.#active.releaseId,
      generation: this.#generation,
      kind: options.kind,
      startedAt: this.#now(),
    };
    this.#inFlight.set(leaseId, operation);
    this.#emit();

    let finished = false;
    return {
      ...operation,
      finish: (outcome: RuntimeOperationOutcome = "completed"): boolean => {
        if (finished) return false;
        if (!RUNTIME_OPERATION_OUTCOMES.includes(outcome)) {
          throw new Error("Runtime operation outcome is invalid.");
        }
        finished = true;
        const tracked = this.#inFlight.get(leaseId);
        if (tracked === undefined) return false;
        this.#inFlight.delete(leaseId);
        if (outcome === "unknown") {
          this.#unknown.set(leaseId, {
            ...tracked,
            unknownAt: this.#now(),
          });
        } else if (outcome === "cancelled") {
          this.#cancelled.set(
            tracked.instanceId,
            (this.#cancelled.get(tracked.instanceId) ?? 0) + 1,
          );
        }
        this.#notifyDrained(tracked.instanceId);
        this.#emit();
        return true;
      },
    };
  }

  quiesce(instanceId: string, expectedGeneration: number): void {
    assertIdentifier(instanceId, "Runtime Host instance ID");
    this.#assertGeneration(expectedGeneration);
    if (instanceId !== this.#active.instanceId) {
      throw new Error("Only the active Runtime Host may be quiesced.");
    }
    this.#quiesced.add(instanceId);
    this.#emit();
  }

  resume(instanceId: string): void {
    assertIdentifier(instanceId, "Runtime Host instance ID");
    if (this.#quiesced.delete(instanceId)) this.#emit();
  }

  async drain(
    instanceId: string,
    options: RuntimeDrainOptions,
  ): Promise<RuntimeDrainReport> {
    assertIdentifier(instanceId, "Runtime Host instance ID");
    const timeoutMs = boundedTimeout(options.timeoutMs);
    if (!this.#quiesced.has(instanceId)) {
      throw new Error("Runtime Host must be quiesced before draining.");
    }
    if (options.signal?.aborted === true) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Runtime drain was aborted before it started.");
    }

    if (this.#inFlightCount(instanceId) > 0) {
      await new Promise<void>((resolveDrain, rejectDrain) => {
        let settled = false;
        const waiter: DrainWaiter = {
          instanceId,
          resolve: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            this.#waiters.delete(waiter);
            resolveDrain();
          },
        };
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#waiters.delete(waiter);
          rejectDrain(
            options.signal?.reason instanceof Error
              ? options.signal.reason
              : new Error("Runtime drain was aborted."),
          );
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", onAbort);
          this.#waiters.delete(waiter);
          rejectDrain(
            new Error(`Runtime drain timed out after ${timeoutMs} ms.`),
          );
        }, timeoutMs);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        this.#waiters.add(waiter);
      });
    }

    return {
      inFlight: this.#inFlightCount(instanceId),
      cancelled: this.#cancelled.get(instanceId) ?? 0,
      unknown: this.#unknownCount(instanceId),
    };
  }

  reconcileUnknown(resolution: RuntimeUnknownResolution): boolean {
    assertIdentifier(resolution.leaseId, "Unknown runtime lease ID");
    if (
      resolution.resolution !== "completed" &&
      resolution.resolution !== "not-applied"
    ) {
      throw new Error("Unknown runtime operation resolution is invalid.");
    }
    const removed = this.#unknown.delete(resolution.leaseId);
    if (removed) this.#emit();
    return removed;
  }

  switchActive(input: RuntimeTrafficSwitchInput): RuntimeTrafficSnapshot {
    assertHost(input.from, "Previous Runtime Host");
    assertHost(input.to, "Candidate Runtime Host");
    assertCheckpoint(input.checkpoint);
    this.#assertGeneration(input.expectedGeneration);
    if (
      input.from.instanceId !== this.#active.instanceId ||
      input.from.releaseId !== this.#active.releaseId
    ) {
      throw new Error("Runtime traffic switch source is not the active host.");
    }
    if (input.to.instanceId === input.from.instanceId) {
      throw new Error(
        "Runtime traffic switch target must use a different instance ID.",
      );
    }
    if (!this.#quiesced.has(input.from.instanceId)) {
      throw new Error("Runtime traffic switch source must be quiesced.");
    }
    if (this.#inFlightCount(input.from.instanceId) !== 0) {
      throw new Error(
        "Runtime traffic switch source still has in-flight calls.",
      );
    }
    if (this.#unknownCount(input.from.instanceId) !== 0) {
      throw new Error(
        "Runtime traffic switch source still has unknown side effects.",
      );
    }

    this.#active = { ...input.to };
    this.#generation += 1;
    this.#fencingToken = input.checkpoint.fencingToken;
    this.#quiesced.delete(input.to.instanceId);
    this.#emit();
    return this.snapshot();
  }

  clearCancelled(instanceId: string): number {
    assertIdentifier(instanceId, "Runtime Host instance ID");
    const count = this.#cancelled.get(instanceId) ?? 0;
    this.#cancelled.delete(instanceId);
    if (count > 0) this.#emit();
    return count;
  }

  #assertGeneration(expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 1) {
      throw new Error("Expected runtime traffic generation is invalid.");
    }
    if (expected !== this.#generation) {
      throw new RuntimeTrafficGenerationError(expected, this.#generation);
    }
  }

  #inFlightCount(instanceId: string): number {
    let count = 0;
    for (const operation of this.#inFlight.values()) {
      if (operation.instanceId === instanceId) count += 1;
    }
    return count;
  }

  #unknownCount(instanceId: string): number {
    let count = 0;
    for (const operation of this.#unknown.values()) {
      if (operation.instanceId === instanceId) count += 1;
    }
    return count;
  }

  #notifyDrained(instanceId: string): void {
    if (this.#inFlightCount(instanceId) !== 0) return;
    for (const waiter of [...this.#waiters]) {
      if (waiter.instanceId === instanceId) waiter.resolve();
    }
  }

  #emit(): void {
    try {
      this.#onChange?.(this.snapshot());
    } catch {
      // Observers cannot change traffic authority.
    }
  }
}
