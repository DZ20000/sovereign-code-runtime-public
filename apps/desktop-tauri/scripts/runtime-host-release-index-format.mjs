import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export const RELEASE_INDEX_ENVELOPE_SCHEMA_VERSION =
  "scr.runtime-host-release-index-signature/v1";
export const RELEASE_INDEX_SCHEMA_VERSION = "scr.runtime-host-release-index/v1";
export const RELEASE_INDEX_SIGNATURE_PAYLOAD_SCHEMA_VERSION =
  "scr.runtime-host-release-index-signature-payload/v1";
export const RELEASE_INDEX_TRUST_SCHEMA_VERSION =
  "scr.runtime-host-release-index-trusted-keys/v1";
export const RUNTIME_TRUST_SCHEMA_VERSION =
  "scr.runtime-candidate-trusted-keys/v1";
export const RUNTIME_ENVELOPE_SCHEMA_VERSION =
  "scr.runtime-candidate-release-signature/v1";
export const RUNTIME_MANIFEST_SCHEMA_VERSION =
  "scr.runtime-candidate-manifest/v1";
export const RUNTIME_SIGNATURE_PAYLOAD_SCHEMA_VERSION =
  "scr.runtime-candidate-signature/v1";

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PATH_SAFE_RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PORTABLE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/u;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_TRUST_BYTES = 256 * 1024;
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 256 * 1024 * 1024;
const MAX_RELEASES = 128;
const MAX_TRUSTED_KEYS = 64;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export function fail(message) {
  const bounded = String(message)
    .replace(/[\0\r\n]+/gu, " ")
    .slice(0, 1_000);
  throw new Error(bounded);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a plain object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has an unsupported field set.`);
  }
}

function boundedString(value, label, maximumLength = 32_767) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer.`);
  }
  return value;
}

function optionalMaximum(value, minimum, label) {
  if (value === null) return null;
  const maximum = positiveSafeInteger(value, label);
  if (maximum < minimum) fail(`${label} may not be below its minimum.`);
  return maximum;
}

function identifier(value, label, pattern) {
  const normalized = boundedString(value, label, 256);
  if (!pattern.test(normalized)) fail(`${label} is invalid.`);
  return normalized;
}

function digest(value, label) {
  const normalized = boundedString(value, label, 64);
  if (!SHA256_PATTERN.test(normalized))
    fail(`${label} must be lowercase SHA-256.`);
  return normalized;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isVolumeRoot(candidate) {
  const normalized = resolve(candidate);
  return (
    normalized.toLowerCase() === resolve(parse(normalized).root).toLowerCase()
  );
}

export function isContained(root, candidate) {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function rejectShallowRoot(candidate, label) {
  const normalized = resolve(candidate);
  const volumeRoot = resolve(parse(normalized).root);
  if (
    normalized.toLowerCase() === volumeRoot.toLowerCase() ||
    dirname(normalized).toLowerCase() === volumeRoot.toLowerCase()
  ) {
    fail(`${label} may not be a filesystem root or a direct child of one.`);
  }
}

async function stableMetadata(candidate, label, kind, maximumBytes = null) {
  const metadata = await lstat(candidate).catch((error) => {
    fail(`${label} is unavailable: ${error.code ?? "FS_ERROR"}`);
  });
  if (metadata.isSymbolicLink())
    fail(`${label} may not be a symbolic link or junction.`);
  if (kind === "file" && (!metadata.isFile() || metadata.nlink !== 1)) {
    fail(`${label} must be a direct unshared regular file.`);
  }
  if (kind === "directory" && !metadata.isDirectory()) {
    fail(`${label} must be a direct directory.`);
  }
  if (
    maximumBytes !== null &&
    (metadata.size < 1 || metadata.size > maximumBytes)
  ) {
    fail(`${label} is outside its size bound.`);
  }
  return metadata;
}

export async function directDirectory(
  candidate,
  label,
  { shallow = false, requireCanonicalPath = false } = {},
) {
  const absolute = resolve(candidate);
  if (shallow) rejectShallowRoot(absolute, label);
  else if (isVolumeRoot(absolute))
    fail(`${label} may not be a filesystem root.`);
  await stableMetadata(absolute, label, "directory");
  const canonical = await realpath(absolute);
  if (shallow) rejectShallowRoot(canonical, `Canonical ${label}`);
  else if (isVolumeRoot(canonical))
    fail(`Canonical ${label} may not be a filesystem root.`);
  if (
    requireCanonicalPath &&
    resolve(absolute).toLowerCase() !== resolve(canonical).toLowerCase()
  ) {
    fail(
      `${label} may not pass through a symbolic link, junction, or reparse path.`,
    );
  }
  return Object.freeze({ path: absolute, canonical });
}

export async function directFile(candidate, label, maximumBytes) {
  const absolute = resolve(candidate);
  const before = await stableMetadata(absolute, label, "file", maximumBytes);
  const canonical = await realpath(absolute);
  let handle;
  let bytes;
  try {
    handle = await open(absolute, "r");
    const openedBefore = await handle.stat();
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1 ||
      openedBefore.dev !== before.dev ||
      openedBefore.ino !== before.ino ||
      openedBefore.size !== before.size ||
      openedBefore.mtimeMs !== before.mtimeMs
    ) {
      fail(`${label} changed before its verified read began.`);
    }
    bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (
      openedAfter.dev !== openedBefore.dev ||
      openedAfter.ino !== openedBefore.ino ||
      openedAfter.nlink !== 1 ||
      openedAfter.size !== openedBefore.size ||
      openedAfter.mtimeMs !== openedBefore.mtimeMs ||
      openedAfter.ctimeMs !== openedBefore.ctimeMs ||
      bytes.byteLength !== openedBefore.size
    ) {
      fail(`${label} changed while reading.`);
    }
  } finally {
    await handle?.close();
  }
  const after = await stableMetadata(absolute, label, "file", maximumBytes);
  const canonicalAfter = await realpath(absolute);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    resolve(canonicalAfter).toLowerCase() !== resolve(canonical).toLowerCase()
  ) {
    fail(`${label} changed after reading.`);
  }
  return Object.freeze({ path: absolute, canonical, bytes });
}

