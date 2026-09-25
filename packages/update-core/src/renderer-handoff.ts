import { createHash, randomBytes } from "node:crypto";

import { canonicalReleaseJson } from "./manifest.js";

export const RENDERER_HANDOFF_SCHEMA_VERSION =
  "scr.renderer-handoff/v1" as const;

const STORAGE_KEY = "sovereign.renderer-handoff.v1";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 5 * 60_000;
const MAX_STATE_BYTES = 64 * 1_024;
const MAX_SCROLL_POSITIONS = 64;
const MAX_DRAFTS = 64;
const MAX_DRAFT_VALUE_BYTES = 16 * 1_024;

export interface RendererHandoffScrollPosition {
  readonly key: string;
  readonly top: number;
  readonly left: number;
}

export interface RendererHandoffDraft {
  readonly key: string;
  readonly value: string;
}

export interface RendererHandoffState {
  readonly viewId: string;
  readonly settingsTab: string | null;
  readonly selectedTaskId: string | null;
  readonly selectedRunId: string | null;
  readonly focusKey: string | null;
  readonly scrollPositions: readonly RendererHandoffScrollPosition[];
  readonly drafts: readonly RendererHandoffDraft[];
}

export interface RendererHandoffEnvelope {
  readonly schemaVersion: typeof RENDERER_HANDOFF_SCHEMA_VERSION;
  readonly handoffId: string;
  readonly sourceReleaseId: string;
  readonly targetReleaseId: string;
  readonly targetGeneration: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: RendererHandoffState;
  readonly stateSha256: string;
}

export interface RendererHandoffStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RendererHandoffVaultOptions {
  readonly storage: RendererHandoffStorage;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly storageKey?: string;
}

export interface RendererHandoffCreateInput {
  readonly sourceReleaseId: string;
  readonly targetReleaseId: string;
  readonly targetGeneration: number;
  readonly ttlMs?: number;
  readonly state: RendererHandoffState;
}

export interface RendererHandoffConsumeInput {
  readonly targetReleaseId: string;
  readonly targetGeneration: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function optionalIdentifier(value: unknown, label: string): string | null {
  if (value === null) return null;
  assertIdentifier(value, label);
  return value;
}

function boundedText(
  value: unknown,
  label: string,
  maximumCharacters: number,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximumCharacters ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedCoordinate(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 100_000_000
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function stateDigest(state: RendererHandoffState): string {
  return createHash("sha256")
    .update(canonicalReleaseJson(state), "utf8")
    .digest("hex");
}

export function parseRendererHandoffState(
  value: unknown,
): RendererHandoffState {
  if (!isRecord(value))
    throw new Error("Renderer handoff state must be an object.");
  assertExactKeys(
    value,
    [
      "viewId",
      "settingsTab",
      "selectedTaskId",
      "selectedRunId",
      "focusKey",
      "scrollPositions",
      "drafts",
    ],
    "Renderer handoff state",
  );
  assertIdentifier(value.viewId, "Renderer handoff view ID");
  const settingsTab = optionalIdentifier(
    value.settingsTab,
    "Renderer handoff settings tab",
  );
  const selectedTaskId = optionalIdentifier(
    value.selectedTaskId,
    "Renderer handoff selected task ID",
  );
  const selectedRunId = optionalIdentifier(
    value.selectedRunId,
    "Renderer handoff selected run ID",
  );
  const focusKey =
    value.focusKey === null
      ? null
      : (() => {
          const parsed = boundedText(
            value.focusKey,
            "Renderer handoff focus key",
            256,
          );
          if (parsed.length === 0 || /[\u0000-\u001f\u007f]/u.test(parsed)) {
            throw new Error("Renderer handoff focus key is invalid.");
          }
          return parsed;
        })();

  if (
    !Array.isArray(value.scrollPositions) ||
    value.scrollPositions.length > MAX_SCROLL_POSITIONS
  ) {
    throw new Error("Renderer handoff scroll positions are invalid.");
  }
  const scrollKeys = new Set<string>();
  const scrollPositions = value.scrollPositions.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("Renderer handoff scroll position must be an object.");
    }
    assertExactKeys(
      candidate,
      ["key", "top", "left"],
      "Renderer handoff scroll position",
    );
    const key = boundedText(candidate.key, "Renderer handoff scroll key", 256);
    if (key.length === 0)
      throw new Error("Renderer handoff scroll key is invalid.");
    if (scrollKeys.has(key)) {
      throw new Error(`Renderer handoff scroll key ${key} is duplicated.`);
    }
    scrollKeys.add(key);
    return {
      key,
      top: boundedCoordinate(candidate.top, "Renderer handoff scroll top"),
      left: boundedCoordinate(candidate.left, "Renderer handoff scroll left"),
    };
  });

