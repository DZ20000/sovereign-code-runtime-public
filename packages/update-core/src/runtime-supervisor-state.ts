const RUNTIME_SUPERVISOR_PHASES = [
  "stable",
  "candidate-starting",
  "candidate-ready",
  "quiescing",
  "publishing",
  "candidate-active",
  "rolling-back",
  "needs-attention",
] as const;

const STATE_KEYS = [
  "schemaVersion",
  "phase",
  "epoch",
  "active",
  "previous",
  "candidate",
  "transitionId",
  "phaseStartedAt",
  "updatedAt",
  "managedSessionRevision",
  "externalRefreshRequired",
  "lastReportId",
  "failureCode",
  "failureDigest",
] as const;

const IDENTITY_KEYS = [
  "releaseId",
  "releaseSequence",
  "version",
  "instanceId",
  "runtimeGeneration",
  "endpoint",
  "manifestDigest",
  "processId",
  "startedAt",
] as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,127}$/u;

export const RUNTIME_SUPERVISOR_STATE_SCHEMA_VERSION =
  "scr.runtime-supervisor-state/v1" as const;
export const RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION =
  "scr.runtime-supervisor-recovery/v1" as const;

export type RuntimeSupervisorPhase = (typeof RUNTIME_SUPERVISOR_PHASES)[number];

export interface RuntimeSlotIdentity {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly instanceId: string;
  readonly runtimeGeneration: number;
  readonly endpoint: string;
  readonly manifestDigest: string;
  readonly processId: number;
  readonly startedAt: string;
}

export interface RuntimeSupervisorState {
  readonly schemaVersion: typeof RUNTIME_SUPERVISOR_STATE_SCHEMA_VERSION;
  readonly phase: RuntimeSupervisorPhase;
  readonly epoch: number;
  readonly active: RuntimeSlotIdentity;
  readonly previous: RuntimeSlotIdentity | null;
  readonly candidate: RuntimeSlotIdentity | null;
  readonly transitionId: string | null;
  readonly phaseStartedAt: string;
  readonly updatedAt: string;
  readonly managedSessionRevision: number;
  readonly externalRefreshRequired: boolean;
  readonly lastReportId: string | null;
  readonly failureCode: string | null;
  readonly failureDigest: string | null;
}

interface RuntimeSupervisorEpochEvent {
  readonly at: string;
  readonly expectedEpoch: number;
  readonly transitionId: string;
}

export type RuntimeSupervisorEvent =
  | {
      readonly type: "stage-candidate";
      readonly at: string;
      readonly transitionId: string;
      readonly candidate: RuntimeSlotIdentity;
    }
  | (RuntimeSupervisorEpochEvent & { readonly type: "candidate-ready" })
  | (RuntimeSupervisorEpochEvent & { readonly type: "begin-quiesce" })
  | (RuntimeSupervisorEpochEvent & { readonly type: "begin-publish" })
  | (RuntimeSupervisorEpochEvent & {
      readonly type: "candidate-published";
      readonly managedSessionRevision: number;
      readonly externalRefreshRequired: boolean;
    })
  | (RuntimeSupervisorEpochEvent & {
      readonly type: "commit-candidate";
      readonly reportId: string;
    })
  | (RuntimeSupervisorEpochEvent & {
      readonly type: "begin-rollback";
      readonly failureCode: string;
      readonly failureDigest: string;
    })
  | (RuntimeSupervisorEpochEvent & {
      readonly type: "rollback-published";
      readonly restored: RuntimeSlotIdentity;
      readonly managedSessionRevision: number;
      readonly externalRefreshRequired: boolean;
      readonly reportId: string;
    })
  | (RuntimeSupervisorEpochEvent & {
      readonly type: "fail";
      readonly failureCode: string;
      readonly failureDigest: string;
    });

export interface RuntimeObservation {
  readonly runtime: RuntimeSlotIdentity;
  readonly alive: boolean;
  readonly healthy: boolean;
}

export interface PublishedRuntimeObservation {
  readonly revision: number;
  readonly runtimeGeneration: number;
  readonly instanceId: string;
  readonly endpoint: string;
  readonly manifestDigest: string;
}

