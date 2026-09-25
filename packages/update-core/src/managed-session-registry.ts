export const MANAGED_SESSION_REGISTRY_SCHEMA_VERSION =
  "scr.managed-session-registry/v1" as const;
export const MANAGED_SESSION_REBIND_REPORT_SCHEMA_VERSION =
  "scr.managed-session-rebind-report/v1" as const;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_MAX_SESSIONS = 4_096;
const ABSOLUTE_MAX_SESSIONS = 100_000;

export type RuntimeSessionKind = "managed" | "external";

export interface RuntimeSessionTarget {
  readonly runtimeGeneration: number;
  readonly endpoint: string;
  readonly manifestDigest: string;
  readonly connectionRevision: number;
}

export interface ManagedRuntimeSessionAdapter {
  rebind(target: RuntimeSessionTarget, signal: AbortSignal): Promise<void>;
}

export interface ManagedSessionRegistrySnapshot {
  readonly schemaVersion: typeof MANAGED_SESSION_REGISTRY_SCHEMA_VERSION;
  readonly revision: number;
  readonly managedSessions: number;
  readonly externalSessions: number;
  readonly managedByGeneration: Readonly<Record<string, number>>;
  readonly externalByGeneration: Readonly<Record<string, number>>;
}

export interface ManagedSessionRebindReport {
  readonly schemaVersion: typeof MANAGED_SESSION_REBIND_REPORT_SCHEMA_VERSION;
  readonly outcome: "rebound" | "rolled-back" | "partial" | "failed";
  readonly registryRevision: number;
  readonly target: RuntimeSessionTarget;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly attemptedManagedSessions: number;
  readonly alreadyCurrentManagedSessions: number;
  readonly reboundManagedSessions: number;
  readonly failedManagedSessions: number;
  readonly rolledBackManagedSessions: number;
  readonly rollbackFailedManagedSessions: number;
  readonly externalSessions: number;
  readonly externalRefreshRequired: boolean;
  readonly failureCodes: readonly string[];
}

export type ManagedSessionRegistryErrorCode =
  | "INVALID_SESSION"
  | "SESSION_ALREADY_REGISTERED"
  | "SESSION_NOT_FOUND"
  | "SESSION_REBIND_BUSY"
  | "SESSION_REBIND_FAILED"
  | "SESSION_REBIND_TIMEOUT"
  | "SESSION_ROLLBACK_FAILED"
  | "SESSION_LIMIT_REACHED";

export class ManagedSessionRegistryError extends Error {
  readonly code: ManagedSessionRegistryErrorCode;

  constructor(
    code: ManagedSessionRegistryErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ManagedSessionRegistryError";
    this.code = code;
  }
}

interface ManagedSessionRecord {
  readonly id: string;
  readonly kind: "managed";
  readonly registrationToken: symbol;
  target: RuntimeSessionTarget;
  readonly adapter: ManagedRuntimeSessionAdapter;
}

interface ExternalSessionRecord {
  readonly id: string;
  readonly kind: "external";
  readonly registrationToken: symbol;
  target: RuntimeSessionTarget;
}

type RuntimeSessionRecord = ManagedSessionRecord | ExternalSessionRecord;

interface ManagedRebindSuccess {
  readonly record: ManagedSessionRecord;
  readonly previous: RuntimeSessionTarget;
}

interface ManagedRebindFailure {
  readonly code: string;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ManagedSessionRegistryError(
      "INVALID_SESSION",
      `${label} must be a positive safe integer.`,
    );
  }
  return value;
}

function parseEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new ManagedSessionRegistryError(
      "INVALID_SESSION",
      "Runtime session endpoint is invalid.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ManagedSessionRegistryError(
      "INVALID_SESSION",
      "Runtime session endpoint is invalid.",
    );
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
    throw new ManagedSessionRegistryError(
      "INVALID_SESSION",
      "Runtime session endpoint must be an uncredentialed loopback /mcp URL.",
    );
  }
  return value;
}