  if (!Array.isArray(value.drafts) || value.drafts.length > MAX_DRAFTS) {
    throw new Error("Renderer handoff drafts are invalid.");
  }
  const draftKeys = new Set<string>();
  const drafts = value.drafts.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("Renderer handoff draft must be an object.");
    }
    assertExactKeys(candidate, ["key", "value"], "Renderer handoff draft");
    const key = boundedText(candidate.key, "Renderer handoff draft key", 256);
    if (key.length === 0)
      throw new Error("Renderer handoff draft key is invalid.");
    if (draftKeys.has(key)) {
      throw new Error(`Renderer handoff draft key ${key} is duplicated.`);
    }
    draftKeys.add(key);
    const draftValue = boundedText(
      candidate.value,
      "Renderer handoff draft value",
      MAX_DRAFT_VALUE_BYTES,
    );
    if (Buffer.byteLength(draftValue, "utf8") > MAX_DRAFT_VALUE_BYTES) {
      throw new Error("Renderer handoff draft exceeds its byte limit.");
    }
    return { key, value: draftValue };
  });

  const parsed: RendererHandoffState = {
    viewId: value.viewId,
    settingsTab,
    selectedTaskId,
    selectedRunId,
    focusKey,
    scrollPositions,
    drafts,
  };
  if (
    Buffer.byteLength(canonicalReleaseJson(parsed), "utf8") > MAX_STATE_BYTES
  ) {
    throw new Error("Renderer handoff state exceeds its byte limit.");
  }
  return parsed;
}

export function parseRendererHandoffEnvelope(
  value: unknown,
): RendererHandoffEnvelope {
  if (!isRecord(value)) {
    throw new Error("Renderer handoff envelope must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "handoffId",
      "sourceReleaseId",
      "targetReleaseId",
      "targetGeneration",
      "createdAt",
      "expiresAt",
      "state",
      "stateSha256",
    ],
    "Renderer handoff envelope",
  );
  if (value.schemaVersion !== RENDERER_HANDOFF_SCHEMA_VERSION) {
    throw new Error("Unsupported Renderer handoff schema version.");
  }
  assertIdentifier(value.handoffId, "Renderer handoff ID");
  assertIdentifier(value.sourceReleaseId, "Renderer handoff source release ID");
  assertIdentifier(value.targetReleaseId, "Renderer handoff target release ID");
  if (value.sourceReleaseId === value.targetReleaseId) {
    throw new Error("Renderer handoff source and target releases must differ.");
  }
  if (
    typeof value.targetGeneration !== "number" ||
    !Number.isSafeInteger(value.targetGeneration) ||
    value.targetGeneration < 1
  ) {
    throw new Error("Renderer handoff target generation is invalid.");
  }
  const createdAt = value.createdAt;
  const expiresAt = value.expiresAt;
  for (const [label, timestamp] of [
    ["creation timestamp", createdAt],
    ["expiry timestamp", expiresAt],
  ] as const) {
    if (
      typeof timestamp !== "number" ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0
    ) {
      throw new Error(`Renderer handoff ${label} is invalid.`);
    }
  }
  if (
    typeof createdAt !== "number" ||
    typeof expiresAt !== "number" ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > MAX_TTL_MS
  ) {
    throw new Error("Renderer handoff expiry window is invalid.");
  }
  const state = parseRendererHandoffState(value.state);
  if (
    typeof value.stateSha256 !== "string" ||
    !SHA256_PATTERN.test(value.stateSha256)
  ) {
    throw new Error("Renderer handoff state digest is invalid.");
  }
  if (stateDigest(state) !== value.stateSha256) {
    throw new Error("Renderer handoff state digest does not match.");
  }
  return {
    schemaVersion: RENDERER_HANDOFF_SCHEMA_VERSION,
    handoffId: value.handoffId,
    sourceReleaseId: value.sourceReleaseId,
    targetReleaseId: value.targetReleaseId,
    targetGeneration: value.targetGeneration,
    createdAt,
    expiresAt,
    state,
    stateSha256: value.stateSha256,
  };
}

