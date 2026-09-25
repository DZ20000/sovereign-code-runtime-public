import type { ReleaseManifest } from "./manifest.js";

const UPDATE_LIFECYCLES = [
  "idle",
  "staged",
  "preflight",
  "ready-to-cutover",
  "cutover",
  "canary",
  "rollback",
  "needs-attention",
] as const;
const UPDATE_STATE_KEYS = [
  "schemaVersion",
  "lifecycle",
  "generation",
  "active",
  "lastKnownGood",
  "candidate",
  "phaseStartedAt",
  "deadlineAt",
  "cutoverLeaseId",
  "preflightReportId",
  "canaryReportId",
  "failureReason",
] as const;
const RELEASE_REF_KEYS = ["releaseId", "releaseSequence", "version"] as const;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export type UpdateLifecycle = typeof UPDATE_LIFECYCLES[number];

export interface UpdateReleaseRef {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
}

export interface UpdatePolicy {
  readonly preflightTimeoutMs: number;
  readonly cutoverTimeoutMs: number;
  readonly canaryTimeoutMs: number;
}

export const DEFAULT_UPDATE_POLICY: UpdatePolicy = Object.freeze({
  preflightTimeoutMs: 60_000,
  cutoverTimeoutMs: 30_000,
  canaryTimeoutMs: 120_000,
});

export interface UpdateState {
  readonly schemaVersion: "scr.update-state/v1";
  readonly lifecycle: UpdateLifecycle;
  readonly generation: number;
  readonly active: UpdateReleaseRef;
  readonly lastKnownGood: UpdateReleaseRef;
  readonly candidate: UpdateReleaseRef | null;
  readonly phaseStartedAt: number;
  readonly deadlineAt: number | null;
  readonly cutoverLeaseId: string | null;
  readonly preflightReportId: string | null;
  readonly canaryReportId: string | null;
  readonly failureReason: string | null;
}

interface GenerationEvent {
  readonly at: number;
  readonly generation: number;
}

export type UpdateEvent =
  | { readonly type: "stage-candidate"; readonly at: number; readonly candidate: UpdateReleaseRef }
  | (GenerationEvent & { readonly type: "start-preflight" })
  | (GenerationEvent & { readonly type: "preflight-passed"; readonly reportId: string })
  | (GenerationEvent & { readonly type: "preflight-failed"; readonly redactedReason: string })
  | (GenerationEvent & {
      readonly type: "begin-cutover";
      readonly leaseId: string;
      readonly consequentialWorkInFlight: boolean;
      readonly updateOperationInFlight: boolean;
    })
  | (GenerationEvent & { readonly type: "candidate-activated"; readonly leaseId: string })
  | (GenerationEvent & { readonly type: "canary-passed"; readonly reportId: string })
  | (GenerationEvent & { readonly type: "canary-failed"; readonly redactedReason: string })
  | (GenerationEvent & { readonly type: "candidate-crashed"; readonly redactedReason: string })
  | (GenerationEvent & { readonly type: "rollback-completed"; readonly releaseId: string })
  | (GenerationEvent & { readonly type: "rollback-failed"; readonly redactedReason: string })
  | (GenerationEvent & { readonly type: "deadline-expired" })
  | (GenerationEvent & { readonly type: "cancel"; readonly redactedReason: string })
  | {
      readonly type: "recover";
      readonly at: number;
      readonly observedActiveReleaseId: string | null;
    };

