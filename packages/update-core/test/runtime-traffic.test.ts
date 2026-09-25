import { describe, expect, it } from "vitest";
import {
  RuntimeTrafficGenerationError,
  RuntimeTrafficQuiescedError,
  RuntimeTrafficRegistry,
} from "../src/runtime-traffic.js";

const active = { instanceId: "host-1", releaseId: "runtime-1" } as const;
const candidate = { instanceId: "host-2", releaseId: "runtime-2" } as const;
const checkpoint = {
  checkpointId: "checkpoint-1",
  fencingToken: "fence-1",
} as const;

describe("RuntimeTrafficRegistry", () => {
  it("routes calls to the authoritative host and tracks completion idempotently", () => {
    const snapshots: number[] = [];
    const registry = new RuntimeTrafficRegistry({
      active,
      generation: 7,
      now: () => 100,
      onChange: (snapshot) => snapshots.push(snapshot.generation),
    });

    const lease = registry.begin({
      kind: "read",
      expectedGeneration: 7,
      leaseId: "call-1",
    });

    expect(lease).toMatchObject({
      leaseId: "call-1",
      instanceId: "host-1",
      releaseId: "runtime-1",
      generation: 7,
      kind: "read",
      startedAt: 100,
    });
    expect(registry.snapshot().inFlight).toEqual({ "host-1": 1 });
    expect(lease.finish()).toBe(true);
    expect(lease.finish()).toBe(false);
    expect(registry.snapshot().inFlight).toEqual({});
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
  });

  it("quiesces before draining and blocks new work on the old host", async () => {
    const registry = new RuntimeTrafficRegistry({ active, generation: 1 });
    const first = registry.begin({
      kind: "consequential",
      leaseId: "call-first",
    });
    const second = registry.begin({ kind: "read", leaseId: "call-second" });

    registry.quiesce("host-1", 1);
    expect(() => registry.begin({ kind: "read" })).toThrow(
      RuntimeTrafficQuiescedError,
    );

    const draining = registry.drain("host-1", { timeoutMs: 1_000 });
    let settled = false;
    void draining.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    first.finish("completed");
    await Promise.resolve();
    expect(settled).toBe(false);
    second.finish("cancelled");

    await expect(draining).resolves.toEqual({
      inFlight: 0,
      cancelled: 1,
      unknown: 0,
    });
  });

  it("blocks traffic switching while unknown side effects remain", async () => {
    const registry = new RuntimeTrafficRegistry({ active, generation: 1 });
    const lease = registry.begin({
      kind: "consequential",
      leaseId: "unknown-call",
    });
    registry.quiesce("host-1", 1);
    lease.finish("unknown");

    await expect(
      registry.drain("host-1", { timeoutMs: 100 }),
    ).resolves.toMatchObject({ unknown: 1, inFlight: 0 });
    expect(() =>
      registry.switchActive({
        expectedGeneration: 1,
        from: active,
        to: candidate,
        checkpoint,
      }),
    ).toThrow(/unknown side effects/u);

    expect(
      registry.reconcileUnknown({
        leaseId: "unknown-call",
        resolution: "not-applied",
      }),
    ).toBe(true);
    expect(
      registry.reconcileUnknown({
        leaseId: "unknown-call",
        resolution: "not-applied",
      }),
    ).toBe(false);

    expect(
      registry.switchActive({
        expectedGeneration: 1,
        from: active,
        to: candidate,
        checkpoint,
      }),
    ).toMatchObject({
      generation: 2,
      active: candidate,
      fencingToken: "fence-1",
    });
  });

  it("supports a fenced switch and rollback without routing through a stale generation", async () => {
    const registry = new RuntimeTrafficRegistry({ active, generation: 4 });
    registry.quiesce("host-1", 4);
    await registry.drain("host-1", { timeoutMs: 100 });

    const switched = registry.switchActive({
      expectedGeneration: 4,
      from: active,
      to: candidate,
      checkpoint,
    });
    expect(switched).toMatchObject({ generation: 5, active: candidate });
    expect(() =>
      registry.begin({ kind: "read", expectedGeneration: 4 }),
    ).toThrow(RuntimeTrafficGenerationError);

    const candidateLease = registry.begin({
      kind: "read",
      expectedGeneration: 5,
      leaseId: "candidate-call",
    });
    candidateLease.finish();
    registry.quiesce("host-2", 5);
    await registry.drain("host-2", { timeoutMs: 100 });
    const rolledBack = registry.switchActive({
      expectedGeneration: 5,
      from: candidate,
      to: active,
      checkpoint: {
        checkpointId: "checkpoint-rollback",
        fencingToken: "fence-rollback",
      },
    });

    expect(rolledBack).toMatchObject({
      generation: 6,
      active,
      fencingToken: "fence-rollback",
    });
  });

  it("requires the switch source to be active, quiesced, drained, and distinct", () => {
    const registry = new RuntimeTrafficRegistry({ active, generation: 1 });

    expect(() =>
      registry.switchActive({
        expectedGeneration: 1,
        from: active,
        to: candidate,
        checkpoint,
      }),
    ).toThrow(/must be quiesced/u);

    const lease = registry.begin({ kind: "read", leaseId: "still-running" });
    registry.quiesce("host-1", 1);
    expect(() =>
      registry.switchActive({
        expectedGeneration: 1,
        from: active,
        to: candidate,
        checkpoint,
      }),
    ).toThrow(/in-flight/u);
    lease.finish();

    expect(() =>
      registry.switchActive({
        expectedGeneration: 1,
        from: { instanceId: "other", releaseId: "runtime-1" },
        to: candidate,
        checkpoint,
      }),
    ).toThrow(/not the active host/u);
    expect(() =>
      registry.switchActive({
        expectedGeneration: 1,
        from: active,
        to: active,
        checkpoint,
      }),
    ).toThrow(/different instance/u);
  });

  it("times out and aborts a drain without losing the tracked call", async () => {
    const registry = new RuntimeTrafficRegistry({ active });
    const lease = registry.begin({ kind: "read", leaseId: "slow-call" });
    registry.quiesce("host-1", 1);

    await expect(registry.drain("host-1", { timeoutMs: 5 })).rejects.toThrow(
      /timed out/u,
    );
    expect(registry.snapshot().inFlight).toEqual({ "host-1": 1 });

    const controller = new AbortController();
    const draining = registry.drain("host-1", {
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort(new Error("operator aborted drain"));
    await expect(draining).rejects.toThrow(/operator aborted/u);

    lease.finish();
    await expect(
      registry.drain("host-1", { timeoutMs: 100 }),
    ).resolves.toMatchObject({ inFlight: 0 });
  });

  it("resumes a quiesced host and clears bounded cancellation counters", () => {
    const registry = new RuntimeTrafficRegistry({ active });
    const lease = registry.begin({
      kind: "consequential",
      leaseId: "cancelled-call",
    });
    registry.quiesce("host-1", 1);
    lease.finish("cancelled");
    expect(registry.snapshot().cancelled).toEqual({ "host-1": 1 });

    registry.resume("host-1");
    expect(() => registry.begin({ kind: "read" })).not.toThrow();
    expect(registry.clearCancelled("host-1")).toBe(1);
    expect(registry.clearCancelled("host-1")).toBe(0);
  });

  it("ignores observer failures and rejects duplicate explicit lease IDs", () => {
    const registry = new RuntimeTrafficRegistry({
      active,
      onChange: () => {
        throw new Error("telemetry unavailable");
      },
    });
    const lease = registry.begin({ kind: "read", leaseId: "duplicate" });
    expect(() =>
      registry.begin({ kind: "read", leaseId: "duplicate" }),
    ).toThrow(/already tracked/u);
    expect(lease.finish()).toBe(true);
  });
});