export type RuntimeRecoveryAction =
  | {
      readonly kind: "hold";
      readonly reason: string;
    }
  | {
      readonly kind: "stop-runtime";
      readonly instanceId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "resume-runtime";
      readonly instanceId: string;
      readonly expectedGeneration: number;
      readonly nextGeneration: number;
    }
  | {
      readonly kind: "publish-runtime";
      readonly runtime: RuntimeSlotIdentity;
      readonly expectedPublicationRevision: number;
      readonly expectedPublicationGeneration: number;
    }
  | {
      readonly kind: "rebind-managed-sessions";
      readonly fromGeneration: number;
      readonly to: RuntimeSlotIdentity;
    }
  | {
      readonly kind: "continue-canary";
      readonly instanceId: string;
      readonly runtimeGeneration: number;
    }
  | {
      readonly kind: "mark-needs-attention";
      readonly failureCode: string;
      readonly failureDigest: string;
    };

export interface RuntimeRecoveryPlan {
  readonly schemaVersion: typeof RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION;
  readonly outcome:
    | "held"
    | "restored-active"
    | "continued-candidate"
    | "rolled-back"
    | "needs-attention";
  readonly state: RuntimeSupervisorState;
  readonly actions: readonly RuntimeRecoveryAction[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new Error(`${label} contains an unknown field: ${key}`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} is missing the required field: ${key}`);
    }
  }
}

function parseTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 40 ||
    /[\0\r\n]/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function parseIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseNullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : parseIdentifier(value, label);
}

function parseFailureCode(value: unknown): string {
  if (typeof value !== "string" || !FAILURE_CODE_PATTERN.test(value)) {
    throw new Error("Runtime supervisor failure code is invalid.");
  }
  return value;
}

function parseNullableFailureCode(value: unknown): string | null {
  return value === null ? null : parseFailureCode(value);
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256.`);
  }
  return value;
}

function parseNullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : parseDigest(value, label);
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function parseEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("Runtime endpoint is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Runtime endpoint is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    ) ||
    url.pathname !== "/mcp" ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw new Error(
      "Runtime endpoint must be an uncredentialed loopback /mcp URL.",
    );
  }
  return value;
}

function parseVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !VERSION_PATTERN.test(value)
  ) {
    throw new Error("Runtime release version is invalid.");
  }
  return value;
}

export function parseRuntimeSlotIdentity(
  value: unknown,
  label = "Runtime slot identity",
): RuntimeSlotIdentity {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertExactKeys(value, IDENTITY_KEYS, label);
  if (
    typeof value.releaseId !== "string" ||
    !RELEASE_ID_PATTERN.test(value.releaseId)
  ) {
    throw new Error(`${label} release ID is invalid.`);
  }
  return {
    releaseId: value.releaseId,
    releaseSequence: parsePositiveInteger(
      value.releaseSequence,
      `${label} release sequence`,
    ),
    version: parseVersion(value.version),
    instanceId: parseIdentifier(value.instanceId, `${label} instance ID`),
    runtimeGeneration: parsePositiveInteger(
      value.runtimeGeneration,
      `${label} Runtime generation`,
    ),
    endpoint: parseEndpoint(value.endpoint),
    manifestDigest: parseDigest(
      value.manifestDigest,
      `${label} manifest digest`,
    ),
    processId: parsePositiveInteger(value.processId, `${label} process ID`),
    startedAt: parseTimestamp(value.startedAt, `${label} startedAt`),
  };
}

function sameIdentity(
  left: RuntimeSlotIdentity,
  right: RuntimeSlotIdentity,
): boolean {
  return (
    left.releaseId === right.releaseId &&
    left.releaseSequence === right.releaseSequence &&
    left.version === right.version &&
    left.instanceId === right.instanceId &&
    left.runtimeGeneration === right.runtimeGeneration &&
    left.endpoint === right.endpoint &&
    left.manifestDigest === right.manifestDigest &&
    left.processId === right.processId
  );
}

function sameRelease(
  left: RuntimeSlotIdentity,
  right: RuntimeSlotIdentity,
): boolean {
  return (
    left.releaseId === right.releaseId &&
    left.releaseSequence === right.releaseSequence &&
    left.version === right.version
  );
}

function samePublishedRuntime(
  publication: PublishedRuntimeObservation,
  runtime: RuntimeSlotIdentity,
): boolean {
  return (
    publication.runtimeGeneration === runtime.runtimeGeneration &&
    publication.instanceId === runtime.instanceId &&
    publication.endpoint === runtime.endpoint &&
    publication.manifestDigest === runtime.manifestDigest
  );
}

