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
import {
  RENDERER_CUTOVER_PHASES,
  type RendererCutoverOutcome,
  type RendererCutoverPhase,
  type RendererCutoverReceipt,
  type RendererCutoverTransition,
} from "./renderer-cutover.js";
import {
  RUNTIME_CUTOVER_PHASES,
  type RuntimeCutoverOutcome,
  type RuntimeCutoverPhase,
  type RuntimeCutoverReceipt,
  type RuntimeCutoverTransition,
} from "./runtime-cutover.js";

export const CUTOVER_LEDGER_ENTRY_SCHEMA_VERSION =
  "scr.cutover-ledger-entry/v1" as const;

const ENTRIES_DIRECTORY = "entries";
const LOCK_FILE = "ledger.lock";
const ENTRY_PATTERN = /^(\d{20})-([a-f0-9]{16})\.json$/u;
const PENDING_PATTERN = /^\.pending-(\d{20})-[a-f0-9]{32}\.tmp$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ENTRIES = 4_096;
const MAX_ENTRY_BYTES = 128 * 1_024;
const MAX_CHAIN_BYTES = 64 * 1_024 * 1_024;
const MAX_PENDING_FILES = 64;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 15 * 60_000;

const RUNTIME_PHASE_SET = new Set<string>(RUNTIME_CUTOVER_PHASES);
const RENDERER_PHASE_SET = new Set<string>(RENDERER_CUTOVER_PHASES);

export type CutoverKind = "runtime" | "renderer";
export type CutoverRecordType = "transition" | "receipt";
export type CutoverRecoveryAction =
  | "none"
  | "stop-candidate"
  | "resume-active-and-stop-candidate"
  | "rollback-traffic-resume-active-stop-candidate"
  | "finish-commit-cleanup"
  | "rollback-renderer"
  | "finish-renderer-rollback"
  | "verify-terminal-state"
  | "manual-intervention";

export interface RuntimeLedgerTransitionContext {
  readonly activeReleaseId: string;
  readonly candidateReleaseId: string;
}

export interface CutoverLedgerPayload {
  readonly kind: CutoverKind;
  readonly recordType: CutoverRecordType;
  readonly cutoverId: string;
  readonly phase: RuntimeCutoverPhase | RendererCutoverPhase | null;
  readonly outcome: RuntimeCutoverOutcome | RendererCutoverOutcome | null;
  readonly activeReleaseId: string;
  readonly candidateReleaseId: string;
  readonly activeInstanceId: string | null;
  readonly candidateInstanceId: string | null;
  readonly generation: number | null;
  readonly checkpointId: string | null;
  readonly failureReason: string | null;
  readonly cleanupFailures: readonly string[];
}

export interface CutoverLedgerEntry {
  readonly schemaVersion: typeof CUTOVER_LEDGER_ENTRY_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousEntrySha256: string | null;
  readonly recordedAt: number;
  readonly payload: CutoverLedgerPayload;
  readonly entrySha256: string;
}

export interface CutoverRecoveryPlan {
  readonly kind: CutoverKind;
  readonly cutoverId: string;
  readonly action: CutoverRecoveryAction;
  readonly reason: string;
  readonly lastPhase: RuntimeCutoverPhase | RendererCutoverPhase | null;
  readonly activeReleaseId: string;
  readonly candidateReleaseId: string;
  readonly activeInstanceId: string | null;
  readonly candidateInstanceId: string | null;
  readonly generation: number | null;
}

export interface CutoverLedgerOptions {
  readonly rootDirectory: string;
  readonly now?: () => number;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

interface EntryPayload {
  readonly schemaVersion: typeof CUTOVER_LEDGER_ENTRY_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousEntrySha256: string | null;
  readonly recordedAt: number;
  readonly payload: CutoverLedgerPayload;
}

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

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
}

function assertOptionalIdentifier(value: unknown, label: string): void {
  if (value !== null) assertIdentifier(value, label);
}

