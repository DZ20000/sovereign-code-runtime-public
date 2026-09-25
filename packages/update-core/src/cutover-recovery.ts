import {
  CutoverLedger,
  type CutoverRecoveryAction,
  type CutoverRecoveryPlan,
} from "./cutover-ledger.js";
import { RendererSlotStore } from "./renderer-slot.js";
import { RuntimeRouteRegistry } from "./runtime-route.js";

export interface ResolvedCutoverRecoveryPlan extends CutoverRecoveryPlan {
  readonly resolvedAction: CutoverRecoveryAction;
  readonly safeToAutomate: boolean;
  readonly authoritativeReleaseId: string | null;
  readonly rollbackReleaseId: string | null;
  readonly authorityGeneration: number | null;
  readonly evidence: readonly string[];
}

export interface CutoverRecoveryInspectorOptions {
  readonly ledger: CutoverLedger;
  readonly routes: RuntimeRouteRegistry;
  readonly rendererSlots: RendererSlotStore;
}

function runtimeEvidence(input: {
  readonly generation: number;
  readonly operation: string;
  readonly activeReleaseId: string;
  readonly previousReleaseId: string | null;
  readonly activeInstanceId: string;
  readonly previousInstanceId: string | null;
}): readonly string[] {
  return [
    `route.generation=${input.generation}`,
    `route.operation=${input.operation}`,
    `route.activeRelease=${input.activeReleaseId}`,
    `route.previousRelease=${input.previousReleaseId ?? "none"}`,
    `route.activeInstance=${input.activeInstanceId}`,
    `route.previousInstance=${input.previousInstanceId ?? "none"}`,
  ];
}

function rendererEvidence(input: {
  readonly generation: number;
  readonly activeReleaseId: string;
  readonly previousReleaseId: string | null;
}): readonly string[] {
  return [
    `renderer.generation=${input.generation}`,
    `renderer.activeRelease=${input.activeReleaseId}`,
    `renderer.previousRelease=${input.previousReleaseId ?? "none"}`,
  ];
}

export class CutoverRecoveryInspector {
  readonly #ledger: CutoverLedger;
  readonly #routes: RuntimeRouteRegistry;
  readonly #rendererSlots: RendererSlotStore;

  constructor(options: CutoverRecoveryInspectorOptions) {
    this.#ledger = options.ledger;
    this.#routes = options.routes;
    this.#rendererSlots = options.rendererSlots;
  }

  async inspect(): Promise<readonly ResolvedCutoverRecoveryPlan[]> {
    const plans = await this.#ledger.recoveryPlans();
    const [route, rendererPointer] = await Promise.all([
      this.#routes.readCurrent(),
      this.#rendererSlots.readPointer(),
    ]);
    return plans.map((plan) => {
      if (plan.kind === "runtime") {
        if (route === null) {
          return {
            ...plan,
            resolvedAction: "manual-intervention",
            safeToAutomate: false,
            authoritativeReleaseId: null,
            rollbackReleaseId: null,
            authorityGeneration: null,
            evidence: ["Runtime route registry is not bootstrapped."],
          };
        }
        const activeReleaseId = route.active.releaseId;
        const previousReleaseId = route.previous?.releaseId ?? null;
        const evidence = runtimeEvidence({
          generation: route.generation,
          operation: route.operation,
          activeReleaseId,
          previousReleaseId,
          activeInstanceId: route.active.instanceId,
          previousInstanceId: route.previous?.instanceId ?? null,
        });
        const resolution = resolveRuntimeAction(plan, {
          activeReleaseId,
          previousReleaseId,
          operation: route.operation,
        });
        return {
          ...plan,
          ...resolution,
          authoritativeReleaseId: activeReleaseId,
          rollbackReleaseId: previousReleaseId,
          authorityGeneration: route.generation,
          evidence,
        };
      }

      if (rendererPointer === null) {
        return {
          ...plan,
          resolvedAction: "manual-intervention",
          safeToAutomate: false,
          authoritativeReleaseId: null,
          rollbackReleaseId: null,
          authorityGeneration: null,
          evidence: ["Renderer slot pointer is not initialized."],
        };
      }
      const evidence = rendererEvidence({
        generation: rendererPointer.generation,
        activeReleaseId: rendererPointer.activeReleaseId,
        previousReleaseId: rendererPointer.previousReleaseId,
      });
      const resolution = resolveRendererAction(plan, {
        activeReleaseId: rendererPointer.activeReleaseId,
        previousReleaseId: rendererPointer.previousReleaseId,
      });
      return {
        ...plan,
        ...resolution,
        authoritativeReleaseId: rendererPointer.activeReleaseId,
        rollbackReleaseId: rendererPointer.previousReleaseId,
        authorityGeneration: rendererPointer.generation,
        evidence,
      };
    });
  }
}

