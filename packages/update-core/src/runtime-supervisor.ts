import { createHash, randomUUID } from "node:crypto";

import {
  MANAGED_SESSION_REBIND_REPORT_SCHEMA_VERSION,
  type ManagedRuntimeSessionRegistry,
  type ManagedSessionRebindReport,
  type RuntimeSessionTarget,
} from "./managed-session-registry.js";
import {
  parseRuntimeSlotIdentity,
  parseRuntimeSupervisorState,
  planRuntimeSupervisorRecovery,
  type PublishedRuntimeObservation,
  type RuntimeObservation,
  type RuntimeRecoveryAction,
  type RuntimeRecoveryPlan,
  type RuntimeSlotIdentity,
  type RuntimeSupervisorState,
} from "./runtime-supervisor-state.js";
import {
  RuntimeSupervisorStoreError,
  type RuntimeSupervisorStore,
  type RuntimeSupervisorStoreSnapshot,
} from "./runtime-supervisor-store.js";

export const RUNTIME_SUPERVISOR_EXECUTION_SCHEMA_VERSION =
  "scr.runtime-supervisor-execution/v1" as const;
export const RUNTIME_SUPERVISOR_STATUS_SCHEMA_VERSION =
  "scr.runtime-supervisor-status/v1" as const;

const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ACTIONS = 256;

export type RuntimeSupervisorCoordinatorErrorCode =
  | "EXECUTION_BUSY"
  | "ACTION_FAILED"
  | "ACTION_TIMEOUT"
  | "ACTION_RESULT_INVALID"
  | "STATE_CONFLICT"
  | "PLAN_INVALID";

export class RuntimeSupervisorCoordinatorError extends Error {
  readonly code: RuntimeSupervisorCoordinatorErrorCode;

  constructor(
    code: RuntimeSupervisorCoordinatorErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "RuntimeSupervisorCoordinatorError";
    this.code = code;
  }
}

export interface RuntimeCanaryResult {
  readonly healthy: boolean;
  readonly failureCode: string | null;
  readonly failureDigest: string | null;
}

export interface RuntimeSupervisorActionPort {
  observeRuntimes(
    state: RuntimeSupervisorState,
    signal: AbortSignal,
  ): Promise<readonly RuntimeObservation[]>;
  readPublication(signal: AbortSignal): Promise<PublishedRuntimeObservation>;
  resumeRuntime(
    input: {
      readonly instanceId: string;
      readonly expectedGeneration: number;
      readonly nextGeneration: number;
    },
    signal: AbortSignal,
  ): Promise<RuntimeSlotIdentity>;
  publishRuntime(
    input: {
      readonly runtime: RuntimeSlotIdentity;
      readonly expectedPublicationRevision: number;
      readonly expectedPublicationGeneration: number;
    },
    signal: AbortSignal,
  ): Promise<PublishedRuntimeObservation>;
  stopRuntime(
    input: { readonly instanceId: string; readonly reason: string },
    signal: AbortSignal,
  ): Promise<void>;
  continueCanary(
    input: {
      readonly instanceId: string;
      readonly runtimeGeneration: number;
    },
    signal: AbortSignal,
  ): Promise<RuntimeCanaryResult>;
  markNeedsAttention?(
    input: { readonly failureCode: string; readonly failureDigest: string },
    signal: AbortSignal,
  ): Promise<void>;
}

export interface RuntimeSupervisorActionExecution {
  readonly index: number;
  readonly kind: RuntimeRecoveryAction["kind"];
  readonly outcome: "succeeded" | "failed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly failureCode: string | null;
  readonly failureDigest: string | null;
}

export interface RuntimeSupervisorExecutionReport {
  readonly schemaVersion: typeof RUNTIME_SUPERVISOR_EXECUTION_SCHEMA_VERSION;
  readonly id: string;
  readonly outcome:
    "applied" | "held" | "needs-attention" | "conflict" | "failed";
  readonly planOutcome: RuntimeRecoveryPlan["outcome"] | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly sourceRevision: number | null;
  readonly sourceEntrySha256: string | null;
  readonly committedRevision: number | null;
  readonly committedEntrySha256: string | null;
  readonly actionExecutions: readonly RuntimeSupervisorActionExecution[];
  readonly managedSessionReport: ManagedSessionRebindReport | null;
  readonly errorCode: string | null;
  readonly errorDigest: string | null;
}

export interface RuntimeSupervisorExecutionResult {
  readonly report: RuntimeSupervisorExecutionReport;
  readonly snapshot: RuntimeSupervisorStoreSnapshot | null;
}

