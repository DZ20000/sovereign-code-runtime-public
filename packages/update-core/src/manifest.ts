import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { win32 } from "node:path";

export const RELEASE_MANIFEST_SCHEMA_VERSION = "scr.release/v1" as const;
export const RELEASE_SIGNATURE_SCHEMA_VERSION = "scr.release-signature/v1" as const;

const MAX_COMPONENTS = 128;
const MAX_COMPONENT_BYTES = 2_147_483_647;
const MAX_RELEASE_BYTES = 4_294_967_295;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PUBLIC_KEY_CHARACTERS = 16 * 1024;
const MAX_TRUSTED_KEYS = 64;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const COMPONENT_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_CREATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const RESERVED_RELEASE_COMPONENT_ROOT = ".scr-update";

const ENVELOPE_KEYS = [
  "schemaVersion",
  "algorithm",
  "keyId",
  "manifestSha256",
  "signature",
  "manifest",
] as const;
const MANIFEST_KEYS = [
  "schemaVersion",
  "releaseId",
  "releaseSequence",
  "version",
  "channel",
  "createdAt",
  "entrypoint",
  "totalBytes",
  "components",
  "compatibility",
] as const;
const COMPONENT_KEYS = ["path", "sha256", "bytes", "role"] as const;
const COMPATIBILITY_KEYS = [
  "minimumBootstrapVersion",
  "maximumBootstrapVersion",
  "runtimeHostProtocolVersion",
  "preCommitDataPolicy",
  "dataSchemas",
] as const;
const DATA_SCHEMAS_KEYS = ["settings", "audit", "runs"] as const;
const DATA_SCHEMA_COMPATIBILITY_KEYS = ["readableMin", "readableMax", "writeVersion"] as const;

export type ReleaseChannel = "stable" | "beta" | "development";
export type ReleaseComponentRole =
  | "shell"
  | "node"
  | "runtime-host"
  | "host-guardian"
  | "native-agent"
  | "resource";

export interface ReleaseComponent {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly role: ReleaseComponentRole;
}

export interface ReleaseDataSchemaCompatibility {
  readonly readableMin: number;
  readonly readableMax: number;
  readonly writeVersion: number;
}

export interface ReleaseCompatibility {
  readonly minimumBootstrapVersion: string;
  readonly maximumBootstrapVersion: string | null;
  readonly runtimeHostProtocolVersion: number;
  readonly preCommitDataPolicy: "backward-compatible";
  readonly dataSchemas: {
    readonly settings: ReleaseDataSchemaCompatibility;
    readonly audit: ReleaseDataSchemaCompatibility;
    readonly runs: ReleaseDataSchemaCompatibility;
  };
}

export interface ReleaseManifest {
  readonly schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly createdAt: string;
  readonly entrypoint: string;
  readonly totalBytes: number;
  readonly components: readonly ReleaseComponent[];
  readonly compatibility: ReleaseCompatibility;
}

export interface ReleaseSignatureEnvelope {
  readonly schemaVersion: typeof RELEASE_SIGNATURE_SCHEMA_VERSION;
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly manifestSha256: string;
  readonly signature: string;
  readonly manifest: ReleaseManifest;
}

export interface TrustedReleasePublicKey {
  readonly keyId: string;
  readonly algorithm: "ed25519";
  readonly publicKeyPem: string;
  readonly minimumReleaseSequence: number;
  readonly maximumReleaseSequence: number | null;
  readonly allowedChannels: readonly ReleaseChannel[];
}

export interface VerifiedReleaseEnvelope {
  readonly envelope: ReleaseSignatureEnvelope;
  readonly manifestCanonicalJson: string;
  readonly signingKeyId: string;
}

