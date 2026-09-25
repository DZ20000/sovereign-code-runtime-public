import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalReleaseJson } from "./manifest.js";

export const RESTART_JOURNAL_ENTRY_SCHEMA_VERSION =
  "scr.restart-journal-entry/v1" as const;

export const RESTART_INTENT_PHASES = [
  "prepared",
  "restart-requested",
  "candidate-started",
  "candidate-healthy",
  "rollback-requested",
  "committed",
  "rolled-back",
  "failed",
] as const;

export type RestartIntentPhase = (typeof RESTART_INTENT_PHASES)[number];

export interface RestartCheckpointReference {
  readonly checkpointId: string;
  readonly checkpointSha256: string;
  readonly fencingToken: string;
}

export interface RestartIntentIdentity extends RestartCheckpointReference {
  readonly updateId: string;
  readonly currentReleaseId: string;
  readonly candidateReleaseId: string;
  readonly restartId: string;
}

export interface RestartJournalEntry extends RestartIntentIdentity {
  readonly schemaVersion: typeof RESTART_JOURNAL_ENTRY_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousEntrySha256: string | null;
  readonly phase: RestartIntentPhase;
  readonly failureReason: string | null;
  readonly recordedAt: number;
  readonly entrySha256: string;
}

export interface RestartJournalOptions {
  readonly rootDirectory: string;
  readonly now?: () => number;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

interface RestartEntryPayload extends RestartIntentIdentity {
  readonly schemaVersion: typeof RESTART_JOURNAL_ENTRY_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousEntrySha256: string | null;
  readonly phase: RestartIntentPhase;
  readonly failureReason: string | null;
  readonly recordedAt: number;
}

const ENTRIES_DIRECTORY = "entries";
const LOCK_FILE = "restart-journal.lock";
const ENTRY_PATTERN = /^(\d{20})-([a-f0-9]{16})\.json$/u;
const PENDING_PATTERN = /^\.pending-(\d{20})-[a-f0-9]{32}\.tmp$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PHASE_SET = new Set<string>(RESTART_INTENT_PHASES);
const MAX_ENTRIES = 4_096;
const MAX_ENTRY_BYTES = 128 * 1_024;
const MAX_PENDING_FILES = 64;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 15 * 60_000;

const ALLOWED_TRANSITIONS: Readonly<
  Record<RestartIntentPhase, ReadonlySet<RestartIntentPhase>>
> = {
  prepared: new Set(["restart-requested", "failed"]),
  "restart-requested": new Set([
    "candidate-started",
    "rollback-requested",
    "rolled-back",
    "failed",
  ]),
  "candidate-started": new Set([
    "candidate-healthy",
    "rollback-requested",
    "failed",
  ]),
  "candidate-healthy": new Set(["committed", "rollback-requested", "failed"]),
  "rollback-requested": new Set(["rolled-back", "failed"]),
  committed: new Set(),
  "rolled-back": new Set(),
  failed: new Set(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    wanted.some((key, index) => key !== actual[index])
  ) {
    throw new Error(`${label} contains missing or unsupported fields.`);
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
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertTimestamp(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Restart journal timestamp is invalid.");
  }
}

function normalizedFailureReason(
  value: unknown,
  required: boolean,
): string | null {
  if (value === null && !required) return null;
  if (typeof value !== "string") {
    throw new Error("Restart failure reason is invalid.");
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error("Restart failure reason is empty or exceeds its limit.");
  }
  return normalized;
}

function validateIdentity(value: RestartIntentIdentity): RestartIntentIdentity {
  if (!isRecord(value)) throw new Error("Restart intent identity is invalid.");
  assertIdentifier(value.updateId, "Restart update ID");
  assertIdentifier(value.currentReleaseId, "Current release ID");
  assertIdentifier(value.candidateReleaseId, "Candidate release ID");
  if (value.currentReleaseId === value.candidateReleaseId) {
    throw new Error("Restart current and candidate releases must differ.");
  }
  assertIdentifier(value.restartId, "Restart ID");
  assertIdentifier(value.checkpointId, "Restart checkpoint ID");
  assertSha256(value.checkpointSha256, "Restart checkpoint digest");
  assertIdentifier(value.fencingToken, "Restart fencing token");
  return {
    updateId: value.updateId,
    currentReleaseId: value.currentReleaseId,
    candidateReleaseId: value.candidateReleaseId,
    restartId: value.restartId,
    checkpointId: value.checkpointId,
    checkpointSha256: value.checkpointSha256,
    fencingToken: value.fencingToken,
  };
}

function sameIdentity(
  left: RestartIntentIdentity,
  right: RestartIntentIdentity,
): boolean {
  return (
    left.updateId === right.updateId &&
    left.currentReleaseId === right.currentReleaseId &&
    left.candidateReleaseId === right.candidateReleaseId &&
    left.restartId === right.restartId &&
    left.checkpointId === right.checkpointId &&
    left.checkpointSha256 === right.checkpointSha256 &&
    left.fencingToken === right.fencingToken
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPayload(value: RestartEntryPayload): string {
  return canonicalReleaseJson(value);
}

function parseEntry(value: unknown): RestartJournalEntry {
  if (!isRecord(value))
    throw new Error("Restart journal entry must be an object.");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sequence",
      "previousEntrySha256",
      "updateId",
      "currentReleaseId",
      "candidateReleaseId",
      "restartId",
      "checkpointId",
      "checkpointSha256",
      "fencingToken",
      "phase",
      "failureReason",
      "recordedAt",
      "entrySha256",
    ],
    "Restart journal entry",
  );
  if (value.schemaVersion !== RESTART_JOURNAL_ENTRY_SCHEMA_VERSION) {
    throw new Error("Unsupported restart journal entry schema version.");
  }
  if (
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.sequence > MAX_ENTRIES
  ) {
    throw new Error("Restart journal sequence is invalid.");
  }
  if (value.previousEntrySha256 !== null) {
    assertSha256(value.previousEntrySha256, "Previous restart entry digest");
  }
  const identity = validateIdentity(value as unknown as RestartIntentIdentity);
  if (typeof value.phase !== "string" || !PHASE_SET.has(value.phase)) {
    throw new Error("Restart journal phase is invalid.");
  }
  const terminal = ["committed", "rolled-back", "failed"].includes(value.phase);
  const failureReason = normalizedFailureReason(
    value.failureReason,
    value.phase === "failed",
  );
  if (
    !terminal &&
    failureReason !== null &&
    value.phase !== "rollback-requested"
  ) {
    throw new Error("Restart failure reason is not valid for this phase.");
  }
  assertTimestamp(value.recordedAt);
  assertSha256(value.entrySha256, "Restart journal entry digest");
  const payload: RestartEntryPayload = {
    schemaVersion: RESTART_JOURNAL_ENTRY_SCHEMA_VERSION,
    sequence: value.sequence,
    previousEntrySha256: value.previousEntrySha256,
    ...identity,
    phase: value.phase as RestartIntentPhase,
    failureReason,
    recordedAt: value.recordedAt,
  };
  if (sha256(canonicalPayload(payload)) !== value.entrySha256) {
    throw new Error("Restart journal entry digest does not match its payload.");
  }
  return { ...payload, entrySha256: value.entrySha256 };
}

function fileName(
  entry: Pick<RestartJournalEntry, "sequence" | "entrySha256">,
): string {
  return `${entry.sequence.toString().padStart(20, "0")}-${entry.entrySha256.slice(0, 16)}.json`;
}

function isTerminal(phase: RestartIntentPhase): boolean {
  return phase === "committed" || phase === "rolled-back" || phase === "failed";
}

async function assertContainedDirectory(
  root: string,
  child: string,
): Promise<void> {
  const rootInfo = await lstat(root);
  const childInfo = await lstat(child);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !childInfo.isDirectory() ||
    childInfo.isSymbolicLink()
  ) {
    throw new Error("Restart journal storage must use real directories.");
  }
  const fromRoot = relative(await realpath(root), await realpath(child));
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("Restart journal entries resolve outside their root.");
  }
}
export class RestartJournal {
  readonly #rootDirectory: string;
  readonly #entriesDirectory: string;
  readonly #lockPath: string;
  readonly #now: () => number;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RestartJournalOptions) {
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.trim().length === 0
    ) {
      throw new Error("Restart journal root directory is required.");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#entriesDirectory = join(this.#rootDirectory, ENTRIES_DIRECTORY);
    this.#lockPath = join(this.#rootDirectory, LOCK_FILE);
    this.#now = options.now ?? Date.now;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    if (
      !Number.isSafeInteger(this.#lockTimeoutMs) ||
      this.#lockTimeoutMs < 1 ||
      this.#lockTimeoutMs > 60_000
    ) {
      throw new Error("Restart journal lock timeout is invalid.");
    }
    if (
      !Number.isSafeInteger(this.#staleLockMs) ||
      this.#staleLockMs < 1 ||
      this.#staleLockMs > 24 * 60 * 60_000
    ) {
      throw new Error("Restart journal stale lock timeout is invalid.");
    }
  }

  async readAll(): Promise<readonly RestartJournalEntry[]> {
    await this.#initializeStorage();
    return await this.#readEntries();
  }

  async openIntent(): Promise<RestartJournalEntry | null> {
    const entries = await this.readAll();
    const latest = entries.at(-1);
    return latest === undefined || isTerminal(latest.phase) ? null : latest;
  }

  async prepare(identity: RestartIntentIdentity): Promise<RestartJournalEntry> {
    const normalized = validateIdentity(identity);
    return await this.#serialize(async () => {
      await this.#initializeStorage();
      const entries = await this.#readEntries();
      const latest = entries.at(-1);
      if (latest !== undefined && !isTerminal(latest.phase)) {
        if (latest.phase === "prepared" && sameIdentity(latest, normalized)) {
          return latest;
        }
        throw new Error(`Restart intent ${latest.updateId} is already open.`);
      }
      return await this.#publishNext(entries, {
        ...normalized,
        phase: "prepared",
        failureReason: null,
        recordedAt: this.#now(),
      });
    });
  }

  async transition(
    updateId: string,
    phase: RestartIntentPhase,
    failureReason: string | null = null,
  ): Promise<RestartJournalEntry> {
    assertIdentifier(updateId, "Restart update ID");
    if (!PHASE_SET.has(phase))
      throw new Error("Restart journal phase is invalid.");
    return await this.#serialize(async () => {
      await this.#initializeStorage();
      const entries = await this.#readEntries();
      const current = entries.at(-1);
      if (current === undefined || isTerminal(current.phase)) {
        throw new Error(`Restart intent ${updateId} is not open.`);
      }
      if (current.updateId !== updateId) {
        throw new Error(`Restart intent ${updateId} is not open.`);
      }
      const reason = normalizedFailureReason(failureReason, phase === "failed");
      if (phase === current.phase) {
        if (current.failureReason === reason) return current;
        throw new Error(
          `Restart phase ${phase} retry changed its failure evidence.`,
        );
      }
      if (!ALLOWED_TRANSITIONS[current.phase].has(phase)) {
        throw new Error(
          `Invalid restart transition ${current.phase} -> ${phase}.`,
        );
      }
      if (
        reason !== null &&
        phase !== "failed" &&
        phase !== "rollback-requested" &&
        phase !== "rolled-back"
      ) {
        throw new Error("Restart failure reason is invalid for this phase.");
      }
      return await this.#publishNext(entries, {
        updateId: current.updateId,
        currentReleaseId: current.currentReleaseId,
        candidateReleaseId: current.candidateReleaseId,
        restartId: current.restartId,
        checkpointId: current.checkpointId,
        checkpointSha256: current.checkpointSha256,
        fencingToken: current.fencingToken,
        phase,
        failureReason: reason,
        recordedAt: this.#now(),
      });
    });
  }

  async #publishNext(
    entries: readonly RestartJournalEntry[],
    value: RestartIntentIdentity & {
      readonly phase: RestartIntentPhase;
      readonly failureReason: string | null;
      readonly recordedAt: number;
    },
  ): Promise<RestartJournalEntry> {
    if (entries.length >= MAX_ENTRIES) {
      throw new Error("Restart journal reached its entry limit.");
    }
    await this.#removePendingFiles();
    const payload: RestartEntryPayload = {
      schemaVersion: RESTART_JOURNAL_ENTRY_SCHEMA_VERSION,
      sequence: entries.length + 1,
      previousEntrySha256: entries.at(-1)?.entrySha256 ?? null,
      updateId: value.updateId,
      currentReleaseId: value.currentReleaseId,
      candidateReleaseId: value.candidateReleaseId,
      restartId: value.restartId,
      checkpointId: value.checkpointId,
      checkpointSha256: value.checkpointSha256,
      fencingToken: value.fencingToken,
      phase: value.phase,
      failureReason: value.failureReason,
      recordedAt: value.recordedAt,
    };
    const entry: RestartJournalEntry = {
      ...payload,
      entrySha256: sha256(canonicalPayload(payload)),
    };
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    if (bytes.length > MAX_ENTRY_BYTES) {
      throw new Error("Restart journal entry exceeds its size limit.");
    }
    const temporaryPath = join(
      this.#entriesDirectory,
      `.pending-${entry.sequence.toString().padStart(20, "0")}-${randomBytes(16).toString("hex")}.tmp`,
    );
    const finalPath = join(this.#entriesDirectory, fileName(entry));
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (nodeErrorCode(error) === "EEXIST") {
        throw new Error("Restart journal sequence was concurrently published.");
      }
      throw error;
    }
    await rm(temporaryPath, { force: true });
    try {
      const directory = await open(this.#entriesDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (
        !["EINVAL", "ENOTSUP", "EPERM", "EACCES"].includes(
          nodeErrorCode(error) ?? "",
        )
      ) {
        throw error;
      }
    }
    const published = (await this.#readEntries()).at(-1);
    if (
      published === undefined ||
      published.sequence !== entry.sequence ||
      published.entrySha256 !== entry.entrySha256
    ) {
      throw new Error("Published restart journal entry could not be verified.");
    }
    return published;
  }

  async #initializeStorage(): Promise<void> {
    await mkdir(this.#entriesDirectory, { recursive: true });
    await assertContainedDirectory(this.#rootDirectory, this.#entriesDirectory);
  }

  async #readEntries(): Promise<RestartJournalEntry[]> {
    const directoryEntries = await readdir(this.#entriesDirectory, {
      withFileTypes: true,
    });
    const committed: { readonly name: string; readonly path: string }[] = [];
    let pendingCount = 0;
    for (const directoryEntry of directoryEntries) {
      if (
        directoryEntry.isFile() &&
        PENDING_PATTERN.test(directoryEntry.name)
      ) {
        pendingCount += 1;
        continue;
      }
      if (
        !directoryEntry.isFile() ||
        !ENTRY_PATTERN.test(directoryEntry.name)
      ) {
        throw new Error(
          `Restart journal contains an unexpected entry: ${directoryEntry.name}.`,
        );
      }
      committed.push({
        name: directoryEntry.name,
        path: join(this.#entriesDirectory, directoryEntry.name),
      });
    }
    if (pendingCount > MAX_PENDING_FILES) {
      throw new Error("Restart journal contains too many pending entries.");
    }
    if (committed.length > MAX_ENTRIES) {
      throw new Error("Restart journal exceeds its entry limit.");
    }
    committed.sort((left, right) => left.name.localeCompare(right.name));
    const entries: RestartJournalEntry[] = [];
    let previous: string | null = null;
    for (let index = 0; index < committed.length; index += 1) {
      const expectedSequence = index + 1;
      const file = committed[index]!;
      const match = ENTRY_PATTERN.exec(file.name)!;
      if (Number(match[1]) !== expectedSequence) {
        throw new Error("Restart journal contains a sequence gap.");
      }
      const info = await lstat(file.path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size < 2 ||
        info.size > MAX_ENTRY_BYTES
      ) {
        throw new Error("Restart journal entry has invalid metadata.");
      }
      const bytes = await readFile(file.path);
      if (bytes.length !== info.size || bytes.at(-1) !== 0x0a) {
        throw new Error("Restart journal entry is incomplete.");
      }
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch (error) {
        throw new Error(
          `Restart journal entry is invalid JSON: ${String(error)}`,
        );
      }
      const parsed = parseEntry(parsedValue);
      if (
        parsed.sequence !== expectedSequence ||
        file.name !== fileName(parsed)
      ) {
        throw new Error(
          "Restart journal entry filename does not match its digest.",
        );
      }
      if (parsed.previousEntrySha256 !== previous) {
        throw new Error("Restart journal entry breaks the hash chain.");
      }
      const prior = entries.at(-1);
      if (prior !== undefined) {
        if (!sameIdentity(prior, parsed)) {
          if (!isTerminal(prior.phase)) {
            throw new Error(
              "Restart intent identity changed before it became terminal.",
            );
          }
        } else if (
          parsed.phase !== prior.phase &&
          !ALLOWED_TRANSITIONS[prior.phase].has(parsed.phase)
        ) {
          throw new Error(
            `Restart journal contains invalid transition ${prior.phase} -> ${parsed.phase}.`,
          );
        }
      }
      entries.push(parsed);
      previous = parsed.entrySha256;
    }
    return entries;
  }
  async #removePendingFiles(): Promise<void> {
    const entries = await readdir(this.#entriesDirectory, {
      withFileTypes: true,
    });
    const pending = entries
      .filter((entry) => entry.isFile() && PENDING_PATTERN.test(entry.name))
      .map((entry) => join(this.#entriesDirectory, entry.name));
    if (pending.length > MAX_PENDING_FILES) {
      throw new Error("Restart journal contains too many pending entries.");
    }
    await Promise.all(pending.map((path) => rm(path, { force: true })));
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.#initializeStorage();
    const deadline = Date.now() + this.#lockTimeoutMs;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    while (handle === null) {
      try {
        handle = await open(this.#lockPath, "wx", 0o600);
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        try {
          const lock = await stat(this.#lockPath);
          if (!lock.isFile() || lock.isSymbolicLink()) {
            throw new Error("Restart journal lock is not a regular file.");
          }
          if (Date.now() - lock.mtimeMs > this.#staleLockMs) {
            await rm(this.#lockPath, { force: true });
            continue;
          }
        } catch (lockError) {
          if (nodeErrorCode(lockError) === "ENOENT") continue;
          throw lockError;
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for the restart journal lock.");
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    try {
      await handle.writeFile(`${process.pid}\n`, { encoding: "utf8" });
      await handle.sync();
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
