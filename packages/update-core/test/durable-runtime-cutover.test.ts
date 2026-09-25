import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CutoverLedger } from "../src/cutover-ledger.js";
import {
  DurableRuntimeCutoverCoordinator,
  type DurableRuntimeCutoverAdapter,
} from "../src/durable-runtime-cutover.js";
import type {
  RuntimeCheckpoint,
  RuntimeCutoverContext,
  RuntimeDrainReport,
  RuntimeHostHandle,
  RuntimeReleaseCandidate,
} from "../src/runtime-cutover.js";
import {
  RuntimeRouteRegistry,
  type RuntimeRouteRevision,
  type RuntimeRouteTarget,
} from "../src/runtime-route.js";

const roots: string[] = [];

const active: RuntimeHostHandle = {
  instanceId: "runtime-active-1",
  releaseId: "runtime-release-1",
};
const candidateRelease: RuntimeReleaseCandidate = {
  releaseId: "runtime-release-2",
  directory: "candidate/runtime-release-2",
  manifestSha256: "a".repeat(64),
};
const activeRoute: RuntimeRouteTarget = {
  instanceId: active.instanceId,
  releaseId: active.releaseId,
  routeId: "route:active-1",
  checkpointId: "checkpoint-bootstrap",
  fencingToken: "fence-bootstrap",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-durable-runtime-cutover-"));
  roots.push(root);
  const ledger = new CutoverLedger({ rootDirectory: join(root, "ledger") });
  const routes = new RuntimeRouteRegistry({
    rootDirectory: join(root, "routes"),
  });
  await routes.bootstrap(activeRoute, {
    cutoverId: "bootstrap-active",
    expectedGeneration: null,
  });
  return { root, ledger, routes };
}

class FakeDurableAdapter implements DurableRuntimeCutoverAdapter {
  readonly order: string[] = [];
  readonly appliedRoutes: RuntimeRouteRevision[] = [];
  failAt: string | null = null;
  failCandidateRouteApplyOnce = false;