function resolveRuntimeAction(
  plan: CutoverRecoveryPlan,
  route: {
    readonly activeReleaseId: string;
    readonly previousReleaseId: string | null;
    readonly operation: string;
  },
): Pick<ResolvedCutoverRecoveryPlan, "resolvedAction" | "safeToAutomate"> {
  const activeIsPrevious = route.activeReleaseId === plan.activeReleaseId;
  const activeIsCandidate = route.activeReleaseId === plan.candidateReleaseId;
  const previousIsPrevious = route.previousReleaseId === plan.activeReleaseId;
  const previousIsCandidate =
    route.previousReleaseId === plan.candidateReleaseId;

  switch (plan.action) {
    case "stop-candidate":
      if (activeIsPrevious) {
        return { resolvedAction: "stop-candidate", safeToAutomate: true };
      }
      break;
    case "resume-active-and-stop-candidate":
      if (activeIsPrevious) {
        return {
          resolvedAction: "resume-active-and-stop-candidate",
          safeToAutomate: true,
        };
      }
      break;
    case "rollback-traffic-resume-active-stop-candidate":
      if (activeIsCandidate && previousIsPrevious) {
        return {
          resolvedAction: "rollback-traffic-resume-active-stop-candidate",
          safeToAutomate: true,
        };
      }
      if (activeIsPrevious && previousIsCandidate) {
        return {
          resolvedAction: "resume-active-and-stop-candidate",
          safeToAutomate: true,
        };
      }
      break;
    case "finish-commit-cleanup":
      if (activeIsCandidate && route.operation === "commit") {
        return {
          resolvedAction: "finish-commit-cleanup",
          safeToAutomate: true,
        };
      }
      if (activeIsCandidate && previousIsPrevious) {
        return {
          resolvedAction: "finish-commit-cleanup",
          safeToAutomate: false,
        };
      }
      break;
    case "verify-terminal-state":
      if (activeIsPrevious || activeIsCandidate) {
        return {
          resolvedAction: "verify-terminal-state",
          safeToAutomate: false,
        };
      }
      break;
    default:
      break;
  }
  return { resolvedAction: "manual-intervention", safeToAutomate: false };
}

function resolveRendererAction(
  plan: CutoverRecoveryPlan,
  pointer: {
    readonly activeReleaseId: string;
    readonly previousReleaseId: string | null;
  },
): Pick<ResolvedCutoverRecoveryPlan, "resolvedAction" | "safeToAutomate"> {
  const activeIsPrevious = pointer.activeReleaseId === plan.activeReleaseId;
  const activeIsCandidate = pointer.activeReleaseId === plan.candidateReleaseId;
  const previousIsPrevious = pointer.previousReleaseId === plan.activeReleaseId;
  const previousIsCandidate =
    pointer.previousReleaseId === plan.candidateReleaseId;

  switch (plan.action) {
    case "none":
      if (activeIsPrevious) {
        return { resolvedAction: "none", safeToAutomate: true };
      }
      break;
    case "rollback-renderer":
      if (activeIsCandidate && previousIsPrevious) {
        return { resolvedAction: "rollback-renderer", safeToAutomate: true };
      }
      if (activeIsPrevious && previousIsCandidate) {
        return {
          resolvedAction: "finish-renderer-rollback",
          safeToAutomate: true,
        };
      }
      break;
    case "finish-renderer-rollback":
      if (activeIsPrevious) {
        return {
          resolvedAction: "finish-renderer-rollback",
          safeToAutomate: true,
        };
      }
      if (activeIsCandidate && previousIsPrevious) {
        return { resolvedAction: "rollback-renderer", safeToAutomate: true };
      }
      break;
    case "verify-terminal-state":
      if (activeIsPrevious || activeIsCandidate) {
        return {
          resolvedAction: "verify-terminal-state",
          safeToAutomate: false,
        };
      }
      break;
    default:
      break;
  }
  return { resolvedAction: "manual-intervention", safeToAutomate: false };
}