export type UpdateEffect =
  | {
      readonly kind: "launch-preflight";
      readonly generation: number;
      readonly candidate: UpdateReleaseRef;
      readonly deadlineAt: number;
    }
  | {
      readonly kind: "discard-candidate";
      readonly generation: number;
      readonly candidate: UpdateReleaseRef;
      readonly reason: string;
    }
  | {
      readonly kind: "activate-candidate";
      readonly generation: number;
      readonly candidate: UpdateReleaseRef;
      readonly leaseId: string;
      readonly deadlineAt: number;
    }
  | {
      readonly kind: "start-canary";
      readonly generation: number;
      readonly candidate: UpdateReleaseRef;
      readonly deadlineAt: number;
    }
  | {
      readonly kind: "activate-last-known-good";
      readonly generation: number;
      readonly release: UpdateReleaseRef;
      readonly reason: string;
    }
  | {
      readonly kind: "commit-candidate";
      readonly generation: number;
      readonly active: UpdateReleaseRef;
      readonly lastKnownGood: UpdateReleaseRef;
    }
  | { readonly kind: "attention"; readonly reason: string }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "hold"; readonly reason: string };

export interface UpdateTransition {
  readonly state: UpdateState;
  readonly effect: UpdateEffect;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unknown field: ${key}`);
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing the required field: ${key}`);
  }
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Update event timestamp must be a non-negative safe integer.");
  }
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number.`);
  validateTimestamp(value);
  return value;
}

function validateTimer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`${label} must be an integer from 1 through 2147483647.`);
  }
}

function validatePolicy(policy: UpdatePolicy): void {
  validateTimer(policy.preflightTimeoutMs, "Preflight timeout");
  validateTimer(policy.cutoverTimeoutMs, "Cutover timeout");
  validateTimer(policy.canaryTimeoutMs, "Canary timeout");
}

function validateIdentifier(
  value: string,
  pattern: RegExp,
  label: string,
): string {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\r\n\0]/u.test(value) ||
    !pattern.test(value)
  ) {
    throw new Error(`${label} has an invalid shape.`);
  }
  return value;
}

function validateReleaseId(value: string, label: string): string {
  return validateIdentifier(value, RELEASE_ID_PATTERN, label);
}

function validateOpaqueIdentifier(value: string, label: string): string {
  return validateIdentifier(value, OPAQUE_ID_PATTERN, label);
}

function parseNullableIdentifier(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null.`);
  return validateOpaqueIdentifier(value, label);
}

