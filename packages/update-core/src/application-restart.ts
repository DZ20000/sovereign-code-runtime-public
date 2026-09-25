import { randomBytes } from "node:crypto";

import {
  RestartJournal,
  type RestartCheckpointReference,
  type RestartIntentPhase,
  type RestartJournalEntry,
} from "./restart-journal.js";

export interface ApplicationRestartCandidate {
  readonly releaseId: string;
  readonly directory: string;
  readonly manifestSha256: string;
}

export interface ApplicationRestartSafePoint {
  readonly consequentialInFlight: number;
  readonly unknownOutcomes: number;
}

export interface ApplicationRestartContext {
  readonly updateId: string;
  readonly phase: RestartIntentPhase;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface ApplicationRestartRequest {
  readonly updateId: string;
  readonly restartId: string;
  readonly targetReleaseId: string;
  readonly checkpoint: RestartCheckpointReference;
  readonly rollback: boolean;
}

export interface ApplicationRestartAdapter {
  verifyCandidate(
    candidate: ApplicationRestartCandidate,
    context: ApplicationRestartContext,
  ): Promise<void>;
  waitForSafePoint(
    currentReleaseId: string,
    context: ApplicationRestartContext,
  ): Promise<ApplicationRestartSafePoint>;
  checkpoint(
    currentReleaseId: string,
    context: ApplicationRestartContext,
  ): Promise<RestartCheckpointReference>;
  requestRestart(
    request: ApplicationRestartRequest,
    context: ApplicationRestartContext,
  ): Promise<void>;
  waitUntilHealthy(
    releaseId: string,
    restartId: string,
    context: ApplicationRestartContext,
  ): Promise<void>;
  restoreCheckpoint(
    checkpoint: RestartCheckpointReference,
    context: ApplicationRestartContext,
  ): Promise<void>;
  commitCandidate(
    candidateReleaseId: string,
    checkpoint: RestartCheckpointReference,
    context: ApplicationRestartContext,
  ): Promise<void>;
}

export interface ApplicationRestartPolicy {
  readonly verifyTimeoutMs?: number;
  readonly safePointTimeoutMs?: number;
  readonly checkpointTimeoutMs?: number;
  readonly restartRequestTimeoutMs?: number;
  readonly healthTimeoutMs?: number;
  readonly restoreTimeoutMs?: number;
  readonly commitTimeoutMs?: number;
}

export interface ApplicationRestartCoordinatorOptions {
  readonly journal: RestartJournal;
  readonly adapter: ApplicationRestartAdapter;
  readonly policy?: ApplicationRestartPolicy;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export interface ApplicationRestartPrepareInput {
  readonly updateId: string;
  readonly currentReleaseId: string;
  readonly candidate: ApplicationRestartCandidate;
}

export interface ApplicationRestartPrepareReceipt {
  readonly updateId: string;
  readonly restartId: string;
  readonly currentReleaseId: string;
  readonly candidateReleaseId: string;
  readonly phase: "restart-requested";
  readonly checkpointId: string;
  readonly preparedAt: number;
}

export interface ApplicationRestartResumeReceipt {
  readonly updateId: string;
  readonly restartId: string;
  readonly currentReleaseId: string;
  readonly candidateReleaseId: string;
  readonly runningReleaseId: string;
  readonly outcome:
    "committed" | "rollback-requested" | "rolled-back" | "failed";
  readonly phase: "committed" | "rollback-requested" | "rolled-back" | "failed";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly failureReason: string | null;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_POLICY = {
  verifyTimeoutMs: 30_000,
  safePointTimeoutMs: 30_000,
  checkpointTimeoutMs: 30_000,
  restartRequestTimeoutMs: 15_000,
  healthTimeoutMs: 60_000,
  restoreTimeoutMs: 30_000,
  commitTimeoutMs: 30_000,
} as const;

type ResolvedPolicy = {
  readonly [Key in keyof typeof DEFAULT_POLICY]: number;
};

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertCandidate(value: ApplicationRestartCandidate): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("Application restart candidate is invalid.");
  }
  assertIdentifier(value.releaseId, "Application restart candidate release ID");
  if (
    typeof value.directory !== "string" ||
    value.directory.trim().length === 0 ||
    value.directory.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value.directory)
  ) {
    throw new Error("Application restart candidate directory is invalid.");
  }
  if (
    typeof value.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.manifestSha256)
  ) {
    throw new Error(
      "Application restart candidate manifest digest is invalid.",
    );
  }
}

