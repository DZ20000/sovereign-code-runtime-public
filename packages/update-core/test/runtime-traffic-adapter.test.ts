import { describe, expect, it } from "vitest";
import {
  RuntimeCutoverCoordinator,
  type RuntimeCheckpoint,
  type RuntimeCutoverContext,
  type RuntimeHostHandle,
  type RuntimeReleaseCandidate,
} from "../src/runtime-cutover.js";
import {
  RuntimeTrafficCutoverAdapter,
  type RuntimeCandidateLifecycle,
} from "../src/runtime-traffic-adapter.js";
import { RuntimeTrafficRegistry } from "../src/runtime-traffic.js";

const active: RuntimeHostHandle = {
  instanceId: "host-active",
  releaseId: "runtime-1",
};
const candidateRelease: RuntimeReleaseCandidate = {
  releaseId: "runtime-2",
  directory: "releases/runtime-2",
  manifestSha256: "a".repeat(64),
};

class FakeLifecycle implements RuntimeCandidateLifecycle {
  readonly order: string[] = [];
  failAt: string | null = null;

  #fail(name: string): void {
    if (this.failAt === name) throw new Error(`${name} failed`);
  }

  async startCandidate(
    candidate: RuntimeReleaseCandidate,
    _context: RuntimeCutoverContext,
  ): Promise<RuntimeHostHandle> {
    this.order.push("start");
    this.#fail("start");
    return { instanceId: "host-candidate", releaseId: candidate.releaseId };
  }

  async waitUntilHealthy(
    _candidate: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push("health");
    this.#fail("health");
  }

  async checkpoint(
    _active: RuntimeHostHandle,
    _context: RuntimeCutoverContext,
  ): Promise<RuntimeCheckpoint> {
    this.order.push("checkpoint");
    this.#fail("checkpoint");
    return { checkpointId: "checkpoint-2", fencingToken: "fence-2" };
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

  async stop(
    host: RuntimeHostHandle,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    this.order.push(`stop:${host.instanceId}:${reason}`);
    this.#fail("stop");
  }
}

function setup() {
  const traffic = new RuntimeTrafficRegistry({ active, generation: 1 });
  const lifecycle = new FakeLifecycle();
  const snapshots: string[] = [];
  const adapter = new RuntimeTrafficCutoverAdapter({
    traffic,
    lifecycle,
    onTrafficChange: (snapshot) => {
      snapshots.push(`${snapshot.generation}:${snapshot.active.instanceId}`);
    },
  });
  const coordinator = new RuntimeCutoverCoordinator({ adapter });
  return { traffic, lifecycle, adapter, coordinator, snapshots };
}

describe("RuntimeTrafficCutoverAdapter", () => {
  it("binds the rolling coordinator to quiescence, drain, fencing, and traffic authority", async () => {
    const { traffic, lifecycle, coordinator, snapshots } = setup();
    const preexisting = traffic.begin({
      kind: "read",
      leaseId: "preexisting-read",
    });
    queueMicrotask(() => preexisting.finish());

    const receipt = await coordinator.cutover({
      cutoverId: "traffic-cutover-1",
      active,
      candidate: candidateRelease,
    });

    expect(receipt.outcome).toBe("committed");
    expect(traffic.snapshot()).toMatchObject({
      generation: 2,
      active: { instanceId: "host-candidate", releaseId: "runtime-2" },
      fencingToken: "fence-2",
    });
    expect(lifecycle.order).toEqual([
      "start",
      "health",
      "checkpoint",
      "canary",
      "commit",
      "stop:host-active:cutover-committed",
    ]);
    expect(snapshots).toContain("2:host-candidate");
  });

  it("rolls traffic back to the old host when the canary fails", async () => {
    const { traffic, lifecycle, coordinator } = setup();
    lifecycle.failAt = "canary";

    const receipt = await coordinator.cutover({
      cutoverId: "traffic-cutover-rollback",
      active,
      candidate: candidateRelease,
    });

    expect(receipt.outcome).toBe("rolled-back");
    expect(traffic.snapshot()).toMatchObject({
      generation: 3,
      active,
      fencingToken: "fence-2",
    });
    expect(traffic.snapshot().quiescedInstanceIds).not.toContain("host-active");
    expect(lifecycle.order).toContain(
      "stop:host-candidate:cutover-rolled-back",
    );
  });

  it("refuses the switch while an unknown consequential result is unresolved", async () => {
    const { traffic, coordinator } = setup();
    const operation = traffic.begin({
      kind: "consequential",
      leaseId: "unknown-side-effect",
    });
    queueMicrotask(() => operation.finish("unknown"));

    const receipt = await coordinator.cutover({
      cutoverId: "traffic-cutover-unknown",
      active,
      candidate: candidateRelease,
    });

    expect(receipt.outcome).toBe("rolled-back");
    expect(receipt.failureReason).toMatch(/unknown=1/u);
    expect(traffic.snapshot().active).toEqual(active);
    expect(traffic.snapshot().unknown).toEqual({ "host-active": 1 });
  });

  it("rejects a cutover whose active handle disagrees with traffic authority", async () => {
    const { coordinator, lifecycle } = setup();
    const receipt = await coordinator.cutover({
      cutoverId: "traffic-cutover-stale-active",
      active: { instanceId: "stale-host", releaseId: "runtime-1" },
      candidate: candidateRelease,
    });

    expect(receipt.outcome).toBe("rolled-back");
    expect(receipt.failureReason).toMatch(
      /does not match the traffic registry/u,
    );
    expect(lifecycle.order).toEqual([
      "start",
      "health",
      "stop:host-candidate:candidate-rejected",
    ]);
  });

  it("will not stop whichever host is currently authoritative", async () => {
    const { adapter } = setup();
    const context: RuntimeCutoverContext = {
      cutoverId: "manual-stop-check",
      phase: "stop-candidate",
      startedAt: 0,
      deadlineAt: 1_000,
      signal: new AbortController().signal,
    };

    await expect(
      adapter.stop(active, "candidate-rejected", context),
    ).rejects.toThrow(/authoritative/u);
  });

  it("fails commit when the durable checkpoint fence and active route diverge", async () => {
    const { traffic, adapter } = setup();
    traffic.quiesce("host-active", 1);
    await traffic.drain("host-active", { timeoutMs: 100 });
    traffic.switchActive({
      expectedGeneration: 1,
      from: active,
      to: { instanceId: "host-candidate", releaseId: "runtime-2" },
      checkpoint: { checkpointId: "checkpoint-other", fencingToken: "other" },
    });
    const context: RuntimeCutoverContext = {
      cutoverId: "manual-commit-check",
      phase: "commit-candidate",
      startedAt: 0,
      deadlineAt: 1_000,
      signal: new AbortController().signal,
    };

    await expect(
      adapter.commitCandidate(
        { instanceId: "host-candidate", releaseId: "runtime-2" },
        { checkpointId: "checkpoint-2", fencingToken: "fence-2" },
        context,
      ),
    ).rejects.toThrow(/fencing token/u);
  });

  it("ignores traffic observer failures", async () => {
    const traffic = new RuntimeTrafficRegistry({ active });
    const lifecycle = new FakeLifecycle();
    const adapter = new RuntimeTrafficCutoverAdapter({
      traffic,
      lifecycle,
      onTrafficChange: () => {
        throw new Error("telemetry unavailable");
      },
    });
    const receipt = await new RuntimeCutoverCoordinator({ adapter }).cutover({
      cutoverId: "traffic-cutover-telemetry",
      active,
      candidate: candidateRelease,
    });
    expect(receipt.outcome).toBe("committed");
  });
});