function boundedReason(value: string): string {
  const normalized = value.replace(/[\r\n\0]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "No update failure reason was supplied.";
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 511)}…`;
}

function parseNullableReason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Update failureReason must be a string or null.");
  return boundedReason(value);
}

function validateReleaseVersion(value: string): string {
  const match = RELEASE_VERSION_PATTERN.exec(value);
  if (match === null || value.length > 128) {
    throw new Error("Release version has an invalid shape.");
  }
  for (const numericComponent of match.slice(1, 4)) {
    const parsed = Number(numericComponent);
    if (!Number.isSafeInteger(parsed) || parsed > 1_000_000) {
      throw new Error("Release version contains an invalid numeric component.");
    }
  }
  const prerelease = match[4];
  if (prerelease !== undefined) {
    for (const identifier of prerelease.split(".")) {
      if (/^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
        throw new Error("Numeric release prerelease identifiers may not contain leading zeros.");
      }
    }
  }
  return value;
}

function validateReleaseRef(value: UpdateReleaseRef): UpdateReleaseRef {
  const releaseId = validateReleaseId(value.releaseId, "Release ID");
  if (!Number.isSafeInteger(value.releaseSequence) || value.releaseSequence < 1) {
    throw new Error("Release sequence must be a positive safe integer.");
  }
  const version = validateReleaseVersion(value.version);
  return { releaseId, releaseSequence: value.releaseSequence, version };
}

function parseReleaseRef(value: unknown, label: string): UpdateReleaseRef {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, RELEASE_REF_KEYS, label);
  if (
    typeof value.releaseId !== "string" ||
    typeof value.releaseSequence !== "number" ||
    typeof value.version !== "string"
  ) {
    throw new Error(`${label} fields have invalid types.`);
  }
  return validateReleaseRef({
    releaseId: value.releaseId,
    releaseSequence: value.releaseSequence,
    version: value.version,
  });
}

export function releaseRefFromManifest(manifest: ReleaseManifest): UpdateReleaseRef {
  return validateReleaseRef({
    releaseId: manifest.releaseId,
    releaseSequence: manifest.releaseSequence,
    version: manifest.version,
  });
}

function sameRelease(left: UpdateReleaseRef, right: UpdateReleaseRef): boolean {
  return left.releaseId === right.releaseId &&
    left.releaseSequence === right.releaseSequence &&
    left.version === right.version;
}

function deadline(at: number, timeoutMs: number): number {
  const value = at + timeoutMs;
  if (!Number.isSafeInteger(value)) throw new Error("Update deadline exceeds the safe integer range.");
  return value;
}

function staleGeneration(state: UpdateState, event: GenerationEvent): UpdateTransition | null {
  if (event.generation === state.generation) return null;
  return {
    state,
    effect: { kind: "ignored", reason: "The update event belongs to a stale generation." },
  };
}

function idleAfterDiscard(
  state: UpdateState,
  at: number,
  reason: string,
): UpdateTransition {
  const candidate = state.candidate;
  if (candidate === null) {
    return { state, effect: { kind: "ignored", reason: "No candidate is staged." } };
  }
  const bounded = boundedReason(reason);
  return {
    state: {
      ...state,
      lifecycle: "idle",
      candidate: null,
      phaseStartedAt: at,
      deadlineAt: null,
      cutoverLeaseId: null,
      preflightReportId: null,
      canaryReportId: null,
      failureReason: bounded,
    },
    effect: {
      kind: "discard-candidate",
      generation: state.generation,
      candidate,
      reason: bounded,
    },
  };
}

function beginRollback(
  state: UpdateState,
  at: number,
  reason: string,
): UpdateTransition {
  const bounded = boundedReason(reason);
  return {
    state: {
      ...state,
      lifecycle: "rollback",
      phaseStartedAt: at,
      deadlineAt: null,
      cutoverLeaseId: null,
      canaryReportId: null,
      failureReason: bounded,
    },
    effect: {
      kind: "activate-last-known-good",
      generation: state.generation,
      release: state.lastKnownGood,
      reason: bounded,
    },
  };
}

export function createUpdateState(active: UpdateReleaseRef, at = 0): UpdateState {
  validateTimestamp(at);
  const release = validateReleaseRef(active);
  return {
    schemaVersion: "scr.update-state/v1",
    lifecycle: "idle",
    generation: 0,
    active: release,
    lastKnownGood: release,
    candidate: null,
    phaseStartedAt: at,
    deadlineAt: null,
    cutoverLeaseId: null,
    preflightReportId: null,
    canaryReportId: null,
    failureReason: null,
  };
}

export function parseUpdateState(value: unknown): UpdateState {
  if (!isRecord(value)) throw new Error("Persisted update state must be an object.");
  assertExactKeys(value, UPDATE_STATE_KEYS, "Persisted update state");
  if (value.schemaVersion !== "scr.update-state/v1") {
    throw new Error("Unsupported persisted update state schema version.");
  }
  if (!UPDATE_LIFECYCLES.includes(value.lifecycle as UpdateLifecycle)) {
    throw new Error("Persisted update lifecycle is invalid.");
  }
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new Error("Persisted update generation is invalid.");
  }
  const active = parseReleaseRef(value.active, "Persisted active release");
  const lastKnownGood = parseReleaseRef(value.lastKnownGood, "Persisted last-known-good release");
  const candidate = value.candidate === null
    ? null
    : parseReleaseRef(value.candidate, "Persisted candidate release");
  const lifecycle = value.lifecycle as UpdateLifecycle;
  const phaseStartedAt = parseTimestamp(value.phaseStartedAt, "Persisted update phaseStartedAt");
  const deadlineAt = value.deadlineAt === null
    ? null
    : parseTimestamp(value.deadlineAt, "Persisted update deadlineAt");
  if (deadlineAt !== null && deadlineAt < phaseStartedAt) {
    throw new Error("Persisted update deadline precedes the phase start.");
  }
  const cutoverLeaseId = parseNullableIdentifier(value.cutoverLeaseId, "Persisted cutover lease ID");
  const preflightReportId = parseNullableIdentifier(value.preflightReportId, "Persisted preflight report ID");
  const canaryReportId = parseNullableIdentifier(value.canaryReportId, "Persisted canary report ID");
  const failureReason = parseNullableReason(value.failureReason);

  if (active.releaseSequence < lastKnownGood.releaseSequence) {
    throw new Error("Persisted active release is older than last-known-good.");
  }
  if (active.releaseId === lastKnownGood.releaseId && !sameRelease(active, lastKnownGood)) {
    throw new Error("Persisted active and last-known-good releases reuse one release ID inconsistently.");
  }
  const candidateRequired = ["staged", "preflight", "ready-to-cutover", "cutover", "canary"].includes(lifecycle);
  if (candidateRequired && candidate === null) {
    throw new Error(`Persisted ${lifecycle} state is missing its candidate.`);
  }
  if (lifecycle === "idle" && candidate !== null) {
    throw new Error("Persisted idle state may not contain a candidate.");
  }
  if (candidate !== null) {
    if (
      candidate.releaseSequence <= lastKnownGood.releaseSequence ||
      candidate.releaseId === lastKnownGood.releaseId
    ) {
      throw new Error("Persisted candidate is not a distinct newer release than last-known-good.");
    }
    if (lifecycle === "canary") {
      if (!sameRelease(active, candidate)) {
        throw new Error("Persisted canary active release must equal the candidate.");
      }
    } else if (["staged", "preflight", "ready-to-cutover", "cutover"].includes(lifecycle)) {
      if (
        candidate.releaseSequence <= active.releaseSequence ||
        candidate.releaseId === active.releaseId
      ) {
        throw new Error("Persisted candidate is not a distinct newer release than active.");
      }
    } else if (["rollback", "needs-attention"].includes(lifecycle) && !sameRelease(active, candidate)) {
      if (
        candidate.releaseSequence <= active.releaseSequence ||
        candidate.releaseId === active.releaseId
      ) {
        throw new Error("Persisted rollback candidate relationship is invalid.");
      }
    }
  }
  const deadlineRequired = ["preflight", "cutover", "canary"].includes(lifecycle);
  if (deadlineRequired !== (deadlineAt !== null)) {
    throw new Error(`Persisted ${lifecycle} state has an invalid deadline relationship.`);
  }
  const cutoverLeaseRequired = ["cutover", "canary"].includes(lifecycle);
  if (cutoverLeaseRequired !== (cutoverLeaseId !== null)) {
    throw new Error(`Persisted ${lifecycle} state has an invalid cutover lease relationship.`);
  }
  const preflightReportRequired = ["ready-to-cutover", "cutover", "canary"].includes(lifecycle);
  if (preflightReportRequired && preflightReportId === null) {
    throw new Error(`Persisted ${lifecycle} state is missing its preflight report.`);
  }
  if (["staged", "preflight"].includes(lifecycle) && preflightReportId !== null) {
    throw new Error(`Persisted ${lifecycle} state may not contain a preflight report.`);
  }
  if (lifecycle !== "idle" && canaryReportId !== null) {
    throw new Error(`Persisted ${lifecycle} state may not contain a canary report.`);
  }
  if (["rollback", "needs-attention"].includes(lifecycle) && failureReason === null) {
    throw new Error(`Persisted ${lifecycle} state is missing its failure reason.`);
  }

  return {
    schemaVersion: "scr.update-state/v1",
    lifecycle,
    generation: value.generation,
    active,
    lastKnownGood,
    candidate,
    phaseStartedAt,
    deadlineAt,
    cutoverLeaseId,
    preflightReportId,
    canaryReportId,
    failureReason,
  };
}

export function reduceUpdateState(
  state: UpdateState,
  event: UpdateEvent,
  policy: UpdatePolicy = DEFAULT_UPDATE_POLICY,
): UpdateTransition {
  validatePolicy(policy);
  validateTimestamp(event.at);

  if (event.type === "recover") {
    const observed = event.observedActiveReleaseId === null
      ? null
      : validateReleaseId(event.observedActiveReleaseId, "Observed active release ID");
    if (state.lifecycle === "idle") {
      if (observed === state.active.releaseId) {
        return {
          state: {
            ...state,
            phaseStartedAt: event.at,
            deadlineAt: null,
            cutoverLeaseId: null,
          },
          effect: {
            kind: "hold",
            reason: "Observed active release matches persisted state; the monotonic epoch was refreshed.",
          },
        };
      }
      return beginRollback(state, event.at, "Observed active release does not match persisted idle state.");
    }
    if (["staged", "preflight", "ready-to-cutover"].includes(state.lifecycle)) {
      if (observed === state.active.releaseId) {
        return idleAfterDiscard(state, event.at, "Interrupted candidate preparation was discarded during recovery.");
      }
      return beginRollback(state, event.at, "Interrupted candidate preparation observed an unexpected active release.");
    }
    if (observed === state.lastKnownGood.releaseId) {
      return {
        state: {
          ...state,
          lifecycle: "idle",
          active: state.lastKnownGood,
          candidate: null,
          phaseStartedAt: event.at,
          deadlineAt: null,
          cutoverLeaseId: null,
          preflightReportId: null,
          canaryReportId: null,
          failureReason: state.failureReason ?? "Recovered last-known-good after interrupted update.",
        },
        effect: { kind: "hold", reason: "Last-known-good is already active after recovery." },
      };
    }
    return beginRollback(state, event.at, "Interrupted cutover, canary, or rollback requires last-known-good activation.");
  }

  if (event.at < state.phaseStartedAt) {
    return {
      state,
      effect: { kind: "ignored", reason: "The update event predates the current lifecycle phase." },
    };
  }

  if (event.type === "stage-candidate") {
    if (state.lifecycle !== "idle") {
      return { state, effect: { kind: "ignored", reason: "Another update lifecycle is already active." } };
    }
    const candidate = validateReleaseRef(event.candidate);
    if (candidate.releaseSequence <= state.active.releaseSequence) {
      return { state, effect: { kind: "attention", reason: "Candidate release sequence is not newer than active." } };
    }
    if (
      candidate.releaseId === state.active.releaseId ||
      candidate.releaseId === state.lastKnownGood.releaseId
    ) {
      return { state, effect: { kind: "attention", reason: "Candidate release ID collides with a retained release slot." } };
    }
    const generation = state.generation + 1;
    if (!Number.isSafeInteger(generation)) throw new Error("Update generation limit reached.");
    return {
      state: {
        ...state,
        lifecycle: "staged",
        generation,
        candidate,
        phaseStartedAt: event.at,
        deadlineAt: null,
        cutoverLeaseId: null,
        preflightReportId: null,
        canaryReportId: null,
        failureReason: null,
      },
      effect: { kind: "hold", reason: "Candidate is staged and awaits isolated preflight." },
    };
  }

  const stale = staleGeneration(state, event);
  if (stale !== null) return stale;

  switch (event.type) {
    case "start-preflight": {
      if (state.lifecycle !== "staged" || state.candidate === null) {
        return { state, effect: { kind: "ignored", reason: "Candidate is not ready for preflight." } };
      }
      const deadlineAt = deadline(event.at, policy.preflightTimeoutMs);
      return {
        state: {
          ...state,
          lifecycle: "preflight",
          phaseStartedAt: event.at,
          deadlineAt,
          failureReason: null,
        },
        effect: {
          kind: "launch-preflight",
          generation: state.generation,
          candidate: state.candidate,
          deadlineAt,
        },
      };
    }
    case "preflight-passed": {
      if (state.lifecycle !== "preflight" || state.candidate === null) {
        return { state, effect: { kind: "ignored", reason: "No candidate preflight is active." } };
      }
      if (state.deadlineAt === null || event.at >= state.deadlineAt) {
        return idleAfterDiscard(state, event.at, "Candidate preflight result arrived after its deadline.");
      }
      const reportId = validateOpaqueIdentifier(event.reportId, "Preflight report ID");
      return {
        state: {
          ...state,
          lifecycle: "ready-to-cutover",
          phaseStartedAt: event.at,
          deadlineAt: null,
          preflightReportId: reportId,
          failureReason: null,
        },
        effect: { kind: "hold", reason: "Candidate preflight passed and awaits cutover lease." },
      };
    }
    case "preflight-failed":
      if (state.lifecycle !== "preflight") {
        return { state, effect: { kind: "ignored", reason: "No candidate preflight is active." } };
      }
      return idleAfterDiscard(state, event.at, event.redactedReason);
    case "begin-cutover": {
      if (state.lifecycle !== "ready-to-cutover" || state.candidate === null) {
        return { state, effect: { kind: "ignored", reason: "Candidate is not ready for cutover." } };
      }
      if (event.consequentialWorkInFlight || event.updateOperationInFlight) {
        return {
          state,
          effect: {
            kind: "hold",
            reason: event.consequentialWorkInFlight
              ? "Consequential work is in flight; cutover lease was not granted."
              : "Another update operation is in flight; cutover lease was not granted.",
          },
        };
      }
      const leaseId = validateOpaqueIdentifier(event.leaseId, "Cutover lease ID");
      const deadlineAt = deadline(event.at, policy.cutoverTimeoutMs);
      return {
        state: {
          ...state,
          lifecycle: "cutover",
          lastKnownGood: state.active,
          phaseStartedAt: event.at,
          deadlineAt,
          cutoverLeaseId: leaseId,
          failureReason: null,
        },
        effect: {
          kind: "activate-candidate",
          generation: state.generation,
          candidate: state.candidate,
          leaseId,
          deadlineAt,
        },
      };
    }
    case "candidate-activated": {
      if (state.lifecycle !== "cutover" || state.candidate === null) {
        return { state, effect: { kind: "ignored", reason: "No candidate cutover is active." } };
      }
      if (event.leaseId !== state.cutoverLeaseId) {
        return { state, effect: { kind: "ignored", reason: "Candidate activation used a stale cutover lease." } };
      }
      if (state.deadlineAt === null || event.at >= state.deadlineAt) {
        return beginRollback(state, event.at, "Candidate activation arrived after the cutover deadline.");
      }
      const deadlineAt = deadline(event.at, policy.canaryTimeoutMs);
      return {
        state: {
          ...state,
          lifecycle: "canary",
          active: state.candidate,
          phaseStartedAt: event.at,
          deadlineAt,
          failureReason: null,
        },
        effect: {
          kind: "start-canary",
          generation: state.generation,
          candidate: state.candidate,
          deadlineAt,
        },
      };
    }
    case "canary-passed": {
      if (state.lifecycle !== "canary" || state.candidate === null) {
        return { state, effect: { kind: "ignored", reason: "No candidate canary is active." } };
      }
      if (state.deadlineAt === null || event.at >= state.deadlineAt) {
        return beginRollback(state, event.at, "Candidate canary result arrived after its deadline.");
      }
      const reportId = validateOpaqueIdentifier(event.reportId, "Canary report ID");
      return {
        state: {
          ...state,
          lifecycle: "idle",
          active: state.candidate,
          candidate: null,
          phaseStartedAt: event.at,
          deadlineAt: null,
          cutoverLeaseId: null,
          canaryReportId: reportId,
          failureReason: null,
        },
        effect: {
          kind: "commit-candidate",
          generation: state.generation,
          active: state.candidate,
          lastKnownGood: state.lastKnownGood,
        },
      };
    }
    case "canary-failed":
      if (state.lifecycle !== "canary") {
        return { state, effect: { kind: "ignored", reason: "No candidate canary is active." } };
      }
      return beginRollback(state, event.at, event.redactedReason);
    case "candidate-crashed":
      if (!["cutover", "canary"].includes(state.lifecycle)) {
        return { state, effect: { kind: "ignored", reason: "Candidate is not active." } };
      }
      return beginRollback(state, event.at, event.redactedReason);
    case "rollback-completed": {
      if (state.lifecycle !== "rollback") {
        return { state, effect: { kind: "ignored", reason: "Rollback is not active." } };
      }
      const releaseId = validateReleaseId(event.releaseId, "Rollback release ID");
      if (releaseId !== state.lastKnownGood.releaseId) {
        return { state, effect: { kind: "ignored", reason: "Rollback completion reported the wrong release." } };
      }
      return {
        state: {
          ...state,
          lifecycle: "idle",
          active: state.lastKnownGood,
          candidate: null,
          phaseStartedAt: event.at,
          deadlineAt: null,
          cutoverLeaseId: null,
          preflightReportId: null,
          canaryReportId: null,
        },
        effect: { kind: "hold", reason: "Last-known-good rollback completed." },
      };
    }
    case "rollback-failed": {
      if (state.lifecycle !== "rollback") {
        return { state, effect: { kind: "ignored", reason: "Rollback is not active." } };
      }
      const reason = boundedReason(event.redactedReason);
      return {
        state: {
          ...state,
          lifecycle: "needs-attention",
          phaseStartedAt: event.at,
          deadlineAt: null,
          cutoverLeaseId: null,
          canaryReportId: null,
          failureReason: reason,
        },
        effect: { kind: "attention", reason },
      };
    }
    case "deadline-expired":
      if (state.deadlineAt === null || event.at < state.deadlineAt) {
        return { state, effect: { kind: "ignored", reason: "Update deadline has not expired." } };
      }
      if (state.lifecycle === "preflight") {
        return idleAfterDiscard(state, event.at, "Candidate preflight timed out.");
      }
      if (state.lifecycle === "cutover" || state.lifecycle === "canary") {
        return beginRollback(state, event.at, `${state.lifecycle} health deadline expired.`);
      }
      return { state, effect: { kind: "ignored", reason: "Current update phase has no deadline action." } };
    case "cancel":
      if (["staged", "preflight", "ready-to-cutover"].includes(state.lifecycle)) {
        return idleAfterDiscard(state, event.at, event.redactedReason);
      }
      if (["cutover", "canary"].includes(state.lifecycle)) {
        return beginRollback(state, event.at, event.redactedReason);
      }
      return { state, effect: { kind: "ignored", reason: "No cancellable update phase is active." } };
  }
}

export function retainedReleaseIds(state: UpdateState): readonly string[] {
  return [...new Set([
    state.active.releaseId,
    state.lastKnownGood.releaseId,
    ...(state.candidate === null ? [] : [state.candidate.releaseId]),
  ])];
}

export function planReleaseCleanup(
  installedReleaseIds: readonly string[],
  state: UpdateState,
): readonly string[] {
  if (!Array.isArray(installedReleaseIds) || installedReleaseIds.length > 10_000) {
    throw new Error("Installed release inventory exceeds its limit.");
  }
  const normalized = installedReleaseIds.map((releaseId) =>
    validateReleaseId(releaseId, "Installed release ID")
  );
  const retained = new Set(retainedReleaseIds(state));
  return [...new Set(normalized)]
    .filter((releaseId) => !retained.has(releaseId))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function releasesEqual(left: UpdateReleaseRef, right: UpdateReleaseRef): boolean {
  return sameRelease(left, right);
}
