import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManagedRuntimeSessionRegistry,
  createRuntimeSupervisorState,
  parseRuntimeSupervisorState,
  reduceRuntimeSupervisorState,
  RuntimeSupervisorCoordinator,
  RuntimeSupervisorStore,
  type PublishedRuntimeObservation,
  type RuntimeCanaryResult,
  type RuntimeObservation,
  type RuntimeSlotIdentity,
  type RuntimeSupervisorActionPort,
  type RuntimeSupervisorState,
} from "../src/index.js";

const cleanupPaths: string[] = [];

function runtime(
  options: Partial<RuntimeSlotIdentity> & {
    readonly releaseId: string;
    readonly releaseSequence: number;
    readonly runtimeGeneration: number;
    readonly processId: number;
    readonly port: number;
  },
): RuntimeSlotIdentity {
  return {
    releaseId: options.releaseId,
    releaseSequence: options.releaseSequence,
    version: options.version ?? `1.${options.releaseSequence}.0`,
    instanceId: options.instanceId ?? `${options.releaseId}-instance`,
    runtimeGeneration: options.runtimeGeneration,
    endpoint: options.endpoint ?? `http://127.0.0.1:${options.port}/mcp`,
    manifestDigest:
      options.manifestDigest ?? String(options.releaseSequence % 10).repeat(64),
    processId: options.processId,
    startedAt: options.startedAt ?? "2026-08-23T00:00:00.000Z",
  };
}

const active = runtime({
  releaseId: "release-10",
  releaseSequence: 10,
  runtimeGeneration: 40,
  processId: 100,
  port: 41000,
});
const candidate = runtime({
  releaseId: "release-11",
  releaseSequence: 11,
  runtimeGeneration: 41,
  processId: 200,
  port: 42000,
});

function observation(
  target: RuntimeSlotIdentity,
  healthy = true,
): RuntimeObservation {
  return {
    runtime: target,
    alive: true,
    healthy,
  };
}

function publication(
  target: RuntimeSlotIdentity,
  revision = 7,
): PublishedRuntimeObservation {
  return {
    revision,
    runtimeGeneration: target.runtimeGeneration,
    instanceId: target.instanceId,
    endpoint: target.endpoint,
    manifestDigest: target.manifestDigest,
  };
}

function publishingState(): RuntimeSupervisorState {
  let state = createRuntimeSupervisorState(active, "2026-08-23T00:00:00.000Z");
  state = reduceRuntimeSupervisorState(state, {
    type: "stage-candidate",
    at: "2026-08-23T00:01:00.000Z",
    transitionId: "transition-0001",
    candidate,
  });
  state = reduceRuntimeSupervisorState(state, {
    type: "candidate-ready",
    at: "2026-08-23T00:02:00.000Z",
    expectedEpoch: state.epoch,
    transitionId: "transition-0001",
  });
  state = reduceRuntimeSupervisorState(state, {
    type: "begin-quiesce",
    at: "2026-08-23T00:03:00.000Z",
    expectedEpoch: state.epoch,
    transitionId: "transition-0001",
  });
  return reduceRuntimeSupervisorState(state, {
    type: "begin-publish",
    at: "2026-08-23T00:04:00.000Z",
    expectedEpoch: state.epoch,
    transitionId: "transition-0001",
  });
}