export function portableRelativePath(value, label, { extension = null } = {}) {
  const normalized = boundedString(value, label, 1_024);
  if (
    isAbsolute(normalized) ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    normalized.endsWith("/")
  ) {
    fail(`${label} must use a portable relative path.`);
  }
  const segments = normalized.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !PORTABLE_PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    fail(`${label} contains an unsafe path segment.`);
  }
  if (extension !== null && !normalized.toLowerCase().endsWith(extension)) {
    fail(`${label} must use the ${extension} extension.`);
  }
  return normalized;
}

export async function containedPath(
  root,
  relativePath,
  label,
  kind,
  maximumBytes = null,
) {
  const portable = portableRelativePath(relativePath, label);
  const segments = portable.split("/");
  const lexical = resolve(root.path, ...segments);
  if (!isContained(root.path, lexical) || lexical === root.path) {
    fail(`${label} escaped its authorized root.`);
  }
  let current = root.path;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current).catch((error) => {
      fail(`${label} is unavailable: ${error.code ?? "FS_ERROR"}`);
    });
    if (metadata.isSymbolicLink()) {
      fail(`${label} may not pass through a symbolic link or junction.`);
    }
  }
  const canonical = await realpath(lexical);
  if (!isContained(root.canonical, canonical) || canonical === root.canonical) {
    fail(`${label} escaped its canonical authorized root.`);
  }
  if (kind === "directory") {
    await stableMetadata(lexical, label, "directory");
    return Object.freeze({ path: lexical, canonical, portable });
  }
  const file = await directFile(lexical, label, maximumBytes);
  return Object.freeze({ ...file, portable });
}

export async function readCanonicalJsonFile(candidate, label, maximumBytes) {
  const file = await directFile(candidate, label, maximumBytes);
  const text = file.bytes.toString("utf8");
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
  if (text !== canonicalJson(document))
    fail(`${label} must use canonical JSON.`);
  return Object.freeze({ ...file, document, text });
}

function canonicalPublicKey(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384 ||
    /[\0\r]/u.test(value)
  ) {
    fail(`${label} must be bounded canonical PEM text.`);
  }
  const pem = value;
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    fail(`${label} is not a valid public key.`);
  }
  if (key.asymmetricKeyType !== "ed25519") fail(`${label} must be Ed25519.`);
  const exported = key.export({ format: "pem", type: "spki" }).toString("utf8");
  if (pem !== exported) fail(`${label} must be canonical Ed25519 SPKI PEM.`);
  return key;
}