export interface ObservedReleaseComponent {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface UpdateHostCompatibility {
  readonly bootstrapVersion: string;
  readonly runtimeHostProtocolVersion: number;
  readonly activeReleaseSequence: number;
  readonly currentDataSchemas: {
    readonly settings: number;
    readonly audit: number;
    readonly runs: number;
  };
  readonly lastKnownGoodReadableSchemas: {
    readonly settings: { readonly min: number; readonly max: number };
    readonly audit: { readonly min: number; readonly max: number };
    readonly runs: { readonly min: number; readonly max: number };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains an unknown field: ${key}`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} is missing the required field: ${key}`);
    }
  }
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareOrdinal(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalReleaseJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function releaseSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumCharacters: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumCharacters ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error(`${label} is invalid or exceeds its length limit.`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function parseStrictVersion(value: string, label: string): readonly [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (match === null) {
    throw new Error(`${label} must use numeric major.minor.patch format without leading zeros.`);
  }
  const parts = match.slice(1).map((part) => Number(part));
  for (const part of parts) {
    if (!Number.isSafeInteger(part) || part > 1_000_000) {
      throw new Error(`${label} contains an invalid numeric component.`);
    }
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

function compareStrictVersions(left: string, right: string): number {
  const leftParts = parseStrictVersion(left, "Version");
  const rightParts = parseStrictVersion(right, "Version");
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function validateReleaseVersion(value: unknown): string {
  assertBoundedString(value, "Release version", 128);
  const separatorIndex = value.indexOf("-");
  const core = separatorIndex < 0 ? value : value.slice(0, separatorIndex);
  const prerelease = separatorIndex < 0 ? undefined : value.slice(separatorIndex + 1);
  parseStrictVersion(core, "Release version");
  if (prerelease !== undefined) {
    if (prerelease.length === 0) {
      throw new Error("Release prerelease identifier may not be empty.");
    }
    const identifiers = prerelease.split(".");
    for (const identifier of identifiers) {
      if (!/^[0-9A-Za-z-]+$/u.test(identifier)) {
        throw new Error("Release prerelease identifiers contain invalid characters.");
      }
      if (/^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
        throw new Error("Numeric release prerelease identifiers may not contain leading zeros.");
      }
    }
  }
  return value;
}

function validateCreatedAt(value: unknown): string {
  assertBoundedString(value, "Release createdAt", 128);
  if (!CANONICAL_CREATED_AT_PATTERN.test(value)) {
    throw new Error("Release createdAt must use canonical UTC RFC3339 milliseconds format.");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Release createdAt must be a real canonical UTC timestamp.");
  }
  return value;
}

export function validateReleaseComponentPath(value: unknown): string {
  assertBoundedString(value, "Release component path", 240);
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    !COMPONENT_PATH_PATTERN.test(value)
  ) {
    throw new Error("Release component path must be a bounded portable relative path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Release component path contains an empty, dot, or traversal segment.");
  }
  if (segments[0]!.toLowerCase() === RESERVED_RELEASE_COMPONENT_ROOT) {
    throw new Error("Release component path uses the reserved update-slot metadata directory.");
  }
  for (const segment of segments) {
    if (
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_NAME_PATTERN.test(segment)
    ) {
      throw new Error(`Release component path contains an invalid Windows segment: ${segment}`);
    }
  }
  return value;
}

function parseDataSchemaCompatibility(
  value: unknown,
  label: string,
): ReleaseDataSchemaCompatibility {
  if (!isRecord(value)) throw new Error(`${label} compatibility must be an object.`);
  assertExactKeys(value, DATA_SCHEMA_COMPATIBILITY_KEYS, `${label} compatibility`);
  assertSafeInteger(value.readableMin, `${label}.readableMin`, 0, 1_000_000);
  assertSafeInteger(value.readableMax, `${label}.readableMax`, 0, 1_000_000);
  assertSafeInteger(value.writeVersion, `${label}.writeVersion`, 0, 1_000_000);
  if (value.readableMin > value.readableMax) {
    throw new Error(`${label} readable range is inverted.`);
  }
  if (value.writeVersion < value.readableMin || value.writeVersion > value.readableMax) {
    throw new Error(`${label} write version must be inside the candidate readable range.`);
  }
  return {
    readableMin: value.readableMin,
    readableMax: value.readableMax,
    writeVersion: value.writeVersion,
  };
}

function parseReleaseCompatibility(value: unknown): ReleaseCompatibility {
  if (!isRecord(value)) throw new Error("Release compatibility must be an object.");
  assertExactKeys(value, COMPATIBILITY_KEYS, "Release compatibility");
  assertBoundedString(value.minimumBootstrapVersion, "Minimum bootstrap version", 64);
  parseStrictVersion(value.minimumBootstrapVersion, "Minimum bootstrap version");
  const maximumBootstrapVersion = value.maximumBootstrapVersion;
  if (maximumBootstrapVersion !== null) {
    assertBoundedString(maximumBootstrapVersion, "Maximum bootstrap version", 64);
    parseStrictVersion(maximumBootstrapVersion, "Maximum bootstrap version");
    if (compareStrictVersions(value.minimumBootstrapVersion, maximumBootstrapVersion) > 0) {
      throw new Error("Bootstrap version range is inverted.");
    }
  }
  assertSafeInteger(
    value.runtimeHostProtocolVersion,
    "Runtime Host protocol version",
    1,
    1_000_000,
  );
  if (value.preCommitDataPolicy !== "backward-compatible") {
    throw new Error("Release pre-commit data policy must be backward-compatible.");
  }
  if (!isRecord(value.dataSchemas)) {
    throw new Error("Release dataSchemas compatibility must be an object.");
  }
  assertExactKeys(value.dataSchemas, DATA_SCHEMAS_KEYS, "Release dataSchemas compatibility");
  return {
    minimumBootstrapVersion: value.minimumBootstrapVersion,
    maximumBootstrapVersion,
    runtimeHostProtocolVersion: value.runtimeHostProtocolVersion,
    preCommitDataPolicy: "backward-compatible",
    dataSchemas: {
      settings: parseDataSchemaCompatibility(value.dataSchemas.settings, "settings"),
      audit: parseDataSchemaCompatibility(value.dataSchemas.audit, "audit"),
      runs: parseDataSchemaCompatibility(value.dataSchemas.runs, "runs"),
    },
  };
}

function parseReleaseComponent(value: unknown): ReleaseComponent {
  if (!isRecord(value)) throw new Error("Release component must be an object.");
  assertExactKeys(value, COMPONENT_KEYS, "Release component");
  const path = validateReleaseComponentPath(value.path);
  assertSha256(value.sha256, `Component ${path} SHA-256`);
  assertSafeInteger(value.bytes, `Component ${path} bytes`, 1, MAX_COMPONENT_BYTES);
  if (![
    "shell",
    "node",
    "runtime-host",
    "host-guardian",
    "native-agent",
    "resource",
  ].includes(String(value.role))) {
    throw new Error(`Component ${path} has an unsupported role.`);
  }
  return {
    path,
    sha256: value.sha256,
    bytes: value.bytes,
    role: value.role as ReleaseComponentRole,
  };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value)) throw new Error("Release manifest must be an object.");
  assertExactKeys(value, MANIFEST_KEYS, "Release manifest");
  if (value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Unsupported release manifest schema version.");
  }
  assertBoundedString(value.releaseId, "Release ID", 128);
  if (!RELEASE_ID_PATTERN.test(value.releaseId)) throw new Error("Release ID has an invalid shape.");
  assertSafeInteger(value.releaseSequence, "Release sequence", 1, Number.MAX_SAFE_INTEGER);
  const version = validateReleaseVersion(value.version);
  if (!["stable", "beta", "development"].includes(String(value.channel))) {
    throw new Error("Release channel is invalid.");
  }
  const createdAt = validateCreatedAt(value.createdAt);
  const entrypoint = validateReleaseComponentPath(value.entrypoint);
  assertSafeInteger(value.totalBytes, "Release totalBytes", 1, MAX_RELEASE_BYTES);
  if (!Array.isArray(value.components) || value.components.length < 1 || value.components.length > MAX_COMPONENTS) {
    throw new Error(`Release components must contain 1 through ${MAX_COMPONENTS} entries.`);
  }
  const components = value.components.map(parseReleaseComponent);
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const component of components) {
    const key = component.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Release component path is duplicated: ${component.path}`);
    seen.add(key);
    totalBytes += component.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RELEASE_BYTES) {
      throw new Error("Release component byte total exceeds its limit.");
    }
  }
  for (const componentPath of seen) {
    const segments = componentPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (seen.has(ancestor)) {
        throw new Error(
          `Release component path conflicts with a component used as a directory: ${ancestor}`,
        );
      }
    }
  }
  if (totalBytes !== value.totalBytes) throw new Error("Release totalBytes does not match component bytes.");
  const entrypointComponent = components.find((component) => component.path === entrypoint);
  if (entrypointComponent === undefined || entrypointComponent.role !== "shell") {
    throw new Error("Release entrypoint must identify a shell component.");
  }
  const manifest: ReleaseManifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: value.releaseId,
    releaseSequence: value.releaseSequence,
    version,
    channel: value.channel as ReleaseChannel,
    createdAt,
    entrypoint,
    totalBytes: value.totalBytes,
    components,
    compatibility: parseReleaseCompatibility(value.compatibility),
  };
  if (Buffer.byteLength(canonicalReleaseJson(manifest), "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("Release manifest exceeds its canonical size limit.");
  }
  return manifest;
}

function timingSafeDigestEqual(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseTrustedKey(value: TrustedReleasePublicKey): TrustedReleasePublicKey {
  assertBoundedString(value.keyId, "Trusted release key ID", 128);
  if (!RELEASE_ID_PATTERN.test(value.keyId)) throw new Error("Trusted release key ID has an invalid shape.");
  if (value.algorithm !== "ed25519") throw new Error("Only Ed25519 release keys are supported.");
  if (
    typeof value.publicKeyPem !== "string" ||
    value.publicKeyPem.length === 0 ||
    value.publicKeyPem.length > MAX_PUBLIC_KEY_CHARACTERS ||
    value.publicKeyPem.includes("\0")
  ) {
    throw new Error("Trusted release public key is invalid or exceeds its length limit.");
  }
  if (/PRIVATE KEY/iu.test(value.publicKeyPem) || !/BEGIN PUBLIC KEY/iu.test(value.publicKeyPem)) {
    throw new Error("Trusted release keys must contain public-key PEM only.");
  }
  assertSafeInteger(value.minimumReleaseSequence, "Trusted key minimum sequence", 1, Number.MAX_SAFE_INTEGER);
  if (value.maximumReleaseSequence !== null) {
    assertSafeInteger(value.maximumReleaseSequence, "Trusted key maximum sequence", 1, Number.MAX_SAFE_INTEGER);
    if (value.maximumReleaseSequence < value.minimumReleaseSequence) {
      throw new Error("Trusted release key sequence range is inverted.");
    }
  }
  if (!Array.isArray(value.allowedChannels) || value.allowedChannels.length < 1 || value.allowedChannels.length > 3) {
    throw new Error("Trusted release key must allow one through three channels.");
  }
  const allowedChannels = [...new Set(value.allowedChannels)];
  if (
    allowedChannels.length !== value.allowedChannels.length ||
    allowedChannels.some((channel) => !["stable", "beta", "development"].includes(channel))
  ) {
    throw new Error("Trusted release key channel policy is invalid.");
  }
  const key = createPublicKey(value.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Trusted release key is not Ed25519.");
  const canonicalPem = key.export({ type: "spki", format: "pem" }).toString();
  const normalizedPem = value.publicKeyPem.replace(/\r\n/gu, "\n").trim();
  if (normalizedPem !== canonicalPem.trim()) {
    throw new Error("Trusted release public key PEM must contain exactly one canonical SPKI key.");
  }
  return { ...value, publicKeyPem: canonicalPem, allowedChannels };
}

export function releaseSignaturePayload(manifestSha256: string): Buffer {
  assertSha256(manifestSha256, "Manifest SHA-256");
  return Buffer.from(`SCR-RELEASE-MANIFEST-V1\n${manifestSha256}`, "utf8");
}

export function verifySignedReleaseEnvelope(
  value: unknown,
  trustedKeys: readonly TrustedReleasePublicKey[],
): VerifiedReleaseEnvelope {
  if (!isRecord(value)) throw new Error("Release signature envelope must be an object.");
  if (value.schemaVersion !== RELEASE_SIGNATURE_SCHEMA_VERSION) {
    throw new Error("Unsigned or unsupported release signature envelope.");
  }
  assertExactKeys(value, ENVELOPE_KEYS, "Release signature envelope");
  if (value.algorithm !== "ed25519") throw new Error("Only Ed25519 release signatures are supported.");
  assertBoundedString(value.keyId, "Release signing key ID", 128);
  assertSha256(value.manifestSha256, "Release manifest SHA-256");
  assertBoundedString(value.signature, "Release signature", 256);
  if (!/^[A-Za-z0-9_-]+$/u.test(value.signature)) throw new Error("Release signature is not canonical base64url.");
  const signature = Buffer.from(value.signature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value.signature) {
    throw new Error("Ed25519 release signature must use canonical 64-byte base64url encoding.");
  }
  const manifest = parseReleaseManifest(value.manifest);
  const manifestCanonicalJson = canonicalReleaseJson(manifest);
  const manifestSha256 = releaseSha256(manifestCanonicalJson);
  if (!timingSafeDigestEqual(manifestSha256, value.manifestSha256)) {
    throw new Error("Release manifest digest does not match the signed envelope.");
  }
  if (!Array.isArray(trustedKeys) || trustedKeys.length < 1 || trustedKeys.length > MAX_TRUSTED_KEYS) {
    throw new Error(`Trusted release key registry must contain 1 through ${MAX_TRUSTED_KEYS} keys.`);
  }
  const keyIds = new Set<string>();
  const parsedKeys = trustedKeys.map((candidate) => {
    const parsed = parseTrustedKey(candidate);
    if (keyIds.has(parsed.keyId)) throw new Error(`Trusted release key ID is duplicated: ${parsed.keyId}`);
    keyIds.add(parsed.keyId);
    return parsed;
  });
  const trustedKey = parsedKeys.find((candidate) => candidate.keyId === value.keyId);
  if (trustedKey === undefined) throw new Error("Release signing key is unknown.");
  if (
    manifest.releaseSequence < trustedKey.minimumReleaseSequence ||
    (trustedKey.maximumReleaseSequence !== null &&
      manifest.releaseSequence > trustedKey.maximumReleaseSequence)
  ) {
    throw new Error("Release sequence is outside the trusted key's allowed range.");
  }
  if (!trustedKey.allowedChannels.includes(manifest.channel)) {
    throw new Error("Release channel is not allowed by the trusted signing key.");
  }
  const publicKey = createPublicKey(trustedKey.publicKeyPem);
  if (!verifySignature(null, releaseSignaturePayload(manifestSha256), publicKey, signature)) {
    throw new Error("Release signature verification failed.");
  }
  return {
    envelope: {
      schemaVersion: RELEASE_SIGNATURE_SCHEMA_VERSION,
      algorithm: "ed25519",
      keyId: value.keyId,
      manifestSha256,
      signature: value.signature,
      manifest,
    },
    manifestCanonicalJson,
    signingKeyId: trustedKey.keyId,
  };
}

export function verifyReleaseInventory(
  manifest: ReleaseManifest,
  observed: readonly ObservedReleaseComponent[],
): void {
  if (observed.length !== manifest.components.length) {
    throw new Error("Candidate payload inventory has missing or extra components.");
  }
  const observedByPath = new Map<string, ObservedReleaseComponent>();
  for (const component of observed) {
    const path = validateReleaseComponentPath(component.path);
    assertSha256(component.sha256, `Observed component ${path} SHA-256`);
    assertSafeInteger(component.bytes, `Observed component ${path} bytes`, 1, MAX_COMPONENT_BYTES);
    const key = path.toLowerCase();
    if (observedByPath.has(key)) throw new Error(`Observed component path is duplicated: ${path}`);
    observedByPath.set(key, { path, sha256: component.sha256, bytes: component.bytes });
  }
  for (const expected of manifest.components) {
    const actual = observedByPath.get(expected.path.toLowerCase());
    if (actual === undefined) throw new Error(`Candidate component is missing: ${expected.path}`);
    if (actual.path !== expected.path) {
      throw new Error(`Candidate component path casing does not match the manifest: ${expected.path}`);
    }
    if (!timingSafeDigestEqual(actual.sha256, expected.sha256)) {
      throw new Error(`Candidate component SHA-256 mismatch: ${expected.path}`);
    }
    if (actual.bytes !== expected.bytes) {
      throw new Error(`Candidate component byte length mismatch: ${expected.path}`);
    }
  }
}

export function resolveCandidateComponentPath(slotRoot: string, relativePath: string): string {
  if (
    typeof slotRoot !== "string" ||
    !/^[A-Za-z]:[\\/]/u.test(slotRoot) ||
    slotRoot.startsWith("\\\\") ||
    slotRoot.includes("\0")
  ) {
    throw new Error("Candidate slot root must be an absolute local Windows drive path.");
  }
  const component = validateReleaseComponentPath(relativePath);
  const normalizedRoot = win32.resolve(slotRoot);
  const resolved = win32.resolve(normalizedRoot, ...component.split("/"));
  const relative = win32.relative(normalizedRoot, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${win32.sep}`) ||
    win32.isAbsolute(relative)
  ) {
    throw new Error("Candidate component resolves outside its release slot.");
  }
  return resolved;
}

