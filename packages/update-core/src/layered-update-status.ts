import {
  CutoverLedger,
  type CutoverKind,
  type CutoverRecoveryAction,
  type CutoverLedgerEntry,
} from "./cutover-ledger.js";
import {
  CutoverRecoveryInspector,
  type ResolvedCutoverRecoveryPlan,
} from "./cutover-recovery.js";
import {
  RendererSlotStore,
  type RendererSlotPointer,
} from "./renderer-slot.js";
import {
  RuntimeRouteRegistry,
  type RuntimeRouteRevision,
} from "./runtime-route.js";

export const LAYERED_UPDATE_STATUS_SCHEMA_VERSION =
  "scr.layered-update-status/v1" as const;

export type LayeredUpdateHealth =
  "uninitialized" | "ready" | "recovery-required" | "manual-intervention";

export interface LayeredUpdateRendererStatus {
  readonly generation: number;
  readonly activeReleaseId: string;
  readonly previousReleaseId: string | null;
  readonly activeEntrypoint: string;
  readonly activeManifestSha256: string;
}

export interface LayeredUpdateRecoverySummary {
  readonly cutoverId: string;
  readonly kind: CutoverKind;
  readonly action: CutoverRecoveryAction;
  readonly safeToAutomate: boolean;
  readonly reason: string;
  readonly authoritativeReleaseId: string | null;
  readonly rollbackReleaseId: string | null;
  readonly authorityGeneration: number | null;
  readonly evidence: readonly string[];
}

export interface LayeredUpdateRecentCutover {
  readonly cutoverId: string;
  readonly kind: CutoverKind;
  readonly outcome: "committed" | "rolled-back" | "failed";
  readonly activeReleaseId: string;
  readonly candidateReleaseId: string;
  readonly failureReason: string | null;
  readonly cleanupFailures: readonly string[];
  readonly completedSequence: number;
  readonly completedAt: number;
}

export interface LayeredUpdateStatus {
  readonly schemaVersion: typeof LAYERED_UPDATE_STATUS_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly health: LayeredUpdateHealth;
  readonly ledgerHeadSequence: number;
  readonly ledgerHeadSha256: string | null;
  readonly runtimeRoute: RuntimeRouteRevision | null;
  readonly renderer: LayeredUpdateRendererStatus | null;
  readonly recoveries: readonly LayeredUpdateRecoverySummary[];
  readonly recentCutovers: readonly LayeredUpdateRecentCutover[];
}

export interface LayeredUpdateStatusServiceOptions {
  readonly ledger: CutoverLedger;
  readonly routes: RuntimeRouteRegistry;
  readonly rendererSlots: RendererSlotStore;
  readonly recentCutoverLimit?: number;
  readonly now?: () => number;
}

function recoverySummary(
  plan: ResolvedCutoverRecoveryPlan,
): LayeredUpdateRecoverySummary {
  return {
    cutoverId: plan.cutoverId,
    kind: plan.kind,
    action: plan.resolvedAction,
    safeToAutomate: plan.safeToAutomate,
    reason: plan.reason,
    authoritativeReleaseId: plan.authoritativeReleaseId,
    rollbackReleaseId: plan.rollbackReleaseId,
    authorityGeneration: plan.authorityGeneration,
    evidence: [...plan.evidence],
  };
}

function recentCutover(entry: CutoverLedgerEntry): LayeredUpdateRecentCutover {
  if (
    entry.payload.recordType !== "receipt" ||
    entry.payload.outcome === null
  ) {
    throw new Error("Recent cutover projection requires a receipt entry.");
  }
  return {
    cutoverId: entry.payload.cutoverId,
    kind: entry.payload.kind,
    outcome: entry.payload.outcome,
    activeReleaseId: entry.payload.activeReleaseId,
    candidateReleaseId: entry.payload.candidateReleaseId,
    failureReason: entry.payload.failureReason,
    cleanupFailures: [...entry.payload.cleanupFailures],
    completedSequence: entry.sequence,
    completedAt: entry.recordedAt,
  };
}

function healthFor(input: {
  readonly route: RuntimeRouteRevision | null;
  readonly renderer: RendererSlotPointer | null;
  readonly recoveries: readonly LayeredUpdateRecoverySummary[];
}): LayeredUpdateHealth {
  if (input.recoveries.some((recovery) => !recovery.safeToAutomate)) {
    return "manual-intervention";
  }
  if (input.recoveries.length > 0) return "recovery-required";
  if (input.route === null && input.renderer === null) return "uninitialized";
  if (input.route === null || input.renderer === null)
    return "manual-intervention";
  return "ready";
}

export class LayeredUpdateStatusService {
  readonly #ledger: CutoverLedger;
  readonly #routes: RuntimeRouteRegistry;
  readonly #rendererSlots: RendererSlotStore;
  readonly #inspector: CutoverRecoveryInspector;
  readonly #recentCutoverLimit: number;
  readonly #now: () => number;

  constructor(options: LayeredUpdateStatusServiceOptions) {
    if (!(options.ledger instanceof CutoverLedger)) {
      throw new Error("Cutover ledger is required.");
    }
    if (!(options.routes instanceof RuntimeRouteRegistry)) {
      throw new Error("Runtime route registry is required.");
    }
    if (!(options.rendererSlots instanceof RendererSlotStore)) {
      throw new Error("Renderer slot store is required.");
    }
    const limit = options.recentCutoverLimit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Layered update recent-cutover limit is invalid.");
    }
    this.#ledger = options.ledger;
    this.#routes = options.routes;
    this.#rendererSlots = options.rendererSlots;
    this.#inspector = new CutoverRecoveryInspector({
      ledger: options.ledger,
      routes: options.routes,
      rendererSlots: options.rendererSlots,
    });
    this.#recentCutoverLimit = limit;
    this.#now = options.now ?? Date.now;
  }

  async snapshot(): Promise<LayeredUpdateStatus> {
    const [entries, route, pointer, resolvedRecoveries] = await Promise.all([
      this.#ledger.readAll(),
      this.#routes.readCurrent(),
      this.#rendererSlots.readPointer(),
      this.#inspector.inspect(),
    ]);
    let renderer: LayeredUpdateRendererStatus | null = null;
    if (pointer !== null) {
      const verified = await this.#rendererSlots.verifySlot(
        pointer.activeReleaseId,
      );
      if (verified.manifestSha256 !== pointer.manifestSha256) {
        throw new Error(
          "Renderer active slot digest does not match its pointer.",
        );
      }
      renderer = {
        generation: pointer.generation,
        activeReleaseId: pointer.activeReleaseId,
        previousReleaseId: pointer.previousReleaseId,
        activeEntrypoint: verified.entrypoint,
        activeManifestSha256: verified.manifestSha256,
      };
    }
    const recoveries = resolvedRecoveries.map(recoverySummary);
    const recentCutovers = entries
      .filter((entry) => entry.payload.recordType === "receipt")
      .slice(-this.#recentCutoverLimit)
      .reverse()
      .map(recentCutover);
    const head = entries.at(-1);
    return {
      schemaVersion: LAYERED_UPDATE_STATUS_SCHEMA_VERSION,
      generatedAt: this.#now(),
      health: healthFor({ route, renderer: pointer, recoveries }),
      ledgerHeadSequence: head?.sequence ?? 0,
      ledgerHeadSha256: head?.entrySha256 ?? null,
      runtimeRoute: route,
      renderer,
      recoveries,
      recentCutovers,
    };
  }
}