function validateStateRelationships(state: RuntimeSupervisorState): void {
  if (Date.parse(state.updatedAt) < Date.parse(state.phaseStartedAt)) {
    throw new Error("Runtime supervisor updatedAt precedes phaseStartedAt.");
  }
  if (state.previous !== null && sameIdentity(state.active, state.previous)) {
    throw new Error(
      "Runtime supervisor active and previous identities collide.",
    );
  }
  if (state.candidate !== null) {
    if (
      sameIdentity(state.active, state.candidate) ||
      sameRelease(state.active, state.candidate) ||
      state.candidate.runtimeGeneration <= state.active.runtimeGeneration
    ) {
      throw new Error(
        "Runtime supervisor candidate is not a distinct newer Runtime.",
      );
    }
  }
  const candidateRequired = [
    "candidate-starting",
    "candidate-ready",
    "quiescing",
    "publishing",
  ].includes(state.phase);
  if (candidateRequired !== (state.candidate !== null)) {
    throw new Error(
      `Runtime supervisor ${state.phase} candidate relationship is invalid.`,
    );
  }
  const transitionRequired = !["stable", "needs-attention"].includes(
    state.phase,
  );
  if (
    (transitionRequired && state.transitionId === null) ||
    (state.phase === "stable" && state.transitionId !== null)
  ) {
    throw new Error(
      `Runtime supervisor ${state.phase} transition ID relationship is invalid.`,
    );
  }
  if (["candidate-active", "rolling-back"].includes(state.phase)) {
    if (state.previous === null || state.candidate !== null) {
      throw new Error(
        `Runtime supervisor ${state.phase} previous relationship is invalid.`,
      );
    }
  }
  if (state.phase === "stable" && state.candidate !== null) {
    throw new Error(
      "Stable Runtime supervisor state may not retain a candidate.",
    );
  }
  const failureRequired = ["rolling-back", "needs-attention"].includes(
    state.phase,
  );
  if (
    failureRequired !==
    (state.failureCode !== null && state.failureDigest !== null)
  ) {
    throw new Error(
      `Runtime supervisor ${state.phase} failure relationship is invalid.`,
    );
  }
}

export function parseRuntimeSupervisorState(
  value: unknown,
): RuntimeSupervisorState {
  if (!isRecord(value)) {
    throw new Error("Runtime supervisor state must be an object.");
  }
  assertExactKeys(value, STATE_KEYS, "Runtime supervisor state");
  if (value.schemaVersion !== RUNTIME_SUPERVISOR_STATE_SCHEMA_VERSION) {
    throw new Error("Unsupported Runtime supervisor state schema version.");
  }
  if (
    !RUNTIME_SUPERVISOR_PHASES.includes(value.phase as RuntimeSupervisorPhase)
  ) {
    throw new Error("Runtime supervisor phase is invalid.");
  }
  if (typeof value.externalRefreshRequired !== "boolean") {
    throw new Error(
      "Runtime supervisor externalRefreshRequired must be boolean.",
    );
  }
  const state: RuntimeSupervisorState = {
    schemaVersion: RUNTIME_SUPERVISOR_STATE_SCHEMA_VERSION,
    phase: value.phase as RuntimeSupervisorPhase,
    epoch: parsePositiveInteger(value.epoch, "Runtime supervisor epoch"),
    active: parseRuntimeSlotIdentity(value.active, "Active Runtime"),
    previous:
      value.previous === null
        ? null
        : parseRuntimeSlotIdentity(value.previous, "Previous Runtime"),
    candidate:
      value.candidate === null
        ? null
        : parseRuntimeSlotIdentity(value.candidate, "Candidate Runtime"),
    transitionId: parseNullableIdentifier(
      value.transitionId,
      "Runtime supervisor transition ID",
    ),
    phaseStartedAt: parseTimestamp(
      value.phaseStartedAt,
      "Runtime supervisor phaseStartedAt",
    ),
    updatedAt: parseTimestamp(value.updatedAt, "Runtime supervisor updatedAt"),
    managedSessionRevision: parseNonNegativeInteger(
      value.managedSessionRevision,
      "Runtime supervisor managed session revision",
    ),
    externalRefreshRequired: value.externalRefreshRequired,
    lastReportId: parseNullableIdentifier(
      value.lastReportId,
      "Runtime supervisor report ID",
    ),
    failureCode: parseNullableFailureCode(value.failureCode),
    failureDigest: parseNullableDigest(
      value.failureDigest,
      "Runtime supervisor failure digest",
    ),
  };
  validateStateRelationships(state);
  return state;
}

