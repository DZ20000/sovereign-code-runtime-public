import { describe, expect, it } from "vitest";

import {
  createUpdateState,
  parseUpdateState,
  planReleaseCleanup,
  reduceUpdateState,
  retainedReleaseIds,
  type UpdatePolicy,
  type UpdateReleaseRef,
  type UpdateState,
} from "../src/state-machine.js";

const active: UpdateReleaseRef = {
  releaseId: "release-0001",
  releaseSequence: 1,
  version: "0.1.0",
};
const candidate: UpdateReleaseRef = {
  releaseId: "release-0002",
  releaseSequence: 2,
  version: "0.2.0",
};
const candidateThree: UpdateReleaseRef = {
  releaseId: "release-0003",
  releaseSequence: 3,
  version: "0.3.0",
};
const policy: UpdatePolicy = {
  preflightTimeoutMs: 100,
  cutoverTimeoutMs: 50,
  canaryTimeoutMs: 200,
};

function staged(base: UpdateState = createUpdateState(active, 0), next = candidate): UpdateState {
  return reduceUpdateState(
    base,
    { type: "stage-candidate", at: base.phaseStartedAt + 10, candidate: next },
    policy,
  ).state;
}

function preflight(base = staged()): UpdateState {
  return reduceUpdateState(
    base,
    { type: "start-preflight", at: base.phaseStartedAt + 10, generation: base.generation },
    policy,
  ).state;
}

function readyToCutover(base = preflight()): UpdateState {
  return reduceUpdateState(
    base,
    {
      type: "preflight-passed",
      at: base.phaseStartedAt + 10,
      generation: base.generation,
      reportId: `preflight-report-${base.generation}`,
    },
    policy,
  ).state;
}

function cutover(base = readyToCutover()): UpdateState {
  return reduceUpdateState(
    base,
    {
      type: "begin-cutover",
      at: base.phaseStartedAt + 10,
      generation: base.generation,
      leaseId: `cutover-lease-${base.generation}`,
      consequentialWorkInFlight: false,
      updateOperationInFlight: false,
    },
    policy,
  ).state;
}

function canary(base = cutover()): UpdateState {
  return reduceUpdateState(
    base,
    {
      type: "candidate-activated",
      at: base.phaseStartedAt + 5,
      generation: base.generation,
      leaseId: base.cutoverLeaseId!,
    },
    policy,
  ).state;
}

function committed(base = canary()): UpdateState {
  return reduceUpdateState(
    base,
    {
      type: "canary-passed",
      at: base.phaseStartedAt + 10,
      generation: base.generation,
      reportId: `canary-report-${base.generation}`,
    },
    policy,
  ).state;
}

function rollback(base = canary()): UpdateState {
  return reduceUpdateState(
    base,
    {
      type: "canary-failed",
      at: base.phaseStartedAt + 10,
      generation: base.generation,
      redactedReason: "remote canary failed",
    },
    policy,
  ).state;
}

