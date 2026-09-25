import { createHash } from "node:crypto";

export const RENDERER_STATE_SCHEMA_VERSION = "scr.renderer-state/v1";
export const MAX_RENDERER_STATE_REVISIONS = 4_096;
export const MAX_RENDERER_STATE_BYTES = 64 * 1024;
export const MAX_RENDERER_STATE_JOURNAL_BYTES = 16 * 1024 * 1024;

const MAX_SAFE_JSON_INTEGER = Number.MAX_SAFE_INTEGER;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MAX_U64 = (1n << 64n) - 1n;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RELEASE_CHANNELS = new Set(["stable", "beta", "development"]);
const RELEASE_KEYS = [
  "releaseId",
  "releaseSequence",
  "version",
  "channel",
  "manifestSha256",
];
const STATE_KEYS = [
  "activeRelease",
  "highestReleaseSequence",
  "lastFailure",
  "lastKnownGoodRelease",
  "previousStateSha256",
  "schemaVersion",
  "storageRevision",
  "updatedAtUnixMs",
];

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} fields do not match the persisted schema.`);
  }
}

function assertSafeInteger(value, minimum, label) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > MAX_SAFE_JSON_INTEGER
  ) {
    throw new Error(`${label} is not a safe JSON integer.`);
  }
}

function isCanonicalVersion(value) {
  const match =
    typeof value === "string" && value.length <= 64
      ? VERSION_PATTERN.exec(value)
      : null;
  if (match === null) return false;
  return match.slice(1).every((part) => BigInt(part) <= MAX_U64);
}

export function verifyRendererReleaseReference(
  value,
  label = "Renderer release reference",
) {
  if (value === null) return null;
  assertExactKeys(value, RELEASE_KEYS, label);
  if (
    typeof value.releaseId !== "string" ||
    !RELEASE_ID_PATTERN.test(value.releaseId) ||
    !isCanonicalVersion(value.version) ||
    typeof value.channel !== "string" ||
    !RELEASE_CHANNELS.has(value.channel) ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.manifestSha256)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  assertSafeInteger(value.releaseSequence, 1, `${label} release sequence`);
  return Object.freeze({
    releaseId: value.releaseId,
    releaseSequence: value.releaseSequence,
    version: value.version,
    channel: value.channel,
    manifestSha256: value.manifestSha256,
  });
}

function releasesEqual(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.releaseId === right.releaseId &&
    left.releaseSequence === right.releaseSequence &&
    left.version === right.version &&
    left.channel === right.channel &&
    left.manifestSha256 === right.manifestSha256
  );
}

function stateRevision(value, expectedRevision, expectedPreviousSha256) {
  const label = `Renderer state revision ${expectedRevision}`;
  assertExactKeys(value, STATE_KEYS, label);
  if (value.schemaVersion !== RENDERER_STATE_SCHEMA_VERSION) {
    throw new Error(`${label} uses an unsupported schema version.`);
  }
  assertSafeInteger(value.storageRevision, 1, `${label} storageRevision`);
  if (value.storageRevision !== expectedRevision) {
    throw new Error(`${label} storageRevision is not contiguous.`);
  }
  const previousStateSha256 = value.previousStateSha256;
  if (
    previousStateSha256 !== null &&
    (typeof previousStateSha256 !== "string" ||
      !SHA256_PATTERN.test(previousStateSha256))
  ) {
    throw new Error(`${label} previousStateSha256 is invalid.`);
  }
  if (previousStateSha256 !== expectedPreviousSha256) {
    throw new Error(`${label} hash chain is invalid.`);
  }

  const activeRelease = verifyRendererReleaseReference(
    value.activeRelease,
    `${label} active release`,
  );
  const lastKnownGoodRelease = verifyRendererReleaseReference(
    value.lastKnownGoodRelease,
    `${label} last-known-good release`,
  );
  if (activeRelease === null && lastKnownGoodRelease !== null) {
    throw new Error(
      `${label} cannot retain a custom rollback release while the built-in Renderer is active.`,
    );
  }
  if (releasesEqual(activeRelease, lastKnownGoodRelease)) {
    throw new Error(
      `${label} active and last-known-good releases must be distinct.`,
    );
  }

  assertSafeInteger(
    value.highestReleaseSequence,
    0,
    `${label} highestReleaseSequence`,
  );
  const referencedMaximum = Math.max(
    activeRelease?.releaseSequence ?? 0,
    lastKnownGoodRelease?.releaseSequence ?? 0,
  );
  if (value.highestReleaseSequence < referencedMaximum) {
    throw new Error(
      `${label} highestReleaseSequence is below a referenced release.`,
    );
  }
  assertSafeInteger(value.updatedAtUnixMs, 1, `${label} updatedAtUnixMs`);
  if (
    value.lastFailure !== null &&
    (typeof value.lastFailure !== "string" ||
      value.lastFailure.length === 0 ||
      Buffer.byteLength(value.lastFailure, "utf8") > 1_024 ||
      /[\r\n\0]/u.test(value.lastFailure))
  ) {
    throw new Error(`${label} lastFailure is invalid.`);
  }

  return Object.freeze({
    schemaVersion: RENDERER_STATE_SCHEMA_VERSION,
    storageRevision: value.storageRevision,
    previousStateSha256,
    highestReleaseSequence: value.highestReleaseSequence,
    activeRelease,
    lastKnownGoodRelease,
    lastFailure: value.lastFailure,
    updatedAtUnixMs: value.updatedAtUnixMs,
  });
}

export function rendererStateRevisionName(revision) {
  assertSafeInteger(revision, 1, "Renderer state revision number");
  return `revision-${String(revision).padStart(20, "0")}.json`;
}

export function verifyRendererStateJournal(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Renderer state journal contains no revision.");
  }
  if (entries.length > MAX_RENDERER_STATE_REVISIONS) {
    throw new Error("Renderer state journal contains too many revisions.");
  }

  const sorted = [...entries].sort((left, right) =>
    left.fileName.localeCompare(right.fileName),
  );
  let previousSha256 = null;
  let latestState = null;
  let journalBytes = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const expectedRevision = index + 1;
    const entry = sorted[index];
    if (
      !isRecord(entry) ||
      entry.fileName !== rendererStateRevisionName(expectedRevision) ||
      !(entry.content instanceof Uint8Array)
    ) {
      throw new Error(
        "Renderer state journal has a missing or malformed revision.",
      );
    }
    if (
      entry.content.byteLength === 0 ||
      entry.content.byteLength > MAX_RENDERER_STATE_BYTES
    ) {
      throw new Error(
        `Renderer state revision ${expectedRevision} exceeds its byte limit.`,
      );
    }
    journalBytes += entry.content.byteLength;
    if (journalBytes > MAX_RENDERER_STATE_JOURNAL_BYTES) {
      throw new Error(
        "Renderer state journal exceeds its cumulative size limit.",
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(entry.content).toString("utf8"));
    } catch (error) {
      throw new Error(
        `Renderer state revision ${expectedRevision} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    latestState = stateRevision(parsed, expectedRevision, previousSha256);
    previousSha256 = createHash("sha256").update(entry.content).digest("hex");
  }

  return Object.freeze({
    latestState,
    latestFileName: sorted.at(-1).fileName,
    latestSha256: previousSha256,
    revisionCount: sorted.length,
    journalBytes,
  });
}
