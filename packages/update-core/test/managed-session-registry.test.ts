import { describe, expect, it, vi } from "vitest";

import {
  ManagedRuntimeSessionRegistry,
  ManagedSessionRegistryError,
  type ManagedRuntimeSessionAdapter,
  type RuntimeSessionTarget,
} from "../src/managed-session-registry.js";

function target(
  runtimeGeneration: number,
  port: number,
  connectionRevision = runtimeGeneration,
): RuntimeSessionTarget {
  return {
    runtimeGeneration,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    manifestDigest: String(runtimeGeneration % 10).repeat(64),
    connectionRevision,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function adapter(
  implementation: ManagedRuntimeSessionAdapter["rebind"] = async () =>
    undefined,
): ManagedRuntimeSessionAdapter & {
  readonly rebind: ReturnType<typeof vi.fn>;
} {
  return {
    rebind: vi.fn(implementation),
  };
}

describe("ManagedRuntimeSessionRegistry", () => {
  it("tracks only bounded aggregate metadata in snapshots", () => {
    const registry = new ManagedRuntimeSessionRegistry();
    registry.registerManaged({
      sessionId: "desktop-session-secret-looking-id",
      target: target(5, 41000),
      adapter: adapter(),
    });
    registry.registerExternal({
      sessionId: "chatgpt-session-0001",
      target: target(4, 40000),
    });
    registry.registerManaged({
      sessionId: "desktop-session-0002",
      target: target(5, 41000),
      adapter: adapter(),
    });

    const snapshot = registry.snapshot();
    expect(snapshot).toEqual({
      schemaVersion: "scr.managed-session-registry/v1",
      revision: 4,
      managedSessions: 2,
      externalSessions: 1,
      managedByGeneration: { "5": 2 },
      externalByGeneration: { "4": 1 },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("desktop-session");
    expect(serialized).not.toContain("chatgpt-session");
  });

  it("rebinds managed sessions and reports external refresh without exposing IDs", async () => {
    const registry = new ManagedRuntimeSessionRegistry();
    const first = adapter();
    const second = adapter();
    registry.registerManaged({
      sessionId: "managed-session-0001",
      target: target(10, 41000),
      adapter: first,
    });
    registry.registerManaged({
      sessionId: "managed-session-0002",
      target: target(10, 41000),
      adapter: second,
    });
    registry.registerExternal({
      sessionId: "external-session-0001",
      target: target(10, 41000),
    });
    const next = target(11, 42000, 20);

    const report = await registry.rebindManaged(next, {
      timeoutMs: 1_000,
      concurrency: 2,
    });
    expect(report).toMatchObject({
      schemaVersion: "scr.managed-session-rebind-report/v1",
      outcome: "rebound",
      registryRevision: 5,
      target: next,
      attemptedManagedSessions: 2,
      alreadyCurrentManagedSessions: 0,
      reboundManagedSessions: 2,
      failedManagedSessions: 0,
      rolledBackManagedSessions: 0,
      rollbackFailedManagedSessions: 0,
      externalSessions: 1,
      externalRefreshRequired: true,
      failureCodes: [],
    });
    expect(first.rebind).toHaveBeenCalledWith(next, expect.any(AbortSignal));
    expect(second.rebind).toHaveBeenCalledWith(next, expect.any(AbortSignal));
    expect(registry.snapshot()).toMatchObject({
      managedByGeneration: { "11": 2 },
      externalByGeneration: { "10": 1 },
    });
    expect(JSON.stringify(report)).not.toContain("managed-session-0001");
    expect(JSON.stringify(report)).not.toContain("managed-session-0002");
    expect(JSON.stringify(report)).not.toContain("external-session");
  });

  it("does not call adapters that already point at the target", async () => {
    const registry = new ManagedRuntimeSessionRegistry();
    const current = target(20, 43000, 30);
    const currentAdapter = adapter();
    registry.registerManaged({
      sessionId: "managed-current-0001",
      target: current,
      adapter: currentAdapter,
    });

    const report = await registry.rebindManaged(current);
    expect(report).toMatchObject({
      outcome: "rebound",
      attemptedManagedSessions: 0,
      alreadyCurrentManagedSessions: 1,
      reboundManagedSessions: 0,
      externalRefreshRequired: false,
    });
    expect(currentAdapter.rebind).not.toHaveBeenCalled();
  });

  it("rolls successful sessions back when any managed rebind fails", async () => {
    const registry = new ManagedRuntimeSessionRegistry();
    const previous = target(30, 44000, 40);
    const next = target(31, 45000, 41);
    const successful = adapter();
    const failing = adapter(async () => {
      throw new ManagedSessionRegistryError(
        "SESSION_REBIND_FAILED",
        "sensitive transport URL and token must not escape",
      );
    });
    registry.registerManaged({
      sessionId: "managed-rollback-success",
      target: previous,
      adapter: successful,
    });
    registry.registerManaged({
      sessionId: "managed-rollback-failure",
      target: previous,
      adapter: failing,
    });

    const report = await registry.rebindManaged(next, {
      timeoutMs: 1_000,
      concurrency: 1,
      rollbackOnFailure: true,
    });
    expect(report).toMatchObject({
      outcome: "rolled-back",
      attemptedManagedSessions: 2,
      reboundManagedSessions: 0,
      failedManagedSessions: 1,
      rolledBackManagedSessions: 1,
      rollbackFailedManagedSessions: 0,
      failureCodes: ["SESSION_REBIND_FAILED"],
    });
    expect(successful.rebind.mock.calls).toHaveLength(2);
    expect(successful.rebind.mock.calls[0]?.[0]).toEqual(next);
    expect(successful.rebind.mock.calls[1]?.[0]).toEqual(previous);
    expect(registry.snapshot().managedByGeneration).toEqual({ "30": 2 });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("sensitive transport");
    expect(serialized).not.toContain("managed-rollback");
  });

  it("reports a partial state when a rollback adapter also fails", async () => {
    const registry = new ManagedRuntimeSessionRegistry();
    const previous = target(40, 46000, 50);
    const next = target(41, 47000, 51);
    let call = 0;
    const rollbackFails = adapter(async () => {
      call += 1;
      if (call === 2) {
        const error = new Error("rollback local secret detail") as Error & {
          code: string;
        };
        error.code = "SESSION_ROLLBACK_FAILED";
        throw error;
      }
    });
    const primaryFails = adapter(async () => {
      throw new Error("primary failure with credential-like text");
    });
    registry.registerManaged({
      sessionId: "managed-partial-0001",
      target: previous,
      adapter: rollbackFails,
    });
    registry.registerManaged({
      sessionId: "managed-partial-0002",
      target: previous,
      adapter: primaryFails,
    });

    const report = await registry.rebindManaged(next, {
      concurrency: 1,
      timeoutMs: 1_000,
    });
    expect(report).toMatchObject({
      outcome: "partial",
      reboundManagedSessions: 1,
      failedManagedSessions: 1,
      rolledBackManagedSessions: 0,
      rollbackFailedManagedSessions: 1,
      failureCodes: ["SESSION_REBIND_FAILED", "SESSION_ROLLBACK_FAILED"],
    });
    expect(registry.snapshot().managedByGeneration).toEqual({
      "40": 1,
      "41": 1,
    });
    expect(JSON.stringify(report)).not.toContain("credential-like");
    expect(JSON.stringify(report)).not.toContain("local secret");
  });

  it("times out a non-cooperative adapter and keeps the prior binding", async () => {
    const registry = new ManagedRuntimeSessionRegistry();
    const previous = target(50, 48000, 60);
    const blocked = deferred<void>();
    registry.registerManaged({
      sessionId: "managed-timeout-0001",
      target: previous,
      adapter: adapter(async () => await blocked.promise),
    });

    const report = await registry.rebindManaged(target(51, 49000, 61), {
      timeoutMs: 100,
    });
    expect(report).toMatchObject({
      outcome: "failed",
      reboundManagedSessions: 0,
      failedManagedSessions: 1,
      failureCodes: ["SESSION_REBIND_TIMEOUT"],
    });
    expect(registry.snapshot().managedByGeneration).toEqual({ "50": 1 });
    blocked.resolve();
  });

  it("serializes rebind operations and rejects a concurrent cutover", async () => {
    const registry = new ManagedRuntimeSessionRegistry();
    const gate = deferred<void>();
    registry.registerManaged({
      sessionId: "managed-busy-0001",
      target: target(60, 50000, 70),
      adapter: adapter(async () => await gate.promise),
    });
    const first = registry.rebindManaged(target(61, 51000, 71), {
      timeoutMs: 5_000,
    });
    await Promise.resolve();
    await expect(
      registry.rebindManaged(target(62, 52000, 72)),
    ).rejects.toMatchObject({ code: "SESSION_REBIND_BUSY" });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ outcome: "rebound" });
  });

  it("validates registration, supports idempotent unregister, and updates external targets", () => {
    const registry = new ManagedRuntimeSessionRegistry();
    const unregister = registry.registerExternal({
      sessionId: "external-update-0001",
      target: target(70, 53000, 80),
    });
    expect(() =>
      registry.registerExternal({
        sessionId: "external-update-0001",
        target: target(70, 53000, 80),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SESSION_ALREADY_REGISTERED" }),
    );
    registry.updateExternalTarget(
      "external-update-0001",
      target(71, 54000, 81),
    );
    expect(registry.snapshot()).toMatchObject({
      revision: 3,
      externalByGeneration: { "71": 1 },
    });
    unregister();
    unregister();
    expect(registry.snapshot()).toMatchObject({
      revision: 4,
      externalSessions: 0,
    });
    expect(() =>
      registry.registerManaged({
        sessionId: "bad session id",
        target: target(1, 40000),
        adapter: adapter(),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SESSION" }));
  });

  it("freezes registration and target mutation while a managed rebind is active", async () => {
    const registry = new ManagedRuntimeSessionRegistry();
    const gate = deferred<void>();
    registry.registerManaged({
      sessionId: "managed-freeze-0001",
      target: target(80, 55000, 90),
      adapter: adapter(async () => await gate.promise),
    });
    registry.registerExternal({
      sessionId: "external-freeze-0001",
      target: target(80, 55000, 90),
    });

    const rebind = registry.rebindManaged(target(81, 56000, 91), {
      timeoutMs: 5_000,
    });
    await Promise.resolve();

    expect(() =>
      registry.registerManaged({
        sessionId: "managed-freeze-0002",
        target: target(80, 55000, 90),
        adapter: adapter(),
      }),
    ).toThrowError(expect.objectContaining({ code: "SESSION_REBIND_BUSY" }));
    expect(() =>
      registry.registerExternal({
        sessionId: "external-freeze-0002",
        target: target(80, 55000, 90),
      }),
    ).toThrowError(expect.objectContaining({ code: "SESSION_REBIND_BUSY" }));
    expect(() => registry.unregister("external-freeze-0001")).toThrowError(
      expect.objectContaining({ code: "SESSION_REBIND_BUSY" }),
    );
    expect(() =>
      registry.updateExternalTarget(
        "external-freeze-0001",
        target(81, 56000, 91),
      ),
    ).toThrowError(expect.objectContaining({ code: "SESSION_REBIND_BUSY" }));

    gate.resolve();
    await expect(rebind).resolves.toMatchObject({ outcome: "rebound" });
    expect(() => registry.unregister("external-freeze-0001")).not.toThrow();
  });

  it("does not let a stale unregister closure delete a replacement session", () => {
    const registry = new ManagedRuntimeSessionRegistry();
    const unregisterFirst = registry.registerExternal({
      sessionId: "external-replacement-0001",
      target: target(90, 57000, 100),
    });
    registry.unregister("external-replacement-0001");
    const unregisterReplacement = registry.registerExternal({
      sessionId: "external-replacement-0001",
      target: target(91, 58000, 101),
    });

    unregisterFirst();
    expect(registry.snapshot()).toMatchObject({
      externalSessions: 1,
      externalByGeneration: { "91": 1 },
    });
    unregisterReplacement();
    expect(registry.snapshot()).toMatchObject({
      externalSessions: 0,
      externalByGeneration: {},
    });
  });

  it("enforces a configured aggregate session bound", () => {
    const registry = new ManagedRuntimeSessionRegistry({ maxSessions: 2 });
    registry.registerManaged({
      sessionId: "bounded-managed-0001",
      target: target(100, 59000, 110),
      adapter: adapter(),
    });
    registry.registerExternal({
      sessionId: "bounded-external-0001",
      target: target(100, 59000, 110),
    });

    expect(() =>
      registry.registerExternal({
        sessionId: "bounded-external-0002",
        target: target(100, 59000, 110),
      }),
    ).toThrowError(expect.objectContaining({ code: "SESSION_LIMIT_REACHED" }));
    expect(
      () => new ManagedRuntimeSessionRegistry({ maxSessions: 0 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SESSION" }));

    const seeded = new ManagedRuntimeSessionRegistry({ initialRevision: 9 });
    expect(seeded.snapshot().revision).toBe(9);
    seeded.registerExternal({
      sessionId: "seeded-external-0001",
      target: target(101, 59100, 111),
    });
    expect(seeded.snapshot().revision).toBe(10);
    expect(
      () => new ManagedRuntimeSessionRegistry({ initialRevision: 0 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SESSION" }));
  });
});
