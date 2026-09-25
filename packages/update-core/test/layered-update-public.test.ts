import { describe, expect, it } from "vitest";

import { publicLayeredUpdateStatus } from "../src/layered-update-public.js";
import type { LayeredUpdateStatus } from "../src/layered-update-status.js";

function internalStatus(): LayeredUpdateStatus {
  return {
    schemaVersion: "scr.layered-update-status/v1",
    generatedAt: 1_000,
    health: "recovery-required",
    ledgerHeadSequence: 7,
    ledgerHeadSha256: "a".repeat(64),
    runtimeRoute: {
      schemaVersion: "scr.runtime-route-revision/v1",
      generation: 3,
      previousRecordSha256: "c".repeat(64),
      activatedAt: 900,
      cutoverId: "runtime-route-cutover-1",
      operation: "switch",
      active: {
        instanceId: "runtime-candidate",
        releaseId: "runtime-release-2",
        routeId: "private:pipe/runtime-candidate",
        checkpointId: "checkpoint-secret",
        fencingToken: "fence-secret",
      },
      previous: {
        instanceId: "runtime-active",
        releaseId: "runtime-release-1",
        routeId: "private:pipe/runtime-active",
        checkpointId: "checkpoint-old-secret",
        fencingToken: "fence-old-secret",
      },
      recordSha256: "d".repeat(64),
    },
    renderer: {
      generation: 2,
      activeReleaseId: "renderer-release-2",
      previousReleaseId: "renderer-release-1",
      activeEntrypoint:
        "C:\\Users\\operator\\AppData\\Local\\Sovereign\\renderer-slots\\renderer-release-2\\index.html",
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
    recentCutovers: [
      {
        cutoverId: "renderer-cutover-1",
        kind: "renderer",
        outcome: "rolled-back",
        activeReleaseId: "renderer-release-1",
        candidateReleaseId: "renderer-release-2",
        failureReason: "candidate failed",
        cleanupFailures: ["cleanup warning"],
        completedSequence: 6,
        completedAt: 900,
      },
    ],
  };
}

describe("publicLayeredUpdateStatus", () => {
  it("removes private route, checkpoint, fencing, and filesystem details", () => {
    const publicStatus = publicLayeredUpdateStatus(internalStatus());
    expect(publicStatus).toMatchObject({
      schemaVersion: "scr.public-layered-update-status/v1",
      health: "recovery-required",
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
    });
    const serialized = JSON.stringify(publicStatus);
    for (const secret of [
      "private:pipe",
      "checkpoint-secret",
      "fence-secret",
      "AppData",
      "index.html",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("returns detached arrays so callers cannot mutate the internal snapshot", () => {
    const internal = internalStatus();
    const publicStatus = publicLayeredUpdateStatus(internal);
    (publicStatus.recoveries[0]!.evidence as string[]).push("ui-only");
    (publicStatus.recentCutovers[0]!.cleanupFailures as string[]).push(
      "ui-only",
    );

    expect(internal.recoveries[0]?.evidence).toEqual(["route.generation=3"]);
    expect(internal.recentCutovers[0]?.cleanupFailures).toEqual([
      "cleanup warning",
    ]);
  });

  it("preserves null authority while changing only the public schema", () => {
    const internal = internalStatus();
    const publicStatus = publicLayeredUpdateStatus({
      ...internal,
      health: "uninitialized",
      runtimeRoute: null,
      renderer: null,
      recoveries: [],
      recentCutovers: [],
    });
    expect(publicStatus).toMatchObject({
      schemaVersion: "scr.public-layered-update-status/v1",
      health: "uninitialized",
      runtimeRoute: null,
      renderer: null,
    });
  });
});