export interface RuntimeSupervisorStatus {
  readonly schemaVersion: typeof RUNTIME_SUPERVISOR_STATUS_SCHEMA_VERSION;
  readonly ledger: RuntimeSupervisorStoreSnapshot;
  readonly sessions: ReturnType<ManagedRuntimeSessionRegistry["snapshot"]>;
  readonly executionActive: boolean;
}

export interface RuntimeSupervisorCoordinatorOptions {
  readonly store: RuntimeSupervisorStore;
  readonly sessions: ManagedRuntimeSessionRegistry;
  readonly actions: RuntimeSupervisorActionPort;
  readonly rebindTimeoutMs?: number;
  readonly rebindConcurrency?: number;
  readonly discoveryTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  readonly clock?: () => Date;
}

interface ExecutionContext {
  publication: PublishedRuntimeObservation;
  managedSessionReport: ManagedSessionRebindReport | null;
}

function boundedErrorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\0\r\n]+/gu, " ")
    .slice(0, 2_000);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function runWithTimeout<T>(
  label: string,
  timeoutMs: number,
  outerSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (outerSignal.aborted) {
    throw outerSignal.reason instanceof Error
      ? outerSignal.reason
      : new Error(`${label} was cancelled.`);
  }
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(
      outerSignal.reason instanceof Error
        ? outerSignal.reason
        : new Error(`${label} was cancelled.`),
    );
  };
  outerSignal.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      new RuntimeSupervisorCoordinatorError(
        "ACTION_TIMEOUT",
        `${label} exceeded its ${timeoutMs}ms deadline.`,
      ),
    );
  }, timeoutMs);
  let abortListener: (() => void) | undefined;
  try {
    return await new Promise<T>((resolveOperation, rejectOperation) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (abortListener !== undefined) {
          controller.signal.removeEventListener("abort", abortListener);
        }
        callback();
      };
      abortListener = () => {
        finish(() =>
          rejectOperation(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error(`${label} was cancelled.`),
          ),
        );
      };
      controller.signal.addEventListener("abort", abortListener, {
        once: true,
      });
      if (controller.signal.aborted) {
        abortListener();
        return;
      }
      Promise.resolve()
        .then(() => operation(controller.signal))
        .then(
          (value) => finish(() => resolveOperation(value)),
          (error: unknown) =>
            finish(() =>
              rejectOperation(
                error instanceof Error
                  ? error
                  : new RuntimeSupervisorCoordinatorError(
                      "ACTION_FAILED",
                      `${label} failed without an Error value.`,
                    ),
              ),
            ),
        );
    });
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", forwardAbort);
    if (abortListener !== undefined) {
      controller.signal.removeEventListener("abort", abortListener);
    }
  }
}

function failureCode(error: unknown, fallback: string): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    FAILURE_CODE_PATTERN.test(error.code)
  ) {
    return error.code;
  }
  return fallback;
}

function sameRuntimeIdentity(
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

function expectedRuntimeFor(
  state: RuntimeSupervisorState,
  instanceId: string,
): RuntimeSlotIdentity | null {
  for (const runtime of [state.active, state.previous, state.candidate]) {
    if (runtime?.instanceId === instanceId) {
      return runtime;
    }
  }
  return null;
}

function validatePublication(
  value: PublishedRuntimeObservation,
): PublishedRuntimeObservation {
  const record = value as unknown as Record<string, unknown>;
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
    Object.keys(record).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(record, key)) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.runtimeGeneration !== "number" ||
    !Number.isSafeInteger(value.runtimeGeneration) ||
    value.runtimeGeneration < 1 ||
    typeof value.instanceId !== "string" ||
    value.instanceId.length < 1 ||
    value.instanceId.length > 128 ||
    typeof value.endpoint !== "string" ||
    typeof value.manifestDigest !== "string" ||
    !SHA256_PATTERN.test(value.manifestDigest)
  ) {
    throw new RuntimeSupervisorCoordinatorError(
      "ACTION_RESULT_INVALID",
      "Runtime publication result is malformed.",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw new RuntimeSupervisorCoordinatorError(
      "ACTION_RESULT_INVALID",
      "Runtime publication endpoint is invalid.",
    );
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      endpoint.hostname.toLowerCase(),
    ) ||
    endpoint.pathname !== "/mcp" ||
    endpoint.username.length !== 0 ||
    endpoint.password.length !== 0 ||
    endpoint.search.length !== 0 ||
    endpoint.hash.length !== 0
  ) {
    throw new RuntimeSupervisorCoordinatorError(
      "ACTION_RESULT_INVALID",
      "Runtime publication endpoint is not an uncredentialed loopback /mcp URL.",
    );
  }
  return value;
}

