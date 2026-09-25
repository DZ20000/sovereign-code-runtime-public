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
import type { RuntimeHostHandle } from "./runtime-cutover.js";

export const RUNTIME_CHECKPOINT_SCHEMA_VERSION =
  "scr.runtime-cutover-checkpoint/v1" as const;
export const RUNTIME_CHECKPOINT_EVENT_SCHEMA_VERSION =
  "scr.runtime-cutover-checkpoint-event/v1" as const;

export const RUNTIME_CHECKPOINT_STATES = [
  "prepared",
  "adopted",
  "committed",
  "rolled-back",
] as const;
export type RuntimeCheckpointState = (typeof RUNTIME_CHECKPOINT_STATES)[number];
export type RuntimeCheckpointEventType = RuntimeCheckpointState;

export interface RuntimeCheckpointInput {
  readonly cutoverId: string;
  readonly epoch: number;
  readonly sourceHost: RuntimeHostHandle;
  readonly candidateReleaseId: string;
  readonly runtimeManifestSha256: string;
  readonly taskSnapshotSha256: string;
  readonly taskCount: number;
  readonly lastMessageSequence: number;
  readonly activeRunIds: readonly string[];
}

export interface RuntimeCheckpoint extends RuntimeCheckpointInput {
  readonly schemaVersion: typeof RUNTIME_CHECKPOINT_SCHEMA_VERSION;
  readonly checkpointId: string;
  readonly fencingToken: string;
  readonly createdAt: number;
  readonly checkpointSha256: string;
}

export interface RuntimeCheckpointEvent {
  readonly schemaVersion: typeof RUNTIME_CHECKPOINT_EVENT_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousEventSha256: string | null;
  readonly checkpointId: string;
  readonly eventType: RuntimeCheckpointEventType;
  readonly candidateInstanceId: string | null;
  readonly reason: string | null;
  readonly at: number;
  readonly eventSha256: string;
}

export interface RuntimeCheckpointLifecycle {
  readonly state: RuntimeCheckpointState;
  readonly checkpoint: RuntimeCheckpoint;
  readonly candidateInstanceId: string | null;
  readonly latestEvent: RuntimeCheckpointEvent;
}

export interface RuntimeCheckpointStoreStatus {
  readonly active: RuntimeCheckpointLifecycle | null;
  readonly latest: RuntimeCheckpointLifecycle | null;
  readonly eventCount: number;
  readonly checkpointCount: number;
}

export interface RuntimeCheckpointStoreOptions {
  readonly directory: string;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

interface CheckpointPayload extends Omit<
  RuntimeCheckpoint,
  "checkpointSha256"
> {}
interface EventPayload extends Omit<RuntimeCheckpointEvent, "eventSha256"> {}

const CHECKPOINTS_DIRECTORY = "checkpoints";
const EVENTS_DIRECTORY = "events";
const LOCK_FILE = "runtime-checkpoint.lock";
const CHECKPOINT_FILE_PATTERN = /^checkpoint-([a-f0-9]{32})\.json$/u;
const EVENT_FILE_PATTERN = /^event-(\d{12})-([a-f0-9]{16})\.json$/u;
const PENDING_FILE_PATTERN = /^\.pending-[a-f0-9]{32}\.tmp$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,4096}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_CHECKPOINTS = 4_096;
const MAX_EVENTS = 16_384;
const MAX_FILE_BYTES = 256 * 1_024;
const MAX_PENDING_FILES = 64;
const MAX_ACTIVE_RUNS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 15 * 60_000;

const EVENT_TRANSITIONS: Readonly<
  Record<RuntimeCheckpointState, ReadonlySet<RuntimeCheckpointState>>
> = {
  prepared: new Set(["adopted", "rolled-back"]),
  adopted: new Set(["committed", "rolled-back"]),
  committed: new Set(),
  "rolled-back": new Set(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    expected.some((key, index) => key !== actual[index])
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
    throw new Error(`${label} is invalid.`);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function checkpointId(cutoverId: string, epoch: number): string {
  return `checkpoint:${cutoverId}:${epoch}`;
}

function checkpointFileName(id: string): string {
  return `checkpoint-${sha256(id).slice(0, 32)}.json`;
}

function eventFileName(
  event: Pick<RuntimeCheckpointEvent, "sequence" | "eventSha256">,
): string {
  return `event-${event.sequence.toString().padStart(12, "0")}-${event.eventSha256.slice(0, 16)}.json`;
}

function normalizedReason(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Runtime checkpoint rollback reason is invalid.");
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error("Runtime checkpoint rollback reason is invalid.");
  }
  return normalized;
}

function parseHost(value: unknown, label: string): RuntimeHostHandle {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, ["instanceId", "releaseId"], label);
  assertIdentifier(value.instanceId, `${label} instance ID`);
  assertIdentifier(value.releaseId, `${label} release ID`);
  return { instanceId: value.instanceId, releaseId: value.releaseId };
}