async function loadTrustedKeys(
  trustPath,
  { label, schemaVersion, minimumField, maximumField, forbiddenRoot = null },
) {
  const registryFile = await readCanonicalJsonFile(
    trustPath,
    label,
    MAX_TRUST_BYTES,
  );
  if (
    resolve(registryFile.path).toLowerCase() !==
    resolve(registryFile.canonical).toLowerCase()
  ) {
    fail(
      `${label} may not pass through a symbolic link, junction, or reparse path.`,
    );
  }
  if (
    forbiddenRoot !== null &&
    isContained(forbiddenRoot.canonical, registryFile.canonical)
  ) {
    fail(`${label} may not be supplied by the untrusted release source.`);
  }
  const registry = plainObject(registryFile.document, label);
  exactKeys(registry, ["schemaVersion", "keys"], label);
  if (registry.schemaVersion !== schemaVersion)
    fail(`${label} schema is unsupported.`);
  if (
    !Array.isArray(registry.keys) ||
    registry.keys.length > MAX_TRUSTED_KEYS
  ) {
    fail(`${label} has an invalid key inventory.`);
  }
  const keys = new Map();
  for (const [index, raw] of registry.keys.entries()) {
    const entryLabel = `${label} key ${index}`;
    const entry = plainObject(raw, entryLabel);
    exactKeys(
      entry,
      ["keyId", "publicKeyPem", minimumField, maximumField],
      entryLabel,
    );
    const keyId = identifier(entry.keyId, `${entryLabel} ID`, KEY_ID_PATTERN);
    if (keys.has(keyId)) fail(`${label} contains a duplicate key ID.`);
    const minimum = positiveSafeInteger(
      entry[minimumField],
      `${entryLabel} minimum`,
    );
    const maximum = optionalMaximum(
      entry[maximumField],
      minimum,
      `${entryLabel} maximum`,
    );
    keys.set(
      keyId,
      Object.freeze({
        keyId,
        publicKey: canonicalPublicKey(
          entry.publicKeyPem,
          `${entryLabel} public key`,
        ),
        minimum,
        maximum,
      }),
    );
  }
  return keys;
}

export async function loadReleaseIndexTrustedKeys(path, forbiddenRoot = null) {
  return loadTrustedKeys(path, {
    label: "Runtime Host release-index trusted-key registry",
    schemaVersion: RELEASE_INDEX_TRUST_SCHEMA_VERSION,
    minimumField: "minimumIndexSequence",
    maximumField: "maximumIndexSequence",
    forbiddenRoot,
  });
}

export async function loadRuntimeCandidateTrustedKeys(
  path,
  forbiddenRoot = null,
) {
  return loadTrustedKeys(path, {
    label: "Runtime candidate trusted-key registry",
    schemaVersion: RUNTIME_TRUST_SCHEMA_VERSION,
    minimumField: "minimumReleaseSequence",
    maximumField: "maximumReleaseSequence",
    forbiddenRoot,
  });
}

function verifyEd25519Signature(signature, payload, trusted, label) {
  const encoded = boundedString(signature, `${label} signature`, 512);
  let bytes;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    fail(`${label} signature is invalid base64url.`);
  }
  if (bytes.byteLength !== 64 || bytes.toString("base64url") !== encoded) {
    fail(`${label} signature encoding is not canonical Ed25519.`);
  }
  if (!verifySignature(null, payload, trusted.publicKey, bytes)) {
    fail(`${label} signature is invalid.`);
  }
}

function verifySequenceTrust(sequence, trusted, label) {
  if (
    sequence < trusted.minimum ||
    (trusted.maximum !== null && sequence > trusted.maximum)
  ) {
    fail(`${label} sequence is outside its trusted-key window.`);
  }
}

function versionParts(value, label) {
  const version = boundedString(value, label, 64);
  if (!VERSION_PATTERN.test(version))
    fail(`${label} must be a stable numeric version.`);
  return version.split(".").map((part) => Number(part));
}

