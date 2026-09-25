import { describe, expect, it } from "vitest";

import type { CutoverRecoveryExecutionReceipt } from "../src/cutover-recovery-executor.js";
import {
  LayeredUpdateControlService,
  isLayeredUpdateControlMethod,
} from "../src/layered-update-control.js";
import type { LayeredUpdateRecoveryBatchReceipt } from "../src/layered-update-controller.js";
import type { LayeredUpdateStatus } from "../src/layered-update-status.js";

function internalStatus(): LayeredUpdateStatus {
  return {
    schemaVersion: "scr.layered-update-status/v1",
    generatedAt: 1_000,
    health: "recovery-required",
    ledgerHeadSequence: 4,
    ledgerHeadSha256: "a".repeat(64),
    runtimeRoute: {
      schemaVersion: "scr.runtime-route-revision/v1",
      generation: 2,
      previousRecordSha256: "c".repeat(64),
      activatedAt: 900,
      cutoverId: "runtime-route-cutover-1",
      operation: "switch",
      active: {
        instanceId: "runtime-candidate",
        releaseId: "runtime-release-2",
        routeId: "private:route:candidate",
        checkpointId: "checkpoint-secret",
        fencingToken: "fence-secret",
      },
      previous: {
        instanceId: "runtime-active",
        releaseId: "runtime-release-1",
        routeId: "private:route:active",
        checkpointId: "checkpoint-old-secret",
        fencingToken: "fence-old-secret",
      },
      recordSha256: "d".repeat(64),
    },
    renderer: {
      generation: 1,
      activeReleaseId: "renderer-release-1",
      previousReleaseId: null,
      activeEntrypoint: "C:\\private\\renderer\\index.html",
      activeManifestSha256: "b".repeat(64),
    },
    recoveries: [
      {
        cutoverId: "runtime-cutover-1",
        kind: "runtime",
        action: "rollback-traffic-resume-active-stop-candidate",
        safeToAutomate: true,
        reason: "Candidate route is active.",
        authoritativeReleaseId: "runtime-release-2",
        rollbackReleaseId: "runtime-release-1",
        authorityGeneration: 2,
        evidence: ["route.generation=2"],
      },
    ],
    recentCutovers: [],
  };
}

function recoveryReceipt(cutoverId: string): CutoverRecoveryExecutionReceipt {
  return {
    recoveryId: `${cutoverId}:recovery`,
    cutoverId,
    kind: "runtime",
    action: "rollback-traffic-resume-active-stop-candidate",
    outcome: "rolled-back",
    startedAt: 1_000,
    completedAt: 1_001,
    authorityGeneration: 3,
    authoritativeReleaseId: "runtime-release-1",
    candidateReleaseId: "runtime-release-2",
  };
}

describe("LayeredUpdateControlService", () => {
  it("returns only a redacted status through the local control facade", async () => {
    const service = new LayeredUpdateControlService({
      controller: {
        status: async () => internalStatus(),
        recover: async (cutoverId) => recoveryReceipt(cutoverId),
        recoverAllSafe: async () => ({
          attempted: 0,
          completed: [],
          finalStatus: internalStatus(),
        }),
      },
    });

    const result = await service.handle("update.layered.status", {});
    expect(result).toMatchObject({
      schemaVersion: "scr.public-layered-update-status/v1",
      runtimeRoute: {
        active: {
          instanceId: "runtime-candidate",
          releaseId: "runtime-release-2",
        },
      },
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "routeId",
      "checkpointId",
      "fencingToken",
      "activeEntrypoint",
      "C:\\private",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("runs one evidence-based recovery by bounded cutover ID", async () => {
    const calls: string[] = [];
    const service = new LayeredUpdateControlService({
      controller: {
        status: async () => internalStatus(),
        recover: async (cutoverId) => {
          calls.push(cutoverId);
          return recoveryReceipt(cutoverId);
        },
        recoverAllSafe: async () => ({
          attempted: 0,
          completed: [],
          finalStatus: internalStatus(),
        }),
      },
    });

    await expect(
      service.handle("update.layered.recovery.run", {
        cutoverId: "runtime-cutover-1",
      }),
    ).resolves.toMatchObject({
      outcome: "rolled-back",
      cutoverId: "runtime-cutover-1",
    });
    expect(calls).toEqual(["runtime-cutover-1"]);
  });

  it("redacts the final status returned by recover-all-safe", async () => {
    const batch: LayeredUpdateRecoveryBatchReceipt = {
      attempted: 1,
      completed: [recoveryReceipt("runtime-cutover-1")],
      finalStatus: internalStatus(),
    };
    const service = new LayeredUpdateControlService({
      controller: {
        status: async () => internalStatus(),
        recover: async (cutoverId) => recoveryReceipt(cutoverId),
        recoverAllSafe: async () => batch,
      },
    });

    const result = await service.handle(
      "update.layered.recovery.run_all_safe",
      {},
    );
    expect(result).toMatchObject({
      attempted: 1,
      completed: [expect.objectContaining({ cutoverId: "runtime-cutover-1" })],
      finalStatus: {
        schemaVersion: "scr.public-layered-update-status/v1",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private:route");
  });

  it("rejects unknown or extra parameters before controller mutation", async () => {
    const calls: string[] = [];
    const service = new LayeredUpdateControlService({
      controller: {
        status: async () => {
          calls.push("status");
          return internalStatus();
        },
        recover: async (cutoverId) => {
          calls.push(cutoverId);
          return recoveryReceipt(cutoverId);
        },
        recoverAllSafe: async () => {
          calls.push("all");
          return {
            attempted: 0,
            completed: [],
            finalStatus: internalStatus(),
          };
        },
      },
    });

    await expect(
      service.handle("update.layered.status", { extra: true }),
    ).rejects.toThrow(/unsupported fields/u);
    await expect(
      service.handle("update.layered.recovery.run", {
        cutoverId: "bad/id",
      }),
    ).rejects.toThrow(/cutover ID is invalid/u);
    await expect(
      service.handle("update.layered.recovery.run", {
        cutoverId: "runtime-cutover-1",
        force: true,
      }),
    ).rejects.toThrow(/unsupported fields/u);
    expect(calls).toEqual([]);
  });

  it("recognizes only the three non-tool control methods", () => {
    expect(isLayeredUpdateControlMethod("update.layered.status")).toBe(true);
    expect(isLayeredUpdateControlMethod("update.layered.recovery.run")).toBe(
      true,
    );
    expect(
      isLayeredUpdateControlMethod("update.layered.recovery.run_all_safe"),
    ).toBe(true);
    expect(isLayeredUpdateControlMethod("tools/list_changed")).toBe(false);
    expect(isLayeredUpdateControlMethod("update.layered.install")).toBe(false);
  });
});
