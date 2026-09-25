import type { CutoverRecoveryExecutionReceipt } from "./cutover-recovery-executor.js";
import type {
  LayeredUpdateOrchestrator,
  LayeredUpdateReceipt,
  LayeredUpdateRequest,
} from "./layered-orchestrator.js";
import type {
  LayeredUpdateRecoverySummary,
  LayeredUpdateStatus,
  LayeredUpdateStatusService,
} from "./layered-update-status.js";
import type { ReleaseManifest } from "./manifest.js";
import {
  planVerifiedReleaseUpdate,
  type VerifiedReleaseUpdatePlan,
} from "./release-diff.js";
import type { ComponentUpdatePolicy } from "./update-plan.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;

export interface LayeredUpdateRecoveryPort {
  readonly busy: boolean;
  recover(cutoverId: string): Promise<CutoverRecoveryExecutionReceipt>;
}

export interface LayeredUpdateOrchestratorPort {
  readonly busy: boolean;
  execute(request: LayeredUpdateRequest): Promise<LayeredUpdateReceipt>;
}

export interface LayeredUpdateStatusPort {
  snapshot(): Promise<LayeredUpdateStatus>;
}

export interface LayeredUpdateControllerOptions {
  readonly orchestrator:
    LayeredUpdateOrchestratorPort | LayeredUpdateOrchestrator;
  readonly status: LayeredUpdateStatusPort | LayeredUpdateStatusService;
  readonly recovery: LayeredUpdateRecoveryPort;
  readonly maxAutomaticRecoveries?: number;
}

export interface LayeredUpdatePlanRequest {
  readonly current: ReleaseManifest;
  readonly candidate: ReleaseManifest;
  readonly policy?: ComponentUpdatePolicy;
}

export interface LayeredUpdateRecoveryBatchReceipt {
  readonly attempted: number;
  readonly completed: readonly CutoverRecoveryExecutionReceipt[];
  readonly finalStatus: LayeredUpdateStatus;
}

function assertCutoverId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error("Layered update recovery cutover ID is invalid.");
  }
}

function findRecovery(
  status: LayeredUpdateStatus,
  cutoverId: string,
): LayeredUpdateRecoverySummary | null {
  return (
    status.recoveries.find((recovery) => recovery.cutoverId === cutoverId) ??
    null
  );
}

export class LayeredUpdateControllerBusyError extends Error {
  constructor() {
    super("Another layered update or recovery operation is active.");
    this.name = "LayeredUpdateControllerBusyError";
  }
}

export class LayeredUpdateBlockedError extends Error {
  readonly status: LayeredUpdateStatus;

  constructor(message: string, status: LayeredUpdateStatus) {
    super(message);
    this.name = "LayeredUpdateBlockedError";
    this.status = status;
  }
}

export class LayeredUpdateController {
  readonly #orchestrator: LayeredUpdateOrchestratorPort;
  readonly #status: LayeredUpdateStatusPort;
  readonly #recovery: LayeredUpdateRecoveryPort;
  readonly #maxAutomaticRecoveries: number;
  #busy = false;

  constructor(options: LayeredUpdateControllerOptions) {
    this.#orchestrator = options.orchestrator;
    this.#status = options.status;
    this.#recovery = options.recovery;
    const maximum = options.maxAutomaticRecoveries ?? 32;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) {
      throw new Error("Layered update automatic-recovery limit is invalid.");
    }
    this.#maxAutomaticRecoveries = maximum;
  }

  get busy(): boolean {
    return this.#busy || this.#orchestrator.busy || this.#recovery.busy;
  }

  plan(request: LayeredUpdatePlanRequest): VerifiedReleaseUpdatePlan {
    return planVerifiedReleaseUpdate(
      request.current,
      request.candidate,
      request.policy,
    );
  }

  status(): Promise<LayeredUpdateStatus> {
    return this.#status.snapshot();
  }

  async execute(request: LayeredUpdateRequest): Promise<LayeredUpdateReceipt> {
    return await this.#exclusive(async () => {
      if (request.dryRun !== true) {
        const status = await this.#status.snapshot();
        if (status.health !== "ready") {
          throw new LayeredUpdateBlockedError(
            `Layered update mutation is blocked while authority health is ${status.health}.`,
            status,
          );
        }
      }
      return await this.#orchestrator.execute(request);
    });
  }

  async recover(cutoverId: string): Promise<CutoverRecoveryExecutionReceipt> {
    assertCutoverId(cutoverId);
    return await this.#exclusive(async () => {
      const before = await this.#status.snapshot();
      const recovery = findRecovery(before, cutoverId);
      if (recovery === null) {
        throw new LayeredUpdateBlockedError(
          `Cutover ${cutoverId} has no open recovery plan.`,
          before,
        );
      }
      if (!recovery.safeToAutomate) {
        throw new LayeredUpdateBlockedError(
          `Cutover ${cutoverId} requires manual intervention.`,
          before,
        );
      }
      const receipt = await this.#recovery.recover(cutoverId);
      const after = await this.#status.snapshot();
      if (findRecovery(after, cutoverId) !== null) {
        throw new Error(`Cutover recovery ${cutoverId} did not close.`);
      }
      return receipt;
    });
  }

  async recoverAllSafe(): Promise<LayeredUpdateRecoveryBatchReceipt> {
    return await this.#exclusive(async () => {
      const initial = await this.#status.snapshot();
      const safe = initial.recoveries.filter(
        (recovery) => recovery.safeToAutomate,
      );
      if (safe.length > this.#maxAutomaticRecoveries) {
        throw new LayeredUpdateBlockedError(
          `Safe recovery count ${safe.length} exceeds the automatic-recovery limit.`,
          initial,
        );
      }
      const completed: CutoverRecoveryExecutionReceipt[] = [];
      for (const recovery of safe) {
        completed.push(await this.#recovery.recover(recovery.cutoverId));
      }
      const finalStatus = await this.#status.snapshot();
      for (const recovery of safe) {
        if (findRecovery(finalStatus, recovery.cutoverId) !== null) {
          throw new Error(
            `Cutover recovery ${recovery.cutoverId} did not close.`,
          );
        }
      }
      return {
        attempted: safe.length,
        completed,
        finalStatus,
      };
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new LayeredUpdateControllerBusyError();
    this.#busy = true;
    try {
      return await operation();
    } finally {
      this.#busy = false;
    }
  }
}