function normalizeInput(value: RuntimeCheckpointInput): RuntimeCheckpointInput {
  if (!isRecord(value)) throw new Error("Runtime checkpoint input is invalid.");
  assertIdentifier(value.cutoverId, "Runtime checkpoint cutover ID");
  assertSafeInteger(value.epoch, "Runtime checkpoint epoch", 1);
  const sourceHost = parseHost(
    value.sourceHost,
    "Runtime checkpoint source host",
  );
  assertIdentifier(
    value.candidateReleaseId,
    "Runtime checkpoint candidate release ID",
  );
  if (sourceHost.releaseId === value.candidateReleaseId) {
    throw new Error(
      "Runtime checkpoint source and candidate releases must differ.",
    );
  }
  assertSha256(
    value.runtimeManifestSha256,
    "Runtime checkpoint manifest digest",
  );
  assertSha256(
    value.taskSnapshotSha256,
    "Runtime checkpoint task snapshot digest",
  );
  assertSafeInteger(
    value.taskCount,
    "Runtime checkpoint task count",
    0,
    10_000_000,
  );
  assertSafeInteger(
    value.lastMessageSequence,
    "Runtime checkpoint message sequence",
    0,
  );
  if (
    !Array.isArray(value.activeRunIds) ||
    value.activeRunIds.length > MAX_ACTIVE_RUNS
  ) {
    throw new Error("Runtime checkpoint active run inventory is invalid.");
  }
  const activeRunIds = value.activeRunIds.map((runId, index) => {
    assertIdentifier(runId, `Runtime checkpoint active run ${index}`);
    return runId;
  });
  const unique = new Set(activeRunIds);
  if (unique.size !== activeRunIds.length) {
    throw new Error(
      "Runtime checkpoint active run inventory contains duplicates.",
    );
  }
  activeRunIds.sort();
  return {
    cutoverId: value.cutoverId,
    epoch: value.epoch,
    sourceHost,
    candidateReleaseId: value.candidateReleaseId,
    runtimeManifestSha256: value.runtimeManifestSha256,
    taskSnapshotSha256: value.taskSnapshotSha256,
    taskCount: value.taskCount,
    lastMessageSequence: value.lastMessageSequence,
    activeRunIds,
  };
}
function checkpointPayload(checkpoint: CheckpointPayload): string {
  return canonicalReleaseJson(checkpoint);
}

function parseCheckpoint(value: unknown): RuntimeCheckpoint {
  if (!isRecord(value)) {
    throw new Error("Runtime checkpoint must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "checkpointId",
      "cutoverId",
      "epoch",
      "sourceHost",
      "candidateReleaseId",
      "runtimeManifestSha256",
      "taskSnapshotSha256",
      "taskCount",
      "lastMessageSequence",
      "activeRunIds",
      "fencingToken",
      "createdAt",
      "checkpointSha256",
    ],
    "Runtime checkpoint",
  );
  if (value.schemaVersion !== RUNTIME_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error("Unsupported Runtime checkpoint schema version.");
  }
  assertIdentifier(value.checkpointId, "Runtime checkpoint ID");
  const input = normalizeInput(value as unknown as RuntimeCheckpointInput);
  if (value.checkpointId !== checkpointId(input.cutoverId, input.epoch)) {
    throw new Error(
      "Runtime checkpoint ID does not match its cutover evidence.",
    );
  }
  if (
    typeof value.fencingToken !== "string" ||
    !TOKEN_PATTERN.test(value.fencingToken)
  ) {
    throw new Error("Runtime checkpoint fencing token is invalid.");
  }
  assertSafeInteger(
    value.createdAt,
    "Runtime checkpoint creation timestamp",
    0,
  );
  assertSha256(value.checkpointSha256, "Runtime checkpoint digest");
  const payload: CheckpointPayload = {
    schemaVersion: RUNTIME_CHECKPOINT_SCHEMA_VERSION,
    checkpointId: value.checkpointId,
    ...input,
    fencingToken: value.fencingToken,
    createdAt: value.createdAt,
  };
  if (sha256(checkpointPayload(payload)) !== value.checkpointSha256) {
    throw new Error("Runtime checkpoint digest does not match its payload.");
  }
  return { ...payload, checkpointSha256: value.checkpointSha256 };
}

