import type {
  RuntimeCheckpoint,
  RuntimeCutoverAdapter,
  RuntimeCutoverContext,
  RuntimeHostHandle,
  RuntimeReleaseCandidate,
  RuntimeTrafficSwitch,
} from "./runtime-cutover.js";
import {
  RuntimeTrafficRegistry,
  type RuntimeTrafficSnapshot,
} from "./runtime-traffic.js";

export interface RuntimeCandidateLifecycle {
  startCandidate(
    candidate: RuntimeReleaseCandidate,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeHostHandle>;
  waitUntilHealthy(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  checkpoint(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeCheckpoint>;
  runCanary(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  commitCandidate(
    candidate: RuntimeHostHandle,
    checkpoint: RuntimeCheckpoint,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  stop(
    host: RuntimeHostHandle,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
    context: RuntimeCutoverContext,
  ): Promise<void>;
}

export interface RuntimeTrafficCutoverAdapterOptions {
  readonly traffic: RuntimeTrafficRegistry;
  readonly lifecycle: RuntimeCandidateLifecycle;
  readonly onTrafficChange?: (snapshot: RuntimeTrafficSnapshot) => void;
}

function sameHost(left: RuntimeHostHandle, right: RuntimeHostHandle): boolean {
  return (
    left.instanceId === right.instanceId && left.releaseId === right.releaseId
  );
}

function phaseTimeoutMs(context: RuntimeCutoverContext): number {
  const value = context.deadlineAt - context.startedAt;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
    throw new Error("Runtime cutover context has an invalid deadline.");
  }
  return value;
}

/**
 * Concrete RuntimeCutoverAdapter that supplies quiescence, in-flight drain,
 * traffic fencing, rollback routing, and active-host guards through a
 * RuntimeTrafficRegistry. Process startup, health, checkpoint persistence,
 * canary, commit, and process termination remain shell-specific lifecycle
 * callbacks.
 */
export class RuntimeTrafficCutoverAdapter implements RuntimeCutoverAdapter {
  readonly #traffic: RuntimeTrafficRegistry;
  readonly #lifecycle: RuntimeCandidateLifecycle;
  readonly #onTrafficChange:
    ((snapshot: RuntimeTrafficSnapshot) => void) | undefined;

  constructor(options: RuntimeTrafficCutoverAdapterOptions) {
    if (!(options.traffic instanceof RuntimeTrafficRegistry)) {
      throw new Error("Runtime traffic registry is required.");
    }
    if (typeof options.lifecycle !== "object" || options.lifecycle === null) {
      throw new Error("Runtime candidate lifecycle is required.");
    }
    this.#traffic = options.traffic;
    this.#lifecycle = options.lifecycle;
    this.#onTrafficChange = options.onTrafficChange;
  }

  startCandidate(
    candidate: RuntimeReleaseCandidate,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeHostHandle> {
    return this.#lifecycle.startCandidate(candidate, context);
  }

  waitUntilHealthy(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    return this.#lifecycle.waitUntilHealthy(candidate, context);
  }

  async quiesce(
    active: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    const snapshot = this.#traffic.snapshot();
    if (!sameHost(snapshot.active, active)) {
      throw new Error(
        "Cutover active host does not match the traffic registry.",
      );
    }
    this.#traffic.quiesce(active.instanceId, snapshot.generation);
    this.#emit();
  }

  async drain(active: RuntimeHostHandle, context: RuntimeCutoverContext) {
    const report = await this.#traffic.drain(active.instanceId, {
      timeoutMs: phaseTimeoutMs(context),
      signal: context.signal,
    });
    this.#emit();
    return report;
  }

  checkpoint(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeCheckpoint> {
    return this.#lifecycle.checkpoint(active, context);
  }

  async switchTraffic(
    change: RuntimeTrafficSwitch,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    let snapshot = this.#traffic.snapshot();
    if (!sameHost(snapshot.active, change.from)) {
      throw new Error(
        "Runtime traffic switch source is no longer authoritative.",
      );
    }
    if (
      change.rollback &&
      !snapshot.quiescedInstanceIds.includes(change.from.instanceId)
    ) {
      this.#traffic.quiesce(change.from.instanceId, snapshot.generation);
      const drain = await this.#traffic.drain(change.from.instanceId, {
        timeoutMs: phaseTimeoutMs(_context),
        signal: _context.signal,
      });
      if (drain.inFlight !== 0 || drain.unknown !== 0) {
        throw new Error(
          `Runtime rollback source did not drain safely: inFlight=${drain.inFlight}, unknown=${drain.unknown}.`,
        );
      }
      snapshot = this.#traffic.snapshot();
    }
    this.#traffic.switchActive({
      expectedGeneration: snapshot.generation,
      from: change.from,
      to: change.to,
      checkpoint: change.checkpoint,
    });
    this.#emit();
  }

  runCanary(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    const snapshot = this.#traffic.snapshot();
    if (!sameHost(snapshot.active, candidate)) {
      return Promise.reject(
        new Error(
          "Runtime canary target is not the authoritative traffic host.",
        ),
      );
    }
    return this.#lifecycle.runCanary(candidate, context);
  }

  commitCandidate(
    candidate: RuntimeHostHandle,
    checkpoint: RuntimeCheckpoint,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    const snapshot = this.#traffic.snapshot();
    if (!sameHost(snapshot.active, candidate)) {
      return Promise.reject(
        new Error(
          "Runtime commit target is not the authoritative traffic host.",
        ),
      );
    }
    if (snapshot.fencingToken !== checkpoint.fencingToken) {
      return Promise.reject(
        new Error(
          "Runtime traffic fencing token does not match the checkpoint.",
        ),
      );
    }
    return this.#lifecycle.commitCandidate(candidate, checkpoint, context);
  }

  async resume(
    active: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    const snapshot = this.#traffic.snapshot();
    if (!sameHost(snapshot.active, active)) {
      throw new Error("Only the authoritative Runtime Host may be resumed.");
    }
    this.#traffic.resume(active.instanceId);
    this.#emit();
  }

  async stop(
    host: RuntimeHostHandle,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
    context: RuntimeCutoverContext,
  ): Promise<void> {
    const snapshot = this.#traffic.snapshot();
    if (sameHost(snapshot.active, host)) {
      throw new Error("Refusing to stop the authoritative Runtime Host.");
    }
    await this.#lifecycle.stop(host, reason, context);
  }

  #emit(): void {
    try {
      this.#onTrafficChange?.(this.#traffic.snapshot());
    } catch {
      // Rendering/audit observers cannot change Runtime Host authority.
    }
  }
}