  #fail(name: string): void {
    if (this.failAt === name) throw new Error(`${name} failed`);
  }

  async startCandidate(
    candidate: RuntimeReleaseCandidate,
    _context: RuntimeCutoverContext,
  ): Promise<RuntimeHostHandle> {
    this.order.push("start");
    this.#fail("start");
    return {
      instanceId: "runtime-candidate-2",
      releaseId: candidate.releaseId,
    };
  }

  async waitUntilHealthy(
    _candidate: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push("health");
    this.#fail("health");
  }

  async quiesce(
    _active: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push("quiesce");
    this.#fail("quiesce");
  }

  async drain(
    _active: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<RuntimeDrainReport> {
    this.order.push("drain");
    this.#fail("drain");
    return { inFlight: 0, cancelled: 0, unknown: 0 };
  }

  async checkpoint(
    _active: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<RuntimeCheckpoint> {
    this.order.push("checkpoint");
    this.#fail("checkpoint");
    return { checkpointId: "checkpoint-2", fencingToken: "fence-2" };
  }

  async describeRoute(
    host: RuntimeHostHandle,
    _checkpoint: RuntimeCheckpoint,
    _context: RuntimeCutoverContext,
  ): Promise<{ readonly routeId: string }> {
    this.order.push(`describe-route:${host.instanceId}`);
    this.#fail("describe-route");
    return { routeId: `route:${host.instanceId}` };
  }

  async applyAuthoritativeRoute(
    revision: RuntimeRouteRevision,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push(`apply-route:${revision.active.instanceId}`);
    if (
      this.failCandidateRouteApplyOnce &&
      revision.active.instanceId === "runtime-candidate-2"
    ) {
      this.failCandidateRouteApplyOnce = false;
      throw new Error("candidate route apply failed");
    }
    this.#fail(`apply-route:${revision.active.instanceId}`);
    this.appliedRoutes.push(revision);
  }

  async runCanary(
    _candidate: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push("canary");
    this.#fail("canary");
  }

  async commitCandidate(
    _candidate: RuntimeHostHandle,
    _checkpoint: RuntimeCheckpoint,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push("commit");
    this.#fail("commit");
  }

  async resume(
    _active: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push("resume");
    this.#fail("resume");
  }

  async stop(
    host: RuntimeHostHandle,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push(`stop:${host.instanceId}:${reason}`);
    this.#fail(`stop:${host.instanceId}`);
  }
}

function input(cutoverId: string) {
  return {
    cutoverId,
    active,
    candidate: candidateRelease,
    expectedRouteGeneration: 1,
  } as const;
}

describe("DurableRuntimeCutoverCoordinator", () => {
  it("binds the rolling cutover to a hash-chained ledger and authoritative route registry", async () => {
    const { ledger, routes } = await fixture();
    const adapter = new FakeDurableAdapter();
    const coordinator = new DurableRuntimeCutoverCoordinator({
      adapter,
      ledger,
      routes,
    });

    const receipt = await coordinator.cutover(input("durable-cutover-1"));

    expect(receipt.outcome).toBe("committed");
    await expect(routes.readCurrent()).resolves.toMatchObject({
      generation: 3,
      operation: "commit",
      active: {
        instanceId: "runtime-candidate-2",
        releaseId: "runtime-release-2",
        checkpointId: "checkpoint-2",
        fencingToken: "fence-2",
      },
      previous: null,
    });
    const entries = await ledger.readAll();
    expect(entries.at(-1)?.payload).toMatchObject({
      recordType: "receipt",
      outcome: "committed",
      checkpointId: "checkpoint-2",
    });
    expect(
      entries.map((entry) => entry.payload.phase).filter(Boolean),
    ).toContain("switch-traffic");
    await expect(ledger.recoveryPlans()).resolves.toEqual([]);
  });

  it("rolls the durable route back and records a closed receipt after canary failure", async () => {
    const { ledger, routes } = await fixture();
    const adapter = new FakeDurableAdapter();
    adapter.failAt = "canary";
    const receipt = await new DurableRuntimeCutoverCoordinator({
      adapter,
      ledger,
      routes,
    }).cutover(input("durable-cutover-canary"));

    expect(receipt.outcome).toBe("rolled-back");
    await expect(routes.readCurrent()).resolves.toMatchObject({
      generation: 3,
      operation: "rollback",
      active: activeRoute,
      previous: { instanceId: "runtime-candidate-2" },
    });
    expect(adapter.order).toContain("apply-route:runtime-active-1");
    expect((await ledger.readAll()).at(-1)?.payload.outcome).toBe(
      "rolled-back",
    );
    await expect(ledger.recoveryPlans()).resolves.toEqual([]);
  });

  it("restores the persisted and applied route if forward route application fails", async () => {
    const { ledger, routes } = await fixture();
    const adapter = new FakeDurableAdapter();
    adapter.failCandidateRouteApplyOnce = true;
    const receipt = await new DurableRuntimeCutoverCoordinator({
      adapter,
      ledger,
      routes,
    }).cutover(input("durable-cutover-route-apply"));

    expect(receipt.outcome).toBe("rolled-back");
    expect(receipt.failureReason).toMatch(/candidate route apply failed/u);
    await expect(routes.readCurrent()).resolves.toMatchObject({
      generation: 3,
      active: activeRoute,
    });
    expect(adapter.order).toContain("apply-route:runtime-active-1");
  });

  it("rejects a stale or mismatched active route before starting a candidate", async () => {
    const { ledger, routes } = await fixture();
    const adapter = new FakeDurableAdapter();
    const coordinator = new DurableRuntimeCutoverCoordinator({
      adapter,
      ledger,
      routes,
    });

    await expect(
      coordinator.cutover({
        ...input("durable-cutover-stale"),
        expectedRouteGeneration: 99,
      }),
    ).rejects.toThrow(/generation changed/u);
    await expect(
      coordinator.cutover({
        ...input("durable-cutover-mismatch"),
        active: { ...active, instanceId: "different-active" },
      }),
    ).rejects.toThrow(/does not match/u);
    expect(adapter.order).toEqual([]);
    await expect(ledger.readAll()).resolves.toEqual([]);
  });

  it("persists cleanup phases before their side effects", async () => {
    const { ledger, routes } = await fixture();
    const adapter = new FakeDurableAdapter();
    adapter.failAt = "health";
    const receipt = await new DurableRuntimeCutoverCoordinator({
      adapter,
      ledger,
      routes,
    }).cutover(input("durable-cutover-health"));

    expect(receipt.outcome).toBe("rolled-back");
    const entries = await ledger.readAll();
    const phases = entries
      .map((entry) => entry.payload.phase)
      .filter((phase): phase is NonNullable<typeof phase> => phase !== null);
    expect(phases).toEqual([
      "start-candidate",
      "candidate-health",
      "stop-candidate",
    ]);
    expect(entries.at(-1)?.payload.recordType).toBe("receipt");
  });
});