function parseTarget(value: RuntimeSessionTarget): RuntimeSessionTarget {
  const expectedKeys = [
    "runtimeGeneration",
    "endpoint",
    "manifestDigest",
    "connectionRevision",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expectedKeys.length ||
    !Object.keys(value).every((key) => expectedKeys.includes(key)) ||
    !expectedKeys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new ManagedSessionRegistryError(
      "INVALID_SESSION",
      "Runtime session target has an invalid shape.",
    );
  }
  if (
    typeof value.manifestDigest !== "string" ||
    !SHA256_PATTERN.test(value.manifestDigest)
  ) {
    throw new ManagedSessionRegistryError(
      "INVALID_SESSION",
      "Runtime session manifest digest must be lowercase SHA-256.",
    );
  }
  return {
    runtimeGeneration: parsePositiveInteger(
      value.runtimeGeneration,
      "Runtime session generation",
    ),
    endpoint: parseEndpoint(value.endpoint),
    manifestDigest: value.manifestDigest,
    connectionRevision: parsePositiveInteger(
      value.connectionRevision,
      "Runtime session connection revision",
    ),
  };
}

function parseSessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new ManagedSessionRegistryError(
      "INVALID_SESSION",
      "Runtime session ID is invalid.",
    );
  }
  return value;
}

function sameTarget(
  left: RuntimeSessionTarget,
  right: RuntimeSessionTarget,
): boolean {
  return (
    left.runtimeGeneration === right.runtimeGeneration &&
    left.endpoint === right.endpoint &&
    left.manifestDigest === right.manifestDigest &&
    left.connectionRevision === right.connectionRevision
  );
}

function errorCode(
  error: unknown,
  fallback: ManagedSessionRegistryErrorCode,
): string {
  if (
    error instanceof ManagedSessionRegistryError &&
    FAILURE_CODE_PATTERN.test(error.code)
  ) {
    return error.code;
  }
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

async function withTimeout(
  operation: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<void> {
  const controller = new AbortController();
  const cancellationError = (): Error =>
    controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new ManagedSessionRegistryError(
          "SESSION_REBIND_FAILED",
          "Managed session rebinding was cancelled.",
        );
  const abortFromOuter = (): void => {
    controller.abort(
      outerSignal?.reason instanceof Error
        ? outerSignal.reason
        : new ManagedSessionRegistryError(
            "SESSION_REBIND_FAILED",
            "Managed session rebinding was cancelled.",
          ),
    );
  };
  if (outerSignal?.aborted === true) {
    abortFromOuter();
  } else {
    outerSignal?.addEventListener("abort", abortFromOuter, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new ManagedSessionRegistryError(
        "SESSION_REBIND_TIMEOUT",
        "Managed session rebinding exceeded its deadline.",
      ),
    );
  }, timeoutMs);
  try {
    await new Promise<void>((resolveOperation, rejectOperation) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void =>
        finish(() => rejectOperation(cancellationError()));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      operation(controller.signal).then(
        () => finish(resolveOperation),
        (error: unknown) =>
          finish(() =>
            rejectOperation(
              error instanceof Error
                ? error
                : new ManagedSessionRegistryError(
                    "SESSION_REBIND_FAILED",
                    "Managed session adapter failed.",
                  ),
            ),
          ),
      );
    });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abortFromOuter);
  }
}

