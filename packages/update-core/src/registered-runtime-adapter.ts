import {
  RuntimeEndpointRegistry,
  type RuntimeEndpointRecord,
  type RuntimeEndpointResolution,
} from "./runtime-endpoint-registry.js";
import type {
  RuntimeCheckpoint,
  RuntimeCutoverAdapter,
  RuntimeCutoverContext,
  RuntimeDrainReport,
  RuntimeHostHandle,
  RuntimeReleaseCandidate,
  RuntimeTrafficSwitch,
} from "./runtime-cutover.js";

export interface RuntimeProcessLifecycleAdapter {
  startCandidate(
    candidate: RuntimeReleaseCandidate,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeEndpointRecord>;
  waitUntilHealthy(
    candidate: RuntimeEndpointRecord,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  quiesce(
    active: RuntimeEndpointRecord,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  drain(
    active: RuntimeEndpointRecord,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeDrainReport>;
  checkpoint(
    active: RuntimeEndpointRecord,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeCheckpoint>;
  runCanary(
    candidate: RuntimeEndpointRecord,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  commitCandidate(
    candidate: RuntimeEndpointRecord,
    checkpoint: RuntimeCheckpoint,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  resume(
    active: RuntimeEndpointRecord,
    context: RuntimeCutoverContext,
  ): Promise<void>;
  stop(
    host: RuntimeEndpointRecord,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
    context: RuntimeCutoverContext,
  ): Promise<void>;
}

export interface RegisteredRuntimeCutoverAdapterOptions {
  readonly registry: RuntimeEndpointRegistry;
  readonly lifecycle: RuntimeProcessLifecycleAdapter;
}

function assertHandleMatchesRecord(
  handle: RuntimeHostHandle,
  record: RuntimeEndpointRecord,
): void {
  if (
    handle.instanceId !== record.instanceId ||
    handle.releaseId !== record.releaseId
  ) {
    throw new Error(
      `Runtime Host handle ${handle.instanceId}/${handle.releaseId} does not match its registered endpoint.`,
    );
  }
}

function checkpointFence(checkpoint: RuntimeCheckpoint): {
  readonly checkpointId: string;
  readonly fencingToken: string;
} {
  return {
    checkpointId: checkpoint.checkpointId,
    fencingToken: checkpoint.fencingToken,
  };
}

/**
 * Concrete RuntimeCutoverAdapter that makes the endpoint registry the sole
 * traffic-routing authority. Lifecycle hooks own process and protocol work;
 * this adapter binds every switch to an immutable endpoint record and a
 * compare-and-swap pointer generation.
 */
export class RegisteredRuntimeCutoverAdapter implements RuntimeCutoverAdapter {
  readonly #registry: RuntimeEndpointRegistry;
  readonly #lifecycle: RuntimeProcessLifecycleAdapter;

  constructor(options: RegisteredRuntimeCutoverAdapterOptions) {
    if (!(options.registry instanceof RuntimeEndpointRegistry)) {
      throw new Error("Runtime endpoint registry is required.");
    }
    if (typeof options.lifecycle !== "object" || options.lifecycle === null) {
      throw new Error("Runtime process lifecycle adapter is required.");
    }
    this.#registry = options.registry;
    this.#lifecycle = options.lifecycle;
  }

  async bootstrapActive(
    endpoint: RuntimeEndpointRecord,
    checkpoint: RuntimeCheckpoint,
  ): Promise<RuntimeEndpointResolution> {
    await this.#registry.register(endpoint);
    const current = await this.#registry.resolveActive();
    if (current !== null) {
      if (current.endpoint.instanceId !== endpoint.instanceId) {
        throw new Error(
          `Runtime endpoint registry is already active on ${current.endpoint.instanceId}.`,
        );
      }
      if (current.endpoint.releaseId !== endpoint.releaseId) {
        throw new Error("Active Runtime endpoint release identity changed.");
      }
      return current;
    }
    await this.#registry.activate(endpoint.instanceId, {
      ...checkpointFence(checkpoint),
      expectedGeneration: null,
      expectedActiveInstanceId: null,
    });
    const active = await this.#registry.resolveActive();
    if (active === null) {
      throw new Error(
        "Runtime endpoint registry did not publish the bootstrap endpoint.",
      );
    }
    return active;
  }

  async startCandidate(
    candidate: RuntimeReleaseCandidate,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeHostHandle> {
    const endpoint = await this.#lifecycle.startCandidate(candidate, context);
    if (endpoint.releaseId !== candidate.releaseId) {
      throw new Error(
        "Candidate Runtime process reported the wrong release ID.",
      );
    }
    if (endpoint.manifestSha256 !== candidate.manifestSha256) {
      throw new Error(
        "Candidate Runtime process reported the wrong manifest digest.",
      );
    }
    await this.#registry.register(endpoint);
    return { instanceId: endpoint.instanceId, releaseId: endpoint.releaseId };
  }

  async waitUntilHealthy(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#lifecycle.waitUntilHealthy(
      await this.#endpoint(candidate),
      context,
    );
  }

  async quiesce(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#requireActive(active);
    await this.#lifecycle.quiesce(await this.#endpoint(active), context);
  }

  async drain(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeDrainReport> {
    await this.#requireActive(active);
    return await this.#lifecycle.drain(await this.#endpoint(active), context);
  }

  async checkpoint(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<RuntimeCheckpoint> {
    await this.#requireActive(active);
    return await this.#lifecycle.checkpoint(
      await this.#endpoint(active),
      context,
    );
  }

  async switchTraffic(
    change: RuntimeTrafficSwitch,
    _context: RuntimeCutoverContext,
  ): Promise<void> {
    const current = await this.#registry.resolveActive();
    if (current === null) {
      throw new Error("Runtime endpoint registry has no active endpoint.");
    }
    assertHandleMatchesRecord(change.from, current.endpoint);

    if (change.rollback) {
      const pointer = await this.#registry.rollback({
        ...checkpointFence(change.checkpoint),
        expectedGeneration: current.pointer.generation,
      });
      if (pointer.active.instanceId !== change.to.instanceId) {
        throw new Error(
          "Runtime endpoint rollback selected the wrong instance.",
        );
      }
      await this.#requireActive(change.to);
      return;
    }

    const target = await this.#endpoint(change.to);
    const pointer = await this.#registry.activate(target.instanceId, {
      ...checkpointFence(change.checkpoint),
      expectedGeneration: current.pointer.generation,
      expectedActiveInstanceId: change.from.instanceId,
    });
    if (pointer.active.instanceId !== target.instanceId) {
      throw new Error(
        "Runtime endpoint activation selected the wrong instance.",
      );
    }
  }

  async runCanary(
    candidate: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#requireActive(candidate);
    await this.#lifecycle.runCanary(await this.#endpoint(candidate), context);
  }

  async commitCandidate(
    candidate: RuntimeHostHandle,
    checkpoint: RuntimeCheckpoint,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#requireActive(candidate);
    const active = await this.#registry.resolveActive();
    if (
      active === null ||
      active.pointer.checkpointId !== checkpoint.checkpointId ||
      active.pointer.fencingToken !== checkpoint.fencingToken
    ) {
      throw new Error(
        "Runtime endpoint pointer is not fenced by the candidate checkpoint.",
      );
    }
    await this.#lifecycle.commitCandidate(
      await this.#endpoint(candidate),
      checkpoint,
      context,
    );
  }

  async resume(
    active: RuntimeHostHandle,
    context: RuntimeCutoverContext,
  ): Promise<void> {
    await this.#requireActive(active);
    await this.#lifecycle.resume(await this.#endpoint(active), context);
  }

  async stop(
    host: RuntimeHostHandle,
    reason: "candidate-rejected" | "cutover-rolled-back" | "cutover-committed",
    context: RuntimeCutoverContext,
  ): Promise<void> {
    const endpoint = await this.#endpoint(host);
    await this.#lifecycle.stop(endpoint, reason, context);
    if (reason !== "cutover-committed") {
      const active = await this.#registry.resolveActive();
      const protectedInstanceIds = new Set([
        active?.pointer.active.instanceId,
        active?.pointer.previous?.instanceId,
      ]);
      if (!protectedInstanceIds.has(host.instanceId)) {
        await this.#registry.remove(host.instanceId);
      }
    }
  }

  async #endpoint(handle: RuntimeHostHandle): Promise<RuntimeEndpointRecord> {
    const endpoint = await this.#registry.readInstance(handle.instanceId);
    assertHandleMatchesRecord(handle, endpoint);
    return endpoint;
  }

  async #requireActive(handle: RuntimeHostHandle): Promise<void> {
    const active = await this.#registry.resolveActive();
    if (active === null) {
      throw new Error("Runtime endpoint registry has no active endpoint.");
    }
    assertHandleMatchesRecord(handle, active.endpoint);
  }
}