function compareVersions(left, right) {
  const maximum = Math.max(left.length, right.length);
  for (let index = 0; index < maximum; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateIndexRelease(raw, index) {
  const label = `Runtime Host release-index entry ${index}`;
  const value = plainObject(raw, label);
  exactKeys(
    value,
    [
      "releaseId",
      "releaseSequence",
      "packagePath",
      "envelopeSha256",
      "runtimeHostSha256",
    ],
    label,
  );
  const releaseId = identifier(
    value.releaseId,
    `${label} release ID`,
    PATH_SAFE_RELEASE_ID_PATTERN,
  );
  const packagePath = portableRelativePath(
    value.packagePath,
    `${label} package path`,
  );
  if (basename(packagePath) !== releaseId) {
    fail(`${label} package directory must be named after its release ID.`);
  }
  return Object.freeze({
    releaseId,
    releaseSequence: positiveSafeInteger(
      value.releaseSequence,
      `${label} release sequence`,
    ),
    packagePath,
    envelopeSha256: digest(value.envelopeSha256, `${label} envelope digest`),
    runtimeHostSha256: digest(
      value.runtimeHostSha256,
      `${label} Runtime Host digest`,
    ),
  });
}

export async function verifyRuntimeHostReleaseIndex({
  indexPath,
  trustedKeys,
  nowUnixMs = Date.now(),
}) {
  if (!(trustedKeys instanceof Map) || trustedKeys.size === 0) {
    fail("No trusted Runtime Host release-index signing keys are provisioned.");
  }
  const indexFile = await readCanonicalJsonFile(
    indexPath,
    "Runtime Host release index",
    MAX_INDEX_BYTES,
  );
  const envelope = plainObject(
    indexFile.document,
    "Runtime Host release-index envelope",
  );
  exactKeys(
    envelope,
    [
      "schemaVersion",
      "algorithm",
      "keyId",
      "indexSha256",
      "index",
      "signature",
    ],
    "Runtime Host release-index envelope",
  );
  if (
    envelope.schemaVersion !== RELEASE_INDEX_ENVELOPE_SCHEMA_VERSION ||
    envelope.algorithm !== "ed25519"
  ) {
    fail("Runtime Host release-index envelope metadata is unsupported.");
  }
  const keyId = identifier(
    envelope.keyId,
    "Runtime Host release-index signing key ID",
    KEY_ID_PATTERN,
  );
  const trusted = trustedKeys.get(keyId);
  if (trusted === undefined)
    fail("Runtime Host release-index signing key is not trusted.");
  const indexDocument = plainObject(
    envelope.index,
    "Runtime Host release index",
  );
  exactKeys(
    indexDocument,
    [
      "schemaVersion",
      "indexSequence",
      "generatedAtUnixMs",
      "expiresAtUnixMs",
      "releases",
    ],
    "Runtime Host release index",
  );
  if (indexDocument.schemaVersion !== RELEASE_INDEX_SCHEMA_VERSION) {
    fail("Runtime Host release-index schema is unsupported.");
  }
  const indexSequence = positiveSafeInteger(
    indexDocument.indexSequence,
    "Runtime Host release-index sequence",
  );
  verifySequenceTrust(indexSequence, trusted, "Runtime Host release-index");
  const generatedAtUnixMs = positiveSafeInteger(
    indexDocument.generatedAtUnixMs,
    "Runtime Host release-index generation time",
  );
  const expiresAtUnixMs = positiveSafeInteger(
    indexDocument.expiresAtUnixMs,
    "Runtime Host release-index expiration time",
  );
  if (expiresAtUnixMs <= generatedAtUnixMs) {
    fail("Runtime Host release-index expiration must follow generation.");
  }
  if (generatedAtUnixMs > nowUnixMs + MAX_CLOCK_SKEW_MS) {
    fail("Runtime Host release index was generated too far in the future.");
  }
  if (expiresAtUnixMs < nowUnixMs)
    fail("Runtime Host release index has expired.");
  if (
    !Array.isArray(indexDocument.releases) ||
    indexDocument.releases.length < 1 ||
    indexDocument.releases.length > MAX_RELEASES
  ) {
    fail("Runtime Host release index has an invalid release inventory.");
  }
  const releases = indexDocument.releases.map(validateIndexRelease);
  const releaseIds = new Set();
  const releaseSequences = new Set();
  const packagePaths = new Set();
  for (const release of releases) {
    if (releaseIds.has(release.releaseId))
      fail("Runtime Host release index duplicates a release ID.");
    if (releaseSequences.has(release.releaseSequence)) {
      fail("Runtime Host release index duplicates a release sequence.");
    }
    if (packagePaths.has(release.packagePath)) {
      fail("Runtime Host release index duplicates a package path.");
    }
    releaseIds.add(release.releaseId);
    releaseSequences.add(release.releaseSequence);
    packagePaths.add(release.packagePath);
  }
  const sorted = [...releases].sort(
    (left, right) =>
      left.releaseSequence - right.releaseSequence ||
      left.releaseId.localeCompare(right.releaseId),
  );
  if (releases.some((release, index) => release !== sorted[index])) {
    fail("Runtime Host release-index entries must be strictly sorted.");
  }
  const canonicalIndex = canonicalJson(indexDocument);
  const indexSha256 = sha256(Buffer.from(canonicalIndex, "utf8"));
  if (
    digest(envelope.indexSha256, "Runtime Host release-index digest") !==
    indexSha256
  ) {
    fail("Runtime Host release-index digest does not match its envelope.");
  }
  verifyEd25519Signature(
    envelope.signature,
    Buffer.from(
      `${RELEASE_INDEX_SIGNATURE_PAYLOAD_SCHEMA_VERSION}\n${indexSha256}`,
      "utf8",
    ),
    trusted,
    "Runtime Host release index",
  );
  return Object.freeze({
    path: indexFile.path,
    canonical: indexFile.canonical,
    rawBytes: indexFile.bytes,
    envelopeSha256: sha256(indexFile.bytes),
    keyId,
    indexSha256,
    indexSequence,
    generatedAtUnixMs,
    expiresAtUnixMs,
    releases,
  });
}

function validateRuntimeManifest(raw) {
  const manifest = plainObject(raw, "Runtime candidate manifest");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "releaseId",
      "releaseSequence",
      "createdAtUnixMs",
      "minimumShellVersion",
      "runtimeProtocolVersion",
      "component",
    ],
    "Runtime candidate manifest",
  );
  if (manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    fail("Runtime candidate manifest schema is unsupported.");
  }
  const component = plainObject(
    manifest.component,
    "Runtime candidate component declaration",
  );
  exactKeys(
    component,
    ["path", "size", "sha256"],
    "Runtime candidate component declaration",
  );
  if (component.path !== "runtime-host.cjs") {
    fail("Runtime candidate component path is unsupported.");
  }
  return Object.freeze({
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    releaseId: identifier(
      manifest.releaseId,
      "Runtime candidate release ID",
      RELEASE_ID_PATTERN,
    ),
    releaseSequence: positiveSafeInteger(
      manifest.releaseSequence,
      "Runtime candidate release sequence",
    ),
    createdAtUnixMs: positiveSafeInteger(
      manifest.createdAtUnixMs,
      "Runtime candidate creation time",
    ),
    minimumShellVersion: boundedString(
      manifest.minimumShellVersion,
      "Runtime candidate minimum shell version",
      64,
    ),
    runtimeProtocolVersion: positiveSafeInteger(
      manifest.runtimeProtocolVersion,
      "Runtime candidate protocol version",
    ),
    component: Object.freeze({
      path: "runtime-host.cjs",
      size: positiveSafeInteger(
        component.size,
        "Runtime candidate component size",
      ),
      sha256: digest(component.sha256, "Runtime candidate component digest"),
    }),
  });
}

