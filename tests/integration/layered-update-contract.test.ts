import { describe, expect, it } from "vitest";

import {
  DESKTOP_LAYERED_UPDATE_STATUS_SCHEMA_VERSION,
  type DesktopLayeredUpdateStatus,
  type SovereignLayeredUpdateApi,
} from "../../packages/control-plane-contract/src/index.js";

function status(): DesktopLayeredUpdateStatus {
  return {
    schemaVersion: DESKTOP_LAYERED_UPDATE_STATUS_SCHEMA_VERSION,
    generatedAt: 1_000,
    health: "recovery-required",
    ledgerHeadSequence: 7,
    ledgerHeadSha256: "a".repeat(64),
    runtimeRoute: {
      generation: 3,
      operation: "switch",
      active: {
        instanceId: "runtime-candidate",
        releaseId: "runtime-release-2",
      },
      previous: {
        instanceId: "runtime-active",
        releaseId: "runtime-release-1",
      },
    },
    renderer: {
      generation: 2,
      activeReleaseId: "renderer-release-2",
      previousReleaseId: "renderer-release-1",
      activeManifestSha256: "b".repeat(64),
    },
    recoveries: [
      {
        cutoverId: "runtime-cutover-1",
        kind: "runtime",
        action: "rollback-traffic-resume-active-stop-candidate",
        safeToAutomate: true,
        reason: "Candidate route is authoritative.",
        authoritativeReleaseId: "runtime-release-2",
        rollbackReleaseId: "runtime-release-1",
        authorityGeneration: 3,
        evidence: ["route.generation=3"],
      },
    ],
    recentCutovers: [],
  };
}

describe("layered update desktop contract", () => {
  it("exposes the redacted status schema without private authority fields", () => {
    const value = status();
    expect(value.schemaVersion).toBe("scr.public-layered-update-status/v1");
    const serialized = JSON.stringify(value);
    for (const privateField of [
      "routeId",
      "checkpointId",
      "fencingToken",
      "activeEntrypoint",
    ]) {
      expect(serialized).not.toContain(privateField);
    }
  });

  it("defines a narrow desktop API for status and evidence-based recovery", async () => {
    const calls: string[] = [];
    const api: SovereignLayeredUpdateApi = {
      getLayeredUpdateStatus: async () => status(),
      recoverLayeredUpdate: async (cutoverId) => {
        calls.push(cutoverId);
        return {
          recoveryId: `${cutoverId}:recovery`,
          cutoverId,
          kind: "runtime",
          action: "rollback-traffic-resume-active-stop-candidate",
          outcome: "rolled-back",
          startedAt: 1_000,
          completedAt: 1_001,
          authorityGeneration: 4,
          authoritativeReleaseId: "runtime-release-1",
          candidateReleaseId: "runtime-release-2",
        };
      },
      recoverAllSafeLayeredUpdates: async () => ({
        attempted: 0,
        completed: [],
        finalStatus: status(),
      }),
    };

    await expect(api.getLayeredUpdateStatus()).resolves.toMatchObject({
      health: "recovery-required",
    });
    await expect(
      api.recoverLayeredUpdate("runtime-cutover-1"),
    ).resolves.toMatchObject({
      outcome: "rolled-back",
    });
    expect(calls).toEqual(["runtime-cutover-1"]);
  });
});
