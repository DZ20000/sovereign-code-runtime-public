import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RegisteredRuntimeCutoverAdapter,
  type RuntimeProcessLifecycleAdapter,
} from "../src/registered-runtime-adapter.js";
import {
  RUNTIME_ENDPOINT_SCHEMA_VERSION,
  RuntimeEndpointRegistry,
  type RuntimeEndpointRecord,
} from "../src/runtime-endpoint-registry.js";
import {
  RuntimeCutoverCoordinator,
  type RuntimeCheckpoint,
  type RuntimeCutoverContext,
  type RuntimeDrainReport,
  type RuntimeHostHandle,
  type RuntimeReleaseCandidate,
} from "../src/runtime-cutover.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scr-registered-runtime-"));
  roots.push(root);
  return {
    root,
    registry: new RuntimeEndpointRegistry({ rootDirectory: root }),
  };
}

function endpoint(
  instanceId: string,
  releaseId: string,
  marker: string,
): RuntimeEndpointRecord {
  return {
    schemaVersion: RUNTIME_ENDPOINT_SCHEMA_VERSION,
    instanceId,
    releaseId,
    endpointId: `pipe-${instanceId}`,
    processId: instanceId === "active-1" ? 1001 : 1002,
    protocolVersion: 1,
    manifestSha256: marker.repeat(64),
    startedAt: 10,
  };
}

const activeEndpoint = endpoint("active-1", "release-1", "a");
const candidateRelease: RuntimeReleaseCandidate = {
  releaseId: "release-2",
  directory: "candidate/release-2",
  manifestSha256: "b".repeat(64),
};
const bootstrapCheckpoint: RuntimeCheckpoint = {
  checkpointId: "checkpoint-bootstrap",
  fencingToken: "fence-bootstrap",
};

class FakeLifecycle implements RuntimeProcessLifecycleAdapter {
  readonly order: string[] = [];
  candidate = endpoint("candidate-2", "release-2", "b");
  failAt: string | null = null;

  #fail(name: string): void {
    if (this.failAt === name) throw new Error(`${name} failed`);
  }

  async startCandidate(
    _candidate: RuntimeReleaseCandidate,
    _context: RuntimeCutoverContext,
  ): Promise<RuntimeEndpointRecord> {
    this.order.push("start");
    this.#fail("start");
    return this.candidate;
  }

  async waitUntilHealthy(endpoint: RuntimeEndpointRecord): Promise<void> {
    this.order.push(`health:${endpoint.instanceId}`);
    this.#fail("health");
  }

  async quiesce(endpoint: RuntimeEndpointRecord): Promise<void> {
    this.order.push(`quiesce:${endpoint.instanceId}`);
    this.#fail("quiesce");
  }

  async drain(endpoint: RuntimeEndpointRecord): Promise<RuntimeDrainReport> {
    this.order.push(`drain:${endpoint.instanceId}`);
    this.#fail("drain");
    return { inFlight: 0, cancelled: 0, unknown: 0 };
  }

  async checkpoint(
    endpoint: RuntimeEndpointRecord,
  ): Promise<RuntimeCheckpoint> {
    this.order.push(`checkpoint:${endpoint.instanceId}`);
    this.#fail("checkpoint");
    return { checkpointId: "checkpoint-1", fencingToken: "fence-1" };
  }

  async runCanary(endpoint: RuntimeEndpointRecord): Promise<void> {
    this.order.push(`canary:${endpoint.instanceId}`);
    this.#fail("canary");
  }

  async commitCandidate(
    endpoint: RuntimeEndpointRecord,
    checkpoint: RuntimeCheckpoint,
  ): Promise<void> {
    this.order.push(`commit:${endpoint.instanceId}:${checkpoint.fencingToken}`);
    this.#fail("commit");
  }

  async resume(endpoint: RuntimeEndpointRecord): Promise<void> {
    this.order.push(`resume:${endpoint.instanceId}`);
    this.#fail("resume");
  }

  async stop(
    endpoint: RuntimeEndpointRecord,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
  ): Promise<void> {
    this.order.push(`stop:${endpoint.instanceId}:${reason}`);
    this.#fail("stop");
  }
}

async function configuredAdapter(lifecycle = new FakeLifecycle()) {
  const { root, registry } = await fixture();
  const adapter = new RegisteredRuntimeCutoverAdapter({ registry, lifecycle });
  await adapter.bootstrapActive(activeEndpoint, bootstrapCheckpoint);
  return { root, registry, lifecycle, adapter };
}

