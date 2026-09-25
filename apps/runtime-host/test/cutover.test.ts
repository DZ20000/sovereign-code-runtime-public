import { describe, expect, it } from "vitest";

import {
  DESKTOP_RUNTIME_CUTOVER_STATUS_SCHEMA_VERSION,
  type DesktopRuntimeTrafficStatus,
} from "@sovereign/control-plane-contract";
import { RuntimeError } from "@sovereign/runtime-core";

import {
  RuntimeCutoverGate,
  createRuntimeCutoverFencingToken,
  type RuntimeCutoverHostAdapter,
  type RuntimeGatewayDrainReport,
} from "../src/cutover.js";

class FakeCutoverAdapter implements RuntimeCutoverHostAdapter {
  gateway: DesktopRuntimeTrafficStatus | null = {
    generation: 0,
    acceptingRequests: true,
    activeRequestCount: 0,
    sessionCount: 0,
    pendingSessionInitializations: 0,
  };
  promotedCheckpointId: string | null = null;
  promotedExternalRouteDesired: boolean | null = null;
  detachedCheckpointId: string | null = null;
  restoredCheckpointId: string | null = null;
  externalRouteDesiredValue = true;
  detachFailure: Error | null = null;
  resumeFailure: Error | null = null;
  snapshots = 0;
  canaries = 0;

  trafficStatus(): DesktopRuntimeTrafficStatus | null {
    return this.gateway === null ? null : { ...this.gateway };
  }

  quiesceTraffic(): DesktopRuntimeTrafficStatus | null {
    if (this.gateway === null) return null;
    this.gateway = {
      generation: this.gateway.generation + 1,
      acceptingRequests: false,
      activeRequestCount: this.gateway.activeRequestCount,
      sessionCount: this.gateway.sessionCount,
      pendingSessionInitializations: this.gateway.pendingSessionInitializations,
    };
    return this.trafficStatus();
  }

  async waitForTrafficIdle(
    expectedGeneration: number,
    _timeoutMs: number,
  ): Promise<RuntimeGatewayDrainReport> {
    if (this.gateway === null) {
      throw new Error("Gateway is absent.");
    }
    if (this.gateway.generation !== expectedGeneration) {
      return {
        ...this.gateway,
        drained: false,
        timedOut: false,
        interrupted: true,
        waitedMs: 0,
      };
    }
    return {
      ...this.gateway,
      drained: this.gateway.activeRequestCount === 0,
      timedOut: this.gateway.activeRequestCount !== 0,
      interrupted: false,
      waitedMs: 1,
    };
  }

  resumeTraffic(expectedGeneration: number): DesktopRuntimeTrafficStatus {
    if (
      this.gateway === null ||
      this.gateway.generation !== expectedGeneration
    ) {
      throw new Error("Stale Gateway generation.");
    }
    this.gateway = {
      generation: this.gateway.generation + 1,
      acceptingRequests: true,
      activeRequestCount: this.gateway.activeRequestCount,
      sessionCount: this.gateway.sessionCount,
      pendingSessionInitializations: this.gateway.pendingSessionInitializations,
    };
    const resumed = this.gateway;
    return { ...resumed };
  }

  externalRouteDesired(): boolean {
    return this.externalRouteDesiredValue;
  }

  async detachExternalTraffic(checkpointId: string): Promise<void> {
    if (this.detachFailure !== null) throw this.detachFailure;
    this.detachedCheckpointId = checkpointId;
  }

  async resumeExternalTraffic(
    checkpointId: string,
    externalRouteDesired: boolean,
  ): Promise<void> {
    if (this.resumeFailure !== null) throw this.resumeFailure;
    this.restoredCheckpointId = checkpointId;
    this.externalRouteDesiredValue = externalRouteDesired;
  }

  async snapshot(): Promise<unknown> {
    this.snapshots += 1;
    return {
      schemaVersion: "scr.test-runtime-snapshot/v1",
      state: { phase: "running" },
      tasks: [{ id: "task-1", status: "running" }],
    };
  }

  async promote(
    checkpointId: string,
    externalRouteDesired: boolean,
  ): Promise<void> {
    this.promotedCheckpointId = checkpointId;
    this.promotedExternalRouteDesired = externalRouteDesired;
    this.externalRouteDesiredValue = externalRouteDesired;
  }

  async canary(): Promise<unknown> {
    this.canaries += 1;
    return { phase: "running", gateway: this.gateway };
  }
}

function activeGate(adapter = new FakeCutoverAdapter()): {
  readonly adapter: FakeCutoverAdapter;
  readonly gate: RuntimeCutoverGate;
} {
  return {
    adapter,
    gate: new RuntimeCutoverGate({
      instanceId: "runtime-active-1",
      releaseId: "release-1",
      role: "active",
      adapter,
      now: () => 1_000,
    }),
  };
}