function eventPayload(event: EventPayload): string {
  return canonicalReleaseJson(event);
}

function parseEvent(value: unknown): RuntimeCheckpointEvent {
  if (!isRecord(value)) {
    throw new Error("Runtime checkpoint event must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sequence",
      "previousEventSha256",
      "checkpointId",
      "eventType",
      "candidateInstanceId",
      "reason",
      "at",
      "eventSha256",
    ],
    "Runtime checkpoint event",
  );
  if (value.schemaVersion !== RUNTIME_CHECKPOINT_EVENT_SCHEMA_VERSION) {
    throw new Error("Unsupported Runtime checkpoint event schema version.");
  }
  assertSafeInteger(
    value.sequence,
    "Runtime checkpoint event sequence",
    1,
    MAX_EVENTS,
  );
  if (value.previousEventSha256 !== null) {
    assertSha256(
      value.previousEventSha256,
      "Previous Runtime checkpoint event digest",
    );
  }
  assertIdentifier(
    value.checkpointId,
    "Runtime checkpoint event checkpoint ID",
  );
  if (
    value.eventType !== "prepared" &&
    value.eventType !== "adopted" &&
    value.eventType !== "committed" &&
    value.eventType !== "rolled-back"
  ) {
    throw new Error("Runtime checkpoint event type is invalid.");
  }
  if (value.candidateInstanceId !== null) {
    assertIdentifier(
      value.candidateInstanceId,
      "Runtime checkpoint candidate instance ID",
    );
  }
  const reason = value.reason === null ? null : normalizedReason(value.reason);
  if (value.eventType === "rolled-back") {
    if (reason === null) {
      throw new Error("Runtime checkpoint rollback event requires a reason.");
    }
  } else if (reason !== null) {
    throw new Error("Runtime checkpoint event reason is inconsistent.");
  }
  if (
    (value.eventType === "prepared" && value.candidateInstanceId !== null) ||
    ((value.eventType === "adopted" || value.eventType === "committed") &&
      value.candidateInstanceId === null)
  ) {
    throw new Error(
      "Runtime checkpoint event candidate identity is inconsistent.",
    );
  }
  assertSafeInteger(value.at, "Runtime checkpoint event timestamp", 0);
  assertSha256(value.eventSha256, "Runtime checkpoint event digest");
  const payload: EventPayload = {
    schemaVersion: RUNTIME_CHECKPOINT_EVENT_SCHEMA_VERSION,
    sequence: value.sequence,
    previousEventSha256: value.previousEventSha256,
    checkpointId: value.checkpointId,
    eventType: value.eventType,
    candidateInstanceId: value.candidateInstanceId as string | null,
    reason,
    at: value.at,
  };
  if (sha256(eventPayload(payload)) !== value.eventSha256) {
    throw new Error(
      "Runtime checkpoint event digest does not match its payload.",
    );
  }
  return { ...payload, eventSha256: value.eventSha256 };
}

function checkpointEvidenceEqual(
  checkpoint: RuntimeCheckpoint,
  input: RuntimeCheckpointInput,
): boolean {
  return (
    checkpoint.cutoverId === input.cutoverId &&
    checkpoint.epoch === input.epoch &&
    checkpoint.sourceHost.instanceId === input.sourceHost.instanceId &&
    checkpoint.sourceHost.releaseId === input.sourceHost.releaseId &&
    checkpoint.candidateReleaseId === input.candidateReleaseId &&
    checkpoint.runtimeManifestSha256 === input.runtimeManifestSha256 &&
    checkpoint.taskSnapshotSha256 === input.taskSnapshotSha256 &&
    checkpoint.taskCount === input.taskCount &&
    checkpoint.lastMessageSequence === input.lastMessageSequence &&
    checkpoint.activeRunIds.length === input.activeRunIds.length &&
    checkpoint.activeRunIds.every(
      (runId, index) => runId === input.activeRunIds[index],
    )
  );
}

