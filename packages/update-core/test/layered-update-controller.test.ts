import { describe, expect, it } from "vitest";

import type { CutoverRecoveryExecutionReceipt } from "../src/cutover-recovery-executor.js";
import {
  LayeredUpdateBlockedError,
  LayeredUpdateController,
  LayeredUpdateControllerBusyError,
} from "../src/layered-update-controller.js";
import type {
  LayeredUpdateReceipt,
  LayeredUpdateRequest,
} from "../src/layered-orchestrator.js";
import type {
  LayeredUpdateHealth,
  LayeredUpdateStatus,
  LayeredUpdateRecoverySummary,
} from "../src/layered-update-status.js";
import type { ReleaseManifest } from "../src/manifest.js";

interface ComponentFixture {
  readonly path: string;
  readonly role: string;
  readonly sha256: string;
}

function manifest(
  releaseId: string,
  components: readonly ComponentFixture[],
): ReleaseManifest {
  return {
    releaseId,
    components: components.map((component, index) => ({
      ...component,
      bytes: index + 1,
    })),
  } as unknown as ReleaseManifest;
}

function recovery(
  cutoverId: string,
  safeToAutomate = true,
): LayeredUpdateRecoverySummary {
  return {
    cutoverId,
    kind: "renderer",
    action: safeToAutomate ? "rollback-renderer" : "manual-intervention",
    safeToAutomate,
    reason: safeToAutomate
      ? "Candidate renderer is active."
      : "Authority is ambiguous.",
    authoritativeReleaseId: "renderer-release-2",
    rollbackReleaseId: "renderer-release-1",
    authorityGeneration: 2,
    evidence: [],
  };
}

function status(
  health: LayeredUpdateHealth,
  recoveries: readonly LayeredUpdateRecoverySummary[] = [],
): LayeredUpdateStatus {
  return {
    schemaVersion: "scr.layered-update-status/v1",
    generatedAt: 1_000,
    health,
    ledgerHeadSequence: 0,
    ledgerHeadSha256: null,
    runtimeRoute: null,
    renderer: null,
    recoveries,
    recentCutovers: [],
  };
}

function updateReceipt(request: LayeredUpdateRequest): LayeredUpdateReceipt {
  return {
    updateId: request.updateId,
    mode: "renderer-reload",
    outcome: "committed",
    currentReleaseId: request.current.releaseId,
    candidateReleaseId: request.candidate.releaseId,
    startedAt: 1,
    completedAt: 2,
    failureReason: null,
    cleanupFailures: [],
    plan: {
      currentReleaseId: request.current.releaseId,
      candidateReleaseId: request.candidate.releaseId,
      changes: [],
      plan: {
        mode: "renderer-reload",
        changedRoles: ["renderer"],
        reasons: [],
        phases: [],
        requiresQuiescence: false,
        requiresApplicationRestart: false,
        preservesTaskState: true,
        rollbackRequired: true,
      },
    },
    detail: null,
  };
}

function recoveryReceipt(cutoverId: string): CutoverRecoveryExecutionReceipt {
  return {
    recoveryId: `${cutoverId}:recovery`,
    cutoverId,
    kind: "renderer",
    action: "rollback-renderer",
    outcome: "rolled-back",
    startedAt: 1,
    completedAt: 2,
    authorityGeneration: 3,
    authoritativeReleaseId: "renderer-release-1",
    candidateReleaseId: "renderer-release-2",
  };
}

const currentManifest = manifest("release-1", [
  { path: "renderer/index.html", role: "renderer", sha256: "1".repeat(64) },
]);
const candidateManifest = manifest("release-2", [
  { path: "renderer/index.html", role: "renderer", sha256: "2".repeat(64) },
]);