describe("RuntimeCutoverGate", () => {
  it("tracks ordinary control calls, quiesces both gates, drains, checkpoints, and resumes", async () => {
    const { adapter, gate } = activeGate();
    const release = gate.admit("tasks.get");
    expect(gate.status()).toMatchObject({
      schemaVersion: DESKTOP_RUNTIME_CUTOVER_STATUS_SCHEMA_VERSION,
      role: "active",
      promoted: true,
      activeControlRequestCount: 1,
    });

    const quiesced = gate.quiesce();
    expect(quiesced).toMatchObject({
      controlQuiesced: true,
      controlGeneration: 1,
      gateway: {
        generation: 1,
        acceptingRequests: false,
      },
    });
    expect(() => gate.admit("state.get")).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: "POLICY_DENIED" }),
    );

    setTimeout(release, 5);
    const drain = await gate.drain({
      controlGeneration: 1,
      gatewayGeneration: 1,
      timeoutMs: 100,
    });
    expect(drain).toMatchObject({
      drained: true,
      timedOut: false,
      interrupted: false,
      activeControlRequestCount: 0,
      activeGatewayRequestCount: 0,
      unknownOutcomeCount: 0,
    });

    const fencingToken = createRuntimeCutoverFencingToken();
    const checkpoint = await gate.checkpoint({
      controlGeneration: 1,
      gatewayGeneration: 1,
      fencingToken,
    });
    expect(checkpoint).toMatchObject({
      instanceId: "runtime-active-1",
      releaseId: "release-1",
      controlGeneration: 1,
      gatewayGeneration: 1,
      fencingToken,
      externalRouteDesired: true,
    });
    expect(checkpoint.stateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(adapter.snapshots).toBe(1);

    const detached = await gate.detach({
      controlGeneration: 1,
      gatewayGeneration: 1,
      checkpointId: checkpoint.checkpointId,
      fencingToken,
    });
    expect(detached).toMatchObject({
      trafficDetached: true,
      externalRouteDesired: true,
    });
    expect(adapter.detachedCheckpointId).toBe(checkpoint.checkpointId);

    const resumed = await gate.resume({
      controlGeneration: 1,
      gatewayGeneration: 1,
    });
    expect(resumed).toMatchObject({
      controlQuiesced: false,
      controlGeneration: 2,
      checkpointId: null,
      gateway: {
        generation: 2,
        acceptingRequests: true,
      },
    });
    expect(adapter.restoredCheckpointId).toBe(checkpoint.checkpointId);
    expect(gate.admit("state.get")).toBeTypeOf("function");
  });

  it("binds traffic detachment to the exact checkpoint and fencing token", async () => {
    const { gate } = activeGate();
    const quiesced = gate.quiesce();
    await gate.drain({
      controlGeneration: quiesced.controlGeneration,
      gatewayGeneration: quiesced.gateway?.generation ?? null,
      timeoutMs: 100,
    });
    const fencingToken = createRuntimeCutoverFencingToken();
    const checkpoint = await gate.checkpoint({
      controlGeneration: quiesced.controlGeneration,
      gatewayGeneration: quiesced.gateway?.generation ?? null,
      fencingToken,
    });

    await expect(
      gate.detach({
        controlGeneration: quiesced.controlGeneration,
        gatewayGeneration: quiesced.gateway?.generation ?? null,
        checkpointId: checkpoint.checkpointId,
        fencingToken: createRuntimeCutoverFencingToken(),
      }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });
    await expect(
      gate.detach({
        controlGeneration: quiesced.controlGeneration,
        gatewayGeneration: quiesced.gateway?.generation ?? null,
        checkpointId: "different-checkpoint",
        fencingToken,
      }),
    ).rejects.toMatchObject({ code: "STALE_HASH" });
    expect(gate.status().trafficDetached).toBe(false);
  });

  it("re-quiesces Gateway traffic when external route restoration fails", async () => {
    const { adapter, gate } = activeGate();
    const quiesced = gate.quiesce();
    await gate.drain({
      controlGeneration: quiesced.controlGeneration,
      gatewayGeneration: quiesced.gateway?.generation ?? null,
      timeoutMs: 100,
    });
    const fencingToken = createRuntimeCutoverFencingToken();
    const checkpoint = await gate.checkpoint({
      controlGeneration: quiesced.controlGeneration,
      gatewayGeneration: quiesced.gateway?.generation ?? null,
      fencingToken,
    });
    await gate.detach({
      controlGeneration: quiesced.controlGeneration,
      gatewayGeneration: quiesced.gateway?.generation ?? null,
      checkpointId: checkpoint.checkpointId,
      fencingToken,
    });
    adapter.resumeFailure = new Error("route restore failed");

    await expect(
      gate.resume({
        controlGeneration: quiesced.controlGeneration,
        gatewayGeneration: quiesced.gateway?.generation ?? null,
      }),
    ).rejects.toThrow(/route restore failed/u);
    expect(gate.status()).toMatchObject({
      controlQuiesced: true,
      controlGeneration: quiesced.controlGeneration,
      checkpointId: checkpoint.checkpointId,
      trafficDetached: true,
      gateway: {
        generation: 3,
        acceptingRequests: false,
      },
    });
  });

  it("reports an unsafe drain while consequential work remains or has an unknown outcome", async () => {
    const { adapter, gate } = activeGate();
    const release = gate.admit("tool.invoke");
    adapter.gateway = {
      generation: 0,
      acceptingRequests: true,
      activeRequestCount: 1,
      sessionCount: 1,
      pendingSessionInitializations: 0,
    };
    const quiesced = gate.quiesce();

    const drain = await gate.drain({
      controlGeneration: quiesced.controlGeneration,
      gatewayGeneration: quiesced.gateway?.generation ?? null,
      timeoutMs: 5,
    });
    expect(drain).toMatchObject({
      drained: false,
      timedOut: true,
      activeControlRequestCount: 1,
      activeGatewayRequestCount: 1,
    });
    expect(drain.unknownOutcomeCount).toBeGreaterThan(0);
    await expect(
      gate.checkpoint({
        controlGeneration: quiesced.controlGeneration,
        gatewayGeneration: quiesced.gateway?.generation ?? null,
        fencingToken: createRuntimeCutoverFencingToken(),
      }),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    release();
  });

  it("rejects stale control and Gateway generations", async () => {
    const { gate } = activeGate();
    gate.quiesce();

    await expect(
      gate.drain({
        controlGeneration: 0,
        gatewayGeneration: 1,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "STALE_HASH" });
    await expect(
      gate.drain({
        controlGeneration: 1,
        gatewayGeneration: 0,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "STALE_HASH" });
  });

  it("keeps a candidate passive until a matching promotion fencing token is supplied", async () => {
    const adapter = new FakeCutoverAdapter();
    const token = createRuntimeCutoverFencingToken();
    const gate = new RuntimeCutoverGate({
      instanceId: "runtime-candidate-2",
      releaseId: "release-2",
      role: "candidate",
      adapter,
      promotionFencingToken: token,
      now: () => 2_000,
    });

    expect(gate.status()).toMatchObject({
      role: "candidate",
      promoted: false,
    });
    expect(gate.admit("state.get")).toBeTypeOf("function");
    expect(() => gate.admit("runtime.start")).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: "POLICY_DENIED" }),
    );
    await expect(gate.canary()).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });

    await expect(
      gate.promote({
        checkpointId: "checkpoint-1",
        fencingToken: createRuntimeCutoverFencingToken(),
        externalRouteDesired: true,
      }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });

    const promoted = await gate.promote({
      checkpointId: "checkpoint-1",
      fencingToken: token,
      externalRouteDesired: true,
    });
    expect(promoted).toMatchObject({
      role: "active",
      promoted: true,
      promotedCheckpointId: "checkpoint-1",
      externalRouteDesired: true,
    });
    expect(adapter.promotedCheckpointId).toBe("checkpoint-1");
    expect(adapter.promotedExternalRouteDesired).toBe(true);
    expect(gate.admit("runtime.start")).toBeTypeOf("function");

    const canary = await gate.canary();
    expect(canary).toMatchObject({
      instanceId: "runtime-candidate-2",
      releaseId: "release-2",
      promoted: true,
    });
    expect(canary.stateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(adapter.canaries).toBe(1);
  });

  it("requires candidate promotion tokens and bounds serialized checkpoints", async () => {
    const adapter = new FakeCutoverAdapter();
    expect(
      () =>
        new RuntimeCutoverGate({
          instanceId: "runtime-candidate-3",
          releaseId: "release-3",
          role: "candidate",
          adapter,
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    adapter.snapshot = async () => ({ text: "x".repeat(4 * 1_024 * 1_024) });
    const gate = activeGate(adapter).gate;
    const status = gate.quiesce();
    await expect(
      gate.checkpoint({
        controlGeneration: status.controlGeneration,
        gatewayGeneration: status.gateway?.generation ?? null,
        fencingToken: createRuntimeCutoverFencingToken(),
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