export function createRuntimeSupervisorState(
  active: RuntimeSlotIdentity,
  at = new Date().toISOString(),
): RuntimeSupervisorState {
  const timestamp = parseTimestamp(at, "Runtime supervisor creation timestamp");
  const state: RuntimeSupervisorState = {
    schemaVersion: RUNTIME_SUPERVISOR_STATE_SCHEMA_VERSION,
    phase: "stable",
    epoch: 1,
    active: parseRuntimeSlotIdentity(active, "Initial active Runtime"),
    previous: null,
    candidate: null,
    transitionId: null,
    phaseStartedAt: timestamp,
    updatedAt: timestamp,
    managedSessionRevision: 0,
    externalRefreshRequired: false,
    lastReportId: null,
    failureCode: null,
    failureDigest: null,
  };
  validateStateRelationships(state);
  return state;
}

function validateEventBinding(
  state: RuntimeSupervisorState,
  event: RuntimeSupervisorEpochEvent,
): string {
  const at = parseTimestamp(event.at, "Runtime supervisor event timestamp");
  if (event.expectedEpoch !== state.epoch) {
    throw new Error("Runtime supervisor event belongs to a stale epoch.");
  }
  if (event.transitionId !== state.transitionId) {
    throw new Error("Runtime supervisor event belongs to a stale transition.");
  }
  if (Date.parse(at) < Date.parse(state.updatedAt)) {
    throw new Error("Runtime supervisor event predates the current state.");
  }
  return at;
}

function nextState(
  state: RuntimeSupervisorState,
  patch: Partial<Omit<RuntimeSupervisorState, "schemaVersion">>,
): RuntimeSupervisorState {
  const next: RuntimeSupervisorState = {
    ...state,
    ...patch,
    schemaVersion: RUNTIME_SUPERVISOR_STATE_SCHEMA_VERSION,
  };
  validateStateRelationships(next);
  return next;
}