function assertBoundedReason(value: unknown, label: string): void {
  if (
    value !== null &&
    (typeof value !== "string" ||
      value.length === 0 ||
      value.length > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(value))
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertCleanupFailures(
  value: unknown,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (failure) =>
        typeof failure !== "string" ||
        failure.length === 0 ||
        failure.length > 1_024 ||
        /[\u0000-\u001f\u007f]/u.test(failure),
    )
  ) {
    throw new Error("Cutover cleanup failures are invalid.");
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function entryPayload(entry: EntryPayload): string {
  return canonicalReleaseJson(entry);
}

function validatePayload(value: unknown): CutoverLedgerPayload {
  if (!isRecord(value)) {
    throw new Error("Cutover ledger payload must be an object.");
  }
  assertExactKeys(
    value,
    [
      "kind",
      "recordType",
      "cutoverId",
      "phase",
      "outcome",
      "activeReleaseId",
      "candidateReleaseId",
      "activeInstanceId",
      "candidateInstanceId",
      "generation",
      "checkpointId",
      "failureReason",
      "cleanupFailures",
    ],
    "Cutover ledger payload",
  );
  if (value.kind !== "runtime" && value.kind !== "renderer") {
    throw new Error("Cutover ledger kind is invalid.");
  }
  if (value.recordType !== "transition" && value.recordType !== "receipt") {
    throw new Error("Cutover ledger record type is invalid.");
  }
  assertIdentifier(value.cutoverId, "Cutover ID");
  assertIdentifier(value.activeReleaseId, "Active release ID");
  assertIdentifier(value.candidateReleaseId, "Candidate release ID");
  if (value.activeReleaseId === value.candidateReleaseId) {
    throw new Error("Cutover release identities are inconsistent.");
  }
  assertOptionalIdentifier(
    value.activeInstanceId,
    "Active Runtime instance ID",
  );
  assertOptionalIdentifier(
    value.candidateInstanceId,
    "Candidate Runtime instance ID",
  );
  assertOptionalIdentifier(value.checkpointId, "Runtime checkpoint ID");
  assertBoundedReason(value.failureReason, "Cutover failure reason");
  const cleanupFailures = value.cleanupFailures;
  assertCleanupFailures(cleanupFailures);

  if (value.recordType === "transition") {
    if (value.outcome !== null || value.failureReason !== null) {
      throw new Error("Cutover transition outcome fields are inconsistent.");
    }
    if (value.checkpointId !== null || cleanupFailures.length !== 0) {
      throw new Error("Cutover transition receipt fields are inconsistent.");
    }
  } else {
    if (
      value.outcome !== "committed" &&
      value.outcome !== "rolled-back" &&
      value.outcome !== "failed"
    ) {
      throw new Error("Cutover receipt outcome is invalid.");
    }
    if (value.phase !== null) {
      throw new Error("Cutover receipt phase must be null.");
    }
  }

  if (value.kind === "runtime") {
    if (value.activeInstanceId === null) {
      throw new Error("Runtime cutover active instance identity is required.");
    }
    if (value.generation !== null) {
      throw new Error("Runtime cutover generation fields are inconsistent.");
    }
    if (
      value.recordType === "transition" &&
      (typeof value.phase !== "string" || !RUNTIME_PHASE_SET.has(value.phase))
    ) {
      throw new Error("Runtime cutover phase is invalid.");
    }
  } else {
    if (value.activeInstanceId !== null || value.candidateInstanceId !== null) {
      throw new Error("Renderer cutover instance fields are inconsistent.");
    }
    assertSafeInteger(value.generation, "Renderer cutover generation", 1);
    if (
      value.recordType === "transition" &&
      (typeof value.phase !== "string" || !RENDERER_PHASE_SET.has(value.phase))
    ) {
      throw new Error("Renderer cutover phase is invalid.");
    }
    if (value.checkpointId !== null) {
      throw new Error("Renderer cutover checkpoint field is inconsistent.");
    }
  }

  return {
    kind: value.kind,
    recordType: value.recordType,
    cutoverId: value.cutoverId,
    phase: value.phase as RuntimeCutoverPhase | RendererCutoverPhase | null,
    outcome: value.outcome as
      RuntimeCutoverOutcome | RendererCutoverOutcome | null,
    activeReleaseId: value.activeReleaseId,
    candidateReleaseId: value.candidateReleaseId,
    activeInstanceId: value.activeInstanceId as string | null,
    candidateInstanceId: value.candidateInstanceId as string | null,
    generation: value.generation as number | null,
    checkpointId: value.checkpointId as string | null,
    failureReason: value.failureReason as string | null,
    cleanupFailures: [...cleanupFailures],
  };
}

function parseEntry(value: unknown): CutoverLedgerEntry {
  if (!isRecord(value)) {
    throw new Error("Cutover ledger entry must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sequence",
      "previousEntrySha256",
      "recordedAt",
      "payload",
      "entrySha256",
    ],
    "Cutover ledger entry",
  );
  if (value.schemaVersion !== CUTOVER_LEDGER_ENTRY_SCHEMA_VERSION) {
    throw new Error("Unsupported cutover ledger entry schema version.");
  }
  assertSafeInteger(value.sequence, "Cutover ledger sequence", 1, MAX_ENTRIES);
  if (value.previousEntrySha256 !== null) {
    assertSha256(value.previousEntrySha256, "Previous cutover entry digest");
  }
  assertSafeInteger(value.recordedAt, "Cutover ledger timestamp", 0);
  const payload = validatePayload(value.payload);
  assertSha256(value.entrySha256, "Cutover ledger entry digest");
  const canonical: EntryPayload = {
    schemaVersion: CUTOVER_LEDGER_ENTRY_SCHEMA_VERSION,
    sequence: value.sequence,
    previousEntrySha256: value.previousEntrySha256,
    recordedAt: value.recordedAt,
    payload,
  };
  if (sha256(entryPayload(canonical)) !== value.entrySha256) {
    throw new Error("Cutover ledger entry digest does not match its payload.");
  }
  return { ...canonical, entrySha256: value.entrySha256 };
}

function fileName(
  entry: Pick<CutoverLedgerEntry, "sequence" | "entrySha256">,
): string {
  return `${entry.sequence.toString().padStart(20, "0")}-${entry.entrySha256.slice(0, 16)}.json`;
}

function sameIdentity(
  left: CutoverLedgerPayload,
  right: CutoverLedgerPayload,
): boolean {
  return (
    left.kind === right.kind &&
    left.activeReleaseId === right.activeReleaseId &&
    left.candidateReleaseId === right.candidateReleaseId &&
    left.activeInstanceId === right.activeInstanceId &&
    (left.candidateInstanceId === null ||
      right.candidateInstanceId === null ||
      left.candidateInstanceId === right.candidateInstanceId)
  );
}

function validateAppendAgainstHistory(
  entries: readonly CutoverLedgerEntry[],
  payload: CutoverLedgerPayload,
): void {
  const prior = entries.filter(
    (entry) => entry.payload.cutoverId === payload.cutoverId,
  );
  if (prior.length === 0) return;
  if (!sameIdentity(prior[0]!.payload, payload)) {
    throw new Error(
      `Cutover ${payload.cutoverId} identity changed within its ledger history.`,
    );
  }
  if (prior.some((entry) => entry.payload.recordType === "receipt")) {
    throw new Error(
      `Cutover ${payload.cutoverId} cannot append records after the receipt.`,
    );
  }
  if (payload.kind === "renderer") {
    const highest = Math.max(
      ...prior.map((entry) => entry.payload.generation ?? 0),
    );
    if ((payload.generation ?? 0) < highest) {
      throw new Error(
        `Renderer cutover ${payload.cutoverId} generation moved backwards.`,
      );
    }
  }
  const knownCandidate = prior
    .map((entry) => entry.payload.candidateInstanceId)
    .find((candidate): candidate is string => candidate !== null);
  if (
    knownCandidate !== undefined &&
    payload.candidateInstanceId !== null &&
    payload.candidateInstanceId !== knownCandidate
  ) {
    throw new Error(`Cutover ${payload.cutoverId} candidate identity changed.`);
  }
}
function runtimeRecoveryAction(
  phase: RuntimeCutoverPhase,
): CutoverRecoveryAction {
  switch (phase) {
    case "start-candidate":
    case "candidate-health":
      return "stop-candidate";
    case "quiesce-active":
    case "drain-active":
    case "checkpoint-active":
      return "resume-active-and-stop-candidate";
    case "switch-traffic":
    case "candidate-canary":
    case "rollback-traffic":
      return "rollback-traffic-resume-active-stop-candidate";
    case "commit-candidate":
    case "stop-previous":
      return "finish-commit-cleanup";
    case "resume-active":
    case "stop-candidate":
    case "committed":
    case "rolled-back":
    case "failed":
      return "verify-terminal-state";
  }
}

function rendererRecoveryAction(
  phase: RendererCutoverPhase,
): CutoverRecoveryAction {
  switch (phase) {
    case "verify-candidate":
    case "preflight-candidate":
    case "capture-view-state":
      return "none";
    case "activate-candidate":
    case "reload-candidate":
    case "candidate-ready":
    case "restore-view-state":
    case "observe-candidate":
      return "rollback-renderer";
    case "rollback-pointer":
    case "reload-previous":
    case "previous-ready":
    case "restore-previous-state":
      return "finish-renderer-rollback";
    case "committed":
    case "rolled-back":
    case "failed":
      return "verify-terminal-state";
  }
}

function recoveryReason(
  kind: CutoverKind,
  phase: RuntimeCutoverPhase | RendererCutoverPhase,
  action: CutoverRecoveryAction,
): string {
  const surface = kind === "runtime" ? "Runtime Host" : "Renderer";
  return `${surface} cutover stopped after ${phase}; recovery action ${action} is required.`;
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function assertContainedDirectory(
  root: string,
  child: string,
  label: string,
): Promise<void> {
  await assertRealDirectory(root, "Cutover ledger root");
  await assertRealDirectory(child, label);
  const realRoot = await realpath(root);
  const realChild = await realpath(child);
  const pathFromRoot = relative(realRoot, realChild);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`${label} resolves outside the cutover ledger root.`);
  }
}

export function ledgerFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (
    normalized.length === 0 ? "Cutover ledger write failed." : normalized
  ).slice(0, 1_024);
}

