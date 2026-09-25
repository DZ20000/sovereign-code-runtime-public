import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  LAYERED_UPDATE_OUTCOMES,
  LayeredUpdateCoordinator,
  type LayeredUpdateExecutionOptions,
  type LayeredUpdateOutcome,
  type LayeredUpdateReceipt,
  type VerifiedLayeredUpdateCandidate,
} from "./layered-update.js";
import {
  COMPONENT_UPDATE_MODES,
  type ComponentUpdateMode,
} from "./update-plan.js";

export const LAYERED_UPDATE_JOURNAL_SCHEMA_VERSION =
  "scr.layered-update-journal/v1" as const;

const RECORD_PATTERN = /^(\d{12})-([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\.json$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const MAX_RECORDS = 4_096;
const MAX_RECORD_BYTES = 128 * 1_024;
const MAX_FAILURE_REASON = 1_024;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 15 * 60_000;

export interface LayeredUpdateJournalPayload {
  readonly operationId: string;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly manifestSha256: string;
  readonly signingKeyId: string;
  readonly strategy: ComponentUpdateMode;
  readonly outcome: LayeredUpdateOutcome;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly failureReason: string | null;
  readonly delegatedReceiptSha256: string | null;
  readonly transitionsSha256: string;
}

export interface LayeredUpdateJournalRecord {
  readonly schemaVersion: typeof LAYERED_UPDATE_JOURNAL_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousRecordSha256: string | null;
  readonly payload: LayeredUpdateJournalPayload;
  readonly recordSha256: string;
  readonly recordedAt: number;
}

export interface LayeredUpdateJournalOptions {
  readonly directory: string;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    expected.some((key, index) => actual[index] !== key)
  ) {
    throw new Error(`${label} contains unsupported or missing fields.`);
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

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertSafeTimestamp(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid.`);
  }
}

function boundedFailure(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (
    normalized.length === 0 ? "Layered update failed." : normalized
  ).slice(0, MAX_FAILURE_REASON);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nodeErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function receiptPayload(
  receipt: LayeredUpdateReceipt,
): LayeredUpdateJournalPayload {
  return {
    operationId: receipt.operationId,
    releaseId: receipt.releaseId,
    releaseSequence: receipt.releaseSequence,
    manifestSha256: receipt.manifestSha256,
    signingKeyId: receipt.signingKeyId,
    strategy: receipt.strategy,
    outcome: receipt.outcome,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    failureReason: boundedFailure(receipt.failureReason),
    delegatedReceiptSha256:
      receipt.delegatedReceipt === null
        ? null
        : sha256(canonicalJson(receipt.delegatedReceipt)),
    transitionsSha256: sha256(canonicalJson(receipt.transitions)),
  };
}

function validatePayload(value: unknown): LayeredUpdateJournalPayload {
  if (!isRecord(value)) {
    throw new Error("Layered update journal payload must be an object.");
  }
  assertExactKeys(
    value,
    [
      "operationId",
      "releaseId",
      "releaseSequence",
      "manifestSha256",
      "signingKeyId",
      "strategy",
      "outcome",
      "startedAt",
      "completedAt",
      "failureReason",
      "delegatedReceiptSha256",
      "transitionsSha256",
    ],
    "Layered update journal payload",
  );
  assertIdentifier(value.operationId, "Layered update operation ID");
  assertIdentifier(value.releaseId, "Layered update release ID");
  assertIdentifier(value.signingKeyId, "Layered update signing key ID");
  if (
    !Number.isSafeInteger(value.releaseSequence) ||
    (value.releaseSequence as number) < 1
  ) {
    throw new Error("Layered update release sequence is invalid.");
  }
  assertSha256(value.manifestSha256, "Layered update manifest digest");
  if (
    typeof value.strategy !== "string" ||
    !COMPONENT_UPDATE_MODES.includes(value.strategy as ComponentUpdateMode)
  ) {
    throw new Error("Layered update journal strategy is invalid.");
  }
  if (
    typeof value.outcome !== "string" ||
    !LAYERED_UPDATE_OUTCOMES.includes(value.outcome as LayeredUpdateOutcome)
  ) {
    throw new Error("Layered update journal outcome is invalid.");
  }
  assertSafeTimestamp(value.startedAt, "Layered update start time");
  assertSafeTimestamp(value.completedAt, "Layered update completion time");
  if ((value.completedAt as number) < (value.startedAt as number)) {
    throw new Error("Layered update journal time range is inverted.");
  }
  if (
    value.failureReason !== null &&
    (typeof value.failureReason !== "string" ||
      value.failureReason.length === 0 ||
      value.failureReason.length > MAX_FAILURE_REASON ||
      /[\u0000-\u001f\u007f]/u.test(value.failureReason))
  ) {
    throw new Error("Layered update journal failure reason is invalid.");
  }
  if (value.delegatedReceiptSha256 !== null) {
    assertSha256(
      value.delegatedReceiptSha256,
      "Layered update delegated receipt digest",
    );
  }
  assertSha256(value.transitionsSha256, "Layered update transition digest");
  return {
    operationId: value.operationId,
    releaseId: value.releaseId,
    releaseSequence: value.releaseSequence as number,
    manifestSha256: value.manifestSha256,
    signingKeyId: value.signingKeyId,
    strategy: value.strategy as ComponentUpdateMode,
    outcome: value.outcome as LayeredUpdateOutcome,
    startedAt: value.startedAt as number,
    completedAt: value.completedAt as number,
    failureReason: value.failureReason as string | null,
    delegatedReceiptSha256: value.delegatedReceiptSha256 as string | null,
    transitionsSha256: value.transitionsSha256,
  };
}

function recordHashInput(
  record: Omit<LayeredUpdateJournalRecord, "recordSha256">,
): string {
  return canonicalJson(record);
}

function parseRecord(value: unknown): LayeredUpdateJournalRecord {
  if (!isRecord(value)) {
    throw new Error("Layered update journal record must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sequence",
      "previousRecordSha256",
      "payload",
      "recordSha256",
      "recordedAt",
    ],
    "Layered update journal record",
  );
  if (value.schemaVersion !== LAYERED_UPDATE_JOURNAL_SCHEMA_VERSION) {
    throw new Error("Unsupported layered update journal schema version.");
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) {
    throw new Error("Layered update journal sequence is invalid.");
  }
  if (value.previousRecordSha256 !== null) {
    assertSha256(
      value.previousRecordSha256,
      "Previous update journal record digest",
    );
  }
  assertSha256(value.recordSha256, "Update journal record digest");
  assertSafeTimestamp(value.recordedAt, "Update journal record time");
  const payload = validatePayload(value.payload);
  const unsigned = {
    schemaVersion: LAYERED_UPDATE_JOURNAL_SCHEMA_VERSION,
    sequence: value.sequence as number,
    previousRecordSha256: value.previousRecordSha256 as string | null,
    payload,
    recordedAt: value.recordedAt as number,
  } satisfies Omit<LayeredUpdateJournalRecord, "recordSha256">;
  const expected = sha256(recordHashInput(unsigned));
  if (expected !== value.recordSha256) {
    throw new Error("Layered update journal record digest does not match.");
  }
  return { ...unsigned, recordSha256: value.recordSha256 };
}

function recordFileName(record: LayeredUpdateJournalRecord): string {
  const operationDigest = sha256(record.payload.operationId).slice(0, 16);
  return `${record.sequence.toString().padStart(12, "0")}-${operationDigest}.json`;
}

export class LayeredUpdateJournal {
  readonly #directory: string;
  readonly #lockPath: string;
  readonly #now: () => number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: LayeredUpdateJournalOptions) {
    if (
      typeof options.directory !== "string" ||
      options.directory.trim().length === 0
    ) {
      throw new Error("Layered update journal directory is required.");
    }
    this.#directory = resolve(options.directory);
    this.#lockPath = join(this.#directory, ".journal.lock");
    this.#now = options.now ?? Date.now;
  }

  async list(): Promise<readonly LayeredUpdateJournalRecord[]> {
    await mkdir(this.#directory, { recursive: true });
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const records: { readonly sequence: number; readonly path: string }[] = [];
    for (const entry of entries) {
      if (entry.name === basename(this.#lockPath)) continue;
      if (entry.name.startsWith(".pending-") && entry.name.endsWith(".tmp")) {
        await rm(join(this.#directory, entry.name), { force: true }).catch(
          () => undefined,
        );
        continue;
      }
      const match = RECORD_PATTERN.exec(entry.name);
      if (!entry.isFile() || match === null) {
        throw new Error(
          `Layered update journal contains an unexpected entry: ${entry.name}.`,
        );
      }
      records.push({
        sequence: Number.parseInt(match[1]!, 10),
        path: join(this.#directory, entry.name),
      });
    }
    records.sort((left, right) => left.sequence - right.sequence);
    if (records.length > MAX_RECORDS) {
      throw new Error("Layered update journal exceeds its record limit.");
    }

    const parsed: LayeredUpdateJournalRecord[] = [];
    let previousHash: string | null = null;
    const operationIds = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const expectedSequence = index + 1;
      const descriptor = records[index]!;
      if (descriptor.sequence !== expectedSequence) {
        throw new Error("Layered update journal sequence is not contiguous.");
      }
      const bytes = await readFile(descriptor.path);
      if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) {
        throw new Error(
          "Layered update journal record exceeds its size limit.",
        );
      }
      const record = parseRecord(JSON.parse(bytes.toString("utf8")) as unknown);
      if (record.sequence !== expectedSequence) {
        throw new Error(
          "Layered update journal filename and record sequence differ.",
        );
      }
      if (recordFileName(record) !== basename(descriptor.path)) {
        throw new Error(
          "Layered update journal filename does not match its payload.",
        );
      }
      if (record.previousRecordSha256 !== previousHash) {
        throw new Error("Layered update journal hash chain is invalid.");
      }
      if (operationIds.has(record.payload.operationId)) {
        throw new Error(
          "Layered update journal contains a duplicate operation ID.",
        );
      }
      operationIds.add(record.payload.operationId);
      previousHash = record.recordSha256;
      parsed.push(record);
    }
    return parsed;
  }

  async append(
    receipt: LayeredUpdateReceipt,
  ): Promise<LayeredUpdateJournalRecord> {
    return this.#serialize(async () => {
      const payload = validatePayload(receiptPayload(receipt));
      const records = await this.list();
      const existing = records.find(
        (record) => record.payload.operationId === payload.operationId,
      );
      if (existing !== undefined) {
        if (canonicalJson(existing.payload) !== canonicalJson(payload)) {
          throw new Error(
            `Layered update operation ${payload.operationId} is already journaled with different evidence.`,
          );
        }
        return existing;
      }
      if (records.length >= MAX_RECORDS) {
        throw new Error("Layered update journal reached its record limit.");
      }
      const previous = records.at(-1) ?? null;
      const unsigned = {
        schemaVersion: LAYERED_UPDATE_JOURNAL_SCHEMA_VERSION,
        sequence: records.length + 1,
        previousRecordSha256: previous?.recordSha256 ?? null,
        payload,
        recordedAt: this.#now(),
      } satisfies Omit<LayeredUpdateJournalRecord, "recordSha256">;
      const record: LayeredUpdateJournalRecord = {
        ...unsigned,
        recordSha256: sha256(recordHashInput(unsigned)),
      };
      const json = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(json, "utf8") > MAX_RECORD_BYTES) {
        throw new Error(
          "Layered update journal record exceeds its size limit.",
        );
      }
      const finalPath = join(this.#directory, recordFileName(record));
      const temporary = join(
        this.#directory,
        `.pending-${record.sequence.toString().padStart(12, "0")}-${process.pid}.tmp`,
      );
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(json, { encoding: "utf8" });
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, finalPath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      return parseRecord(
        JSON.parse(await readFile(finalPath, "utf8")) as unknown,
      );
    });
  }

  async latest(): Promise<LayeredUpdateJournalRecord | null> {
    return (await this.list()).at(-1) ?? null;
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#lockPath), { recursive: true });
    const deadlineAt = Date.now() + LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    while (handle === null) {
      try {
        handle = await open(this.#lockPath, "wx", 0o600);
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        try {
          const lock = await stat(this.#lockPath);
          if (Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
            await rm(this.#lockPath, { force: true });
            continue;
          }
        } catch (lockError) {
          if (nodeErrorCode(lockError) === "ENOENT") continue;
          throw lockError;
        }
        if (Date.now() >= deadlineAt) {
          throw new Error(
            "Timed out waiting for the layered update journal lock.",
          );
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    try {
      await handle.writeFile(`${process.pid}\n`, { encoding: "utf8" });
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(this.#lockPath, { force: true }).catch(() => undefined);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const locked = () => this.#withLock(operation);
    const result = this.#queue.then(locked, locked);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface JournaledLayeredUpdateResult {
  readonly receipt: LayeredUpdateReceipt;
  readonly journalRecord: LayeredUpdateJournalRecord | null;
  readonly journalFailure: string | null;
}

/**
 * Executes one layered update and persists its bounded hash-chained evidence.
 * A journal failure never disguises or retries an already committed cutover;
 * the caller receives the authoritative cutover receipt plus a separate audit
 * failure that must become a persistent incident.
 */
export async function executeLayeredUpdateWithJournal(
  coordinator: LayeredUpdateCoordinator,
  journal: LayeredUpdateJournal,
  candidate: VerifiedLayeredUpdateCandidate,
  options: LayeredUpdateExecutionOptions = {},
): Promise<JournaledLayeredUpdateResult> {
  if (!(coordinator instanceof LayeredUpdateCoordinator)) {
    throw new Error("Layered update coordinator is required.");
  }
  if (!(journal instanceof LayeredUpdateJournal)) {
    throw new Error("Layered update journal is required.");
  }
  const receipt = await coordinator.execute(candidate, options);
  try {
    return {
      receipt,
      journalRecord: await journal.append(receipt),
      journalFailure: null,
    };
  } catch (error) {
    return {
      receipt,
      journalRecord: null,
      journalFailure: boundedFailure(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}