function assertCheckpoint(value: RestartCheckpointReference): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("Application restart checkpoint is invalid.");
  }
  assertIdentifier(value.checkpointId, "Application restart checkpoint ID");
  if (!SHA256_PATTERN.test(value.checkpointSha256)) {
    throw new Error("Application restart checkpoint digest is invalid.");
  }
  assertIdentifier(value.fencingToken, "Application restart fencing token");
}

function assertSafePoint(value: ApplicationRestartSafePoint): void {
  for (const [name, count] of Object.entries(value)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Application restart safe-point ${name} is invalid.`);
    }
  }
  if (value.consequentialInFlight !== 0 || value.unknownOutcomes !== 0) {
    throw new Error(
      `Application restart did not reach a safe point: inFlight=${value.consequentialInFlight}, unknown=${value.unknownOutcomes}.`,
    );
  }
}

function resolvePolicy(policy: ApplicationRestartPolicy = {}): ResolvedPolicy {
  const resolved = { ...DEFAULT_POLICY, ...policy };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
      throw new Error(`Application restart ${name} is invalid.`);
    }
  }
  return resolved;
}

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (
    normalized.length === 0 ? "Application restart failed." : normalized
  ).slice(0, 1_024);
}

function checkpointReference(
  entry: RestartJournalEntry,
): RestartCheckpointReference {
  return {
    checkpointId: entry.checkpointId,
    checkpointSha256: entry.checkpointSha256,
    fencingToken: entry.fencingToken,
  };
}

export class ApplicationRestartBusyError extends Error {
  constructor() {
    super("Another application restart operation is active.");
    this.name = "ApplicationRestartBusyError";
  }
}

export class ApplicationRestartCoordinator {
  readonly #journal: RestartJournal;
  readonly #adapter: ApplicationRestartAdapter;
  readonly #policy: ResolvedPolicy;
  readonly #now: () => number;
  readonly #randomId: () => string;
  #busy = false;

  constructor(options: ApplicationRestartCoordinatorOptions) {
    this.#journal = options.journal;
    this.#adapter = options.adapter;
    this.#policy = resolvePolicy(options.policy);
    this.#now = options.now ?? Date.now;
    this.#randomId =
      options.randomId ?? (() => `restart-${randomBytes(16).toString("hex")}`);
  }

  get busy(): boolean {
    return this.#busy;
  }

  async prepare(
    input: ApplicationRestartPrepareInput,
  ): Promise<ApplicationRestartPrepareReceipt> {
    return await this.#exclusive(async () => {
      assertIdentifier(input.updateId, "Application restart update ID");
      assertIdentifier(
        input.currentReleaseId,
        "Application restart current release ID",
      );
      assertCandidate(input.candidate);
      if (input.currentReleaseId === input.candidate.releaseId) {
        throw new Error(
          "Application restart candidate must differ from current release.",
        );
      }
      const open = await this.#journal.openIntent();
      if (open !== null) {
        throw new Error(`Restart intent ${open.updateId} is already open.`);
      }
      await this.#phase(
        input.updateId,
        "prepared",
        this.#policy.verifyTimeoutMs,
        (context) => this.#adapter.verifyCandidate(input.candidate, context),
      );
      const safePoint = await this.#phase(
        input.updateId,
        "prepared",
        this.#policy.safePointTimeoutMs,
        (context) =>
          this.#adapter.waitForSafePoint(input.currentReleaseId, context),
      );
      assertSafePoint(safePoint);
      const checkpoint = await this.#phase(
        input.updateId,
        "prepared",
        this.#policy.checkpointTimeoutMs,
        (context) => this.#adapter.checkpoint(input.currentReleaseId, context),
      );
      assertCheckpoint(checkpoint);
      const restartId = this.#randomId();
      assertIdentifier(restartId, "Application restart ID");
      const preparedAt = this.#now();
      await this.#journal.prepare({
        updateId: input.updateId,
        currentReleaseId: input.currentReleaseId,
        candidateReleaseId: input.candidate.releaseId,
        restartId,
        ...checkpoint,
      });
      await this.#journal.transition(input.updateId, "restart-requested");
      try {
        await this.#phase(
          input.updateId,
          "restart-requested",
          this.#policy.restartRequestTimeoutMs,
          (context) =>
            this.#adapter.requestRestart(
              {
                updateId: input.updateId,
                restartId,
                targetReleaseId: input.candidate.releaseId,
                checkpoint,
                rollback: false,
              },
              context,
            ),
        );
      } catch (error) {
        await this.#journal.transition(
          input.updateId,
          "failed",
          boundedReason(error),
        );
        throw error;
      }
      return {
        updateId: input.updateId,
        restartId,
        currentReleaseId: input.currentReleaseId,
        candidateReleaseId: input.candidate.releaseId,
        phase: "restart-requested",
        checkpointId: checkpoint.checkpointId,
        preparedAt,
      };
    });
  }

  async resume(
    runningReleaseId: string,
  ): Promise<ApplicationRestartResumeReceipt | null> {
    return await this.#exclusive(async () => {
      assertIdentifier(runningReleaseId, "Running application release ID");
      const intent = await this.#journal.openIntent();
      if (intent === null) return null;
      const startedAt = this.#now();
      try {
        if (runningReleaseId === intent.candidateReleaseId) {
          return await this.#resumeCandidate(intent, startedAt);
        }
        if (runningReleaseId === intent.currentReleaseId) {
          return await this.#resumePrevious(intent, startedAt);
        }
        const reason = `Running release ${runningReleaseId} does not match restart intent ${intent.updateId}.`;
        await this.#journal.transition(intent.updateId, "failed", reason);
        return this.#resumeReceipt(
          intent,
          runningReleaseId,
          "failed",
          startedAt,
          reason,
        );
      } catch (error) {
        const reason = boundedReason(error);
        const current = await this.#journal.openIntent();
        if (current !== null && current.updateId === intent.updateId) {
          await this.#journal
            .transition(intent.updateId, "failed", reason)
            .catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async #resumeCandidate(
    intent: RestartJournalEntry,
    startedAt: number,
  ): Promise<ApplicationRestartResumeReceipt> {
    if (intent.phase === "prepared") {
      const reason =
        "Application restarted before the restart request became durable.";
      await this.#journal.transition(intent.updateId, "failed", reason);
      return this.#resumeReceipt(
        intent,
        intent.candidateReleaseId,
        "failed",
        startedAt,
        reason,
      );
    }
    if (intent.phase === "rollback-requested") {
      const reason = "Candidate is still running after rollback was requested.";
      await this.#journal.transition(intent.updateId, "failed", reason);
      return this.#resumeReceipt(
        intent,
        intent.candidateReleaseId,
        "failed",
        startedAt,
        reason,
      );
    }
    if (intent.phase === "restart-requested") {
      await this.#journal.transition(intent.updateId, "candidate-started");
    }
    const current = (await this.#journal.openIntent())!;
    const checkpoint = checkpointReference(current);
    try {
      if (current.phase === "candidate-started") {
        await this.#phase(
          current.updateId,
          "candidate-started",
          this.#policy.healthTimeoutMs,
          (context) =>
            this.#adapter.waitUntilHealthy(
              current.candidateReleaseId,
              current.restartId,
              context,
            ),
        );
        await this.#journal.transition(current.updateId, "candidate-healthy");
      }
      await this.#phase(
        current.updateId,
        "candidate-healthy",
        this.#policy.restoreTimeoutMs,
        (context) => this.#adapter.restoreCheckpoint(checkpoint, context),
      );
      await this.#phase(
        current.updateId,
        "candidate-healthy",
        this.#policy.commitTimeoutMs,
        (context) =>
          this.#adapter.commitCandidate(
            current.candidateReleaseId,
            checkpoint,
            context,
          ),
      );
      await this.#journal.transition(current.updateId, "committed");
      return this.#resumeReceipt(
        current,
        current.candidateReleaseId,
        "committed",
        startedAt,
        null,
      );
    } catch (error) {
      const reason = boundedReason(error);
      const latest = (await this.#journal.openIntent()) ?? current;
      if (latest.phase !== "rollback-requested") {
        await this.#journal.transition(
          latest.updateId,
          "rollback-requested",
          reason,
        );
      }
      await this.#phase(
        latest.updateId,
        "rollback-requested",
        this.#policy.restartRequestTimeoutMs,
        (context) =>
          this.#adapter.requestRestart(
            {
              updateId: latest.updateId,
              restartId: latest.restartId,
              targetReleaseId: latest.currentReleaseId,
              checkpoint,
              rollback: true,
            },
            context,
          ),
      );
      return this.#resumeReceipt(
        latest,
        latest.candidateReleaseId,
        "rollback-requested",
        startedAt,
        reason,
      );
    }
  }

  async #resumePrevious(
    intent: RestartJournalEntry,
    startedAt: number,
  ): Promise<ApplicationRestartResumeReceipt> {
    if (intent.phase === "prepared") {
      const reason =
        "Application restarted before a restart request was issued.";
      await this.#journal.transition(intent.updateId, "failed", reason);
      return this.#resumeReceipt(
        intent,
        intent.currentReleaseId,
        "failed",
        startedAt,
        reason,
      );
    }
    const checkpoint = checkpointReference(intent);
    await this.#phase(
      intent.updateId,
      intent.phase,
      this.#policy.healthTimeoutMs,
      (context) =>
        this.#adapter.waitUntilHealthy(
          intent.currentReleaseId,
          intent.restartId,
          context,
        ),
    );
    await this.#phase(
      intent.updateId,
      intent.phase,
      this.#policy.restoreTimeoutMs,
      (context) => this.#adapter.restoreCheckpoint(checkpoint, context),
    );
    if (intent.phase === "restart-requested") {
      await this.#journal.transition(
        intent.updateId,
        "rolled-back",
        "Candidate release did not become active; previous release resumed.",
      );
    } else if (intent.phase === "rollback-requested") {
      await this.#journal.transition(intent.updateId, "rolled-back");
    } else {
      const reason = `Previous release resumed from unexpected phase ${intent.phase}.`;
      await this.#journal.transition(intent.updateId, "failed", reason);
      return this.#resumeReceipt(
        intent,
        intent.currentReleaseId,
        "failed",
        startedAt,
        reason,
      );
    }
    return this.#resumeReceipt(
      intent,
      intent.currentReleaseId,
      "rolled-back",
      startedAt,
      intent.failureReason,
    );
  }

  #resumeReceipt(
    intent: RestartJournalEntry,
    runningReleaseId: string,
    outcome: ApplicationRestartResumeReceipt["outcome"],
    startedAt: number,
    failureReason: string | null,
    phase: ApplicationRestartResumeReceipt["phase"] = outcome,
  ): ApplicationRestartResumeReceipt {
    return {
      updateId: intent.updateId,
      restartId: intent.restartId,
      currentReleaseId: intent.currentReleaseId,
      candidateReleaseId: intent.candidateReleaseId,
      runningReleaseId,
      outcome,
      phase,
      startedAt,
      completedAt: this.#now(),
      failureReason,
    };
  }

  async #phase<T>(
    updateId: string,
    phase: RestartIntentPhase,
    timeoutMs: number,
    operation: (context: ApplicationRestartContext) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const startedAt = this.#now();
    const context: ApplicationRestartContext = {
      updateId,
      phase,
      startedAt,
      deadlineAt: startedAt + timeoutMs,
      signal: controller.signal,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Application restart phase ${phase} timed out after ${timeoutMs} ms.`,
        );
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation(context), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new ApplicationRestartBusyError();
    this.#busy = true;
    try {
      return await operation();
    } finally {
      this.#busy = false;
    }
  }
}