function countByGeneration(
  records: readonly RuntimeSessionRecord[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const generation = String(record.target.runtimeGeneration);
    counts[generation] = (counts[generation] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(
      ([left], [right]) => Number(left) - Number(right),
    ),
  );
}

export class ManagedRuntimeSessionRegistry {
  readonly #records = new Map<string, RuntimeSessionRecord>();
  readonly #maxSessions: number;
  #revision: number;
  #rebindActive = false;

  constructor(
    options: {
      readonly maxSessions?: number;
      readonly initialRevision?: number;
    } = {},
  ) {
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const initialRevision = options.initialRevision ?? 1;
    if (
      !Number.isSafeInteger(maxSessions) ||
      maxSessions < 1 ||
      maxSessions > ABSOLUTE_MAX_SESSIONS
    ) {
      throw new ManagedSessionRegistryError(
        "INVALID_SESSION",
        "Managed Runtime session registry limit is invalid.",
      );
    }
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 1) {
      throw new ManagedSessionRegistryError(
        "INVALID_SESSION",
        "Managed Runtime session registry initial revision is invalid.",
      );
    }
    this.#maxSessions = maxSessions;
    this.#revision = initialRevision;
  }

  registerManaged(input: {
    readonly sessionId: string;
    readonly target: RuntimeSessionTarget;
    readonly adapter: ManagedRuntimeSessionAdapter;
  }): () => void {
    this.#assertMutable();
    const sessionId = parseSessionId(input.sessionId);
    if (this.#records.has(sessionId)) {
      throw new ManagedSessionRegistryError(
        "SESSION_ALREADY_REGISTERED",
        "Runtime session is already registered.",
      );
    }
    if (
      input.adapter === null ||
      typeof input.adapter !== "object" ||
      typeof input.adapter.rebind !== "function"
    ) {
      throw new ManagedSessionRegistryError(
        "INVALID_SESSION",
        "Managed Runtime session adapter is invalid.",
      );
    }
    this.#assertCapacity();
    const registrationToken = Symbol(sessionId);
    this.#records.set(sessionId, {
      id: sessionId,
      kind: "managed",
      registrationToken,
      target: parseTarget(input.target),
      adapter: input.adapter,
    });
    this.#incrementRevision();
    return () => {
      this.#assertMutable();
      this.#unregisterCurrent(sessionId, registrationToken);
    };
  }

  registerExternal(input: {
    readonly sessionId: string;
    readonly target: RuntimeSessionTarget;
  }): () => void {
    this.#assertMutable();
    const sessionId = parseSessionId(input.sessionId);
    if (this.#records.has(sessionId)) {
      throw new ManagedSessionRegistryError(
        "SESSION_ALREADY_REGISTERED",
        "Runtime session is already registered.",
      );
    }
    this.#assertCapacity();
    const registrationToken = Symbol(sessionId);
    this.#records.set(sessionId, {
      id: sessionId,
      kind: "external",
      registrationToken,
      target: parseTarget(input.target),
    });
    this.#incrementRevision();
    return () => {
      this.#assertMutable();
      this.#unregisterCurrent(sessionId, registrationToken);
    };
  }

  unregister(sessionIdInput: string): void {
    this.#assertMutable();
    const sessionId = parseSessionId(sessionIdInput);
    this.#unregisterCurrent(sessionId);
  }

  updateExternalTarget(
    sessionIdInput: string,
    targetInput: RuntimeSessionTarget,
  ): void {
    this.#assertMutable();
    const sessionId = parseSessionId(sessionIdInput);
    const record = this.#records.get(sessionId);
    if (record === undefined || record.kind !== "external") {
      throw new ManagedSessionRegistryError(
        "SESSION_NOT_FOUND",
        "External Runtime session is not registered.",
      );
    }
    const target = parseTarget(targetInput);
    if (sameTarget(record.target, target)) {
      return;
    }
    record.target = target;
    this.#incrementRevision();
  }

  snapshot(): ManagedSessionRegistrySnapshot {
    const managed = [...this.#records.values()].filter(
      (record): record is ManagedSessionRecord => record.kind === "managed",
    );
    const external = [...this.#records.values()].filter(
      (record): record is ExternalSessionRecord => record.kind === "external",
    );
    return {
      schemaVersion: MANAGED_SESSION_REGISTRY_SCHEMA_VERSION,
      revision: this.#revision,
      managedSessions: managed.length,
      externalSessions: external.length,
      managedByGeneration: countByGeneration(managed),
      externalByGeneration: countByGeneration(external),
    };
  }

  async rebindManaged(
    targetInput: RuntimeSessionTarget,
    options: {
      readonly timeoutMs?: number;
      readonly concurrency?: number;
      readonly rollbackOnFailure?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ManagedSessionRebindReport> {
    if (this.#rebindActive) {
      throw new ManagedSessionRegistryError(
        "SESSION_REBIND_BUSY",
        "A managed Runtime session rebind is already active.",
      );
    }
    const target = parseTarget(targetInput);
    const timeoutMs = options.timeoutMs ?? 15_000;
    const concurrency = options.concurrency ?? 4;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 300_000 ||
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 32
    ) {
      throw new ManagedSessionRegistryError(
        "INVALID_SESSION",
        "Managed Runtime session rebind limits are invalid.",
      );
    }
    this.#rebindActive = true;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const failureCodes: string[] = [];
    const managed = [...this.#records.values()]
      .filter(
        (record): record is ManagedSessionRecord => record.kind === "managed",
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const external = [...this.#records.values()]
      .filter(
        (record): record is ExternalSessionRecord => record.kind === "external",
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const pending = managed.filter(
      (record) => !sameTarget(record.target, target),
    );
    const alreadyCurrentManagedSessions = managed.length - pending.length;
    const successful: ManagedRebindSuccess[] = [];
    const failures: ManagedRebindFailure[] = [];
    let cursor = 0;

    try {
      const worker = async (): Promise<void> => {
        while (true) {
          const index = cursor;
          cursor += 1;
          const record = pending[index];
          if (record === undefined) {
            return;
          }
          const previous = record.target;
          try {
            await withTimeout(
              (signal) => record.adapter.rebind(target, signal),
              timeoutMs,
              options.signal,
            );
            record.target = target;
            successful.push({ record, previous });
          } catch (error) {
            const code = errorCode(error, "SESSION_REBIND_FAILED");
            failures.push({ code });
            failureCodes.push(code);
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, Math.max(1, pending.length)) },
          () => worker(),
        ),
      );

      let rolledBackManagedSessions = 0;
      let rollbackFailedManagedSessions = 0;
      if (
        failures.length > 0 &&
        successful.length > 0 &&
        (options.rollbackOnFailure ?? true)
      ) {
        for (const success of [...successful].reverse()) {
          try {
            await withTimeout(
              (signal) =>
                success.record.adapter.rebind(success.previous, signal),
              timeoutMs,
              undefined,
            );
            success.record.target = success.previous;
            rolledBackManagedSessions += 1;
          } catch (error) {
            const code = errorCode(error, "SESSION_ROLLBACK_FAILED");
            failureCodes.push(code);
            rollbackFailedManagedSessions += 1;
          }
        }
      }
      if (
        successful.length > 0 ||
        rolledBackManagedSessions > 0 ||
        rollbackFailedManagedSessions > 0
      ) {
        this.#incrementRevision();
      }
      const externalRefreshRequired = external.some(
        (record) => !sameTarget(record.target, target),
      );
      const completedAtMs = Date.now();
      const outcome: ManagedSessionRebindReport["outcome"] =
        failures.length === 0
          ? "rebound"
          : successful.length === 0
            ? "failed"
            : rolledBackManagedSessions === successful.length &&
                rollbackFailedManagedSessions === 0
              ? "rolled-back"
              : "partial";
      return {
        schemaVersion: MANAGED_SESSION_REBIND_REPORT_SCHEMA_VERSION,
        outcome,
        registryRevision: this.#revision,
        target,
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
        attemptedManagedSessions: pending.length,
        alreadyCurrentManagedSessions,
        reboundManagedSessions: successful.length - rolledBackManagedSessions,
        failedManagedSessions: failures.length,
        rolledBackManagedSessions,
        rollbackFailedManagedSessions,
        externalSessions: external.length,
        externalRefreshRequired,
        failureCodes: [...new Set(failureCodes)].sort(),
      };
    } finally {
      this.#rebindActive = false;
    }
  }

  #assertMutable(): void {
    if (this.#rebindActive) {
      throw new ManagedSessionRegistryError(
        "SESSION_REBIND_BUSY",
        "Managed Runtime session registry is frozen during rebind.",
      );
    }
  }

  #assertCapacity(): void {
    if (this.#records.size >= this.#maxSessions) {
      throw new ManagedSessionRegistryError(
        "SESSION_LIMIT_REACHED",
        "Managed Runtime session registry reached its configured limit.",
      );
    }
  }

  #unregisterCurrent(sessionId: string, registrationToken?: symbol): void {
    const record = this.#records.get(sessionId);
    if (
      record === undefined ||
      (registrationToken !== undefined &&
        record.registrationToken !== registrationToken)
    ) {
      return;
    }
    this.#records.delete(sessionId);
    this.#incrementRevision();
  }

  #incrementRevision(): void {
    const next = this.#revision + 1;
    if (!Number.isSafeInteger(next)) {
      throw new ManagedSessionRegistryError(
        "INVALID_SESSION",
        "Managed Runtime session registry revision limit reached.",
      );
    }
    this.#revision = next;
  }
}