export function reduceRuntimeSupervisorState(
  stateInput: RuntimeSupervisorState,
  event: RuntimeSupervisorEvent,
): RuntimeSupervisorState {
  const state = parseRuntimeSupervisorState(stateInput);
  if (event.type === "stage-candidate") {
    if (state.phase !== "stable") {
      throw new Error("A Runtime transition is already active.");
    }
    const at = parseTimestamp(event.at, "Runtime supervisor event timestamp");
    if (Date.parse(at) < Date.parse(state.updatedAt)) {
      throw new Error("Runtime supervisor event predates the current state.");
    }
    const candidate = parseRuntimeSlotIdentity(
      event.candidate,
      "Staged candidate Runtime",
    );
    if (
      sameRelease(candidate, state.active) ||
      candidate.runtimeGeneration <= state.active.runtimeGeneration
    ) {
      throw new Error("Staged candidate is not a distinct newer Runtime.");
    }
    const epoch = state.epoch + 1;
    if (!Number.isSafeInteger(epoch)) {
      throw new Error("Runtime supervisor epoch limit reached.");
    }
    return nextState(state, {
      phase: "candidate-starting",
      epoch,
      candidate,
      transitionId: parseIdentifier(
        event.transitionId,
        "Runtime supervisor transition ID",
      ),
      phaseStartedAt: at,
      updatedAt: at,
      externalRefreshRequired: false,
      lastReportId: null,
      failureCode: null,
      failureDigest: null,
    });
  }

  const at = validateEventBinding(state, event);
  switch (event.type) {
    case "candidate-ready":
      if (state.phase !== "candidate-starting") {
        throw new Error("Candidate Runtime is not starting.");
      }
      return nextState(state, {
        phase: "candidate-ready",
        phaseStartedAt: at,
        updatedAt: at,
      });
    case "begin-quiesce":
      if (state.phase !== "candidate-ready") {
        throw new Error("Candidate Runtime is not ready for quiesce.");
      }
      return nextState(state, {
        phase: "quiescing",
        phaseStartedAt: at,
        updatedAt: at,
      });
    case "begin-publish":
      if (state.phase !== "quiescing") {
        throw new Error("Live Runtime is not quiesced for publication.");
      }
      return nextState(state, {
        phase: "publishing",
        phaseStartedAt: at,
        updatedAt: at,
      });
    case "candidate-published": {
      if (state.phase !== "publishing" || state.candidate === null) {
        throw new Error("Candidate Runtime publication is not active.");
      }
      return nextState(state, {
        phase: "candidate-active",
        active: state.candidate,
        previous: state.active,
        candidate: null,
        phaseStartedAt: at,
        updatedAt: at,
        managedSessionRevision: parseNonNegativeInteger(
          event.managedSessionRevision,
          "Managed session revision",
        ),
        externalRefreshRequired: event.externalRefreshRequired,
      });
    }
    case "commit-candidate":
      if (state.phase !== "candidate-active") {
        throw new Error("Candidate Runtime is not active for commit.");
      }
      return nextState(state, {
        phase: "stable",
        transitionId: null,
        phaseStartedAt: at,
        updatedAt: at,
        lastReportId: parseIdentifier(
          event.reportId,
          "Runtime cutover report ID",
        ),
        failureCode: null,
        failureDigest: null,
      });
    case "begin-rollback":
      if (state.phase !== "candidate-active" || state.previous === null) {
        throw new Error("Candidate Runtime is not active for rollback.");
      }
      return nextState(state, {
        phase: "rolling-back",
        phaseStartedAt: at,
        updatedAt: at,
        failureCode: parseFailureCode(event.failureCode),
        failureDigest: parseDigest(
          event.failureDigest,
          "Rollback failure digest",
        ),
      });
    case "rollback-published":
      if (state.phase !== "rolling-back" || state.previous === null) {
        throw new Error("Runtime rollback is not active.");
      }
      if (!sameRelease(event.restored, state.previous)) {
        throw new Error("Rollback restored the wrong Runtime release.");
      }
      return nextState(state, {
        phase: "stable",
        active: parseRuntimeSlotIdentity(event.restored, "Restored Runtime"),
        previous: null,
        candidate: null,
        transitionId: null,
        phaseStartedAt: at,
        updatedAt: at,
        managedSessionRevision: parseNonNegativeInteger(
          event.managedSessionRevision,
          "Managed session revision",
        ),
        externalRefreshRequired: event.externalRefreshRequired,
        lastReportId: parseIdentifier(
          event.reportId,
          "Runtime rollback report ID",
        ),
        failureCode: null,
        failureDigest: null,
      });
    case "fail":
      return nextState(state, {
        phase: "needs-attention",
        candidate: null,
        phaseStartedAt: at,
        updatedAt: at,
        failureCode: parseFailureCode(event.failureCode),
        failureDigest: parseDigest(
          event.failureDigest,
          "Runtime failure digest",
        ),
      });
  }
}

function parsePublishedRuntimeObservation(
  value: PublishedRuntimeObservation,
): PublishedRuntimeObservation {
  const expectedKeys = [
    "revision",
    "runtimeGeneration",
    "instanceId",
    "endpoint",
    "manifestDigest",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expectedKeys.length ||
    !Object.keys(value).every((key) => expectedKeys.includes(key)) ||
    !expectedKeys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error("Published Runtime observation has an invalid shape.");
  }
  return {
    revision: parsePositiveInteger(
      value.revision,
      "Published Runtime revision",
    ),
    runtimeGeneration: parsePositiveInteger(
      value.runtimeGeneration,
      "Published Runtime generation",
    ),
    instanceId: parseIdentifier(
      value.instanceId,
      "Published Runtime instance ID",
    ),
    endpoint: parseEndpoint(value.endpoint),
    manifestDigest: parseDigest(
      value.manifestDigest,
      "Published Runtime manifest digest",
    ),
  };
}

function observationFor(
  observations: readonly RuntimeObservation[],
  runtime: RuntimeSlotIdentity | null,
): RuntimeObservation | null {
  if (runtime === null) {
    return null;
  }
  const observation =
    observations.find(
      (candidate) => candidate.runtime.instanceId === runtime.instanceId,
    ) ?? null;
  if (
    observation !== null &&
    (!sameRelease(observation.runtime, runtime) ||
      observation.runtime.manifestDigest !== runtime.manifestDigest)
  ) {
    throw new Error(
      "Runtime recovery observation reuses an instance ID for a different release.",
    );
  }
  return observation;
}

function healthy(observation: RuntimeObservation | null): boolean {
  return observation?.alive === true && observation.healthy === true;
}

