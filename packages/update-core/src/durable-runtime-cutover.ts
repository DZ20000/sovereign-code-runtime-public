import {
  RuntimeCutoverCoordinator,
  RuntimeCutoverBusyError,
  type RuntimeCheckpoint,
  type RuntimeCutoverAdapter,
  type RuntimeCutoverContext,
  type RuntimeCutoverInput,
  type RuntimeCutoverPolicy,
  type RuntimeCutoverReceipt,
  type RuntimeCutoverTransition,
  type RuntimeDrainReport,
  type RuntimeHostHandle,
  type RuntimeReleaseCandidate,
  type RuntimeTrafficSwitch,
} from "./runtime-cutover.js";
import {
  CutoverLedger,
  ledgerFailureReason,
  type RuntimeLedgerTransitionContext,
} from "./cutover-ledger.js";
import {
  RuntimeRouteRegistry,
  type RuntimeRouteRevision,
  type RuntimeRouteTarget,
} from "./runtime-route.js";

export interface RuntimeCandidateRoute {
  readonly routeId: string;
}

export interface DurableRuntimeCutoverAdapter extends Omit<
  RuntimeCutoverAdapter,
  "switchTraffic"
> {
  describeRoute(
    host: RuntimeHostHandle,
    checkpoint: RuntimeCheckpoint,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeCandidateRoute>;
  applyAuthoritativeRoute(
    revision: RuntimeRouteRevision,
    context: RuntimeCutoverContext,
  ): Promise<void>;
}

export interface DurableRuntimeCutoverCoordinatorOptions {
  readonly adapter: DurableRuntimeCutoverAdapter;
  readonly ledger: CutoverLedger;
  readonly routes: RuntimeRouteRegistry;
  readonly policy?: RuntimeCutoverPolicy;
  readonly now?: () => number;
  readonly onTransition?: (transition: RuntimeCutoverTransition) => void;
}

export interface DurableRuntimeCutoverInput extends RuntimeCutoverInput {
  readonly expectedRouteGeneration: number;
}

const CLEANUP_PHASES = new Set<RuntimeCutoverContext["phase"]>([
  "rollback-traffic",
  "resume-active",
  "stop-candidate",
  "stop-previous",
]);

function sameHost(route: RuntimeRouteTarget, host: RuntimeHostHandle): boolean {
  return (
    route.instanceId === host.instanceId && route.releaseId === host.releaseId
  );
}

function assertRouteDescription(value: RuntimeCandidateRoute): void {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.routeId !== "string" ||
    value.routeId.length === 0 ||
    value.routeId.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value.routeId)
  ) {
    throw new Error("Runtime candidate route description is invalid.");
  }
}

export class DurableRuntimeCutoverRecordingError extends Error {
  readonly receipt: RuntimeCutoverReceipt;

  constructor(receipt: RuntimeCutoverReceipt, cause: unknown) {
    super(
      `Runtime cutover completed with outcome ${receipt.outcome}, but its durable receipt could not be recorded: ${ledgerFailureReason(cause)}`,
      { cause },
    );
    this.name = "DurableRuntimeCutoverRecordingError";
    this.receipt = receipt;
  }
}

class DurableAdapter implements RuntimeCutoverAdapter {
  readonly #base: DurableRuntimeCutoverAdapter;
  readonly #ledger: CutoverLedger;
  readonly #routes: RuntimeRouteRegistry;
  readonly #active: RuntimeHostHandle;
  readonly #releases: RuntimeLedgerTransitionContext;
  #candidate: RuntimeHostHandle | null = null;
  #ledgerFailure: unknown = null;

  constructor(options: {
    readonly base: DurableRuntimeCutoverAdapter;
    readonly ledger: CutoverLedger;
    readonly routes: RuntimeRouteRegistry;
    readonly active: RuntimeHostHandle;
    readonly releases: RuntimeLedgerTransitionContext;
  }) {
    this.#base = options.base;
    this.#ledger = options.ledger;
    this.#routes = options.routes;
    this.#active = options.active;
    this.#releases = options.releases;
  }

  get ledgerFailure(): unknown {
    return this.#ledgerFailure;
  }