function isTerminal(state: RuntimeCheckpointState): boolean {
  return state === "committed" || state === "rolled-back";
}

function lifecycleFor(
  checkpoint: RuntimeCheckpoint,
  events: readonly RuntimeCheckpointEvent[],
): RuntimeCheckpointLifecycle | null {
  const relevant = events.filter(
    (event) => event.checkpointId === checkpoint.checkpointId,
  );
  const latest = relevant.at(-1);
  if (latest === undefined) return null;
  return {
    state: latest.eventType,
    checkpoint,
    candidateInstanceId: latest.candidateInstanceId,
    latestEvent: latest,
  };
}

async function assertContainedDirectories(
  root: string,
  checkpoints: string,
  events: string,
): Promise<void> {
  const rootInfo = await lstat(root);
  const checkpointInfo = await lstat(checkpoints);
  const eventInfo = await lstat(events);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !checkpointInfo.isDirectory() ||
    checkpointInfo.isSymbolicLink() ||
    !eventInfo.isDirectory() ||
    eventInfo.isSymbolicLink()
  ) {
    throw new Error("Runtime checkpoint storage must use real directories.");
  }
  const realRoot = await realpath(root);
  for (const [directory, label] of [
    [checkpoints, "checkpoint"],
    [events, "event"],
  ] as const) {
    const fromRoot = relative(realRoot, await realpath(directory));
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error(`Runtime ${label} storage resolves outside its root.`);
    }
  }
}
export class RuntimeCheckpointStore {
  readonly #directory: string;
  readonly #checkpointsDirectory: string;
  readonly #eventsDirectory: string;
  readonly #lockPath: string;
  readonly #now: () => number;
  readonly #tokenFactory: () => string;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RuntimeCheckpointStoreOptions) {
    if (
      typeof options.directory !== "string" ||
      options.directory.trim().length === 0
    ) {
      throw new Error("Runtime checkpoint directory is required.");
    }
    this.#directory = resolve(options.directory);
    this.#checkpointsDirectory = join(this.#directory, CHECKPOINTS_DIRECTORY);
    this.#eventsDirectory = join(this.#directory, EVENTS_DIRECTORY);
    this.#lockPath = join(this.#directory, LOCK_FILE);
    this.#now = options.now ?? Date.now;
    this.#tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    if (
      !Number.isSafeInteger(this.#lockTimeoutMs) ||
      this.#lockTimeoutMs < 1 ||
      this.#lockTimeoutMs > 60_000
    ) {
      throw new Error("Runtime checkpoint lock timeout is invalid.");
    }
    if (
      !Number.isSafeInteger(this.#staleLockMs) ||
      this.#staleLockMs < 1 ||
      this.#staleLockMs > 24 * 60 * 60_000
    ) {
      throw new Error("Runtime checkpoint stale lock timeout is invalid.");
    }
  }