function schemaReadable(
  range: { readonly readableMin: number; readonly readableMax: number },
  version: number,
): boolean {
  return version >= range.readableMin && version <= range.readableMax;
}

function rollbackReadable(
  range: { readonly min: number; readonly max: number },
  version: number,
): boolean {
  return version >= range.min && version <= range.max;
}

function validateHostSchemaVersion(value: unknown, label: string): number {
  assertSafeInteger(value, label, 0, 1_000_000);
  return value;
}

function validateHostReadableRange(
  value: unknown,
  label: string,
): { readonly min: number; readonly max: number } {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, ["min", "max"], label);
  assertSafeInteger(value.min, `${label}.min`, 0, 1_000_000);
  assertSafeInteger(value.max, `${label}.max`, 0, 1_000_000);
  if (value.min > value.max) throw new Error(`${label} is inverted.`);
  return { min: value.min, max: value.max };
}

export function assertReleaseCompatibility(
  manifest: ReleaseManifest,
  host: UpdateHostCompatibility,
): void {
  parseStrictVersion(host.bootstrapVersion, "Host bootstrap version");
  assertSafeInteger(host.runtimeHostProtocolVersion, "Host Runtime Host protocol version", 1, 1_000_000);
  assertSafeInteger(host.activeReleaseSequence, "Active release sequence", 1, Number.MAX_SAFE_INTEGER);
  const currentSchemas = {
    settings: validateHostSchemaVersion(host.currentDataSchemas.settings, "Current settings schema"),
    audit: validateHostSchemaVersion(host.currentDataSchemas.audit, "Current audit schema"),
    runs: validateHostSchemaVersion(host.currentDataSchemas.runs, "Current runs schema"),
  };
  const rollbackRanges = {
    settings: validateHostReadableRange(host.lastKnownGoodReadableSchemas.settings, "Last-known-good settings range"),
    audit: validateHostReadableRange(host.lastKnownGoodReadableSchemas.audit, "Last-known-good audit range"),
    runs: validateHostReadableRange(host.lastKnownGoodReadableSchemas.runs, "Last-known-good runs range"),
  };
  for (const key of ["settings", "audit", "runs"] as const) {
    if (!rollbackReadable(rollbackRanges[key], currentSchemas[key])) {
      throw new Error(`Last-known-good cannot read the current ${key} schema version.`);
    }
  }
  if (manifest.releaseSequence <= host.activeReleaseSequence) {
    throw new Error("Candidate release sequence must be greater than the active release sequence.");
  }
  if (compareStrictVersions(host.bootstrapVersion, manifest.compatibility.minimumBootstrapVersion) < 0) {
    throw new Error("Candidate requires a newer stable bootstrap.");
  }
  if (
    manifest.compatibility.maximumBootstrapVersion !== null &&
    compareStrictVersions(host.bootstrapVersion, manifest.compatibility.maximumBootstrapVersion) > 0
  ) {
    throw new Error("Candidate does not support this stable bootstrap version.");
  }
  if (manifest.compatibility.runtimeHostProtocolVersion !== host.runtimeHostProtocolVersion) {
    throw new Error("Candidate Runtime Host protocol version is incompatible with the stable bootstrap.");
  }
  for (const key of ["settings", "audit", "runs"] as const) {
    const candidate = manifest.compatibility.dataSchemas[key];
    if (!schemaReadable(candidate, currentSchemas[key])) {
      throw new Error(`Candidate cannot read the current ${key} schema version.`);
    }
    if (!rollbackReadable(rollbackRanges[key], candidate.writeVersion)) {
      throw new Error(`Last-known-good cannot read the candidate ${key} write schema version.`);
    }
  }
}