export async function verifyRuntimeCandidatePackage({
  packageRoot,
  trustedKeys,
  shellVersion,
  runtimeProtocolVersion,
  expected = null,
  requireDirectoryName = true,
}) {
  if (!(trustedKeys instanceof Map) || trustedKeys.size === 0) {
    fail("No trusted Runtime candidate signing keys are provisioned.");
  }
  const root = await directDirectory(packageRoot, "Runtime candidate package");
  const inventory = await readdir(root.path, { withFileTypes: true });
  const names = inventory.map((entry) => entry.name).sort();
  if (
    names.length !== 2 ||
    names[0] !== "envelope.json" ||
    names[1] !== "runtime-host.cjs" ||
    inventory.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    fail(
      "Runtime candidate package must contain only envelope.json and runtime-host.cjs.",
    );
  }
  const envelopeFile = await readCanonicalJsonFile(
    join(root.path, "envelope.json"),
    "Runtime candidate envelope",
    MAX_ENVELOPE_BYTES,
  );
  const runtimeFile = await directFile(
    join(root.path, "runtime-host.cjs"),
    "Runtime candidate component",
    MAX_RUNTIME_BYTES,
  );
  if (
    !isContained(root.canonical, envelopeFile.canonical) ||
    !isContained(root.canonical, runtimeFile.canonical)
  ) {
    fail("Runtime candidate package file escaped its package root.");
  }
  const envelope = plainObject(
    envelopeFile.document,
    "Runtime candidate envelope",
  );
  exactKeys(
    envelope,
    [
      "schemaVersion",
      "algorithm",
      "keyId",
      "manifestSha256",
      "manifest",
      "signature",
    ],
    "Runtime candidate envelope",
  );
  if (
    envelope.schemaVersion !== RUNTIME_ENVELOPE_SCHEMA_VERSION ||
    envelope.algorithm !== "ed25519"
  ) {
    fail("Runtime candidate envelope metadata is unsupported.");
  }
  const manifest = validateRuntimeManifest(envelope.manifest);
  if (requireDirectoryName && basename(root.path) !== manifest.releaseId) {
    fail("Runtime candidate package directory does not match its release ID.");
  }
  const manifestSha256 = sha256(
    Buffer.from(canonicalJson(envelope.manifest), "utf8"),
  );
  if (
    digest(envelope.manifestSha256, "Runtime candidate manifest digest") !==
    manifestSha256
  ) {
    fail("Runtime candidate manifest digest does not match its envelope.");
  }
  const keyId = identifier(
    envelope.keyId,
    "Runtime candidate signing key ID",
    KEY_ID_PATTERN,
  );
  const trusted = trustedKeys.get(keyId);
  if (trusted === undefined)
    fail("Runtime candidate signing key is not trusted.");
  verifySequenceTrust(manifest.releaseSequence, trusted, "Runtime candidate");
  verifyEd25519Signature(
    envelope.signature,
    Buffer.from(
      `${RUNTIME_SIGNATURE_PAYLOAD_SCHEMA_VERSION}\n${manifestSha256}`,
      "utf8",
    ),
    trusted,
    "Runtime candidate",
  );
  const currentVersion = versionParts(shellVersion, "Current shell version");
  const minimumVersion = versionParts(
    manifest.minimumShellVersion,
    "Runtime candidate minimum shell version",
  );
  if (compareVersions(currentVersion, minimumVersion) < 0) {
    fail("Runtime candidate requires a newer signed shell.");
  }
  if (
    manifest.runtimeProtocolVersion !==
    positiveSafeInteger(
      runtimeProtocolVersion,
      "Current Runtime protocol version",
    )
  ) {
    fail("Runtime candidate control protocol is incompatible.");
  }
  const runtimeHostSha256 = sha256(runtimeFile.bytes);
  if (
    manifest.component.size !== runtimeFile.bytes.byteLength ||
    manifest.component.sha256 !== runtimeHostSha256
  ) {
    fail("Runtime candidate component size or SHA-256 does not match.");
  }
  const envelopeSha256 = sha256(envelopeFile.bytes);
  if (expected !== null) {
    if (
      manifest.releaseId !== expected.releaseId ||
      manifest.releaseSequence !== expected.releaseSequence ||
      envelopeSha256 !== expected.envelopeSha256 ||
      runtimeHostSha256 !== expected.runtimeHostSha256
    ) {
      fail("Runtime candidate package does not match its release-index entry.");
    }
  }
  return Object.freeze({
    packageRoot: root.path,
    canonicalPackageRoot: root.canonical,
    releaseId: manifest.releaseId,
    releaseSequence: manifest.releaseSequence,
    signingKeyId: keyId,
    manifestSha256,
    envelopeSha256,
    runtimeHostSha256,
    runtimeHostBytes: runtimeFile.bytes.byteLength,
  });
}