describe("LayeredUpdateController", () => {
  it("plans signed releases without requiring mutable update state", () => {
    const controller = new LayeredUpdateController({
      orchestrator: {
        busy: false,
        execute: async (request) => updateReceipt(request),
      },
      status: { snapshot: async () => status("uninitialized") },
      recovery: {
        busy: false,
        recover: async (cutoverId) => recoveryReceipt(cutoverId),
      },
    });

    expect(
      controller.plan({
        current: currentManifest,
        candidate: candidateManifest,
      }).plan.mode,
    ).toBe("renderer-reload");
  });

  it("blocks update mutation until authority is ready but permits a dry run", async () => {
    const calls: string[] = [];
    const controller = new LayeredUpdateController({
      orchestrator: {
        busy: false,
        execute: async (request) => {
          calls.push(request.updateId);
          return updateReceipt(request);
        },
      },
      status: {
        snapshot: async () => status("recovery-required", [recovery("open")]),
      },
      recovery: {
        busy: false,
        recover: async (cutoverId) => recoveryReceipt(cutoverId),
      },
    });

    await expect(
      controller.execute({
        updateId: "blocked-update",
        current: currentManifest,
        candidate: candidateManifest,
      }),
    ).rejects.toBeInstanceOf(LayeredUpdateBlockedError);
    await expect(
      controller.execute({
        updateId: "dry-run-update",
        current: currentManifest,
        candidate: candidateManifest,
        dryRun: true,
      }),
    ).resolves.toMatchObject({ updateId: "dry-run-update" });
    expect(calls).toEqual(["dry-run-update"]);
  });

  it("runs an update only after a ready status snapshot", async () => {
    const calls: string[] = [];
    const controller = new LayeredUpdateController({
      orchestrator: {
        busy: false,
        execute: async (request) => {
          calls.push(request.updateId);
          return updateReceipt(request);
        },
      },
      status: { snapshot: async () => status("ready") },
      recovery: {
        busy: false,
        recover: async (cutoverId) => recoveryReceipt(cutoverId),
      },
    });

    await expect(
      controller.execute({
        updateId: "ready-update",
        current: currentManifest,
        candidate: candidateManifest,
      }),
    ).resolves.toMatchObject({ outcome: "committed" });
    expect(calls).toEqual(["ready-update"]);
  });

  it("executes only a safe recovery and verifies that it closed", async () => {
    let open = true;
    const recoverCalls: string[] = [];
    const controller = new LayeredUpdateController({
      orchestrator: {
        busy: false,
        execute: async (request) => updateReceipt(request),
      },
      status: {
        snapshot: async () =>
          open
            ? status("recovery-required", [recovery("renderer-open")])
            : status("ready"),
      },
      recovery: {
        busy: false,
        recover: async (cutoverId) => {
          recoverCalls.push(cutoverId);
          open = false;
          return recoveryReceipt(cutoverId);
        },
      },
    });

    await expect(controller.recover("renderer-open")).resolves.toMatchObject({
      cutoverId: "renderer-open",
      outcome: "rolled-back",
    });
    expect(recoverCalls).toEqual(["renderer-open"]);
  });

  it("blocks manual recovery and detects a recovery that remains open", async () => {
    const manual = new LayeredUpdateController({
      orchestrator: {
        busy: false,
        execute: async (request) => updateReceipt(request),
      },
      status: {
        snapshot: async () =>
          status("manual-intervention", [recovery("manual-cutover", false)]),
      },
      recovery: {
        busy: false,
        recover: async (cutoverId) => recoveryReceipt(cutoverId),
      },
    });
    await expect(manual.recover("manual-cutover")).rejects.toBeInstanceOf(
      LayeredUpdateBlockedError,
    );

    const stillOpen = new LayeredUpdateController({
      orchestrator: {
        busy: false,
        execute: async (request) => updateReceipt(request),
      },
      status: {
        snapshot: async () =>
          status("recovery-required", [recovery("still-open")]),
      },
      recovery: {
        busy: false,
        recover: async (cutoverId) => recoveryReceipt(cutoverId),
      },
    });
    await expect(stillOpen.recover("still-open")).rejects.toThrow(
      /did not close/u,
    );
  });

  it("recovers all safe cutovers sequentially and leaves manual work visible", async () => {
    const open = new Map([
      ["safe-one", true],
      ["safe-two", true],
    ]);
    const order: string[] = [];
    const snapshot = async (): Promise<LayeredUpdateStatus> => {
      const recoveries = [
        ...(open.get("safe-one") === true ? [recovery("safe-one")] : []),
        ...(open.get("safe-two") === true ? [recovery("safe-two")] : []),
        recovery("manual-one", false),
      ];
      return status("manual-intervention", recoveries);
    };
    const controller = new LayeredUpdateController({
      orchestrator: {
        busy: false,
        execute: async (request) => updateReceipt(request),
      },
      status: { snapshot },
      recovery: {
        busy: false,
        recover: async (cutoverId) => {
          order.push(cutoverId);
          open.set(cutoverId, false);
          return recoveryReceipt(cutoverId);
        },
      },
    });

    const batch = await controller.recoverAllSafe();
    expect(batch.attempted).toBe(2);
    expect(batch.completed.map((receipt) => receipt.cutoverId)).toEqual([
      "safe-one",
      "safe-two",
    ]);
    expect(batch.finalStatus.recoveries).toEqual([
      expect.objectContaining({
        cutoverId: "manual-one",
        safeToAutomate: false,
      }),
    ]);
    expect(order).toEqual(["safe-one", "safe-two"]);
  });

  it("rejects operations while another subsystem is busy", async () => {
    const controller = new LayeredUpdateController({
      orchestrator: {
        busy: true,
        execute: async (request) => updateReceipt(request),
      },
      status: { snapshot: async () => status("ready") },
      recovery: {
        busy: false,
        recover: async (cutoverId) => recoveryReceipt(cutoverId),
      },
    });
    await expect(
      controller.execute({
        updateId: "busy-update",
        current: currentManifest,
        candidate: candidateManifest,
      }),
    ).rejects.toBeInstanceOf(LayeredUpdateControllerBusyError);
  });

  it("rejects invalid automatic-recovery limits", () => {
    expect(
      () =>
        new LayeredUpdateController({
          orchestrator: {
            busy: false,
            execute: async (request) => updateReceipt(request),
          },
          status: { snapshot: async () => status("ready") },
          recovery: {
            busy: false,
            recover: async (cutoverId) => recoveryReceipt(cutoverId),
          },
          maxAutomaticRecoveries: 0,
        }),
    ).toThrow(/automatic-recovery limit/u);
  });
});