describe("RegisteredRuntimeCutoverAdapter", () => {
  it("binds a full rolling cutover to the authoritative endpoint pointer", async () => {
    const { registry, lifecycle, adapter } = await configuredAdapter();
    const receipt = await new RuntimeCutoverCoordinator({ adapter }).cutover({
      cutoverId: "registered-cutover-1",
      active: { instanceId: "active-1", releaseId: "release-1" },
      candidate: candidateRelease,
    });

    expect(receipt.outcome).toBe("committed");
    await expect(registry.resolveActive()).resolves.toMatchObject({
      pointer: {
        generation: 2,
        active: { instanceId: "candidate-2" },
        previous: { instanceId: "active-1" },
        checkpointId: "checkpoint-1",
        fencingToken: "fence-1",
      },
      endpoint: { releaseId: "release-2", endpointId: "pipe-candidate-2" },
    });
    expect(lifecycle.order).toEqual([
      "start",
      "health:candidate-2",
      "quiesce:active-1",
      "drain:active-1",
      "checkpoint:active-1",
      "canary:candidate-2",
      "commit:candidate-2:fence-1",
      "stop:active-1:cutover-committed",
    ]);
  });

  it("rolls the registry pointer back before resuming the previous host", async () => {
    const lifecycle = new FakeLifecycle();
    lifecycle.failAt = "canary";
    const { registry, adapter } = await configuredAdapter(lifecycle);
    const receipt = await new RuntimeCutoverCoordinator({ adapter }).cutover({
      cutoverId: "registered-cutover-rollback",
      active: { instanceId: "active-1", releaseId: "release-1" },
      candidate: candidateRelease,
    });

    expect(receipt.outcome).toBe("rolled-back");
    await expect(registry.resolveActive()).resolves.toMatchObject({
      pointer: {
        generation: 3,
        active: { instanceId: "active-1" },
        previous: { instanceId: "candidate-2" },
      },
    });
    expect(lifecycle.order.slice(-3)).toEqual([
      "canary:candidate-2",
      "resume:active-1",
      "stop:candidate-2:cutover-rolled-back",
    ]);
  });

  it("rejects a candidate that lies about its release identity or manifest", async () => {
    const wrongRelease = new FakeLifecycle();
    wrongRelease.candidate = endpoint("candidate-2", "release-wrong", "b");
    const first = await configuredAdapter(wrongRelease);
    const firstReceipt = await new RuntimeCutoverCoordinator({
      adapter: first.adapter,
    }).cutover({
      cutoverId: "registered-cutover-wrong-release",
      active: { instanceId: "active-1", releaseId: "release-1" },
      candidate: candidateRelease,
    });
    expect(firstReceipt.outcome).toBe("rolled-back");
    expect(firstReceipt.failureReason).toMatch(/wrong release ID/u);

    const wrongManifest = new FakeLifecycle();
    wrongManifest.candidate = endpoint("candidate-2", "release-2", "c");
    const second = await configuredAdapter(wrongManifest);
    const secondReceipt = await new RuntimeCutoverCoordinator({
      adapter: second.adapter,
    }).cutover({
      cutoverId: "registered-cutover-wrong-manifest",
      active: { instanceId: "active-1", releaseId: "release-1" },
      candidate: candidateRelease,
    });
    expect(secondReceipt.outcome).toBe("rolled-back");
    expect(secondReceipt.failureReason).toMatch(/wrong manifest digest/u);
  });

  it("rejects stale or mismatched active handles before quiescence", async () => {
    const { adapter } = await configuredAdapter();
    const context: RuntimeCutoverContext = {
      cutoverId: "manual-context",
      phase: "quiesce-active",
      startedAt: 1,
      deadlineAt: 2,
      signal: new AbortController().signal,
    };

    await expect(
      adapter.quiesce(
        { instanceId: "candidate-2", releaseId: "release-2" },
        context,
      ),
    ).rejects.toThrow(/active|ENOENT|does not match/u);
    await expect(
      adapter.quiesce(
        { instanceId: "active-1", releaseId: "release-wrong" },
        context,
      ),
    ).rejects.toThrow(/does not match/u);
  });

  it("is idempotent when bootstrapping the same active endpoint", async () => {
    const { registry } = await fixture();
    const lifecycle = new FakeLifecycle();
    const adapter = new RegisteredRuntimeCutoverAdapter({
      registry,
      lifecycle,
    });
    const first = await adapter.bootstrapActive(
      activeEndpoint,
      bootstrapCheckpoint,
    );
    const second = await adapter.bootstrapActive(
      activeEndpoint,
      bootstrapCheckpoint,
    );
    expect(second.pointer).toEqual(first.pointer);

    await expect(
      adapter.bootstrapActive(
        endpoint("other-active", "release-other", "c"),
        bootstrapCheckpoint,
      ),
    ).rejects.toThrow(/already active/u);
  });

  it("requires the active endpoint pointer to carry the checkpoint fence at commit", async () => {
    const { registry, adapter } = await configuredAdapter();
    const context: RuntimeCutoverContext = {
      cutoverId: "manual-context",
      phase: "commit-candidate",
      startedAt: 1,
      deadlineAt: 2,
      signal: new AbortController().signal,
    };
    await registry.register(endpoint("candidate-2", "release-2", "b"));
    await registry.activate("candidate-2", {
      checkpointId: "checkpoint-real",
      fencingToken: "fence-real",
      expectedGeneration: 1,
      expectedActiveInstanceId: "active-1",
    });

    await expect(
      adapter.commitCandidate(
        { instanceId: "candidate-2", releaseId: "release-2" },
        { checkpointId: "checkpoint-wrong", fencingToken: "fence-wrong" },
        context,
      ),
    ).rejects.toThrow(/not fenced/u);
  });

  it("does not remove endpoints retained as active or rollback references", async () => {
    const { registry, adapter } = await configuredAdapter();
    const context: RuntimeCutoverContext = {
      cutoverId: "manual-context",
      phase: "stop-candidate",
      startedAt: 1,
      deadlineAt: 2,
      signal: new AbortController().signal,
    };
    await registry.register(endpoint("candidate-2", "release-2", "b"));
    await registry.activate("candidate-2", {
      checkpointId: "checkpoint-1",
      fencingToken: "fence-1",
      expectedGeneration: 1,
    });
    await registry.rollback({
      checkpointId: "checkpoint-rollback",
      fencingToken: "fence-rollback",
      expectedGeneration: 2,
    });

    await expect(
      adapter.stop(
        { instanceId: "candidate-2", releaseId: "release-2" },
        "cutover-rolled-back",
        context,
      ),
    ).resolves.toBeUndefined();
    await expect(registry.readInstance("candidate-2")).resolves.toBeDefined();
  });
});
