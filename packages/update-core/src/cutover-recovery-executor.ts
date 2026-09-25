import {
  CutoverLedger,
  type CutoverLedgerEntry,
  type CutoverRecoveryAction,
} from "./cutover-ledger.js";
import {
  CutoverRecoveryInspector,
  type ResolvedCutoverRecoveryPlan,
} from "./cutover-recovery.js";
import {
  type RendererCutoverContext,
  type RendererCutoverPhase,
  type RendererCutoverReceipt,
  type RendererTarget,
} from "./renderer-cutover.js";
import {
  RendererSlotStore,
  type RendererSlotPointer,
} from "./renderer-slot.js";
import {
  type RuntimeCheckpoint,
  type RuntimeCutoverContext,
  type RuntimeCutoverPhase,
  type RuntimeCutoverReceipt,
  type RuntimeHostHandle,
} from "./runtime-cutover.js";
import {
  RuntimeRouteRegistry,
  type RuntimeRouteRevision,
} from "./runtime-route.js";

export interface RuntimeCutoverRecoveryAdapter {
  applyAuthoritativeRoute(
    revision: RuntimeRouteRevision,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  verifyAuthoritative(
    host: RuntimeHostHandle,
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

export interface RendererCutoverRecoveryAdapter {
  reload(
    target: RendererTarget,
    context: RendererCutoverContext,
  ): Promise<void>;
  waitUntilReady(
    target: RendererTarget,
    context: RendererCutoverContext,
  ): Promise<void>;
}

export interface CutoverRecoveryExecutorOptions {
  readonly ledger: CutoverLedger;
  readonly inspector: CutoverRecoveryInspector;
  readonly routes: RuntimeRouteRegistry;
  readonly rendererSlots: RendererSlotStore;
  readonly runtime: RuntimeCutoverRecoveryAdapter;
  readonly renderer: RendererCutoverRecoveryAdapter;
  readonly now?: () => number;
  readonly phaseTimeoutMs?: number;
}

export interface CutoverRecoveryExecutionReceipt {
  readonly recoveryId: string;
  readonly cutoverId: string;
  readonly kind: "runtime" | "renderer";
  readonly action: CutoverRecoveryAction;
  readonly outcome: "committed" | "rolled-back";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly authorityGeneration: number | null;
  readonly authoritativeReleaseId: string;
  readonly candidateReleaseId: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const DEFAULT_PHASE_TIMEOUT_MS = 30_000;

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (
    normalized.length === 0 ? "Cutover recovery failed." : normalized
  ).slice(0, 1_024);
}

function runtimeEntries(
  entries: readonly CutoverLedgerEntry[],
  cutoverId: string,
): readonly CutoverLedgerEntry[] {
  return entries.filter(
    (entry) =>
      entry.payload.cutoverId === cutoverId && entry.payload.kind === "runtime",
  );
}

function rendererEntries(
  entries: readonly CutoverLedgerEntry[],
  cutoverId: string,
): readonly CutoverLedgerEntry[] {
  return entries.filter(
    (entry) =>
      entry.payload.cutoverId === cutoverId &&
      entry.payload.kind === "renderer",
  );
}

function runtimeIdentity(entries: readonly CutoverLedgerEntry[]): {
  readonly activeInstanceId: string;
  readonly candidateInstanceId: string;
  readonly startedAt: number;
} {
  const activeInstanceId = entries
    .map((entry) => entry.payload.activeInstanceId)
    .find((value): value is string => value !== null);
  const candidateInstanceId = [...entries]
    .reverse()
    .map((entry) => entry.payload.candidateInstanceId)
    .find((value): value is string => value !== null);
  if (activeInstanceId === undefined) {
    throw new Error(
      "Interrupted Runtime cutover does not identify its active host.",
    );
  }
  if (candidateInstanceId === undefined) {
    throw new Error(
      "Interrupted Runtime cutover does not identify a candidate host that can be stopped safely.",
    );
  }
  return {
    activeInstanceId,
    candidateInstanceId,
    startedAt: entries[0]?.recordedAt ?? Date.now(),
  };
}

function candidateCheckpoint(
  route: RuntimeRouteRevision,
  candidateReleaseId: string,
): RuntimeCheckpoint | null {
  const target =
    route.active.releaseId === candidateReleaseId
      ? route.active
      : route.previous?.releaseId === candidateReleaseId
        ? route.previous
        : null;
  return target === null
    ? null
    : {
        checkpointId: target.checkpointId,
        fencingToken: target.fencingToken,
      };
}

function rendererPreviousGeneration(
  entries: readonly CutoverLedgerEntry[],
): number {
  const generations = entries
    .map((entry) => entry.payload.generation)
    .filter((value): value is number => value !== null);
  if (generations.length === 0) {
    throw new Error(
      "Interrupted renderer cutover does not contain a generation.",
    );
  }
  return Math.min(...generations);
}

function rendererTarget(
  slot: Awaited<ReturnType<RendererSlotStore["verifySlot"]>>,
  pointer: RendererSlotPointer,
): RendererTarget {
  return {
    releaseId: slot.releaseId,
    entrypoint: slot.entrypoint,
    manifestSha256: slot.manifestSha256,
    generation: pointer.generation,
  };
}

export class CutoverRecoveryUnsafeError extends Error {
  readonly plan: ResolvedCutoverRecoveryPlan;

  constructor(plan: ResolvedCutoverRecoveryPlan, reason?: string) {
    super(
      reason ??
        `Cutover ${plan.cutoverId} recovery is not safe to automate: ${plan.reason}`,
    );
    this.name = "CutoverRecoveryUnsafeError";
    this.plan = plan;
  }
}

export class CutoverRecoveryBusyError extends Error {
  constructor() {
    super("Another cutover recovery is already active.");
    this.name = "CutoverRecoveryBusyError";
  }
}

export class CutoverRecoveryExecutor {
  readonly #ledger: CutoverLedger;
  readonly #inspector: CutoverRecoveryInspector;
  readonly #routes: RuntimeRouteRegistry;
  readonly #rendererSlots: RendererSlotStore;
  readonly #runtime: RuntimeCutoverRecoveryAdapter;
  readonly #renderer: RendererCutoverRecoveryAdapter;
  readonly #now: () => number;
  readonly #phaseTimeoutMs: number;
  #busy = false;

  constructor(options: CutoverRecoveryExecutorOptions) {
    this.#ledger = options.ledger;
    this.#inspector = options.inspector;
    this.#routes = options.routes;
    this.#rendererSlots = options.rendererSlots;
    this.#runtime = options.runtime;
    this.#renderer = options.renderer;
    this.#now = options.now ?? Date.now;
    this.#phaseTimeoutMs = options.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#phaseTimeoutMs) ||
      this.#phaseTimeoutMs < 1 ||
      this.#phaseTimeoutMs > 10 * 60_000
    ) {
      throw new Error("Cutover recovery phase timeout is invalid.");
    }
  }

  get busy(): boolean {
    return this.#busy;
  }

  async recover(cutoverId: string): Promise<CutoverRecoveryExecutionReceipt> {
    if (this.#busy) throw new CutoverRecoveryBusyError();
    assertIdentifier(cutoverId, "Cutover recovery cutover ID");
    this.#busy = true;
    try {
      const plan = (await this.#inspector.inspect()).find(
        (candidate) => candidate.cutoverId === cutoverId,
      );
      if (plan === undefined) {
        throw new Error(
          `No interrupted cutover requires recovery: ${cutoverId}.`,
        );
      }
      if (!plan.safeToAutomate) throw new CutoverRecoveryUnsafeError(plan);
      const entries = await this.#ledger.readAll();
      return plan.kind === "runtime"
        ? await this.#recoverRuntime(plan, runtimeEntries(entries, cutoverId))
        : await this.#recoverRenderer(
            plan,
            rendererEntries(entries, cutoverId),
          );
    } finally {
      this.#busy = false;
    }
  }

  async #recoverRuntime(
    plan: ResolvedCutoverRecoveryPlan,
    entries: readonly CutoverLedgerEntry[],
  ): Promise<CutoverRecoveryExecutionReceipt> {
    const identity = runtimeIdentity(entries);
    const startedAt = this.#now();
    let route = await this.#routes.readCurrent();
    if (route === null) {
      throw new CutoverRecoveryUnsafeError(
        plan,
        "Runtime route registry is not initialized.",
      );
    }
    const activeHost: RuntimeHostHandle = {
      instanceId: identity.activeInstanceId,
      releaseId: plan.activeReleaseId,
    };
    const candidateHost: RuntimeHostHandle = {
      instanceId: identity.candidateInstanceId,
      releaseId: plan.candidateReleaseId,
    };
    const transition = async (phase: RuntimeCutoverPhase): Promise<void> => {
      await this.#ledger.appendRuntimeTransition(
        {
          cutoverId: plan.cutoverId,
          phase,
          at: this.#now(),
          activeInstanceId: activeHost.instanceId,
          candidateInstanceId: candidateHost.instanceId,
        },
        {
          activeReleaseId: plan.activeReleaseId,
          candidateReleaseId: plan.candidateReleaseId,
        },
      );
    };

    switch (plan.resolvedAction) {
      case "stop-candidate":
        await transition("stop-candidate");
        await this.#runtimePhase(plan, "stop-candidate", (context) =>
          this.#runtime.stop(candidateHost, "candidate-rejected", context),
        );
        break;
      case "resume-active-and-stop-candidate":
        await transition("resume-active");
        await this.#runtimePhase(plan, "resume-active", async (context) => {
          await this.#runtime.verifyAuthoritative(activeHost, context);
          await this.#runtime.resume(activeHost, context);
        });
        await transition("stop-candidate");
        await this.#runtimePhase(plan, "stop-candidate", (context) =>
          this.#runtime.stop(candidateHost, "cutover-rolled-back", context),
        );
        break;
      case "rollback-traffic-resume-active-stop-candidate":
        await transition("rollback-traffic");
        route = await this.#runtimePhase(
          plan,
          "rollback-traffic",
          async (context) => {
            const rolledBack = await this.#routes.rollback({
              cutoverId: `${plan.cutoverId}:recovery-route-rollback`,
              expectedGeneration: route!.generation,
            });
            await this.#runtime.applyAuthoritativeRoute(rolledBack, context);
            return rolledBack;
          },
        );
        await transition("resume-active");
        await this.#runtimePhase(plan, "resume-active", async (context) => {
          await this.#runtime.verifyAuthoritative(activeHost, context);
          await this.#runtime.resume(activeHost, context);
        });
        await transition("stop-candidate");
        await this.#runtimePhase(plan, "stop-candidate", (context) =>
          this.#runtime.stop(candidateHost, "cutover-rolled-back", context),
        );
        break;
      case "finish-commit-cleanup":
        await this.#runtimePhase(plan, "commit-candidate", async (context) => {
          await this.#runtime.verifyAuthoritative(candidateHost, context);
          if (route!.previous !== null) {
            await transition("commit-candidate");
            route = await this.#routes.commit({
              cutoverId: `${plan.cutoverId}:recovery-route-commit`,
              expectedGeneration: route!.generation,
            });
            await this.#runtime.applyAuthoritativeRoute(route, context);
          }
        });
        await transition("stop-previous");
        await this.#runtimePhase(plan, "stop-previous", (context) =>
          this.#runtime.stop(activeHost, "cutover-committed", context),
        );
        break;
      default:
        throw new CutoverRecoveryUnsafeError(plan);
    }

    const outcome =
      plan.resolvedAction === "finish-commit-cleanup"
        ? ("committed" as const)
        : ("rolled-back" as const);
    route = (await this.#routes.readCurrent()) ?? route;
    const checkpoint = candidateCheckpoint(route, plan.candidateReleaseId);
    const receipt: RuntimeCutoverReceipt = {
      cutoverId: plan.cutoverId,
      outcome,
      activeReleaseId: plan.activeReleaseId,
      candidateReleaseId: plan.candidateReleaseId,
      previousInstanceId: activeHost.instanceId,
      candidateInstanceId: candidateHost.instanceId,
      checkpointId: checkpoint?.checkpointId ?? null,
      startedAt: identity.startedAt,
      completedAt: this.#now(),
      failureReason: `Recovered interrupted Runtime cutover after ${plan.lastPhase ?? "unknown"}.`,
      cleanupFailures: [],
      phases: [],
    };
    await this.#ledger.appendRuntimeReceipt(receipt);
    return {
      recoveryId: `${plan.cutoverId}:recovery`,
      cutoverId: plan.cutoverId,
      kind: "runtime",
      action: plan.resolvedAction,
      outcome,
      startedAt,
      completedAt: this.#now(),
      authorityGeneration: route.generation,
      authoritativeReleaseId: route.active.releaseId,
      candidateReleaseId: plan.candidateReleaseId,
    };
  }

  async #recoverRenderer(
    plan: ResolvedCutoverRecoveryPlan,
    entries: readonly CutoverLedgerEntry[],
  ): Promise<CutoverRecoveryExecutionReceipt> {
    const startedAt = this.#now();
    const firstRecordedAt = entries[0]?.recordedAt ?? startedAt;
    const previousGeneration = rendererPreviousGeneration(entries);
    let pointer = await this.#rendererSlots.readPointer();
    if (pointer === null) {
      throw new CutoverRecoveryUnsafeError(
        plan,
        "Renderer slot pointer is not initialized.",
      );
    }
    const transition = async (
      phase: RendererCutoverPhase,
      generation: number,
    ): Promise<void> => {
      await this.#ledger.appendRendererTransition({
        cutoverId: plan.cutoverId,
        phase,
        at: this.#now(),
        previousReleaseId: plan.activeReleaseId,
        candidateReleaseId: plan.candidateReleaseId,
        generation,
      });
    };

    switch (plan.resolvedAction) {
      case "none":
        break;
      case "rollback-renderer":
        await transition("rollback-pointer", pointer.generation);
        pointer = await this.#rendererPhase(
          plan,
          "rollback-pointer",
          async () =>
            await this.#rendererSlots.rollback({
              expectedGeneration: pointer!.generation,
            }),
        );
        await this.#reloadPreviousRenderer(plan, pointer, transition);
        break;
      case "finish-renderer-rollback":
        await this.#reloadPreviousRenderer(plan, pointer, transition);
        break;
      default:
        throw new CutoverRecoveryUnsafeError(plan);
    }

    pointer = (await this.#rendererSlots.readPointer()) ?? pointer;
    const receipt: RendererCutoverReceipt = {
      cutoverId: plan.cutoverId,
      outcome: "rolled-back",
      previousReleaseId: plan.activeReleaseId,
      candidateReleaseId: plan.candidateReleaseId,
      previousGeneration,
      finalGeneration: pointer.generation,
      stateBytes: 0,
      startedAt: firstRecordedAt,
      completedAt: this.#now(),
      failureReason: `Recovered interrupted renderer cutover after ${plan.lastPhase ?? "unknown"}.`,
      cleanupFailures: [],
      phases: [],
    };
    await this.#ledger.appendRendererReceipt(receipt);
    return {
      recoveryId: `${plan.cutoverId}:recovery`,
      cutoverId: plan.cutoverId,
      kind: "renderer",
      action: plan.resolvedAction,
      outcome: "rolled-back",
      startedAt,
      completedAt: this.#now(),
      authorityGeneration: pointer.generation,
      authoritativeReleaseId: pointer.activeReleaseId,
      candidateReleaseId: plan.candidateReleaseId,
    };
  }

  async #reloadPreviousRenderer(
    plan: ResolvedCutoverRecoveryPlan,
    pointer: RendererSlotPointer,
    transition: (
      phase: RendererCutoverPhase,
      generation: number,
    ) => Promise<void>,
  ): Promise<void> {
    if (pointer.activeReleaseId !== plan.activeReleaseId) {
      throw new CutoverRecoveryUnsafeError(
        plan,
        "Renderer pointer does not select the expected rollback release.",
      );
    }
    const slot = await this.#rendererSlots.verifySlot(pointer.activeReleaseId);
    const target = rendererTarget(slot, pointer);
    await transition("reload-previous", pointer.generation);
    await this.#rendererPhase(plan, "reload-previous", (context) =>
      this.#renderer.reload(target, context),
    );
    await transition("previous-ready", pointer.generation);
    await this.#rendererPhase(plan, "previous-ready", (context) =>
      this.#renderer.waitUntilReady(target, context),
    );
  }

  async #runtimePhase<T>(
    plan: ResolvedCutoverRecoveryPlan,
    phase: RuntimeCutoverPhase,
    operation: (context: RuntimeCutoverContext) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const startedAt = this.#now();
    return await this.#bounded(
      controller,
      phase,
      operation({
        cutoverId: plan.cutoverId,
        phase,
        startedAt,
        deadlineAt: startedAt + this.#phaseTimeoutMs,
        signal: controller.signal,
      }),
    );
  }

  async #rendererPhase<T>(
    plan: ResolvedCutoverRecoveryPlan,
    phase: RendererCutoverPhase,
    operation: (context: RendererCutoverContext) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const startedAt = this.#now();
    return await this.#bounded(
      controller,
      phase,
      operation({
        cutoverId: plan.cutoverId,
        phase,
        startedAt,
        deadlineAt: startedAt + this.#phaseTimeoutMs,
        signal: controller.signal,
      }),
    );
  }

  async #bounded<T>(
    controller: AbortController,
    phase: string,
    operation: Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Cutover recovery phase ${phase} timed out after ${this.#phaseTimeoutMs} ms.`,
        );
        controller.abort(error);
        reject(error);
      }, this.#phaseTimeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      throw new Error(
        `Cutover recovery phase ${phase} failed: ${boundedReason(error)}`,
        { cause: error },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
