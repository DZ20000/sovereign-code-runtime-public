import { describe, expect, it } from "vitest";
import {
  RuntimeCutoverBusyError,
  RuntimeCutoverCoordinator,
  type RuntimeCheckpoint,
  type RuntimeCutoverAdapter,
  type RuntimeCutoverContext,
  type RuntimeDrainReport,
  type RuntimeHostHandle,
  type RuntimeReleaseCandidate,
  type RuntimeTrafficSwitch,
} from "../src/runtime-cutover.js";

const active: RuntimeHostHandle = {
  instanceId: "active-1",
  releaseId: "release-1",
};

const candidateRelease: RuntimeReleaseCandidate = {
  releaseId: "release-2",
  directory: "candidate/release-2",
  manifestSha256: "a".repeat(64),
};

class FakeAdapter implements RuntimeCutoverAdapter {
  readonly order: string[] = [];
  failAt: string | null = null;
  drainReport: RuntimeDrainReport = { inFlight: 0, cancelled: 0, unknown: 0 };
  startGate: Promise<void> | null = null;

  #fail(name: string): void {
    if (this.failAt === name) throw new Error(`${name} failed`);
  }

  async startCandidate(
    candidate: RuntimeReleaseCandidate,
    _context: RuntimeCutoverContext,
  ): Promise<RuntimeHostHandle> {
    this.order.push("start");
    this.#fail("start");
    if (this.startGate !== null) await this.startGate;
    return { instanceId: "candidate-2", releaseId: candidate.releaseId };
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
    return this.drainReport;
  }

  async checkpoint(
    _active: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<RuntimeCheckpoint> {
    this.order.push("checkpoint");
    this.#fail("checkpoint");
    return { checkpointId: "checkpoint-1", fencingToken: "fence-1" };
  }

  async switchTraffic(
    change: RuntimeTrafficSwitch,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    const name = change.rollback ? "switch-rollback" : "switch-forward";
    this.order.push(name);
    this.#fail(name);
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
    const name = `stop:${host.instanceId}:${reason}`;
    this.order.push(name);
    this.#fail(host.instanceId === active.instanceId ? "stop-previous" : "stop-candidate");
  }
}

function input(suffix = "1") {
  return {
    cutoverId: `cutover-${suffix}`,
    active,
    candidate: candidateRelease,
  } as const;
}

describe("RuntimeCutoverCoordinator", () => {
  it("starts, drains, checkpoints, switches, canaries, commits, and retires in order", async () => {
    const adapter = new FakeAdapter();
    const transitions: string[] = [];
    const coordinator = new RuntimeCutoverCoordinator({
      adapter,
      onTransition: (value) => transitions.push(value.phase),
    });

    const receipt = await coordinator.cutover(input());

    expect(receipt).toMatchObject({
      outcome: "committed",
      candidateInstanceId: "candidate-2",
      checkpointId: "checkpoint-1",
      failureReason: null,
    });
    expect(adapter.order).toEqual([
      "start",
      "health",
      "quiesce",
      "drain",
      "checkpoint",
      "switch-forward",
      "canary",
      "commit",
      "stop:active-1:cutover-committed",
    ]);
    expect(transitions).toEqual([
      "start-candidate",
      "candidate-health",
      "quiesce-active",
      "drain-active",
      "checkpoint-active",
      "switch-traffic",
      "candidate-canary",
      "commit-candidate",
      "stop-previous",
      "committed",
    ]);
  });

  it("rejects an unhealthy candidate without quiescing the active host", async () => {
    const adapter = new FakeAdapter();
    adapter.failAt = "health";
    const receipt = await new RuntimeCutoverCoordinator({ adapter }).cutover(input());

    expect(receipt.outcome).toBe("rolled-back");
    expect(receipt.failureReason).toMatch(/health failed/u);
    expect(adapter.order).toEqual([
      "start",
      "health",
      "stop:candidate-2:candidate-rejected",
    ]);
  });

  it("refuses to switch while work remains in flight or has an unknown outcome", async () => {
    const adapter = new FakeAdapter();
    adapter.drainReport = { inFlight: 1, cancelled: 0, unknown: 1 };
    const receipt = await new RuntimeCutoverCoordinator({ adapter }).cutover(input());

    expect(receipt.outcome).toBe("rolled-back");
    expect(receipt.failureReason).toMatch(/safe point/u);
    expect(adapter.order).toEqual([
      "start",
      "health",
      "quiesce",
      "drain",
      "resume",
      "stop:candidate-2:candidate-rejected",
    ]);
  });

  it("switches traffic back, resumes the active host, and stops a failed canary", async () => {
    const adapter = new FakeAdapter();
    adapter.failAt = "canary";
    const receipt = await new RuntimeCutoverCoordinator({ adapter }).cutover(input());

    expect(receipt).toMatchObject({
      outcome: "rolled-back",
      checkpointId: "checkpoint-1",
    });
    expect(adapter.order.slice(-3)).toEqual([
      "switch-rollback",
      "resume",
      "stop:candidate-2:cutover-rolled-back",
    ]);
  });

  it("fails closed when rollback traffic restoration fails but still attempts cleanup", async () => {
    const adapter = new FakeAdapter();
    adapter.failAt = "canary";
    const originalSwitch = adapter.switchTraffic.bind(adapter);
    adapter.switchTraffic = async (change, context) => {
      if (change.rollback) {
        adapter.order.push("switch-rollback");
        throw new Error("rollback route failed");
      }
      await originalSwitch(change, context);
    };

    const receipt = await new RuntimeCutoverCoordinator({ adapter }).cutover(input());

    expect(receipt.outcome).toBe("failed");
    expect(receipt.cleanupFailures).toEqual([
      expect.stringMatching(/rollback-traffic: rollback route failed/u),
    ]);
    expect(adapter.order).toContain("resume");
    expect(adapter.order).toContain("stop:candidate-2:cutover-rolled-back");
  });

  it("commits even if retiring the previous host needs later cleanup", async () => {
    const adapter = new FakeAdapter();
    adapter.failAt = "stop-previous";
    const receipt = await new RuntimeCutoverCoordinator({ adapter }).cutover(input());

    expect(receipt.outcome).toBe("committed");
    expect(receipt.cleanupFailures).toEqual([
      expect.stringMatching(/stop-previous/u),
    ]);
  });

  it("rejects concurrent cutovers instead of letting a stale active handle queue", async () => {
    const adapter = new FakeAdapter();
    let releaseStart!: () => void;
    adapter.startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const coordinator = new RuntimeCutoverCoordinator({ adapter });
    const first = coordinator.cutover(input("first"));
    await Promise.resolve();

    expect(coordinator.busy).toBe(true);
    await expect(coordinator.cutover(input("second"))).rejects.toBeInstanceOf(
      RuntimeCutoverBusyError,
    );

    releaseStart();
    await expect(first).resolves.toMatchObject({ outcome: "committed" });
    expect(coordinator.busy).toBe(false);
  });

  it("bounds every phase with a timeout and restores the active release", async () => {
    const adapter = new FakeAdapter();
    adapter.startGate = new Promise<void>(() => undefined);
    const receipt = await new RuntimeCutoverCoordinator({
      adapter,
      policy: { startTimeoutMs: 5, cleanupTimeoutMs: 20 },
    }).cutover(input());

    expect(receipt.outcome).toBe("rolled-back");
    expect(receipt.failureReason).toMatch(/timed out/u);
    expect(receipt.candidateInstanceId).toBeNull();
  });
});