export class RendererHandoffVault {
  readonly #storage: RendererHandoffStorage;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #storageKey: string;

  constructor(options: RendererHandoffVaultOptions) {
    if (
      typeof options.storage !== "object" ||
      options.storage === null ||
      typeof options.storage.getItem !== "function" ||
      typeof options.storage.setItem !== "function" ||
      typeof options.storage.removeItem !== "function"
    ) {
      throw new Error("Renderer handoff storage is required.");
    }
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
    this.#randomId =
      options.randomId ?? (() => `handoff-${randomBytes(16).toString("hex")}`);
    this.#storageKey = options.storageKey ?? STORAGE_KEY;
    if (
      this.#storageKey.length === 0 ||
      this.#storageKey.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(this.#storageKey)
    ) {
      throw new Error("Renderer handoff storage key is invalid.");
    }
  }

  create(input: RendererHandoffCreateInput): RendererHandoffEnvelope {
    assertIdentifier(
      input.sourceReleaseId,
      "Renderer handoff source release ID",
    );
    assertIdentifier(
      input.targetReleaseId,
      "Renderer handoff target release ID",
    );
    if (input.sourceReleaseId === input.targetReleaseId) {
      throw new Error(
        "Renderer handoff source and target releases must differ.",
      );
    }
    if (
      !Number.isSafeInteger(input.targetGeneration) ||
      input.targetGeneration < 1
    ) {
      throw new Error("Renderer handoff target generation is invalid.");
    }
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
      throw new Error("Renderer handoff expiry window is invalid.");
    }
    const handoffId = this.#randomId();
    assertIdentifier(handoffId, "Renderer handoff ID");
    const createdAt = this.#now();
    const state = parseRendererHandoffState(input.state);
    const envelope: RendererHandoffEnvelope = {
      schemaVersion: RENDERER_HANDOFF_SCHEMA_VERSION,
      handoffId,
      sourceReleaseId: input.sourceReleaseId,
      targetReleaseId: input.targetReleaseId,
      targetGeneration: input.targetGeneration,
      createdAt,
      expiresAt: createdAt + ttlMs,
      state,
      stateSha256: stateDigest(state),
    };
    this.#storage.setItem(this.#storageKey, JSON.stringify(envelope));
    return envelope;
  }

  consume(input: RendererHandoffConsumeInput): RendererHandoffEnvelope | null {
    assertIdentifier(
      input.targetReleaseId,
      "Renderer handoff target release ID",
    );
    if (
      !Number.isSafeInteger(input.targetGeneration) ||
      input.targetGeneration < 1
    ) {
      throw new Error("Renderer handoff target generation is invalid.");
    }
    const raw = this.#storage.getItem(this.#storageKey);
    if (raw === null) return null;
    this.#storage.removeItem(this.#storageKey);
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(
        `Renderer handoff envelope is invalid JSON: ${String(error)}`,
      );
    }
    const envelope = parseRendererHandoffEnvelope(parsedValue);
    if (
      envelope.targetReleaseId !== input.targetReleaseId ||
      envelope.targetGeneration !== input.targetGeneration
    ) {
      throw new Error(
        "Renderer handoff is bound to a different release or generation.",
      );
    }
    if (this.#now() > envelope.expiresAt) {
      throw new Error("Renderer handoff has expired.");
    }
    return envelope;
  }

  clear(): void {
    this.#storage.removeItem(this.#storageKey);
  }
}