export class CutoverLedger {
  readonly #rootDirectory: string;
  readonly #entriesDirectory: string;
  readonly #lockPath: string;
  readonly #now: () => number;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: CutoverLedgerOptions) {
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.trim().length === 0
    ) {
      throw new Error("Cutover ledger root directory is required.");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#entriesDirectory = join(this.#rootDirectory, ENTRIES_DIRECTORY);
    this.#lockPath = join(this.#rootDirectory, LOCK_FILE);
    this.#now = options.now ?? Date.now;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    assertSafeInteger(
      this.#lockTimeoutMs,
      "Cutover ledger lock timeout",
      1,
      60_000,
    );
    assertSafeInteger(
      this.#staleLockMs,
      "Cutover ledger stale lock timeout",
      1,
      24 * 60 * 60_000,
    );
  }

  async readAll(): Promise<readonly CutoverLedgerEntry[]> {
    await this.#initializeStorage();
    return await this.#readEntries();
  }

  async append(payload: CutoverLedgerPayload): Promise<CutoverLedgerEntry> {
    return await this.#appendPayload(payload, this.#now());
  }

  async appendRuntimeTransition(
    transition: RuntimeCutoverTransition,
    releases: RuntimeLedgerTransitionContext,
  ): Promise<CutoverLedgerEntry> {
    return await this.#appendPayload(
      {
        kind: "runtime",
        recordType: "transition",
        cutoverId: transition.cutoverId,
        phase: transition.phase,
        outcome: null,
        activeReleaseId: releases.activeReleaseId,
        candidateReleaseId: releases.candidateReleaseId,
        activeInstanceId: transition.activeInstanceId,
        candidateInstanceId: transition.candidateInstanceId,
        generation: null,
        checkpointId: null,
        failureReason: null,
        cleanupFailures: [],
      },
      transition.at,
    );
  }

  async appendRuntimeReceipt(
    receipt: RuntimeCutoverReceipt,
  ): Promise<CutoverLedgerEntry> {
    return await this.#appendPayload(
      {
        kind: "runtime",
        recordType: "receipt",
        cutoverId: receipt.cutoverId,
        phase: null,
        outcome: receipt.outcome,
        activeReleaseId: receipt.activeReleaseId,
        candidateReleaseId: receipt.candidateReleaseId,
        activeInstanceId: receipt.previousInstanceId,
        candidateInstanceId: receipt.candidateInstanceId,
        generation: null,
        checkpointId: receipt.checkpointId,
        failureReason: receipt.failureReason,
        cleanupFailures: receipt.cleanupFailures,
      },
      receipt.completedAt,
    );
  }

  async appendRendererTransition(
    transition: RendererCutoverTransition,
  ): Promise<CutoverLedgerEntry> {
    return await this.#appendPayload(
      {
        kind: "renderer",
        recordType: "transition",
        cutoverId: transition.cutoverId,
        phase: transition.phase,
        outcome: null,
        activeReleaseId: transition.previousReleaseId,
        candidateReleaseId: transition.candidateReleaseId,
        activeInstanceId: null,
        candidateInstanceId: null,
        generation: transition.generation,
        checkpointId: null,
        failureReason: null,
        cleanupFailures: [],
      },
      transition.at,
    );
  }

  async appendRendererReceipt(
    receipt: RendererCutoverReceipt,
  ): Promise<CutoverLedgerEntry> {
    return await this.#appendPayload(
      {
        kind: "renderer",
        recordType: "receipt",
        cutoverId: receipt.cutoverId,
        phase: null,
        outcome: receipt.outcome,
        activeReleaseId: receipt.previousReleaseId,
        candidateReleaseId: receipt.candidateReleaseId,
        activeInstanceId: null,
        candidateInstanceId: null,
        generation: receipt.finalGeneration,
        checkpointId: null,
        failureReason: receipt.failureReason,
        cleanupFailures: receipt.cleanupFailures,
      },
      receipt.completedAt,
    );
  }

  async recoveryPlans(): Promise<readonly CutoverRecoveryPlan[]> {
    const entries = await this.readAll();
    const groups = new Map<string, CutoverLedgerEntry[]>();
    for (const entry of entries) {
      const group = groups.get(entry.payload.cutoverId) ?? [];
      group.push(entry);
      groups.set(entry.payload.cutoverId, group);
    }
    const plans: CutoverRecoveryPlan[] = [];
    for (const group of groups.values()) {
      if (group.some((entry) => entry.payload.recordType === "receipt"))
        continue;
      const last = group.at(-1);
      if (last === undefined || last.payload.phase === null) continue;
      const action =
        last.payload.kind === "runtime"
          ? runtimeRecoveryAction(last.payload.phase as RuntimeCutoverPhase)
          : rendererRecoveryAction(last.payload.phase as RendererCutoverPhase);
      plans.push({
        kind: last.payload.kind,
        cutoverId: last.payload.cutoverId,
        action,
        reason: recoveryReason(last.payload.kind, last.payload.phase, action),
        lastPhase: last.payload.phase,
        activeReleaseId: last.payload.activeReleaseId,
        candidateReleaseId: last.payload.candidateReleaseId,
        activeInstanceId: last.payload.activeInstanceId,
        candidateInstanceId: last.payload.candidateInstanceId,
        generation: last.payload.generation,
      });
    }
    return plans;
  }

  createRecorder(): {
    runtimeTransition: (
      transition: RuntimeCutoverTransition,
      releases: RuntimeLedgerTransitionContext,
    ) => void;
    rendererTransition: (transition: RendererCutoverTransition) => void;
    recordRuntimeReceipt: (receipt: RuntimeCutoverReceipt) => Promise<void>;
    recordRendererReceipt: (receipt: RendererCutoverReceipt) => Promise<void>;
  } {
    let queue: Promise<void> = Promise.resolve();
    let failure: unknown = null;
    const enqueue = (operation: () => Promise<unknown>): void => {
      queue = queue.then(async () => {
        if (failure !== null) throw failure;
        try {
          await operation();
        } catch (error) {
          failure = error;
          throw error;
        }
      });
    };
    return {
      runtimeTransition: (transition, releases) => {
        enqueue(() => this.appendRuntimeTransition(transition, releases));
      },
      rendererTransition: (transition) => {
        enqueue(() => this.appendRendererTransition(transition));
      },
      recordRuntimeReceipt: async (receipt) => {
        enqueue(() => this.appendRuntimeReceipt(receipt));
        await queue;
      },
      recordRendererReceipt: async (receipt) => {
        enqueue(() => this.appendRendererReceipt(receipt));
        await queue;
      },
    };
  }

  async #appendPayload(
    payload: CutoverLedgerPayload,
    recordedAt: number,
  ): Promise<CutoverLedgerEntry> {
    assertSafeInteger(recordedAt, "Cutover ledger timestamp", 0);
    const normalized = validatePayload(payload);
    return await this.#serialize(async () => {
      await this.#initializeStorage();
      const entries = await this.#readEntries();
      validateAppendAgainstHistory(entries, normalized);
      if (entries.length >= MAX_ENTRIES) {
        throw new Error("Cutover ledger reached its entry limit.");
      }
      await this.#removePendingFiles();
      const canonical: EntryPayload = {
        schemaVersion: CUTOVER_LEDGER_ENTRY_SCHEMA_VERSION,
        sequence: entries.length + 1,
        previousEntrySha256: entries.at(-1)?.entrySha256 ?? null,
        recordedAt,
        payload: normalized,
      };
      return await this.#publish({
        ...canonical,
        entrySha256: sha256(entryPayload(canonical)),
      });
    });
  }
  async #publish(entry: CutoverLedgerEntry): Promise<CutoverLedgerEntry> {
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    if (bytes.length > MAX_ENTRY_BYTES) {
      throw new Error("Cutover ledger entry exceeds its size limit.");
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
        throw new Error("Cutover ledger sequence was concurrently published.");
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
      throw new Error("Published cutover ledger entry could not be verified.");
    }
    return published;
  }

  async #initializeStorage(): Promise<void> {
    await mkdir(this.#entriesDirectory, { recursive: true });
    await assertContainedDirectory(
      this.#rootDirectory,
      this.#entriesDirectory,
      "Cutover ledger entries directory",
    );
  }

  async #readEntries(): Promise<CutoverLedgerEntry[]> {
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
          `Cutover ledger contains an unexpected entry: ${directoryEntry.name}.`,
        );
      }
      committed.push({
        name: directoryEntry.name,
        path: join(this.#entriesDirectory, directoryEntry.name),
      });
    }
    if (pendingCount > MAX_PENDING_FILES) {
      throw new Error("Cutover ledger contains too many pending files.");
    }
    if (committed.length > MAX_ENTRIES) {
      throw new Error("Cutover ledger exceeds its entry limit.");
    }
    committed.sort((left, right) => left.name.localeCompare(right.name));
    const entries: CutoverLedgerEntry[] = [];
    let previous: string | null = null;
    let chainBytes = 0;
    for (let index = 0; index < committed.length; index += 1) {
      const expectedSequence = index + 1;
      const file = committed[index]!;
      const match = ENTRY_PATTERN.exec(file.name)!;
      if (Number(match[1]) !== expectedSequence) {
        throw new Error("Cutover ledger hash chain contains a sequence gap.");
      }
      const info = await lstat(file.path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size < 2 ||
        info.size > MAX_ENTRY_BYTES
      ) {
        throw new Error(
          "Cutover ledger entry is linked or has invalid metadata.",
        );
      }
      chainBytes += info.size;
      if (chainBytes > MAX_CHAIN_BYTES) {
        throw new Error("Cutover ledger exceeds its cumulative byte limit.");
      }
      const bytes = await readFile(file.path);
      if (bytes.length !== info.size || bytes.at(-1) !== 0x0a) {
        throw new Error("Cutover ledger entry is incomplete.");
      }
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch (error) {
        throw new Error(
          `Cutover ledger entry is invalid JSON: ${String(error)}`,
        );
      }
      const parsed = parseEntry(parsedValue);
      if (parsed.sequence !== expectedSequence) {
        throw new Error(
          "Cutover ledger entry sequence does not match its filename.",
        );
      }
      if (file.name !== fileName(parsed)) {
        throw new Error(
          "Cutover ledger entry filename does not match its digest.",
        );
      }
      if (parsed.previousEntrySha256 !== previous) {
        throw new Error(
          "Cutover ledger entry breaks the previous-entry hash chain.",
        );
      }
      validateAppendAgainstHistory(entries, parsed.payload);
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
      throw new Error("Cutover ledger contains too many pending files.");
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
            throw new Error("Cutover ledger lock is not a regular file.");
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
          throw new Error("Timed out waiting for the cutover ledger lock.");
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
