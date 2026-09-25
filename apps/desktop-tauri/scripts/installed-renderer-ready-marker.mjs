import { verifyRendererReleaseReference } from "./installed-renderer-state-journal.mjs";

export const RENDERER_READY_SCHEMA_VERSION = "scr.renderer-slot-ready/v1";

const READY_KEYS = ["installedAtUnixMs", "release", "schemaVersion"];

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

export function verifyInstalledRendererReadyMarker(value) {
  const label = "Active Renderer ready marker";
  assertExactKeys(value, READY_KEYS, label);
  if (value.schemaVersion !== RENDERER_READY_SCHEMA_VERSION) {
    throw new Error(`${label} uses an unsupported schema version.`);
  }
  if (
    typeof value.installedAtUnixMs !== "number" ||
    !Number.isSafeInteger(value.installedAtUnixMs) ||
    value.installedAtUnixMs < 1
  ) {
    throw new Error(`${label} installedAtUnixMs is invalid.`);
  }
  const release = verifyRendererReleaseReference(
    value.release,
    `${label} release`,
  );
  if (release === null) throw new Error(`${label} release is missing.`);
  return Object.freeze({
    schemaVersion: RENDERER_READY_SCHEMA_VERSION,
    installedAtUnixMs: value.installedAtUnixMs,
    release,
  });
}