describe("signed update state machine", () => {
  it("stages only a distinct newer candidate and binds a fresh generation", () => {
    const transition = reduceUpdateState(
      createUpdateState(active),
      { type: "stage-candidate", at: 10, candidate },
      policy,
    );
    expect(transition.state).toMatchObject({
      lifecycle: "staged",
      generation: 1,
      candidate,
      active,
      lastKnownGood: active,
    });
    expect(transition.effect.kind).toBe("hold");

    const downgrade = reduceUpdateState(
      createUpdateState(active),
      {
        type: "stage-candidate",
        at: 10,
        candidate: { ...candidate, releaseId: "release-old", releaseSequence: 1 },
      },
      policy,
    );
    expect(downgrade.effect.kind).toBe("attention");
    expect(downgrade.state.lifecycle).toBe("idle");

    const collision = reduceUpdateState(
      createUpdateState(active),
      {
        type: "stage-candidate",
        at: 10,
        candidate: { ...candidate, releaseId: active.releaseId },
      },
      policy,
    );
    expect(collision.effect).toMatchObject({ kind: "attention" });
    expect(collision.state.lifecycle).toBe("idle");
  });

  it("launches isolated preflight with a bounded deadline", () => {
    const state = staged();
    const transition = reduceUpdateState(
      state,
      { type: "start-preflight", at: 20, generation: state.generation },
      policy,
    );
    expect(transition.state).toMatchObject({
      lifecycle: "preflight",
      deadlineAt: 120,
    });
    expect(transition.effect).toEqual({
      kind: "launch-preflight",
      generation: state.generation,
      candidate,
      deadlineAt: 120,
    });
  });

  it("preflight timeout discards candidate while active remains unchanged", () => {
    const state = preflight();
    const early = reduceUpdateState(
      state,
      { type: "deadline-expired", at: state.deadlineAt! - 1, generation: state.generation },
      policy,
    );
    expect(early.effect.kind).toBe("ignored");

    const timedOut = reduceUpdateState(
      state,
      { type: "deadline-expired", at: state.deadlineAt!, generation: state.generation },
      policy,
    );
    expect(timedOut.effect).toMatchObject({
      kind: "discard-candidate",
      candidate,
      reason: "Candidate preflight timed out.",
    });
    expect(timedOut.state).toMatchObject({
      lifecycle: "idle",
      active,
      lastKnownGood: active,
      candidate: null,
    });
  });

  it("rejects a preflight success that arrives at or after the deadline", () => {
    const state = preflight();
    const late = reduceUpdateState(state, {
      type: "preflight-passed",
      at: state.deadlineAt!,
      generation: state.generation,
      reportId: "late-preflight-report",
    }, policy);
    expect(late.effect).toMatchObject({ kind: "discard-candidate" });
    expect(late.state).toMatchObject({ lifecycle: "idle", candidate: null, active });
  });

  it("bounds and flattens preflight failure evidence before persistence", () => {
    const state = preflight();
    const failed = reduceUpdateState(state, {
      type: "preflight-failed",
      at: state.phaseStartedAt + 1,
      generation: state.generation,
      redactedReason: `first\nsecond ${"x".repeat(1_000)}`,
    }, policy);
    expect(failed.state.failureReason).not.toContain("\n");
    expect(failed.state.failureReason!.length).toBeLessThanOrEqual(512);
  });

  it("does not grant cutover while consequential or update work is active", () => {
    const state = readyToCutover();
    for (const flags of [
      { consequentialWorkInFlight: true, updateOperationInFlight: false },
      { consequentialWorkInFlight: false, updateOperationInFlight: true },
    ]) {
      const transition = reduceUpdateState(state, {
        type: "begin-cutover",
        at: state.phaseStartedAt + 10,
        generation: state.generation,
        leaseId: "cutover-lease-1",
        ...flags,
      }, policy);
      expect(transition.effect.kind).toBe("hold");
      expect(transition.state).toBe(state);
    }
  });

  it("promotes the current active release to last-known-good at cutover", () => {
    const secondActive = committed();
    const thirdStaged = staged(secondActive, candidateThree);
    const thirdReady = readyToCutover(preflight(thirdStaged));
    const thirdCutover = cutover(thirdReady);

    expect(secondActive).toMatchObject({ active: candidate, lastKnownGood: active });
    expect(thirdCutover).toMatchObject({
      active: candidate,
      lastKnownGood: candidate,
      candidate: candidateThree,
      lifecycle: "cutover",
    });

    const thirdCanary = canary(thirdCutover);
    const crashed = reduceUpdateState(thirdCanary, {
      type: "candidate-crashed",
      at: thirdCanary.phaseStartedAt + 1,
      generation: thirdCanary.generation,
      redactedReason: "candidate release three crashed",
    }, policy);
    expect(crashed.effect).toMatchObject({
      kind: "activate-last-known-good",
      release: candidate,
    });
  });

  it("requires the exact cutover lease and rejects late activation", () => {
    const state = cutover();
    const staleLease = reduceUpdateState(state, {
      type: "candidate-activated",
      at: state.phaseStartedAt + 5,
      generation: state.generation,
      leaseId: "wrong-lease",
    }, policy);
    expect(staleLease.effect.kind).toBe("ignored");
    expect(staleLease.state).toBe(state);

    const late = reduceUpdateState(state, {
      type: "candidate-activated",
      at: state.deadlineAt!,
      generation: state.generation,
      leaseId: state.cutoverLeaseId!,
    }, policy);
    expect(late.state.lifecycle).toBe("rollback");
    expect(late.effect).toMatchObject({ kind: "activate-last-known-good", release: active });

    const activated = canary(state);
    expect(activated).toMatchObject({
      lifecycle: "canary",
      active: candidate,
      lastKnownGood: active,
      candidate,
    });
  });

  it("retains active candidate and last-known-good throughout canary", () => {
    const state = canary();
    expect(retainedReleaseIds(state)).toEqual([candidate.releaseId, active.releaseId]);
    expect(planReleaseCleanup(
      ["release-0000", active.releaseId, candidate.releaseId, "release-temp"],
      state,
    )).toEqual(["release-0000", "release-temp"]);
    expect(() => planReleaseCleanup(["../unsafe"], state)).toThrow(/invalid shape/u);
  });

  it("candidate crash and canary timeout activate last-known-good", () => {
    const state = canary();
    const crashed = reduceUpdateState(state, {
      type: "candidate-crashed",
      at: state.phaseStartedAt + 1,
      generation: state.generation,
      redactedReason: "candidate process exited",
    }, policy);
    expect(crashed.state.lifecycle).toBe("rollback");
    expect(crashed.effect).toMatchObject({
      kind: "activate-last-known-good",
      release: active,
    });

    const timedOut = reduceUpdateState(state, {
      type: "deadline-expired",
      at: state.deadlineAt!,
      generation: state.generation,
    }, policy);
    expect(timedOut.state.lifecycle).toBe("rollback");
    expect(timedOut.effect).toMatchObject({ kind: "activate-last-known-good" });
  });

  it("rejects a canary pass that arrives at or after the deadline", () => {
    const state = canary();
    const late = reduceUpdateState(state, {
      type: "canary-passed",
      at: state.deadlineAt!,
      generation: state.generation,
      reportId: "late-canary-report",
    }, policy);
    expect(late.state.lifecycle).toBe("rollback");
    expect(late.effect).toMatchObject({ kind: "activate-last-known-good", release: active });
  });

  it("canary pass commits candidate while retaining prior active as last-known-good", () => {
    const committedState = committed();
    expect(committedState).toMatchObject({
      lifecycle: "idle",
      active: candidate,
      lastKnownGood: active,
      candidate: null,
      canaryReportId: "canary-report-1",
    });
    expect(retainedReleaseIds(committedState)).toEqual([candidate.releaseId, active.releaseId]);
  });

  it("ignores stale generation and phase-regressing events", () => {
    const state = staged();
    const late = reduceUpdateState(state, {
      type: "preflight-passed",
      at: state.phaseStartedAt + 1,
      generation: state.generation - 1,
      reportId: "old-report",
    }, policy);
    expect(late.effect.kind).toBe("ignored");
    expect(late.state).toBe(state);

    const backwards = reduceUpdateState(state, {
      type: "start-preflight",
      at: state.phaseStartedAt - 1,
      generation: state.generation,
    }, policy);
    expect(backwards.effect).toMatchObject({ kind: "ignored" });
    expect(backwards.state).toBe(state);
  });

  it("recovers interrupted cutover and canary deterministically to last-known-good", () => {
    for (const interrupted of [cutover(), canary()]) {
      const recovery = reduceUpdateState(interrupted, {
        type: "recover",
        at: 0,
        observedActiveReleaseId: interrupted.candidate?.releaseId ?? null,
      }, policy);
      expect(recovery.state.lifecycle).toBe("rollback");
      expect(recovery.effect).toMatchObject({
        kind: "activate-last-known-good",
        release: active,
      });
    }
  });

  it("requires rollback completion to identify last-known-good", () => {
    const state = rollback();
    const wrong = reduceUpdateState(state, {
      type: "rollback-completed",
      at: state.phaseStartedAt + 1,
      generation: state.generation,
      releaseId: candidate.releaseId,
    }, policy);
    expect(wrong.effect.kind).toBe("ignored");
    expect(wrong.state).toBe(state);

    const completed = reduceUpdateState(state, {
      type: "rollback-completed",
      at: state.phaseStartedAt + 2,
      generation: state.generation,
      releaseId: active.releaseId,
    }, policy);
    expect(completed.state).toMatchObject({
      lifecycle: "idle",
      active,
      lastKnownGood: active,
      candidate: null,
    });
  });

  it("enters needs-attention when last-known-good activation fails", () => {
    const state = rollback();
    const failed = reduceUpdateState(state, {
      type: "rollback-failed",
      at: state.phaseStartedAt + 1,
      generation: state.generation,
      redactedReason: "last-known-good executable could not be started",
    }, policy);
    expect(failed.state).toMatchObject({
      lifecycle: "needs-attention",
      candidate,
      failureReason: "last-known-good executable could not be started",
    });
    expect(failed.effect).toMatchObject({ kind: "attention" });

    const recovered = reduceUpdateState(failed.state, {
      type: "recover",
      at: 0,
      observedActiveReleaseId: active.releaseId,
    }, policy);
    expect(recovered.state).toMatchObject({ lifecycle: "idle", active, candidate: null });
  });

  it("recovers interrupted preflight by discarding candidate when active is unchanged", () => {
    const state = preflight();
    const recovered = reduceUpdateState(state, {
      type: "recover",
      at: 0,
      observedActiveReleaseId: active.releaseId,
    }, policy);
    expect(recovered.effect.kind).toBe("discard-candidate");
    expect(recovered.state).toMatchObject({
      lifecycle: "idle",
      active,
      candidate: null,
    });
  });

  it("validates observed active release IDs during recovery", () => {
    expect(() => reduceUpdateState(createUpdateState(active), {
      type: "recover",
      at: 10,
      observedActiveReleaseId: "../unknown",
    }, policy)).toThrow(/invalid shape/u);
    expect(() => reduceUpdateState(createUpdateState(active), {
      type: "recover",
      at: 10,
      observedActiveReleaseId: `${active.releaseId}\n`,
    }, policy)).toThrow(/invalid shape/u);
  });

  it("refreshes the monotonic epoch when an idle state is recovered", () => {
    const persisted = createUpdateState(active, 50_000);
    const recovered = reduceUpdateState(persisted, {
      type: "recover",
      at: 0,
      observedActiveReleaseId: active.releaseId,
    }, policy).state;
    expect(recovered.phaseStartedAt).toBe(0);

    const next = reduceUpdateState(recovered, {
      type: "stage-candidate",
      at: 10,
      candidate,
    }, policy);
    expect(next.state.lifecycle).toBe("staged");
  });
});