function maximumGeneration(
  state: RuntimeSupervisorState,
  observations: readonly RuntimeObservation[],
  publication: PublishedRuntimeObservation,
): number {
  return Math.max(
    state.active.runtimeGeneration,
    state.previous?.runtimeGeneration ?? 0,
    state.candidate?.runtimeGeneration ?? 0,
    publication.runtimeGeneration,
    ...observations.map((observation) => observation.runtime.runtimeGeneration),
  );
}

function withGeneration(
  runtime: RuntimeSlotIdentity,
  runtimeGeneration: number,
): RuntimeSlotIdentity {
  return parseRuntimeSlotIdentity({
    ...runtime,
    runtimeGeneration,
  });
}

function stableRecoveredState(
  state: RuntimeSupervisorState,
  active: RuntimeSlotIdentity,
  at: string,
  previous: RuntimeSlotIdentity | null = null,
): RuntimeSupervisorState {
  return parseRuntimeSupervisorState({
    ...state,
    phase: "stable",
    active,
    previous,
    candidate: null,
    transitionId: null,
    phaseStartedAt: at,
    updatedAt: at,
    failureCode: null,
    failureDigest: null,
  });
}

function attentionPlan(
  state: RuntimeSupervisorState,
  at: string,
  failureCode: string,
  failureDigest: string,
): RuntimeRecoveryPlan {
  const next = parseRuntimeSupervisorState({
    ...state,
    phase: "needs-attention",
    candidate: null,
    phaseStartedAt: at,
    updatedAt: at,
    failureCode,
    failureDigest,
  });
  return {
    schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
    outcome: "needs-attention",
    state: next,
    actions: [
      {
        kind: "mark-needs-attention",
        failureCode,
        failureDigest,
      },
    ],
  };
}

function publishActions(
  publication: PublishedRuntimeObservation,
  fromGeneration: number,
  runtime: RuntimeSlotIdentity,
): readonly RuntimeRecoveryAction[] {
  return [
    {
      kind: "publish-runtime",
      runtime,
      expectedPublicationRevision: publication.revision,
      expectedPublicationGeneration: publication.runtimeGeneration,
    },
    {
      kind: "rebind-managed-sessions",
      fromGeneration,
      to: runtime,
    },
  ];
}