function parseCanary(value: RuntimeCanaryResult): RuntimeCanaryResult {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.healthy !== "boolean" ||
    (value.failureCode !== null &&
      (typeof value.failureCode !== "string" ||
        !FAILURE_CODE_PATTERN.test(value.failureCode))) ||
    (value.failureDigest !== null &&
      (typeof value.failureDigest !== "string" ||
        !SHA256_PATTERN.test(value.failureDigest))) ||
    (value.healthy &&
      (value.failureCode !== null || value.failureDigest !== null)) ||
    (!value.healthy &&
      (value.failureCode === null || value.failureDigest === null))
  ) {
    throw new RuntimeSupervisorCoordinatorError(
      "ACTION_RESULT_INVALID",
      "Runtime canary result is malformed.",
    );
  }
  return value;
}

function updateSessionMetadata(
  state: RuntimeSupervisorState,
  report: ManagedSessionRebindReport | null,
): RuntimeSupervisorState {
  if (report === null) {
    return state;
  }
  return parseRuntimeSupervisorState({
    ...state,
    managedSessionRevision: report.registryRevision,
    externalRefreshRequired: report.externalRefreshRequired,
  });
}

export class RuntimeSupervisorCoordinator {
  readonly #store: RuntimeSupervisorStore;
  readonly #sessions: ManagedRuntimeSessionRegistry;
  readonly #actions: RuntimeSupervisorActionPort;
  readonly #rebindTimeoutMs: number;
  readonly #rebindConcurrency: number;
  readonly #discoveryTimeoutMs: number;
  readonly #actionTimeoutMs: number;
  readonly #clock: () => Date;
  #executionActive = false;