describe("persisted update state parsing", () => {
  it("round-trips valid idle, preflight, canary, rollback, and needs-attention states", () => {
    const rollbackState = rollback();
    const attention = reduceUpdateState(rollbackState, {
      type: "rollback-failed",
      at: rollbackState.phaseStartedAt + 1,
      generation: rollbackState.generation,
      redactedReason: "rollback failed",
    }, policy).state;
    for (const state of [createUpdateState(active), preflight(), canary(), rollbackState, attention]) {
      expect(parseUpdateState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    }
  });

  it("rejects unknown fields and invalid lifecycle relationships", () => {
    const state = preflight();
    expect(() => parseUpdateState({ ...state, unexpected: true })).toThrow(/unknown field/u);
    expect(() => parseUpdateState({ ...state, candidate: null })).toThrow(/missing its candidate/u);
    expect(() => parseUpdateState({ ...state, deadlineAt: null })).toThrow(/deadline/u);
    expect(() => parseUpdateState({
      ...createUpdateState(active),
      candidate,
    })).toThrow(/idle state may not contain/u);
    expect(() => parseUpdateState({
      ...canary(),
      active,
    })).toThrow(/must equal the candidate/u);
    expect(() => parseUpdateState({
      ...staged(),
      candidate: { ...candidate, releaseId: active.releaseId },
    })).toThrow(/distinct newer release/u);
    expect(() => parseUpdateState({
      ...createUpdateState(active),
      active: { ...active, version: "999999999999999999999.0.0" },
    })).toThrow(/numeric component/u);
  });

  it("requires rollback and attention states to retain a bounded failure reason", () => {
    expect(() => parseUpdateState({ ...rollback(), failureReason: null }))
      .toThrow(/missing its failure reason/u);
    const attention = {
      ...rollback(),
      lifecycle: "needs-attention",
      failureReason: "failure\nwith lines",
    } as const;
    expect(parseUpdateState(attention).failureReason).toBe("failure with lines");
  });

  it("fails closed when persisted idle state disagrees with observed active release", () => {
    const state = parseUpdateState(createUpdateState(active));
    const recovered = reduceUpdateState(state, {
      type: "recover",
      at: 10,
      observedActiveReleaseId: "unknown-release",
    }, policy);
    expect(recovered.state.lifecycle).toBe("rollback");
    expect(recovered.effect).toMatchObject({ kind: "activate-last-known-good" });
  });
});