export function planRuntimeSupervisorRecovery(input: {
  readonly state: RuntimeSupervisorState;
  readonly observations: readonly RuntimeObservation[];
  readonly publication: PublishedRuntimeObservation;
  readonly at: string;
  readonly failureDigest: string;
}): RuntimeRecoveryPlan {
  const state = parseRuntimeSupervisorState(input.state);
  const at = parseTimestamp(input.at, "Runtime recovery timestamp");
  const failureDigest = parseDigest(
    input.failureDigest,
    "Runtime recovery digest",
  );
  if (input.observations.length > 128) {
    throw new Error(
      "Runtime recovery observation inventory exceeds its bound.",
    );
  }
  const publication = parsePublishedRuntimeObservation(input.publication);
  const observations = input.observations.map((observation) => {
    if (
      typeof observation.alive !== "boolean" ||
      typeof observation.healthy !== "boolean" ||
      (observation.healthy && !observation.alive)
    ) {
      throw new Error("Runtime recovery observation health flags are invalid.");
    }
    return {
      runtime: parseRuntimeSlotIdentity(observation.runtime),
      alive: observation.alive,
      healthy: observation.healthy,
    };
  });
  const instanceIds = observations.map(
    (observation) => observation.runtime.instanceId,
  );
  if (new Set(instanceIds).size !== instanceIds.length) {
    throw new Error(
      "Runtime recovery observation inventory contains duplicate instances.",
    );
  }
  const activeObservation = observationFor(observations, state.active);
  const previousObservation = observationFor(observations, state.previous);
  const candidateObservation = observationFor(observations, state.candidate);
  const activeRuntime = activeObservation?.runtime ?? state.active;
  const previousRuntime = previousObservation?.runtime ?? state.previous;
  const candidateRuntime = candidateObservation?.runtime ?? state.candidate;
  const publishedActive = samePublishedRuntime(publication, activeRuntime);
  const publishedCandidate =
    candidateRuntime !== null &&
    samePublishedRuntime(publication, candidateRuntime);
  const nextGeneration =
    maximumGeneration(state, observations, publication) + 1;
  if (!Number.isSafeInteger(nextGeneration)) {
    throw new Error("Runtime recovery generation limit reached.");
  }

  if (state.phase === "needs-attention") {
    return {
      schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
      outcome: "needs-attention",
      state,
      actions: [
        {
          kind: "mark-needs-attention",
          failureCode: state.failureCode ?? "RECOVERY_REQUIRED",
          failureDigest: state.failureDigest ?? failureDigest,
        },
      ],
    };
  }

  if (state.phase === "stable") {
    if (healthy(activeObservation) && publishedActive) {
      return {
        schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
        outcome: "held",
        state: stableRecoveredState(state, activeRuntime, at, previousRuntime),
        actions: [
          {
            kind: "hold",
            reason: "Observed active Runtime is healthy and published.",
          },
        ],
      };
    }
    if (healthy(activeObservation)) {
      const restored = withGeneration(activeRuntime, nextGeneration);
      return {
        schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
        outcome: "restored-active",
        state: stableRecoveredState(state, restored, at, previousRuntime),
        actions: [
          {
            kind: "resume-runtime",
            instanceId: activeRuntime.instanceId,
            expectedGeneration: activeRuntime.runtimeGeneration,
            nextGeneration,
          },
          ...publishActions(
            publication,
            publication.runtimeGeneration,
            restored,
          ),
        ],
      };
    }
    if (state.previous !== null && healthy(previousObservation)) {
      const restored = withGeneration(
        previousObservation?.runtime ?? state.previous,
        nextGeneration,
      );
      const rollbackTarget = previousObservation?.runtime ?? state.previous;
      const actions: RuntimeRecoveryAction[] = [
        {
          kind: "resume-runtime",
          instanceId: rollbackTarget.instanceId,
          expectedGeneration: rollbackTarget.runtimeGeneration,
          nextGeneration,
        },
        ...publishActions(publication, publication.runtimeGeneration, restored),
      ];
      if (activeObservation?.alive === true) {
        actions.push({
          kind: "stop-runtime",
          instanceId: activeRuntime.instanceId,
          reason:
            "Unhealthy active Runtime was replaced by previous healthy Runtime.",
        });
      }
      return {
        schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
        outcome: "rolled-back",
        state: stableRecoveredState(state, restored, at),
        actions,
      };
    }
    return attentionPlan(state, at, "NO_HEALTHY_RUNTIME", failureDigest);
  }

  if (["candidate-starting", "candidate-ready"].includes(state.phase)) {
    if (!healthy(activeObservation)) {
      return attentionPlan(
        state,
        at,
        "ACTIVE_UNHEALTHY_DURING_CANDIDATE_PREPARATION",
        failureDigest,
      );
    }
    const actions: RuntimeRecoveryAction[] = [];
    if (candidateObservation?.alive === true && state.candidate !== null) {
      actions.push({
        kind: "stop-runtime",
        instanceId: (candidateObservation?.runtime ?? state.candidate)
          .instanceId,
        reason:
          "Interrupted candidate preparation is discarded during recovery.",
      });
    }
    if (!publishedActive) {
      const restored = withGeneration(activeRuntime, nextGeneration);
      actions.push(
        {
          kind: "resume-runtime",
          instanceId: activeRuntime.instanceId,
          expectedGeneration: activeRuntime.runtimeGeneration,
          nextGeneration,
        },
        ...publishActions(publication, publication.runtimeGeneration, restored),
      );
      return {
        schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
        outcome: "restored-active",
        state: stableRecoveredState(state, restored, at, previousRuntime),
        actions,
      };
    }
    actions.push({
      kind: "hold",
      reason:
        "Live Runtime remained authoritative; interrupted candidate was discarded.",
    });
    return {
      schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
      outcome: "restored-active",
      state: stableRecoveredState(state, activeRuntime, at, previousRuntime),
      actions,
    };
  }

  if (["quiescing", "publishing"].includes(state.phase)) {
    if (
      publishedCandidate &&
      healthy(candidateObservation) &&
      candidateRuntime !== null
    ) {
      const continued = parseRuntimeSupervisorState({
        ...state,
        phase: "candidate-active",
        active: candidateRuntime,
        previous: activeRuntime,
        candidate: null,
        phaseStartedAt: at,
        updatedAt: at,
      });
      return {
        schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
        outcome: "continued-candidate",
        state: continued,
        actions: [
          {
            kind: "rebind-managed-sessions",
            fromGeneration: activeRuntime.runtimeGeneration,
            to: continued.active,
          },
          {
            kind: "continue-canary",
            instanceId: continued.active.instanceId,
            runtimeGeneration: continued.active.runtimeGeneration,
          },
        ],
      };
    }
    if (healthy(activeObservation)) {
      const restored = withGeneration(activeRuntime, nextGeneration);
      const actions: RuntimeRecoveryAction[] = [
        {
          kind: "resume-runtime",
          instanceId: activeRuntime.instanceId,
          expectedGeneration: activeRuntime.runtimeGeneration,
          nextGeneration,
        },
        ...publishActions(publication, publication.runtimeGeneration, restored),
      ];
      if (candidateObservation?.alive === true && state.candidate !== null) {
        actions.push({
          kind: "stop-runtime",
          instanceId: (candidateObservation?.runtime ?? state.candidate)
            .instanceId,
          reason:
            "Candidate was not authoritative after interrupted publication.",
        });
      }
      return {
        schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
        outcome: "restored-active",
        state: stableRecoveredState(state, restored, at, previousRuntime),
        actions,
      };
    }
    return attentionPlan(
      state,
      at,
      "INTERRUPTED_PUBLICATION_WITHOUT_HEALTHY_RUNTIME",
      failureDigest,
    );
  }

  if (state.phase === "candidate-active") {
    if (healthy(activeObservation) && publishedActive) {
      return {
        schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
        outcome: "continued-candidate",
        state: parseRuntimeSupervisorState({
          ...state,
          active: activeRuntime,
          previous: previousRuntime,
          updatedAt: at,
        }),
        actions: [
          {
            kind: "continue-canary",
            instanceId: activeRuntime.instanceId,
            runtimeGeneration: activeRuntime.runtimeGeneration,
          },
        ],
      };
    }
    if (state.previous !== null && healthy(previousObservation)) {
      const restored = withGeneration(
        previousObservation?.runtime ?? state.previous,
        nextGeneration,
      );
      const actions: RuntimeRecoveryAction[] = [
        {
          kind: "resume-runtime",
          instanceId: (previousObservation?.runtime ?? state.previous)
            .instanceId,
          expectedGeneration: (previousObservation?.runtime ?? state.previous)
            .runtimeGeneration,
          nextGeneration,
        },
        ...publishActions(publication, publication.runtimeGeneration, restored),
      ];
      if (activeObservation?.alive === true) {
        actions.push({
          kind: "stop-runtime",
          instanceId: activeRuntime.instanceId,
          reason: "Candidate Runtime failed recovery health checks.",
        });
      }
      return {
        schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
        outcome: "rolled-back",
        state: stableRecoveredState(state, restored, at),
        actions,
      };
    }
    return attentionPlan(
      state,
      at,
      "CANDIDATE_ACTIVE_WITHOUT_ROLLBACK_TARGET",
      failureDigest,
    );
  }

  if (state.phase === "rolling-back") {
    if (state.previous !== null && healthy(previousObservation)) {
      const restored = withGeneration(
        previousObservation?.runtime ?? state.previous,
        nextGeneration,
      );
      const actions: RuntimeRecoveryAction[] = [];
      if (!samePublishedRuntime(publication, restored)) {
        actions.push(
          {
            kind: "resume-runtime",
            instanceId: (previousObservation?.runtime ?? state.previous)
              .instanceId,
            expectedGeneration: (previousObservation?.runtime ?? state.previous)
              .runtimeGeneration,
            nextGeneration,
          },
          ...publishActions(
            publication,
            publication.runtimeGeneration,
            restored,
          ),
        );
      }
      if (activeObservation?.alive === true) {
        actions.push({
          kind: "stop-runtime",
          instanceId: activeRuntime.instanceId,
          reason: "Rollback target is authoritative after recovery.",
        });
      }
      if (actions.length === 0) {
        actions.push({
          kind: "hold",
          reason: "Persisted rollback target is already healthy and published.",
        });
      }
      return {
        schemaVersion: RUNTIME_SUPERVISOR_RECOVERY_SCHEMA_VERSION,
        outcome: "rolled-back",
        state: stableRecoveredState(state, restored, at),
        actions,
      };
    }
    return attentionPlan(
      state,
      at,
      "ROLLBACK_TARGET_UNAVAILABLE",
      failureDigest,
    );
  }

  return attentionPlan(state, at, "RECOVERY_STATE_UNSUPPORTED", failureDigest);
}