function stableCandidateState(): RuntimeSupervisorState {
  let state = publishingState();
  state = reduceRuntimeSupervisorState(state, {
    type: "candidate-published",
    at: "2026-08-23T00:05:00.000Z",
    expectedEpoch: state.epoch,
    transitionId: "transition-0001",
    managedSessionRevision: 5,
    externalRefreshRequired: true,
  });
  return reduceRuntimeSupervisorState(state, {
    type: "commit-candidate",
    at: "2026-08-23T00:06:00.000Z",
    expectedEpoch: state.epoch,
    transitionId: "transition-0001",
    reportId: "cutover-report-0001",
  });
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

async function storeFor(
  state: RuntimeSupervisorState,
): Promise<RuntimeSupervisorStore> {
  const root = await mkdtemp(
    join(tmpdir(), "scr-runtime-supervisor-executor-"),
  );
  cleanupPaths.push(root);
  const store = new RuntimeSupervisorStore({ directoryPath: root });
  await store.initialize(state);
  return store;
}

function actionPort(input: {
  readonly observations: readonly RuntimeObservation[];
  readonly initialPublication: PublishedRuntimeObservation;
  readonly events?: string[];
  readonly resumeResult?: RuntimeSlotIdentity;
  readonly resumeError?: Error;
  readonly publishError?: Error;
  readonly stopError?: Error;
  readonly canary?: RuntimeCanaryResult;
  readonly canaryError?: Error;
  readonly onObserve?: () => Promise<void> | void;
  readonly onReadPublication?: () => Promise<void> | void;
}): RuntimeSupervisorActionPort & {
  readonly resumeRuntime: ReturnType<typeof vi.fn>;
  readonly publishRuntime: ReturnType<typeof vi.fn>;
  readonly stopRuntime: ReturnType<typeof vi.fn>;
  readonly continueCanary: ReturnType<typeof vi.fn>;
  readonly observeRuntimes: ReturnType<typeof vi.fn>;
  readonly readPublication: ReturnType<typeof vi.fn>;
} {
  let currentPublication = input.initialPublication;
  const events = input.events ?? [];
  return {
    observeRuntimes: vi.fn(async () => {
      await input.onObserve?.();
      return input.observations;
    }),
    readPublication: vi.fn(async () => {
      await input.onReadPublication?.();
      return currentPublication;
    }),
    resumeRuntime: vi.fn(async (request) => {
      events.push("resume");
      if (input.resumeError !== undefined) throw input.resumeError;
      const source =
        input.observations.find(
          (item) => item.runtime.instanceId === request.instanceId,
        )?.runtime ?? active;
      return (
        input.resumeResult ?? {
          ...source,
          runtimeGeneration: request.nextGeneration,
        }
      );
    }),
    publishRuntime: vi.fn(async (request) => {
      events.push("publish");
      if (input.publishError !== undefined) throw input.publishError;
      currentPublication = {
        revision: request.expectedPublicationRevision + 1,
        runtimeGeneration: request.runtime.runtimeGeneration,
        instanceId: request.runtime.instanceId,
        endpoint: request.runtime.endpoint,
        manifestDigest: request.runtime.manifestDigest,
      };
      return currentPublication;
    }),
    stopRuntime: vi.fn(async () => {
      events.push("stop");
      if (input.stopError !== undefined) throw input.stopError;
    }),
    continueCanary: vi.fn(async () => {
      events.push("canary");
      if (input.canaryError !== undefined) throw input.canaryError;
      return (
        input.canary ?? {
          healthy: true,
          failureCode: null,
          failureDigest: null,
        }
      );
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  );
});

describe("RuntimeSupervisorCoordinator", () => {
  it("persists a healthy stable hold without executing side effects", async () => {
    const state = createRuntimeSupervisorState(
      active,
      "2026-08-23T00:00:00.000Z",
    );
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry();
    const actions = actionPort({
      observations: [observation(active)],
      initialPublication: publication(active),
    });
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
    });

    const result = await coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "a".repeat(64),
    });

    expect(result.report).toMatchObject({
      schemaVersion: "scr.runtime-supervisor-execution/v1",
      outcome: "held",
      planOutcome: "held",
      sourceRevision: 1,
      committedRevision: 2,
      actionExecutions: [
        expect.objectContaining({
          index: 0,
          kind: "hold",
          outcome: "succeeded",
        }),
      ],
      errorCode: null,
      errorDigest: null,
    });
    expect(result.snapshot).toMatchObject({
      revision: 2,
      state: {
        phase: "stable",
        active,
        updatedAt: "2026-08-23T01:00:00.000Z",
      },
    });
    expect(actions.resumeRuntime).not.toHaveBeenCalled();
    expect(actions.publishRuntime).not.toHaveBeenCalled();
    expect(actions.stopRuntime).not.toHaveBeenCalled();
    expect(actions.continueCanary).not.toHaveBeenCalled();
  });

  it("executes a stable rollback in fenced order and persists session metadata", async () => {
    const state = stableCandidateState();
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry({
      initialRevision: state.managedSessionRevision,
    });
    const events: string[] = [];
    sessions.registerManaged({
      sessionId: "managed-rollback-0001",
      target: {
        runtimeGeneration: candidate.runtimeGeneration,
        endpoint: candidate.endpoint,
        manifestDigest: candidate.manifestDigest,
        connectionRevision: 9,
      },
      adapter: {
        rebind: vi.fn(async () => {
          events.push("rebind");
        }),
      },
    });
    sessions.registerExternal({
      sessionId: "external-rollback-0001",
      target: {
        runtimeGeneration: candidate.runtimeGeneration,
        endpoint: candidate.endpoint,
        manifestDigest: candidate.manifestDigest,
        connectionRevision: 9,
      },
    });
    const actions = actionPort({
      observations: [observation(candidate, false), observation(active)],
      initialPublication: publication(candidate, 9),
      events,
    });
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
    });

    const result = await coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "b".repeat(64),
    });

    expect(result.report).toMatchObject({
      outcome: "applied",
      planOutcome: "rolled-back",
      committedRevision: 2,
      managedSessionReport: {
        outcome: "rebound",
        registryRevision: 8,
        reboundManagedSessions: 1,
        externalSessions: 1,
        externalRefreshRequired: true,
      },
      errorCode: null,
    });
    expect(events).toEqual(["resume", "publish", "rebind", "stop"]);
    expect(actions.resumeRuntime).toHaveBeenCalledWith(
      {
        instanceId: active.instanceId,
        expectedGeneration: 40,
        nextGeneration: 42,
      },
      expect.any(AbortSignal),
    );
    expect(actions.publishRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: expect.objectContaining({
          releaseId: active.releaseId,
          runtimeGeneration: 42,
        }),
        expectedPublicationRevision: 9,
        expectedPublicationGeneration: 41,
      }),
      expect.any(AbortSignal),
    );
    expect(result.snapshot?.state).toMatchObject({
      phase: "stable",
      active: {
        releaseId: active.releaseId,
        runtimeGeneration: 42,
      },
      previous: null,
      managedSessionRevision: 8,
      externalRefreshRequired: true,
    });
  });

  it("continues an already-published candidate through managed rebind and canary", async () => {
    const state = publishingState();
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry();
    const events: string[] = [];
    sessions.registerManaged({
      sessionId: "managed-candidate-0001",
      target: {
        runtimeGeneration: active.runtimeGeneration,
        endpoint: active.endpoint,
        manifestDigest: active.manifestDigest,
        connectionRevision: 7,
      },
      adapter: {
        rebind: vi.fn(async () => {
          events.push("rebind");
        }),
      },
    });
    sessions.registerExternal({
      sessionId: "external-candidate-0001",
      target: {
        runtimeGeneration: active.runtimeGeneration,
        endpoint: active.endpoint,
        manifestDigest: active.manifestDigest,
        connectionRevision: 7,
      },
    });
    const actions = actionPort({
      observations: [observation(active), observation(candidate)],
      initialPublication: publication(candidate, 8),
      events,
    });
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
    });

    const result = await coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "c".repeat(64),
    });

    expect(events).toEqual(["rebind", "canary"]);
    expect(result.report).toMatchObject({
      outcome: "applied",
      planOutcome: "continued-candidate",
      committedRevision: 2,
      managedSessionReport: {
        outcome: "rebound",
        registryRevision: 4,
        externalRefreshRequired: true,
      },
    });
    expect(result.snapshot?.state).toMatchObject({
      phase: "candidate-active",
      active: candidate,
      previous: active,
      candidate: null,
      managedSessionRevision: 4,
      externalRefreshRequired: true,
    });
    expect(actions.resumeRuntime).not.toHaveBeenCalled();
    expect(actions.publishRuntime).not.toHaveBeenCalled();
    expect(actions.stopRuntime).not.toHaveBeenCalled();
    expect(actions.continueCanary).toHaveBeenCalledWith(
      {
        instanceId: candidate.instanceId,
        runtimeGeneration: candidate.runtimeGeneration,
      },
      expect.any(AbortSignal),
    );
  });

  it("does not commit when managed session rebinding fails", async () => {
    const sensitive = "adapter failed with secret local connection detail";
    const state = publishingState();
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry();
    sessions.registerManaged({
      sessionId: "managed-failing-0001",
      target: {
        runtimeGeneration: active.runtimeGeneration,
        endpoint: active.endpoint,
        manifestDigest: active.manifestDigest,
        connectionRevision: 7,
      },
      adapter: {
        rebind: vi.fn(async () => {
          throw new Error(sensitive);
        }),
      },
    });
    const actions = actionPort({
      observations: [observation(active), observation(candidate)],
      initialPublication: publication(candidate, 8),
    });
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
    });

    const result = await coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "d".repeat(64),
    });

    expect(result.snapshot).toBeNull();
    expect(result.report).toMatchObject({
      outcome: "failed",
      planOutcome: "continued-candidate",
      committedRevision: null,
      actionExecutions: [
        expect.objectContaining({
          kind: "rebind-managed-sessions",
          outcome: "failed",
          failureCode: "ACTION_FAILED",
          failureDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
      managedSessionReport: {
        outcome: "failed",
        failedManagedSessions: 1,
      },
      errorCode: "ACTION_FAILED",
      errorDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(result.report)).not.toContain(sensitive);
    expect(actions.continueCanary).not.toHaveBeenCalled();
    expect((await store.load()).revision).toBe(1);
  });

  it("reports a CAS conflict when another supervisor wins the ledger revision", async () => {
    const state = createRuntimeSupervisorState(
      active,
      "2026-08-23T00:00:00.000Z",
    );
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry();
    const actions = actionPort({
      observations: [observation(active)],
      initialPublication: publication(active),
      onReadPublication: async () => {
        const current = await store.load();
        const concurrent = parseRuntimeSupervisorState({
          ...current.state,
          updatedAt: "2026-08-23T00:30:00.000Z",
        });
        await store.append(concurrent, {
          revision: current.revision,
          entrySha256: current.entrySha256,
        });
      },
    });
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
    });

    const result = await coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "e".repeat(64),
    });

    expect(result.snapshot).toBeNull();
    expect(result.report).toMatchObject({
      outcome: "conflict",
      planOutcome: "held",
      sourceRevision: 1,
      committedRevision: null,
      errorCode: "STATE_CONFLICT",
      errorDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect((await store.load()).revision).toBe(2);
  });

  it("rejects concurrent recovery execution", async () => {
    const state = createRuntimeSupervisorState(
      active,
      "2026-08-23T00:00:00.000Z",
    );
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry();
    const started = deferred<void>();
    const release = deferred<void>();
    const actions = actionPort({
      observations: [observation(active)],
      initialPublication: publication(active),
      onObserve: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
    });
    const first = coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "f".repeat(64),
    });
    await started.promise;

    await expect(
      coordinator.recover({
        at: "2026-08-23T01:00:01.000Z",
        failureDigest: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_BUSY" });
    expect((await coordinator.status()).executionActive).toBe(true);

    release.resolve();
    await expect(first).resolves.toMatchObject({
      report: { outcome: "held" },
    });
    expect((await coordinator.status()).executionActive).toBe(false);
  });

  it("fails before observation when the ephemeral session registry revision regresses", async () => {
    const state = stableCandidateState();
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry({ initialRevision: 1 });
    const actions = actionPort({
      observations: [observation(candidate)],
      initialPublication: publication(candidate),
    });
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
    });

    const result = await coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "1".repeat(64),
    });

    expect(result).toMatchObject({
      snapshot: null,
      report: {
        outcome: "failed",
        planOutcome: null,
        errorCode: "PLAN_INVALID",
        actionExecutions: [],
      },
    });
    expect(actions.observeRuntimes).not.toHaveBeenCalled();
    expect(actions.readPublication).not.toHaveBeenCalled();
  });

  it("rejects a resume result that does not match the planned identity", async () => {
    const state = stableCandidateState();
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry({
      initialRevision: state.managedSessionRevision,
    });
    const actions = actionPort({
      observations: [observation(candidate, false), observation(active)],
      initialPublication: publication(candidate, 9),
      resumeResult: {
        ...active,
        runtimeGeneration: 43,
      },
    });
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
    });

    const result = await coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "2".repeat(64),
    });

    expect(result.snapshot).toBeNull();
    expect(result.report).toMatchObject({
      outcome: "failed",
      actionExecutions: [
        expect.objectContaining({
          kind: "resume-runtime",
          outcome: "failed",
          failureCode: "ACTION_RESULT_INVALID",
        }),
      ],
      errorCode: "ACTION_RESULT_INVALID",
    });
    expect(actions.publishRuntime).not.toHaveBeenCalled();
    expect((await store.load()).revision).toBe(1);
  });

  it("times out a non-cooperative recovery action without committing state", async () => {
    const state = publishingState();
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry();
    const canary = deferred<RuntimeCanaryResult>();
    const actions = actionPort({
      observations: [observation(active), observation(candidate)],
      initialPublication: publication(candidate, 8),
    });
    actions.continueCanary.mockImplementationOnce(
      async () => await canary.promise,
    );
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
      rebindTimeoutMs: 100,
      actionTimeoutMs: 100,
      discoveryTimeoutMs: 100,
    });

    const result = await coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "3".repeat(64),
    });

    expect(result.snapshot).toBeNull();
    expect(result.report).toMatchObject({
      outcome: "failed",
      planOutcome: "continued-candidate",
      actionExecutions: [
        expect.objectContaining({
          kind: "rebind-managed-sessions",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          kind: "continue-canary",
          outcome: "failed",
          failureCode: "ACTION_TIMEOUT",
          failureDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
      errorCode: "ACTION_TIMEOUT",
      errorDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect((await coordinator.status()).executionActive).toBe(false);
    expect((await store.load()).revision).toBe(1);
    canary.resolve({
      healthy: true,
      failureCode: null,
      failureDigest: null,
    });
  });

  it("bounds non-cooperative Runtime observation before planning", async () => {
    const state = createRuntimeSupervisorState(
      active,
      "2026-08-23T00:00:00.000Z",
    );
    const store = await storeFor(state);
    const sessions = new ManagedRuntimeSessionRegistry();
    const observationGate = deferred<void>();
    const actions = actionPort({
      observations: [observation(active)],
      initialPublication: publication(active),
      onObserve: async () => await observationGate.promise,
    });
    const coordinator = new RuntimeSupervisorCoordinator({
      store,
      sessions,
      actions,
      rebindTimeoutMs: 100,
      actionTimeoutMs: 100,
      discoveryTimeoutMs: 100,
    });

    const result = await coordinator.recover({
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "4".repeat(64),
    });

    expect(result).toMatchObject({
      snapshot: null,
      report: {
        outcome: "failed",
        planOutcome: null,
        committedRevision: null,
        actionExecutions: [],
        errorCode: "ACTION_TIMEOUT",
        errorDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect((await coordinator.status()).executionActive).toBe(false);
    expect((await store.load()).revision).toBe(1);
    observationGate.resolve();
  });

  it("validates coordinator timeout relationships", async () => {
    const store = await storeFor(
      createRuntimeSupervisorState(active, "2026-08-23T00:00:00.000Z"),
    );
    const actions = actionPort({
      observations: [observation(active)],
      initialPublication: publication(active),
    });
    expect(
      () =>
        new RuntimeSupervisorCoordinator({
          store,
          sessions: new ManagedRuntimeSessionRegistry(),
          actions,
          rebindTimeoutMs: 2_000,
          actionTimeoutMs: 1_000,
        }),
    ).toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    expect(
      () =>
        new RuntimeSupervisorCoordinator({
          store,
          sessions: new ManagedRuntimeSessionRegistry(),
          actions,
          discoveryTimeoutMs: 10,
        }),
    ).toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
  });
});