  constructor(options: RuntimeSupervisorCoordinatorOptions) {
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#actions = options.actions;
    this.#rebindTimeoutMs = options.rebindTimeoutMs ?? 15_000;
    this.#rebindConcurrency = options.rebindConcurrency ?? 4;
    this.#discoveryTimeoutMs = options.discoveryTimeoutMs ?? 30_000;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? 60_000;
    this.#clock = options.clock ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.#rebindTimeoutMs) ||
      this.#rebindTimeoutMs < 100 ||
      this.#rebindTimeoutMs > 300_000 ||
      !Number.isSafeInteger(this.#rebindConcurrency) ||
      this.#rebindConcurrency < 1 ||
      this.#rebindConcurrency > 32 ||
      !Number.isSafeInteger(this.#discoveryTimeoutMs) ||
      this.#discoveryTimeoutMs < 100 ||
      this.#discoveryTimeoutMs > 300_000 ||
      !Number.isSafeInteger(this.#actionTimeoutMs) ||
      this.#actionTimeoutMs < this.#rebindTimeoutMs ||
      this.#actionTimeoutMs > 300_000
    ) {
      throw new RuntimeSupervisorCoordinatorError(
        "PLAN_INVALID",
        "Runtime supervisor execution limits are invalid.",
      );
    }
  }

  async initialize(
    state: RuntimeSupervisorState,
  ): Promise<RuntimeSupervisorStoreSnapshot> {
    return await this.#store.initialize(state);
  }

  async status(): Promise<RuntimeSupervisorStatus> {
    return {
      schemaVersion: RUNTIME_SUPERVISOR_STATUS_SCHEMA_VERSION,
      ledger: await this.#store.load(),
      sessions: this.#sessions.snapshot(),
      executionActive: this.#executionActive,
    };
  }

  async recover(input: {
    readonly at?: string;
    readonly failureDigest: string;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeSupervisorExecutionResult> {
    if (this.#executionActive) {
      throw new RuntimeSupervisorCoordinatorError(
        "EXECUTION_BUSY",
        "Runtime supervisor recovery is already active.",
      );
    }
    if (!SHA256_PATTERN.test(input.failureDigest)) {
      throw new RuntimeSupervisorCoordinatorError(
        "PLAN_INVALID",
        "Runtime supervisor recovery failure digest must be lowercase SHA-256.",
      );
    }
    this.#executionActive = true;
    const reportId = randomUUID();
    const startedAtMs = this.#clock().getTime();
    const startedAt = new Date(startedAtMs).toISOString();
    const actionExecutions: RuntimeSupervisorActionExecution[] = [];
    let source: RuntimeSupervisorStoreSnapshot | null = null;
    let plan: RuntimeRecoveryPlan | null = null;
    let committed: RuntimeSupervisorStoreSnapshot | null = null;
    let context: ExecutionContext | null = null;
    let error: unknown = null;
    let outcome: RuntimeSupervisorExecutionReport["outcome"] = "failed";
    const executionSignal = input.signal ?? new AbortController().signal;

    try {
      if (executionSignal.aborted) {
        throw executionSignal.reason instanceof Error
          ? executionSignal.reason
          : new Error("Runtime supervisor recovery was cancelled.");
      }
      const loadedSource = await this.#store.load();
      source = loadedSource;
      const sessionSnapshot = this.#sessions.snapshot();
      if (
        sessionSnapshot.revision < loadedSource.state.managedSessionRevision
      ) {
        throw new RuntimeSupervisorCoordinatorError(
          "PLAN_INVALID",
          "Managed session registry revision regresses the persisted supervisor state.",
        );
      }
      const [observations, publication] = await Promise.all([
        runWithTimeout(
          "Runtime observation",
          this.#discoveryTimeoutMs,
          executionSignal,
          (signal) => this.#actions.observeRuntimes(loadedSource.state, signal),
        ),
        runWithTimeout(
          "Runtime publication observation",
          this.#discoveryTimeoutMs,
          executionSignal,
          (signal) => this.#actions.readPublication(signal),
        ),
      ]);
      const executionContext: ExecutionContext = {
        publication: validatePublication(publication),
        managedSessionReport: null,
      };
      context = executionContext;
      const recoveryPlan = planRuntimeSupervisorRecovery({
        state: loadedSource.state,
        observations,
        publication: executionContext.publication,
        at: input.at ?? this.#clock().toISOString(),
        failureDigest: input.failureDigest,
      });
      plan = recoveryPlan;
      if (recoveryPlan.actions.length > MAX_ACTIONS) {
        throw new RuntimeSupervisorCoordinatorError(
          "PLAN_INVALID",
          "Runtime supervisor recovery plan exceeds its action bound.",
        );
      }
      for (let index = 0; index < recoveryPlan.actions.length; index += 1) {
        const action = recoveryPlan.actions[index]!;
        const executionStartedMs = this.#clock().getTime();
        const executionStartedAt = new Date(executionStartedMs).toISOString();
        try {
          await runWithTimeout(
            `Runtime recovery action ${action.kind}`,
            this.#actionTimeoutMs,
            executionSignal,
            (signal) =>
              this.#executeAction(
                action,
                recoveryPlan.state,
                executionContext,
                signal,
              ),
          );
          const completedMs = this.#clock().getTime();
          actionExecutions.push({
            index,
            kind: action.kind,
            outcome: "succeeded",
            startedAt: executionStartedAt,
            completedAt: new Date(completedMs).toISOString(),
            durationMs: Math.max(0, completedMs - executionStartedMs),
            failureCode: null,
            failureDigest: null,
          });
        } catch (actionError) {
          const completedMs = this.#clock().getTime();
          actionExecutions.push({
            index,
            kind: action.kind,
            outcome: "failed",
            startedAt: executionStartedAt,
            completedAt: new Date(completedMs).toISOString(),
            durationMs: Math.max(0, completedMs - executionStartedMs),
            failureCode: failureCode(actionError, "ACTION_FAILED"),
            failureDigest: sha256(boundedErrorText(actionError)),
          });
          throw actionError;
        }
      }
      const finalState = updateSessionMetadata(
        recoveryPlan.state,
        executionContext.managedSessionReport,
      );
      committed = await this.#store.append(finalState, {
        revision: loadedSource.revision,
        entrySha256: loadedSource.entrySha256,
      });
      outcome =
        recoveryPlan.outcome === "held"
          ? "held"
          : recoveryPlan.outcome === "needs-attention"
            ? "needs-attention"
            : "applied";
    } catch (caught) {
      error = caught;
      outcome =
        caught instanceof RuntimeSupervisorStoreError &&
        caught.code === "CONFLICT"
          ? "conflict"
          : "failed";
    } finally {
      this.#executionActive = false;
    }

    const completedAtMs = this.#clock().getTime();
    const report: RuntimeSupervisorExecutionReport = {
      schemaVersion: RUNTIME_SUPERVISOR_EXECUTION_SCHEMA_VERSION,
      id: reportId,
      outcome,
      planOutcome: plan?.outcome ?? null,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      sourceRevision: source?.revision ?? null,
      sourceEntrySha256: source?.entrySha256 ?? null,
      committedRevision: committed?.revision ?? null,
      committedEntrySha256: committed?.entrySha256 ?? null,
      actionExecutions,
      managedSessionReport: context?.managedSessionReport ?? null,
      errorCode:
        error === null
          ? null
          : outcome === "conflict"
            ? "STATE_CONFLICT"
            : failureCode(error, "ACTION_FAILED"),
      errorDigest: error === null ? null : sha256(boundedErrorText(error)),
    };
    return { report, snapshot: committed };
  }

  async #executeAction(
    action: RuntimeRecoveryAction,
    plannedState: RuntimeSupervisorState,
    context: ExecutionContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Runtime supervisor recovery was cancelled.");
    }
    switch (action.kind) {
      case "hold":
        return;
      case "stop-runtime":
        await this.#actions.stopRuntime(
          { instanceId: action.instanceId, reason: action.reason },
          signal,
        );
        return;
      case "resume-runtime": {
        const expected = expectedRuntimeFor(plannedState, action.instanceId);
        if (expected === null) {
          throw new RuntimeSupervisorCoordinatorError(
            "PLAN_INVALID",
            "Resume action does not reference a Runtime in the planned state.",
          );
        }
        const resumed = parseRuntimeSlotIdentity(
          await this.#actions.resumeRuntime(
            {
              instanceId: action.instanceId,
              expectedGeneration: action.expectedGeneration,
              nextGeneration: action.nextGeneration,
            },
            signal,
          ),
          "Resumed Runtime",
        );
        if (
          resumed.runtimeGeneration !== action.nextGeneration ||
          !sameRuntimeIdentity(resumed, expected)
        ) {
          throw new RuntimeSupervisorCoordinatorError(
            "ACTION_RESULT_INVALID",
            "Resumed Runtime identity does not match the recovery plan.",
          );
        }
        return;
      }
      case "publish-runtime": {
        const publication = validatePublication(
          await this.#actions.publishRuntime(
            {
              runtime: action.runtime,
              expectedPublicationRevision: action.expectedPublicationRevision,
              expectedPublicationGeneration:
                action.expectedPublicationGeneration,
            },
            signal,
          ),
        );
        if (
          publication.revision !== action.expectedPublicationRevision + 1 ||
          !samePublishedRuntime(publication, action.runtime)
        ) {
          throw new RuntimeSupervisorCoordinatorError(
            "ACTION_RESULT_INVALID",
            "Published Runtime identity or revision does not match the recovery fence.",
          );
        }
        context.publication = publication;
        return;
      }
      case "rebind-managed-sessions": {
        if (!samePublishedRuntime(context.publication, action.to)) {
          throw new RuntimeSupervisorCoordinatorError(
            "PLAN_INVALID",
            "Managed sessions may only rebind to the currently published Runtime.",
          );
        }
        const target: RuntimeSessionTarget = {
          runtimeGeneration: action.to.runtimeGeneration,
          endpoint: action.to.endpoint,
          manifestDigest: action.to.manifestDigest,
          connectionRevision: context.publication.revision,
        };
        const report = await this.#sessions.rebindManaged(target, {
          timeoutMs: this.#rebindTimeoutMs,
          concurrency: this.#rebindConcurrency,
          rollbackOnFailure: true,
          signal,
        });
        context.managedSessionReport = report;
        if (
          report.schemaVersion !==
            MANAGED_SESSION_REBIND_REPORT_SCHEMA_VERSION ||
          report.outcome !== "rebound" ||
          report.failedManagedSessions !== 0 ||
          report.rollbackFailedManagedSessions !== 0
        ) {
          throw new RuntimeSupervisorCoordinatorError(
            "ACTION_FAILED",
            "Managed Runtime session rebind did not complete atomically.",
          );
        }
        return;
      }
      case "continue-canary": {
        const canary = parseCanary(
          await this.#actions.continueCanary(
            {
              instanceId: action.instanceId,
              runtimeGeneration: action.runtimeGeneration,
            },
            signal,
          ),
        );
        if (!canary.healthy) {
          throw new RuntimeSupervisorCoordinatorError(
            "ACTION_FAILED",
            `Runtime canary failed with ${canary.failureCode ?? "CANARY_FAILED"}.`,
          );
        }
        return;
      }
      case "mark-needs-attention":
        await this.#actions.markNeedsAttention?.(
          {
            failureCode: action.failureCode,
            failureDigest: action.failureDigest,
          },
          signal,
        );
        return;
    }
  }
}
