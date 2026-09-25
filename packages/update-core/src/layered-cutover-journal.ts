import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export const LAYERED_CUTOVER_JOURNAL_SCHEMA_VERSION =
  "scr.layered-cutover-journal/v1" as const;

export const LAYERED_CUTOVER_KINDS = ["renderer", "runtime"] as const;
export type LayeredCutoverKind = (typeof LAYERED_CUTOVER_KINDS)[number];

export const LAYERED_CUTOVER_EVENTS = [
  "started",
  "transition",
  "completed",
  "recovery",
] as const;
export type LayeredCutoverEvent = (typeof LAYERED_CUTOVER_EVENTS)[number];

export type LayeredCutoverOutcome = "committed" | "rolled-back" | "failed";

export type LayeredCutoverRecoveryAction =
  | "discard-candidate"
  | "stop-candidate"
  | "resume-active-and-stop-candidate"
  | "restore-previous-renderer"
  | "restore-previous-traffic"
  | "verify-renderer-commit"
  | "verify-runtime-commit";

export interface LayeredCutoverIdentity {
  readonly cutoverId: string;
  readonly kind: LayeredCutoverKind;
  readonly activeReleaseId: string;
  readonly candidateReleaseId: string;
}

export interface LayeredCutoverJournalRecord extends LayeredCutoverIdentity {
  readonly schemaVersion: typeof LAYERED_CUTOVER_JOURNAL_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousRecordSha256: string | null;
  readonly at: number;
  readonly event: LayeredCutoverEvent;
  readonly phase: string | null;
  readonly outcome: LayeredCutoverOutcome | null;
  readonly failureReason: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export interface LayeredCutoverJournalEntry {
  readonly record: LayeredCutoverJournalRecord;
  readonly recordSha256: string;
  readonly path: string;
}

export interface InterruptedLayeredCutover {
  readonly identity: LayeredCutoverIdentity;
  readonly lastSequence: number;
  readonly lastPhase: string | null;
  readonly recoveryAction: LayeredCutoverRecoveryAction;
  readonly journalDirectory: string;
}

export interface LayeredCutoverJournalOptions {
  readonly rootDirectory: string;
  readonly maxRecordsPerCutover?: number;
  readonly maxDetailsBytes?: number;
  readonly now?: () => number;
}

export interface AppendLayeredCutoverTransition {
  readonly phase: string;
  readonly details?: Readonly<Record<string, unknown>> | null;
}

export interface CompleteLayeredCutover {
  readonly outcome: LayeredCutoverOutcome;
  readonly phase?: string | null;
  readonly failureReason?: string | null;
  readonly details?: Readonly<Record<string, unknown>> | null;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RECORD_FILE_PATTERN = /^(\d{20})-([a-f0-9]{16})\.json$/u;
const MAX_RECORD_BYTES = 64 * 1_024;
const MAX_CUTOVERS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nodeErrorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (
    expected.length !== actual.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid or exceeds its length limit.`);
  }
  return value;
}

function boundedFailure(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(value, "Cutover failure reason", 1_024);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordFileName(sequence: number, recordSha256: string): string {
  return `${sequence.toString().padStart(20, "0")}-${recordSha256.slice(0, 16)}.json`;
}

function parseDetails(
  value: unknown,
  maximumBytes: number,
): Readonly<Record<string, unknown>> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new Error("Cutover journal details must be a plain object or null.");
  }
  const normalized = canonicalize(value) as Readonly<Record<string, unknown>>;
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw new Error(
      "Cutover journal details exceed the configured byte limit.",
    );
  }
  return normalized;
}

function parseRecord(
  value: unknown,
  maximumDetailsBytes: number,
): LayeredCutoverJournalRecord {
  if (!isRecord(value)) {
    throw new Error("Cutover journal record must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "cutoverId",
      "kind",
      "activeReleaseId",
      "candidateReleaseId",
      "sequence",
      "previousRecordSha256",
      "at",
      "event",
      "phase",
      "outcome",
      "failureReason",
      "details",
    ],
    "Cutover journal record",
  );
  if (value.schemaVersion !== LAYERED_CUTOVER_JOURNAL_SCHEMA_VERSION) {
    throw new Error("Unsupported cutover journal schema version.");
  }
  assertIdentifier(value.cutoverId, "Cutover ID");
  if (!LAYERED_CUTOVER_KINDS.includes(value.kind as LayeredCutoverKind)) {
    throw new Error("Cutover kind is invalid.");
  }
  assertIdentifier(value.activeReleaseId, "Active release ID");
  assertIdentifier(value.candidateReleaseId, "Candidate release ID");
  if (value.activeReleaseId === value.candidateReleaseId) {
    throw new Error("Cutover active and candidate release IDs must differ.");
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) {
    throw new Error("Cutover journal sequence is invalid.");
  }
  if (
    value.previousRecordSha256 !== null &&
    (typeof value.previousRecordSha256 !== "string" ||
      !SHA256_PATTERN.test(value.previousRecordSha256))
  ) {
    throw new Error("Cutover journal previous-record digest is invalid.");
  }
  if (!Number.isSafeInteger(value.at) || (value.at as number) < 0) {
    throw new Error("Cutover journal timestamp is invalid.");
  }
  if (!LAYERED_CUTOVER_EVENTS.includes(value.event as LayeredCutoverEvent)) {
    throw new Error("Cutover journal event is invalid.");
  }
  const phase =
    value.phase === null
      ? null
      : boundedText(value.phase, "Cutover phase", 128);
  const outcome =
    value.outcome === null
      ? null
      : value.outcome === "committed" ||
          value.outcome === "rolled-back" ||
          value.outcome === "failed"
        ? value.outcome
        : (() => {
            throw new Error("Cutover journal outcome is invalid.");
          })();
  const failureReason = boundedFailure(value.failureReason);
  const details = parseDetails(value.details, maximumDetailsBytes);

  if ((value.event === "started") !== ((value.sequence as number) === 1)) {
    throw new Error(
      "Only the first cutover journal record may be the started event.",
    );
  }
  if (value.event === "started" && (phase !== null || outcome !== null)) {
    throw new Error(
      "Started cutover records may not contain a phase or outcome.",
    );
  }
  if (value.event === "transition" && (phase === null || outcome !== null)) {
    throw new Error("Transition records require a phase and no outcome.");
  }
  if (value.event === "completed" && outcome === null) {
    throw new Error("Completed cutover records require an outcome.");
  }
  if (value.event === "recovery" && phase === null) {
    throw new Error("Recovery records require a recovery phase.");
  }
  if (outcome === "committed" && failureReason !== null) {
    throw new Error(
      "Committed cutover records may not contain a failure reason.",
    );
  }

  return {
    schemaVersion: LAYERED_CUTOVER_JOURNAL_SCHEMA_VERSION,
    cutoverId: value.cutoverId,
    kind: value.kind as LayeredCutoverKind,
    activeReleaseId: value.activeReleaseId,
    candidateReleaseId: value.candidateReleaseId,
    sequence: value.sequence as number,
    previousRecordSha256: value.previousRecordSha256,
    at: value.at as number,
    event: value.event as LayeredCutoverEvent,
    phase,
    outcome,
    failureReason,
    details,
  };
}

function recoveryAction(
  kind: LayeredCutoverKind,
  lastPhase: string | null,
): LayeredCutoverRecoveryAction {
  if (kind === "renderer") {
    if (
      lastPhase === "observe-candidate" ||
      lastPhase === "restore-view-state" ||
      lastPhase === "candidate-ready"
    ) {
      return "verify-renderer-commit";
    }
    if (
      lastPhase === "activate-candidate" ||
      lastPhase === "reload-candidate" ||
      lastPhase === "rollback-pointer" ||
      lastPhase === "reload-previous" ||
      lastPhase === "previous-ready" ||
      lastPhase === "restore-previous-state"
    ) {
      return "restore-previous-renderer";
    }
    return "discard-candidate";
  }

  if (lastPhase === "commit-candidate" || lastPhase === "stop-previous") {
    return "verify-runtime-commit";
  }
  if (
    lastPhase === "switch-traffic" ||
    lastPhase === "candidate-canary" ||
    lastPhase === "rollback-traffic"
  ) {
    return "restore-previous-traffic";
  }
  if (
    lastPhase === "quiesce-active" ||
    lastPhase === "drain-active" ||
    lastPhase === "checkpoint-active" ||
    lastPhase === "resume-active"
  ) {
    return "resume-active-and-stop-candidate";
  }
  return "stop-candidate";
}

export class LayeredCutoverJournal {
  readonly #rootDirectory: string;
  readonly #maxRecordsPerCutover: number;
  readonly #maxDetailsBytes: number;
  readonly #now: () => number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: LayeredCutoverJournalOptions) {
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.trim().length === 0
    ) {
      throw new Error("Cutover journal root directory is required.");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#maxRecordsPerCutover = options.maxRecordsPerCutover ?? 10_000;
    this.#maxDetailsBytes = options.maxDetailsBytes ?? 16 * 1_024;
    this.#now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.#maxRecordsPerCutover) ||
      this.#maxRecordsPerCutover < 2 ||
      this.#maxRecordsPerCutover > 100_000
    ) {
      throw new Error("Cutover journal record limit is invalid.");
    }
    if (
      !Number.isSafeInteger(this.#maxDetailsBytes) ||
      this.#maxDetailsBytes < 0 ||
      this.#maxDetailsBytes > 48 * 1_024
    ) {
      throw new Error("Cutover journal detail limit is invalid.");
    }
  }

  get rootDirectory(): string {
    return this.#rootDirectory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true });
  }

  async begin(
    identity: LayeredCutoverIdentity,
    details: Readonly<Record<string, unknown>> | null = null,
  ): Promise<LayeredCutoverJournalEntry> {
    return await this.#serialize(async () => {
      await this.initialize();
      const existing = await this.read(identity.cutoverId);
      if (existing.length > 0) {
        throw new Error(
          `Cutover journal ${identity.cutoverId} already exists.`,
        );
      }
      return await this.#append(identity, {
        event: "started",
        phase: null,
        outcome: null,
        failureReason: null,
        details,
      });
    });
  }

  async transition(
    cutoverId: string,
    input: AppendLayeredCutoverTransition,
  ): Promise<LayeredCutoverJournalEntry> {
    return await this.#serialize(async () => {
      assertIdentifier(cutoverId, "Cutover ID");
      const entries = await this.read(cutoverId);
      const last = this.#requiredOpen(entries, cutoverId);
      return await this.#append(last.record, {
        event: "transition",
        phase: boundedText(input.phase, "Cutover phase", 128),
        outcome: null,
        failureReason: null,
        details: input.details ?? null,
      });
    });
  }

  async complete(
    cutoverId: string,
    input: CompleteLayeredCutover,
  ): Promise<LayeredCutoverJournalEntry> {
    return await this.#serialize(async () => {
      assertIdentifier(cutoverId, "Cutover ID");
      const entries = await this.read(cutoverId);
      const last = this.#requiredOpen(entries, cutoverId);
      return await this.#append(last.record, {
        event: "completed",
        phase:
          input.phase === undefined || input.phase === null
            ? null
            : boundedText(input.phase, "Cutover completion phase", 128),
        outcome: input.outcome,
        failureReason: input.failureReason ?? null,
        details: input.details ?? null,
      });
    });
  }

  async recordRecovery(
    cutoverId: string,
    action: LayeredCutoverRecoveryAction,
    details: Readonly<Record<string, unknown>> | null = null,
  ): Promise<LayeredCutoverJournalEntry> {
    return await this.#serialize(async () => {
      assertIdentifier(cutoverId, "Cutover ID");
      const entries = await this.read(cutoverId);
      const last = this.#requiredOpen(entries, cutoverId);
      return await this.#append(last.record, {
        event: "recovery",
        phase: action,
        outcome: null,
        failureReason: null,
        details,
      });
    });
  }

  async read(
    cutoverId: string,
  ): Promise<readonly LayeredCutoverJournalEntry[]> {
    assertIdentifier(cutoverId, "Cutover ID");
    const directory = this.#cutoverDirectory(cutoverId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return [];
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile() && RECORD_FILE_PATTERN.test(entry.name))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    const unsupported = entries.filter(
      (entry) =>
        entry.name !== ".journal.lock" &&
        !(entry.isFile() && RECORD_FILE_PATTERN.test(entry.name)),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `Cutover journal ${cutoverId} contains unsupported entries.`,
      );
    }
    if (files.length > this.#maxRecordsPerCutover) {
      throw new Error(`Cutover journal ${cutoverId} exceeds its record limit.`);
    }

    const result: LayeredCutoverJournalEntry[] = [];
    let previousSha256: string | null = null;
    let identity: LayeredCutoverIdentity | null = null;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      const match = RECORD_FILE_PATTERN.exec(file.name)!;
      const sequence = Number(match[1]);
      if (sequence !== index + 1) {
        throw new Error(
          `Cutover journal ${cutoverId} has a missing or reordered sequence.`,
        );
      }
      const path = join(directory, file.name);
      const bytes = await readFile(path);
      if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) {
        throw new Error(
          `Cutover journal record ${file.name} exceeds its size limit.`,
        );
      }
      const record = parseRecord(
        JSON.parse(bytes.toString("utf8")) as unknown,
        this.#maxDetailsBytes,
      );
      if (record.cutoverId !== cutoverId || record.sequence !== sequence) {
        throw new Error(
          `Cutover journal record ${file.name} has mismatched identity.`,
        );
      }
      if (record.previousRecordSha256 !== previousSha256) {
        throw new Error(
          `Cutover journal record ${file.name} breaks the hash chain.`,
        );
      }
      const recordIdentity: LayeredCutoverIdentity = {
        cutoverId: record.cutoverId,
        kind: record.kind,
        activeReleaseId: record.activeReleaseId,
        candidateReleaseId: record.candidateReleaseId,
      };
      if (identity === null) {
        identity = recordIdentity;
      } else if (canonicalJson(identity) !== canonicalJson(recordIdentity)) {
        throw new Error(
          `Cutover journal record ${file.name} changes cutover identity.`,
        );
      }
      const recordSha256 = sha256(bytes);
      if (match[2] !== recordSha256.slice(0, 16)) {
        throw new Error(
          `Cutover journal record ${file.name} breaks the hash chain digest.`,
        );
      }
      result.push({ record, recordSha256, path });
      previousSha256 = recordSha256;
    }
    if (result.length > 0 && result[0]!.record.event !== "started") {
      throw new Error(
        `Cutover journal ${cutoverId} does not begin with a started record.`,
      );
    }
    const completedIndex = result.findIndex(
      (entry) => entry.record.event === "completed",
    );
    if (completedIndex >= 0 && completedIndex !== result.length - 1) {
      throw new Error(
        `Cutover journal ${cutoverId} contains records after completion.`,
      );
    }
    return result;
  }

  async listInterrupted(): Promise<readonly InterruptedLayeredCutover[]> {
    await this.initialize();
    const entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (directories.length > MAX_CUTOVERS) {
      throw new Error("Cutover journal root exceeds its cutover limit.");
    }
    const interrupted: InterruptedLayeredCutover[] = [];
    for (const cutoverId of directories) {
      if (!IDENTIFIER_PATTERN.test(cutoverId)) {
        throw new Error(
          `Cutover journal root contains invalid directory ${cutoverId}.`,
        );
      }
      const records = await this.read(cutoverId);
      const last = records.at(-1);
      if (last === undefined || last.record.event === "completed") continue;
      const identity: LayeredCutoverIdentity = {
        cutoverId: last.record.cutoverId,
        kind: last.record.kind,
        activeReleaseId: last.record.activeReleaseId,
        candidateReleaseId: last.record.candidateReleaseId,
      };
      interrupted.push({
        identity,
        lastSequence: last.record.sequence,
        lastPhase: last.record.phase,
        recoveryAction: recoveryAction(last.record.kind, last.record.phase),
        journalDirectory: this.#cutoverDirectory(cutoverId),
      });
    }
    return interrupted;
  }

  #requiredOpen(
    entries: readonly LayeredCutoverJournalEntry[],
    cutoverId: string,
  ): LayeredCutoverJournalEntry {
    const last = entries.at(-1);
    if (last === undefined) {
      throw new Error(`Cutover journal ${cutoverId} has not been started.`);
    }
    if (last.record.event === "completed") {
      throw new Error(`Cutover journal ${cutoverId} is already completed.`);
    }
    return last;
  }

  async #append(
    identity: LayeredCutoverIdentity,
    input: {
      readonly event: LayeredCutoverEvent;
      readonly phase: string | null;
      readonly outcome: LayeredCutoverOutcome | null;
      readonly failureReason: string | null;
      readonly details: Readonly<Record<string, unknown>> | null;
    },
  ): Promise<LayeredCutoverJournalEntry> {
    assertIdentifier(identity.cutoverId, "Cutover ID");
    if (!LAYERED_CUTOVER_KINDS.includes(identity.kind)) {
      throw new Error("Cutover kind is invalid.");
    }
    assertIdentifier(identity.activeReleaseId, "Active release ID");
    assertIdentifier(identity.candidateReleaseId, "Candidate release ID");
    const directory = this.#cutoverDirectory(identity.cutoverId);
    await mkdir(directory, { recursive: true });
    return await this.#withLock(directory, async () => {
      const existing = await this.read(identity.cutoverId);
      const previous = existing.at(-1);
      const sequence = (previous?.record.sequence ?? 0) + 1;
      if (sequence > this.#maxRecordsPerCutover) {
        throw new Error(
          `Cutover journal ${identity.cutoverId} reached its record limit.`,
        );
      }
      const record = parseRecord(
        {
          schemaVersion: LAYERED_CUTOVER_JOURNAL_SCHEMA_VERSION,
          cutoverId: identity.cutoverId,
          kind: identity.kind,
          activeReleaseId: identity.activeReleaseId,
          candidateReleaseId: identity.candidateReleaseId,
          sequence,
          previousRecordSha256: previous?.recordSha256 ?? null,
          at: this.#now(),
          event: input.event,
          phase: input.phase,
          outcome: input.outcome,
          failureReason: input.failureReason,
          details: input.details,
        },
        this.#maxDetailsBytes,
      );
      const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
      if (bytes.length > MAX_RECORD_BYTES) {
        throw new Error("Cutover journal record exceeds its size limit.");
      }
      const recordSha256 = sha256(bytes);
      const finalPath = join(directory, recordFileName(sequence, recordSha256));
      const temporaryPath = join(
        directory,
        `.${recordFileName(sequence, recordSha256)}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
      );
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      try {
        await rename(temporaryPath, finalPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return {
        record,
        recordSha256,
        path: finalPath,
      };
    });
  }

  #cutoverDirectory(cutoverId: string): string {
    assertIdentifier(cutoverId, "Cutover ID");
    return join(this.#rootDirectory, cutoverId);
  }

  async #withLock<T>(
    directory: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockPath = join(directory, ".journal.lock");
    const deadlineAt = Date.now() + 10_000;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    while (handle === null) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > 15 * 60_000) {
            await rm(lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if (nodeErrorCode(statError) === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadlineAt) {
          throw new Error("Timed out waiting for the cutover journal lock.");
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    try {
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