  async #record(context: RuntimeCutoverContext): Promise<void> {
    try {
      await this.#ledger.appendRuntimeTransition(
        {
          cutoverId: context.cutoverId,
          phase: context.phase,
          at: context.startedAt,
          activeInstanceId: this.#active.instanceId,
          candidateInstanceId: this.#candidate?.instanceId ?? null,
        },
        this.#releases,
      );
    } catch (error) {
      this.#ledgerFailure ??= error;
      if (!CLEANUP_PHASES.has(context.phase)) throw error;
    }
  }

  async startCandidate(
    candidate: RuntimeReleaseCandidate,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeHostHandle> {
    await this.#record(context);
    const handle = await this.#base.startCandidate(candidate, context);
    this.#candidate = handle;
    return handle;
  }

  async waitUntilHealthy(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#record(context);
    await this.#base.waitUntilHealthy(candidate, context);
  }

  async quiesce(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#record(context);
    await this.#base.quiesce(active, context);
  }

  async drain(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeDrainReport> {
    await this.#record(context);
    return await this.#base.drain(active, context);
  }

  async checkpoint(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeCheckpoint> {
    await this.#record(context);
    return await this.#base.checkpoint(active, context);
  }

  async switchTraffic(
    change: RuntimeTrafficSwitch,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#record(context);
    const current = await this.#routes.readCurrent();
    if (current === null) {
      throw new Error("Runtime route registry is not bootstrapped.");
    }
    if (!sameHost(current.active, change.from)) {
      throw new Error(
        "Persisted Runtime route does not match the host from which traffic is being switched.",
      );
    }

    if (change.rollback) {
      const revision = await this.#routes.rollback({
        cutoverId: change.cutoverId,
        expectedGeneration: current.generation,
      });
      await this.#base.applyAuthoritativeRoute(revision, context);
      return;
    }

    const description = await this.#base.describeRoute(
      change.to,
      change.checkpoint,
      context,
    );
    assertRouteDescription(description);
    const candidateRoute: RuntimeRouteTarget = {
      instanceId: change.to.instanceId,
      releaseId: change.to.releaseId,
      routeId: description.routeId,
      checkpointId: change.checkpoint.checkpointId,
      fencingToken: change.checkpoint.fencingToken,
    };
    const switched = await this.#routes.switchTo(candidateRoute, {
      cutoverId: change.cutoverId,
      expectedGeneration: current.generation,
    });
    try {
      await this.#base.applyAuthoritativeRoute(switched, context);
    } catch (error) {
      const rolledBack = await this.#routes.rollback({
        cutoverId: `${change.cutoverId}:route-apply-rollback`,
        expectedGeneration: switched.generation,
      });
      try {
        await this.#base.applyAuthoritativeRoute(rolledBack, context);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Runtime route apply failed and the previous authoritative route could not be restored.",
        );
      }
      throw error;
    }
  }

  async runCanary(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#record(context);
    await this.#base.runCanary(candidate, context);
  }

  async commitCandidate(
    candidate: RuntimeHostHandle,
    checkpoint: RuntimeCheckpoint,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#record(context);
    await this.#base.commitCandidate(candidate, checkpoint, context);
    const current = await this.#routes.readCurrent();
    if (current === null || !sameHost(current.active, candidate)) {
      throw new Error(
        "Runtime route registry does not point at the candidate during commit.",
      );
    }
    await this.#routes.commit({
      cutoverId: `${context.cutoverId}:route-commit`,
      expectedGeneration: current.generation,
    });
  }

  async resume(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#record(context);
    await this.#base.resume(active, context);
  }

  async stop(
    host: RuntimeHostHandle,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#record(context);
    await this.#base.stop(host, reason, context);
  }
}

export class DurableRuntimeCutoverCoordinator {
  readonly #adapter: DurableRuntimeCutoverAdapter;
  readonly #ledger: CutoverLedger;
  readonly #routes: RuntimeRouteRegistry;
  readonly #policy: RuntimeCutoverPolicy | undefined;
  readonly #now: (() => number) | undefined;
  readonly #onTransition:
    | ((
        transition: import("./runtime-cutover.js").RuntimeCutoverTransition,
      ) => void)
    | undefined;
  #busy = false;

  constructor(options: DurableRuntimeCutoverCoordinatorOptions) {
    this.#adapter = options.adapter;
    this.#ledger = options.ledger;
    this.#routes = options.routes;
    this.#policy = options.policy;
    this.#now = options.now;
    this.#onTransition = options.onTransition;
  }

  get busy(): boolean {
    return this.#busy;
  }

  async cutover(
    input: DurableRuntimeCutoverInput,
  ): Promise<RuntimeCutoverReceipt> {
    if (this.#busy) throw new RuntimeCutoverBusyError();
    this.#busy = true;
    try {
      const current = await this.#routes.readCurrent();
      if (current === null) {
        throw new Error(
          "Runtime route registry must be bootstrapped before cutover.",
        );
      }
      if (current.generation !== input.expectedRouteGeneration) {
        throw new Error(
          `Runtime route generation changed: expected ${input.expectedRouteGeneration}, observed ${current.generation}.`,
        );
      }
      if (!sameHost(current.active, input.active)) {
        throw new Error(
          "Runtime route registry does not match the declared active Runtime Host.",
        );
      }
      const durableAdapter = new DurableAdapter({
        base: this.#adapter,
        ledger: this.#ledger,
        routes: this.#routes,
        active: input.active,
        releases: {
          activeReleaseId: input.active.releaseId,
          candidateReleaseId: input.candidate.releaseId,
        },
      });
      const coordinator = new RuntimeCutoverCoordinator({
        adapter: durableAdapter,
        ...(this.#policy === undefined ? {} : { policy: this.#policy }),
        ...(this.#now === undefined ? {} : { now: this.#now }),
        ...(this.#onTransition === undefined
          ? {}
          : { onTransition: this.#onTransition }),
      });
      const receipt = await coordinator.cutover({
        cutoverId: input.cutoverId,
        active: input.active,
        candidate: input.candidate,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      try {
        await this.#ledger.appendRuntimeReceipt(receipt);
        if (durableAdapter.ledgerFailure !== null) {
          throw durableAdapter.ledgerFailure;
        }
      } catch (error) {
        throw new DurableRuntimeCutoverRecordingError(receipt, error);
      }
      return receipt;
    } finally {
      this.#busy = false;
    }
  }
}