  async prepare(
    inputValue: RuntimeCheckpointInput,
  ): Promise<RuntimeCheckpoint> {
    const input = normalizeInput(inputValue);
    return await this.#serialize(async () => {
      await this.#initializeStorage();
      const [checkpoints, events] = await Promise.all([
        this.#readCheckpoints(),
        this.#readEvents(),
      ]);
      this.#validateEventHistory(checkpoints, events);
      const id = checkpointId(input.cutoverId, input.epoch);
      const existing = checkpoints.find(
        (checkpoint) => checkpoint.checkpointId === id,
      );
      if (existing !== undefined) {
        if (!checkpointEvidenceEqual(existing, input)) {
          throw new Error(
            `Runtime cutover ${input.cutoverId} already has different checkpoint evidence.`,
          );
        }
        const lifecycle = lifecycleFor(existing, events);
        if (lifecycle === null) {
          await this.#appendEvent(events, {
            checkpointId: existing.checkpointId,
            eventType: "prepared",
            candidateInstanceId: null,
            reason: null,
          });
        }
        return existing;
      }
      const active = this.#activeLifecycle(checkpoints, events);
      if (active !== null) {
        throw new Error(
          `Runtime checkpoint ${active.checkpoint.checkpointId} is still active.`,
        );
      }
      const fencingToken = this.#tokenFactory();
      if (
        typeof fencingToken !== "string" ||
        !TOKEN_PATTERN.test(fencingToken)
      ) {
        throw new Error(
          "Runtime checkpoint token factory returned an invalid fencing token.",
        );
      }
      const payload: CheckpointPayload = {
        schemaVersion: RUNTIME_CHECKPOINT_SCHEMA_VERSION,
        checkpointId: id,
        ...input,
        fencingToken,
        createdAt: this.#now(),
      };
      const checkpoint: RuntimeCheckpoint = {
        ...payload,
        checkpointSha256: sha256(checkpointPayload(payload)),
      };
      await this.#publishCheckpoint(checkpoint);
      await this.#appendEvent(events, {
        checkpointId: checkpoint.checkpointId,
        eventType: "prepared",
        candidateInstanceId: null,
        reason: null,
      });
      return checkpoint;
    });
  }

  async adopt(
    checkpointIdValue: string,
    candidateInstanceIdValue: string,
  ): Promise<RuntimeCheckpointLifecycle> {
    assertIdentifier(checkpointIdValue, "Runtime checkpoint ID");
    assertIdentifier(
      candidateInstanceIdValue,
      "Runtime checkpoint candidate instance ID",
    );
    return await this.#serialize(async () => {
      const current = await this.#requireLifecycle(checkpointIdValue);
      if (current.state === "adopted") {
        if (current.candidateInstanceId !== candidateInstanceIdValue) {
          throw new Error(
            "Runtime checkpoint was adopted by another candidate.",
          );
        }
        return current;
      }
      if (current.state !== "prepared") {
        throw new Error(
          `Runtime checkpoint in state ${current.state} cannot be adopted.`,
        );
      }
      const events = await this.#readEvents();
      await this.#appendEvent(events, {
        checkpointId: checkpointIdValue,
        eventType: "adopted",
        candidateInstanceId: candidateInstanceIdValue,
        reason: null,
      });
      return (await this.get(checkpointIdValue))!;
    });
  }

  async commit(
    checkpointIdValue: string,
    candidateInstanceIdValue: string,
  ): Promise<RuntimeCheckpointLifecycle> {
    assertIdentifier(checkpointIdValue, "Runtime checkpoint ID");
    assertIdentifier(
      candidateInstanceIdValue,
      "Runtime checkpoint candidate instance ID",
    );
    return await this.#serialize(async () => {
      const current = await this.#requireLifecycle(checkpointIdValue);
      if (current.state === "committed") {
        if (current.candidateInstanceId !== candidateInstanceIdValue) {
          throw new Error(
            "Runtime checkpoint was committed by another candidate.",
          );
        }
        return current;
      }
      if (current.state === "prepared") {
        throw new Error("Runtime checkpoint must be adopted before commit.");
      }
      if (current.state !== "adopted") {
        throw new Error(
          `Runtime checkpoint in state ${current.state} cannot be committed.`,
        );
      }
      if (current.candidateInstanceId !== candidateInstanceIdValue) {
        throw new Error(
          "Runtime checkpoint must be committed by the same candidate.",
        );
      }
      const events = await this.#readEvents();
      await this.#appendEvent(events, {
        checkpointId: checkpointIdValue,
        eventType: "committed",
        candidateInstanceId: candidateInstanceIdValue,
        reason: null,
      });
      return (await this.get(checkpointIdValue))!;
    });
  }

  async rollback(
    checkpointIdValue: string,
    reasonValue: string,
  ): Promise<RuntimeCheckpointLifecycle> {
    assertIdentifier(checkpointIdValue, "Runtime checkpoint ID");
    const reason = normalizedReason(reasonValue);
    return await this.#serialize(async () => {
      const current = await this.#requireLifecycle(checkpointIdValue);
      if (current.state === "rolled-back") return current;
      if (current.state === "committed") {
        throw new Error(
          "A committed Runtime checkpoint cannot be rolled back in place.",
        );
      }
      const events = await this.#readEvents();
      await this.#appendEvent(events, {
        checkpointId: checkpointIdValue,
        eventType: "rolled-back",
        candidateInstanceId: current.candidateInstanceId,
        reason,
      });
      return (await this.get(checkpointIdValue))!;
    });
  }

  async get(
    checkpointIdValue: string,
  ): Promise<RuntimeCheckpointLifecycle | null> {
    assertIdentifier(checkpointIdValue, "Runtime checkpoint ID");
    await this.#initializeStorage();
    const [checkpoints, events] = await Promise.all([
      this.#readCheckpoints(),
      this.#readEvents(),
    ]);
    this.#validateEventHistory(checkpoints, events);
    const checkpoint = checkpoints.find(
      (candidate) => candidate.checkpointId === checkpointIdValue,
    );
    return checkpoint === undefined ? null : lifecycleFor(checkpoint, events);
  }

  async status(): Promise<RuntimeCheckpointStoreStatus> {
    await this.#initializeStorage();
    const [checkpoints, events] = await Promise.all([
      this.#readCheckpoints(),
      this.#readEvents(),
    ]);
    this.#validateEventHistory(checkpoints, events);
    const active = this.#activeLifecycle(checkpoints, events);
    const latestEvent = events.at(-1);
    const latestCheckpoint =
      latestEvent === undefined
        ? undefined
        : checkpoints.find(
            (checkpoint) =>
              checkpoint.checkpointId === latestEvent.checkpointId,
          );
    const latest =
      latestCheckpoint === undefined
        ? null
        : lifecycleFor(latestCheckpoint, events);
    return {
      active,
      latest,
      eventCount: events.length,
      checkpointCount: checkpoints.length,
    };
  }
  async #requireLifecycle(
    checkpointIdValue: string,
  ): Promise<RuntimeCheckpointLifecycle> {
    const current = await this.get(checkpointIdValue);
    if (current === null) {
      throw new Error(
        `Runtime checkpoint ${checkpointIdValue} does not exist.`,
      );
    }
    return current;
  }

  #activeLifecycle(
    checkpoints: readonly RuntimeCheckpoint[],
    events: readonly RuntimeCheckpointEvent[],
  ): RuntimeCheckpointLifecycle | null {
    const active = checkpoints
      .map((checkpoint) => lifecycleFor(checkpoint, events))
      .filter(
        (lifecycle): lifecycle is RuntimeCheckpointLifecycle =>
          lifecycle !== null && !isTerminal(lifecycle.state),
      );
    if (active.length > 1) {
      throw new Error("Multiple Runtime checkpoints are active.");
    }
    return active[0] ?? null;
  }

  async #publishCheckpoint(checkpoint: RuntimeCheckpoint): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(checkpoint)}\n`, "utf8");
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error("Runtime checkpoint exceeds its size limit.");
    }
    const finalPath = join(
      this.#checkpointsDirectory,
      checkpointFileName(checkpoint.checkpointId),
    );
    const temporaryPath = join(
      this.#checkpointsDirectory,
      `.pending-${randomBytes(16).toString("hex")}.tmp`,
    );
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
        const existing = parseCheckpoint(
          JSON.parse(await readFile(finalPath, "utf8")) as unknown,
        );
        if (existing.checkpointSha256 === checkpoint.checkpointSha256) return;
        throw new Error(
          `Runtime cutover ${checkpoint.cutoverId} already has different checkpoint evidence.`,
        );
      }
      throw error;
    }
    await rm(temporaryPath, { force: true });
    await this.#syncDirectory(this.#checkpointsDirectory);
    const verified = parseCheckpoint(
      JSON.parse(await readFile(finalPath, "utf8")) as unknown,
    );
    if (verified.checkpointSha256 !== checkpoint.checkpointSha256) {
      throw new Error("Published Runtime checkpoint could not be verified.");
    }
  }

  async #appendEvent(
    currentEvents: readonly RuntimeCheckpointEvent[],
    value: {
      readonly checkpointId: string;
      readonly eventType: RuntimeCheckpointEventType;
      readonly candidateInstanceId: string | null;
      readonly reason: string | null;
    },
  ): Promise<RuntimeCheckpointEvent> {
    if (currentEvents.length >= MAX_EVENTS) {
      throw new Error(
        "Runtime checkpoint event journal reached its entry limit.",
      );
    }
    const payload: EventPayload = {
      schemaVersion: RUNTIME_CHECKPOINT_EVENT_SCHEMA_VERSION,
      sequence: currentEvents.length + 1,
      previousEventSha256: currentEvents.at(-1)?.eventSha256 ?? null,
      checkpointId: value.checkpointId,
      eventType: value.eventType,
      candidateInstanceId: value.candidateInstanceId,
      reason: value.reason,
      at: this.#now(),
    };
    const event: RuntimeCheckpointEvent = {
      ...payload,
      eventSha256: sha256(eventPayload(payload)),
    };
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error("Runtime checkpoint event exceeds its size limit.");
    }
    const finalPath = join(this.#eventsDirectory, eventFileName(event));
    const temporaryPath = join(
      this.#eventsDirectory,
      `.pending-${randomBytes(16).toString("hex")}.tmp`,
    );
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
        throw new Error("Runtime checkpoint event was concurrently published.");
      }
      throw error;
    }
    await rm(temporaryPath, { force: true });
    await this.#syncDirectory(this.#eventsDirectory);
    const events = await this.#readEvents();
    const published = events.at(-1);
    if (
      published === undefined ||
      published.sequence !== event.sequence ||
      published.eventSha256 !== event.eventSha256
    ) {
      throw new Error(
        "Published Runtime checkpoint event could not be verified.",
      );
    }
    return published;
  }

  async #readCheckpoints(): Promise<RuntimeCheckpoint[]> {
    const entries = await readdir(this.#checkpointsDirectory, {
      withFileTypes: true,
    });
    const files: string[] = [];
    let pendingCount = 0;
    for (const entry of entries) {
      if (entry.isFile() && PENDING_FILE_PATTERN.test(entry.name)) {
        pendingCount += 1;
        continue;
      }
      if (!entry.isFile() || !CHECKPOINT_FILE_PATTERN.test(entry.name)) {
        throw new Error(
          `Runtime checkpoint directory contains an unexpected entry: ${entry.name}.`,
        );
      }
      files.push(entry.name);
    }
    if (pendingCount > MAX_PENDING_FILES) {
      throw new Error(
        "Runtime checkpoint directory contains too many pending files.",
      );
    }
    if (files.length > MAX_CHECKPOINTS) {
      throw new Error("Runtime checkpoint count exceeds its limit.");
    }
    files.sort();
    const checkpoints: RuntimeCheckpoint[] = [];
    const ids = new Set<string>();
    for (const file of files) {
      const path = join(this.#checkpointsDirectory, file);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size < 2 ||
        info.size > MAX_FILE_BYTES
      ) {
        throw new Error("Runtime checkpoint file has invalid metadata.");
      }
      const bytes = await readFile(path);
      if (bytes.length !== info.size || bytes.at(-1) !== 0x0a) {
        throw new Error("Runtime checkpoint file is incomplete.");
      }
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch (error) {
        throw new Error(`Runtime checkpoint is invalid JSON: ${String(error)}`);
      }
      const checkpoint = parseCheckpoint(parsedValue);
      if (file !== checkpointFileName(checkpoint.checkpointId)) {
        throw new Error(
          "Runtime checkpoint filename does not match its identity.",
        );
      }
      if (ids.has(checkpoint.checkpointId)) {
        throw new Error("Runtime checkpoint identity is duplicated.");
      }
      ids.add(checkpoint.checkpointId);
      checkpoints.push(checkpoint);
    }
    return checkpoints;
  }
  async #readEvents(): Promise<RuntimeCheckpointEvent[]> {
    const entries = await readdir(this.#eventsDirectory, {
      withFileTypes: true,
    });
    const files: string[] = [];
    let pendingCount = 0;
    for (const entry of entries) {
      if (entry.isFile() && PENDING_FILE_PATTERN.test(entry.name)) {
        pendingCount += 1;
        continue;
      }
      if (!entry.isFile() || !EVENT_FILE_PATTERN.test(entry.name)) {
        throw new Error(
          `Runtime checkpoint event directory contains an unexpected entry: ${entry.name}.`,
        );
      }
      files.push(entry.name);
    }
    if (pendingCount > MAX_PENDING_FILES) {
      throw new Error(
        "Runtime checkpoint event directory contains too many pending files.",
      );
    }
    if (files.length > MAX_EVENTS) {
      throw new Error("Runtime checkpoint event count exceeds its limit.");
    }
    files.sort();
    const events: RuntimeCheckpointEvent[] = [];
    let previous: string | null = null;
    for (let index = 0; index < files.length; index += 1) {
      const expectedSequence = index + 1;
      const file = files[index]!;
      const match = EVENT_FILE_PATTERN.exec(file)!;
      if (Number(match[1]) !== expectedSequence) {
        throw new Error("Runtime checkpoint event sequence is not contiguous.");
      }
      const path = join(this.#eventsDirectory, file);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size < 2 ||
        info.size > MAX_FILE_BYTES
      ) {
        throw new Error("Runtime checkpoint event file has invalid metadata.");
      }
      const bytes = await readFile(path);
      if (bytes.length !== info.size || bytes.at(-1) !== 0x0a) {
        throw new Error("Runtime checkpoint event file is incomplete.");
      }
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch (error) {
        throw new Error(
          `Runtime checkpoint event is invalid JSON: ${String(error)}`,
        );
      }
      const event = parseEvent(parsedValue);
      if (
        event.sequence !== expectedSequence ||
        file !== eventFileName(event)
      ) {
        throw new Error(
          "Runtime checkpoint event filename does not match its identity.",
        );
      }
      if (event.previousEventSha256 !== previous) {
        throw new Error("Runtime checkpoint event hash chain is invalid.");
      }
      events.push(event);
      previous = event.eventSha256;
    }
    return events;
  }

  #validateEventHistory(
    checkpoints: readonly RuntimeCheckpoint[],
    events: readonly RuntimeCheckpointEvent[],
  ): void {
    const checkpointById = new Map(
      checkpoints.map(
        (checkpoint) => [checkpoint.checkpointId, checkpoint] as const,
      ),
    );
    const latestByCheckpoint = new Map<string, RuntimeCheckpointEvent>();
    for (const event of events) {
      if (!checkpointById.has(event.checkpointId)) {
        throw new Error(
          `Runtime checkpoint event references missing checkpoint ${event.checkpointId}.`,
        );
      }
      const previous = latestByCheckpoint.get(event.checkpointId);
      if (previous === undefined) {
        if (event.eventType !== "prepared") {
          throw new Error(
            `Runtime checkpoint ${event.checkpointId} history must begin with prepared.`,
          );
        }
      } else {
        if (!EVENT_TRANSITIONS[previous.eventType].has(event.eventType)) {
          throw new Error(
            `Runtime checkpoint ${event.checkpointId} contains invalid transition ${previous.eventType} -> ${event.eventType}.`,
          );
        }
        const previousCandidate = previous.candidateInstanceId;
        if (
          previousCandidate !== null &&
          event.candidateInstanceId !== previousCandidate
        ) {
          throw new Error(
            `Runtime checkpoint ${event.checkpointId} candidate identity changed.`,
          );
        }
      }
      latestByCheckpoint.set(event.checkpointId, event);
    }
    const activeCount = [...latestByCheckpoint.values()].filter(
      (event) => !isTerminal(event.eventType),
    ).length;
    if (activeCount > 1) {
      throw new Error("Multiple Runtime checkpoints are active.");
    }
  }

  async #initializeStorage(): Promise<void> {
    await mkdir(this.#checkpointsDirectory, { recursive: true });
    await mkdir(this.#eventsDirectory, { recursive: true });
    await assertContainedDirectories(
      this.#directory,
      this.#checkpointsDirectory,
      this.#eventsDirectory,
    );
  }

  async #removePendingFiles(): Promise<void> {
    for (const directory of [
      this.#checkpointsDirectory,
      this.#eventsDirectory,
    ]) {
      const entries = await readdir(directory, { withFileTypes: true });
      const pending = entries
        .filter(
          (entry) => entry.isFile() && PENDING_FILE_PATTERN.test(entry.name),
        )
        .map((entry) => join(directory, entry.name));
      if (pending.length > MAX_PENDING_FILES) {
        throw new Error(
          "Runtime checkpoint storage contains too many pending files.",
        );
      }
      await Promise.all(pending.map((path) => rm(path, { force: true })));
    }
  }

  async #syncDirectory(directoryPath: string): Promise<void> {
    try {
      const directory = await open(directoryPath, "r");
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
            throw new Error("Runtime checkpoint lock is not a regular file.");
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
          throw new Error("Timed out waiting for the Runtime checkpoint lock.");
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    try {
      await handle.writeFile(`${process.pid}\n`, { encoding: "utf8" });
      await handle.sync();
      await this.#removePendingFiles();
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
