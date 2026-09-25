import { describe, expect, it } from "vitest";

import {
  createRuntimeSupervisorState,
  parseRuntimeSupervisorState,
  planRuntimeSupervisorRecovery,
  reduceRuntimeSupervisorState,
  type PublishedRuntimeObservation,
  type RuntimeObservation,
  type RuntimeSlotIdentity,
  type RuntimeSupervisorState,
} from "../src/runtime-supervisor-state.js";

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

function stagedState(): RuntimeSupervisorState {
  return reduceRuntimeSupervisorState(
    createRuntimeSupervisorState(active, "2026-08-23T00:00:00.000Z"),
    {
      type: "stage-candidate",
      at: "2026-08-23T00:01:00.000Z",
      transitionId: "transition-0001",
      candidate,
    },
  );
}

function candidateActiveState(): RuntimeSupervisorState {
  let state = stagedState();
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
  state = reduceRuntimeSupervisorState(state, {
    type: "begin-publish",
    at: "2026-08-23T00:04:00.000Z",
    expectedEpoch: state.epoch,
    transitionId: "transition-0001",
  });
  return reduceRuntimeSupervisorState(state, {
    type: "candidate-published",
    at: "2026-08-23T00:05:00.000Z",
    expectedEpoch: state.epoch,
    transitionId: "transition-0001",
    managedSessionRevision: 8,
    externalRefreshRequired: true,
  });
}

describe("Runtime supervisor state", () => {
  it("enforces the staged, quiesced, published, committed transition order", () => {
    let state = stagedState();
    expect(state).toMatchObject({
      schemaVersion: "scr.runtime-supervisor-state/v1",
      phase: "candidate-starting",
      epoch: 2,
      active,
      candidate,
      transitionId: "transition-0001",
    });

    state = reduceRuntimeSupervisorState(state, {
      type: "candidate-ready",
      at: "2026-08-23T00:02:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
    });
    state = reduceRuntimeSupervisorState(state, {
      type: "begin-quiesce",
      at: "2026-08-23T00:03:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
    });
    state = reduceRuntimeSupervisorState(state, {
      type: "begin-publish",
      at: "2026-08-23T00:04:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
    });
    state = reduceRuntimeSupervisorState(state, {
      type: "candidate-published",
      at: "2026-08-23T00:05:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
      managedSessionRevision: 11,
      externalRefreshRequired: true,
    });
    expect(state).toMatchObject({
      phase: "candidate-active",
      active: candidate,
      previous: active,
      candidate: null,
      managedSessionRevision: 11,
      externalRefreshRequired: true,
    });

    state = reduceRuntimeSupervisorState(state, {
      type: "commit-candidate",
      at: "2026-08-23T00:06:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
      reportId: "cutover-report-0001",
    });
    expect(state).toMatchObject({
      phase: "stable",
      active: candidate,
      previous: active,
      transitionId: null,
      lastReportId: "cutover-report-0001",
      failureCode: null,
    });
  });

  it("supports a generation-advanced rollback publication", () => {
    let state = candidateActiveState();
    state = reduceRuntimeSupervisorState(state, {
      type: "begin-rollback",
      at: "2026-08-23T00:06:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
      failureCode: "CANARY_FAILED",
      failureDigest: "f".repeat(64),
    });
    const restored = { ...active, runtimeGeneration: 42 };
    state = reduceRuntimeSupervisorState(state, {
      type: "rollback-published",
      at: "2026-08-23T00:07:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
      restored,
      managedSessionRevision: 15,
      externalRefreshRequired: true,
      reportId: "rollback-report-0001",
    });
    expect(state).toMatchObject({
      phase: "stable",
      active: restored,
      previous: null,
      candidate: null,
      transitionId: null,
      managedSessionRevision: 15,
      lastReportId: "rollback-report-0001",
    });
  });

  it("rejects stale epochs, out-of-order phases, and unknown state fields", () => {
    const state = stagedState();
    expect(() =>
      reduceRuntimeSupervisorState(state, {
        type: "begin-publish",
        at: "2026-08-23T00:02:00.000Z",
        expectedEpoch: 2,
        transitionId: "transition-0001",
      }),
    ).toThrow(/not quiesced/u);
    expect(() =>
      reduceRuntimeSupervisorState(state, {
        type: "candidate-ready",
        at: "2026-08-23T00:02:00.000Z",
        expectedEpoch: 1,
        transitionId: "transition-0001",
      }),
    ).toThrow(/stale epoch/u);
    expect(() =>
      parseRuntimeSupervisorState({
        ...state,
        bearerToken: "must-never-be-persisted",
      }),
    ).toThrow(/unknown field/u);
  });
});

describe("Runtime supervisor recovery planning", () => {
  it("holds a healthy, already-published stable Runtime", () => {
    const state = createRuntimeSupervisorState(active);
    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [observation(active)],
      publication: publication(active),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "a".repeat(64),
    });
    expect(plan).toMatchObject({
      outcome: "held",
      state: { phase: "stable", active },
      actions: [{ kind: "hold" }],
    });
  });

  it("discards an interrupted candidate while preserving the published active Runtime", () => {
    const state = stagedState();
    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [observation(active), observation(candidate)],
      publication: publication(active),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "b".repeat(64),
    });
    expect(plan).toMatchObject({
      outcome: "restored-active",
      state: {
        phase: "stable",
        active,
        candidate: null,
        transitionId: null,
      },
    });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stop-runtime",
          instanceId: candidate.instanceId,
        }),
        expect.objectContaining({ kind: "hold" }),
      ]),
    );
  });

  it("continues the candidate when a crash occurred after candidate publication", () => {
    let state = stagedState();
    state = reduceRuntimeSupervisorState(state, {
      type: "candidate-ready",
      at: "2026-08-23T00:02:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
    });
    state = reduceRuntimeSupervisorState(state, {
      type: "begin-quiesce",
      at: "2026-08-23T00:03:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
    });
    state = reduceRuntimeSupervisorState(state, {
      type: "begin-publish",
      at: "2026-08-23T00:04:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
    });
    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [observation(active), observation(candidate)],
      publication: publication(candidate, 8),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "c".repeat(64),
    });
    expect(plan).toMatchObject({
      outcome: "continued-candidate",
      state: {
        phase: "candidate-active",
        active: candidate,
        previous: active,
        candidate: null,
      },
      actions: [
        { kind: "rebind-managed-sessions", to: candidate },
        {
          kind: "continue-canary",
          instanceId: candidate.instanceId,
          runtimeGeneration: 41,
        },
      ],
    });
  });

  it("resumes and republishes the old Runtime after an interrupted quiesce", () => {
    let state = stagedState();
    state = reduceRuntimeSupervisorState(state, {
      type: "candidate-ready",
      at: "2026-08-23T00:02:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
    });
    state = reduceRuntimeSupervisorState(state, {
      type: "begin-quiesce",
      at: "2026-08-23T00:03:00.000Z",
      expectedEpoch: 2,
      transitionId: "transition-0001",
    });
    const unrelated = runtime({
      releaseId: "release-other",
      releaseSequence: 12,
      runtimeGeneration: 43,
      processId: 300,
      port: 43000,
    });
    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [
        observation(active),
        observation(candidate),
        observation(unrelated),
      ],
      publication: publication(unrelated, 12),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "d".repeat(64),
    });
    expect(plan.outcome).toBe("restored-active");
    expect(plan.state.active).toMatchObject({
      releaseId: active.releaseId,
      runtimeGeneration: 44,
    });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resume-runtime",
          expectedGeneration: 40,
          nextGeneration: 44,
        }),
        expect.objectContaining({
          kind: "publish-runtime",
          expectedPublicationRevision: 12,
          expectedPublicationGeneration: 43,
        }),
        expect.objectContaining({ kind: "rebind-managed-sessions" }),
        expect.objectContaining({
          kind: "stop-runtime",
          instanceId: candidate.instanceId,
        }),
      ]),
    );
  });

  it("rolls back an unhealthy active candidate to the previous healthy Runtime", () => {
    const state = candidateActiveState();
    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [observation(candidate, false), observation(active)],
      publication: publication(candidate),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "e".repeat(64),
    });
    expect(plan).toMatchObject({
      outcome: "rolled-back",
      state: {
        phase: "stable",
        active: {
          releaseId: active.releaseId,
          runtimeGeneration: 42,
        },
      },
    });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resume-runtime",
          instanceId: active.instanceId,
          nextGeneration: 42,
        }),
        expect.objectContaining({ kind: "publish-runtime" }),
        expect.objectContaining({ kind: "rebind-managed-sessions" }),
        expect.objectContaining({
          kind: "stop-runtime",
          instanceId: candidate.instanceId,
        }),
      ]),
    );
  });

  it("fails closed when no healthy active or rollback Runtime remains", () => {
    const state = candidateActiveState();
    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [observation(candidate, false), observation(active, false)],
      publication: publication(candidate),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "f".repeat(64),
    });
    expect(plan).toMatchObject({
      outcome: "needs-attention",
      state: {
        phase: "needs-attention",
        failureCode: "CANDIDATE_ACTIVE_WITHOUT_ROLLBACK_TARGET",
        failureDigest: "f".repeat(64),
      },
      actions: [
        {
          kind: "mark-needs-attention",
          failureCode: "CANDIDATE_ACTIVE_WITHOUT_ROLLBACK_TARGET",
          failureDigest: "f".repeat(64),
        },
      ],
    });
  });
  it("persists a newer observed generation when it is already published", () => {
    const state = createRuntimeSupervisorState(active);
    const observed = {
      ...active,
      runtimeGeneration: 44,
      endpoint: "http://127.0.0.1:41500/mcp",
      processId: 101,
      startedAt: "2026-08-23T00:30:00.000Z",
    };
    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [observation(observed)],
      publication: publication(observed, 9),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "1".repeat(64),
    });
    expect(plan).toMatchObject({
      outcome: "held",
      state: {
        phase: "stable",
        active: observed,
      },
      actions: [{ kind: "hold" }],
    });
    expect(
      plan.actions.some((action) => action.kind === "publish-runtime"),
    ).toBe(false);
    expect(
      plan.actions.some((action) => action.kind === "resume-runtime"),
    ).toBe(false);
  });

  it("allows a stable recovery failure to enter needs-attention without a transition ID", () => {
    const state = createRuntimeSupervisorState(active);
    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [observation(active, false)],
      publication: publication(active),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "2".repeat(64),
    });
    expect(plan).toMatchObject({
      outcome: "needs-attention",
      state: {
        phase: "needs-attention",
        transitionId: null,
        failureCode: "NO_HEALTHY_RUNTIME",
        failureDigest: "2".repeat(64),
      },
    });
  });

  it("rejects malformed publication observations and duplicate Runtime instances", () => {
    const state = createRuntimeSupervisorState(active);
    expect(() =>
      planRuntimeSupervisorRecovery({
        state,
        observations: [observation(active)],
        publication: {
          ...publication(active),
          unexpectedField: "must-not-be-accepted",
        } as unknown as PublishedRuntimeObservation,
        at: "2026-08-23T01:00:00.000Z",
        failureDigest: "3".repeat(64),
      }),
    ).toThrow(/invalid shape/u);
    expect(() =>
      planRuntimeSupervisorRecovery({
        state,
        observations: [observation(active)],
        publication: {
          ...publication(active),
          endpoint: `${active.endpoint}?forbidden=value`,
        },
        at: "2026-08-23T01:00:00.000Z",
        failureDigest: "3".repeat(64),
      }),
    ).toThrow(/uncredentialed loopback/u);
    expect(() =>
      planRuntimeSupervisorRecovery({
        state,
        observations: [observation(active), observation(active)],
        publication: publication(active),
        at: "2026-08-23T01:00:00.000Z",
        failureDigest: "3".repeat(64),
      }),
    ).toThrow(/duplicate instances/u);
  });

  it("rejects an observation that reuses an instance ID for another release", () => {
    const state = createRuntimeSupervisorState(active);
    const impersonator = {
      ...active,
      releaseId: "release-impersonator",
      releaseSequence: 99,
      version: "9.9.9+impersonator",
      runtimeGeneration: 45,
      processId: 999,
    };
    expect(() =>
      planRuntimeSupervisorRecovery({
        state,
        observations: [observation(impersonator)],
        publication: publication(active),
        at: "2026-08-23T01:00:00.000Z",
        failureDigest: "4".repeat(64),
      }),
    ).toThrow(/reuses an instance ID/u);
  });

  it("resumes the previous Runtime before publishing it from a stable rollback", () => {
    let state = candidateActiveState();
    state = reduceRuntimeSupervisorState(state, {
      type: "commit-candidate",
      at: "2026-08-23T00:06:00.000Z",
      expectedEpoch: state.epoch,
      transitionId: "transition-0001",
      reportId: "cutover-report-0002",
    });

    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [observation(candidate, false), observation(active)],
      publication: publication(candidate, 9),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "4".repeat(64),
    });

    expect(plan.outcome).toBe("rolled-back");
    expect(plan.state.active).toMatchObject({
      releaseId: active.releaseId,
      runtimeGeneration: 42,
    });
    expect(plan.actions.slice(0, 3)).toEqual([
      {
        kind: "resume-runtime",
        instanceId: active.instanceId,
        expectedGeneration: 40,
        nextGeneration: 42,
      },
      expect.objectContaining({
        kind: "publish-runtime",
        runtime: expect.objectContaining({ runtimeGeneration: 42 }),
      }),
      expect.objectContaining({
        kind: "rebind-managed-sessions",
        to: expect.objectContaining({ runtimeGeneration: 42 }),
      }),
    ]);
  });

  it("resumes the live Runtime before repairing publication after candidate preparation", () => {
    let state = stagedState();
    state = reduceRuntimeSupervisorState(state, {
      type: "candidate-ready",
      at: "2026-08-23T00:02:00.000Z",
      expectedEpoch: state.epoch,
      transitionId: "transition-0001",
    });
    const unrelated = runtime({
      releaseId: "release-drift",
      releaseSequence: 12,
      runtimeGeneration: 43,
      processId: 301,
      port: 43100,
    });

    const plan = planRuntimeSupervisorRecovery({
      state,
      observations: [
        observation(active),
        observation(candidate),
        observation(unrelated),
      ],
      publication: publication(unrelated, 12),
      at: "2026-08-23T01:00:00.000Z",
      failureDigest: "5".repeat(64),
    });

    expect(plan.outcome).toBe("restored-active");
    expect(plan.state.active.runtimeGeneration).toBe(44);
    expect(plan.actions).toEqual([
      expect.objectContaining({
        kind: "stop-runtime",
        instanceId: candidate.instanceId,
      }),
      {
        kind: "resume-runtime",
        instanceId: active.instanceId,
        expectedGeneration: 40,
        nextGeneration: 44,
      },
      expect.objectContaining({
        kind: "publish-runtime",
        runtime: expect.objectContaining({ runtimeGeneration: 44 }),
      }),
      expect.objectContaining({
        kind: "rebind-managed-sessions",
        to: expect.objectContaining({ runtimeGeneration: 44 }),
      }),
    ]);
  });
});
