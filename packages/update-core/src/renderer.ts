import {
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

import {
  canonicalReleaseJson,
  releaseSha256,
  validateReleaseComponentPath,
  type ReleaseChannel,
  type TrustedReleasePublicKey,
} from "./manifest.js";

export const RENDERER_MANIFEST_SCHEMA_VERSION = "scr.renderer-release/v1" as const;
export const RENDERER_SIGNATURE_SCHEMA_VERSION =
  "scr.renderer-release-signature/v1" as const;
export const RENDERER_TRUSTED_KEYS_SCHEMA_VERSION =
  "scr.renderer-trusted-keys/v1" as const;

const MAX_COMPONENTS = 256;
const MAX_COMPONENT_BYTES = 32 * 1024 * 1024;
const MAX_RENDERER_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PUBLIC_KEY_CHARACTERS = 16 * 1024;
const MAX_TRUSTED_KEYS = 64;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_CREATED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

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
const COMPONENT_KEYS = ["path", "sha256", "bytes"] as const;
const COMPATIBILITY_KEYS = [
  "minimumShellVersion",
  "maximumShellVersion",
  "bridgeApiVersion",
] as const;
const TRUST_REGISTRY_KEYS = ["schemaVersion", "keys"] as const;
const TRUSTED_KEY_KEYS = [
  "keyId",
  "algorithm",
  "publicKeyPem",
  "minimumReleaseSequence",
  "maximumReleaseSequence",
  "allowedChannels",
] as const;

export interface RendererReleaseComponent {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RendererReleaseCompatibility {
  readonly minimumShellVersion: string;
  readonly maximumShellVersion: string | null;
  readonly bridgeApiVersion: number;
}

export interface RendererReleaseManifest {
  readonly schemaVersion: typeof RENDERER_MANIFEST_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly createdAt: string;
  readonly entrypoint: "index.html";
  readonly totalBytes: number;
  readonly components: readonly RendererReleaseComponent[];
  readonly compatibility: RendererReleaseCompatibility;
}

export interface RendererReleaseSignatureEnvelope {
  readonly schemaVersion: typeof RENDERER_SIGNATURE_SCHEMA_VERSION;
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly manifestSha256: string;
  readonly signature: string;
  readonly manifest: RendererReleaseManifest;
}

export interface RendererTrustedKeyRegistry {
  readonly schemaVersion: typeof RENDERER_TRUSTED_KEYS_SCHEMA_VERSION;
  readonly keys: readonly TrustedReleasePublicKey[];
}

export interface VerifiedRendererReleaseEnvelope {
  readonly envelope: RendererReleaseSignatureEnvelope;
  readonly manifestCanonicalJson: string;
  readonly signingKeyId: string;
}

export interface ObservedRendererComponent {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RendererHostCompatibility {
  readonly shellVersion: string;
  readonly bridgeApiVersion: number;
  readonly highestReleaseSequence: number;
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
  for (const key of Object.keys(value)) {
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

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function parseStrictVersion(value: unknown, label: string): string {
  assertBoundedString(value, label, 64);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (match === null) {
    throw new Error(`${label} must use canonical major.minor.patch form.`);
  }
  for (const component of match.slice(1)) {
    const numeric = Number(component);
    if (!Number.isSafeInteger(numeric)) {
      throw new Error(`${label} contains an unsafe numeric component.`);
    }
  }
  return value;
}

function compareStrictVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

function parseCreatedAt(value: unknown): string {
  assertBoundedString(value, "Renderer release createdAt", 64);
  if (!CANONICAL_CREATED_AT_PATTERN.test(value)) {
    throw new Error("Renderer release createdAt must be canonical UTC ISO-8601.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("Renderer release createdAt is not a real canonical timestamp.");
  }
  return value;
}

function parseChannel(value: unknown): ReleaseChannel {
  if (value !== "stable" && value !== "beta" && value !== "development") {
    throw new Error("Renderer release channel is invalid.");
  }
  return value;
}

export function validateRendererComponentPath(value: unknown): string {
  const path = validateReleaseComponentPath(value);
  if (path.split("/")[0]?.toLowerCase() === ".scr-renderer") {
    throw new Error("Renderer component path uses the reserved .scr-renderer root.");
  }
  return path;
}

function parseRendererComponent(value: unknown): RendererReleaseComponent {
  if (!isRecord(value)) {
    throw new Error("Renderer release component must be an object.");
  }
  assertExactKeys(value, COMPONENT_KEYS, "Renderer release component");
  const path = validateRendererComponentPath(value.path);
  assertSha256(value.sha256, `Renderer component ${path} SHA-256`);
  assertSafeInteger(
    value.bytes,
    `Renderer component ${path} bytes`,
    1,
    MAX_COMPONENT_BYTES,
  );
  return { path, sha256: value.sha256, bytes: value.bytes };
}

function parseRendererCompatibility(value: unknown): RendererReleaseCompatibility {
  if (!isRecord(value)) {
    throw new Error("Renderer release compatibility must be an object.");
  }
  assertExactKeys(value, COMPATIBILITY_KEYS, "Renderer release compatibility");
  const minimumShellVersion = parseStrictVersion(
    value.minimumShellVersion,
    "Minimum renderer shell version",
  );
  let maximumShellVersion: string | null = null;
  if (value.maximumShellVersion !== null) {
    maximumShellVersion = parseStrictVersion(
      value.maximumShellVersion,
      "Maximum renderer shell version",
    );
    if (compareStrictVersions(minimumShellVersion, maximumShellVersion) > 0) {
      throw new Error("Renderer shell compatibility range is inverted.");
    }
  }
  assertSafeInteger(
    value.bridgeApiVersion,
    "Renderer bridge API version",
    1,
    1_000_000,
  );
  return {
    minimumShellVersion,
    maximumShellVersion,
    bridgeApiVersion: value.bridgeApiVersion,
  };
}

export function parseRendererReleaseManifest(value: unknown): RendererReleaseManifest {
  if (!isRecord(value)) {
    throw new Error("Renderer release manifest must be an object.");
  }
  assertExactKeys(value, MANIFEST_KEYS, "Renderer release manifest");
  if (value.schemaVersion !== RENDERER_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Unsupported renderer release manifest schema version.");
  }
  assertBoundedString(value.releaseId, "Renderer release ID", 128);
  if (!IDENTIFIER_PATTERN.test(value.releaseId)) {
    throw new Error("Renderer release ID has an invalid shape.");
  }
  assertSafeInteger(
    value.releaseSequence,
    "Renderer release sequence",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const version = parseStrictVersion(value.version, "Renderer release version");
  const channel = parseChannel(value.channel);
  const createdAt = parseCreatedAt(value.createdAt);
  if (value.entrypoint !== "index.html") {
    throw new Error("Renderer entrypoint must be index.html.");
  }
  assertSafeInteger(
    value.totalBytes,
    "Renderer release totalBytes",
    1,
    MAX_RENDERER_BYTES,
  );
  if (
    !Array.isArray(value.components) ||
    value.components.length < 1 ||
    value.components.length > MAX_COMPONENTS
  ) {
    throw new Error(
      `Renderer release components must contain 1 through ${MAX_COMPONENTS} entries.`,
    );
  }
  const components = value.components.map(parseRendererComponent);
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const component of components) {
    const key = component.path.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Renderer component path is duplicated: ${component.path}`);
    }
    seen.add(key);
    totalBytes += component.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RENDERER_BYTES) {
      throw new Error("Renderer component byte total exceeds its limit.");
    }
  }
  for (const componentPath of seen) {
    const segments = componentPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (seen.has(ancestor)) {
        throw new Error(
          `Renderer component path conflicts with a component used as a directory: ${ancestor}`,
        );
      }
    }
  }
  if (!seen.has("index.html")) {
    throw new Error("Renderer release does not contain its index.html entrypoint.");
  }
  if (totalBytes !== value.totalBytes) {
    throw new Error("Renderer totalBytes does not match component bytes.");
  }
  const manifest: RendererReleaseManifest = {
    schemaVersion: RENDERER_MANIFEST_SCHEMA_VERSION,
    releaseId: value.releaseId,
    releaseSequence: value.releaseSequence,
    version,
    channel,
    createdAt,
    entrypoint: "index.html",
    totalBytes: value.totalBytes,
    components,
    compatibility: parseRendererCompatibility(value.compatibility),
  };
  if (
    Buffer.byteLength(canonicalRendererJson(manifest), "utf8") >
    MAX_MANIFEST_BYTES
  ) {
    throw new Error("Renderer release manifest exceeds its canonical size limit.");
  }
  return manifest;
}

export function canonicalRendererJson(value: unknown): string {
  return canonicalReleaseJson(value);
}

export function rendererSha256(value: string | Uint8Array): string {
  return releaseSha256(value);
}

export function rendererSignaturePayload(manifestSha256: string): Buffer {
  assertSha256(manifestSha256, "Renderer manifest SHA-256");
  return Buffer.from(`SCR-RENDERER-MANIFEST-V1\n${manifestSha256}`, "utf8");
}

function timingSafeDigestEqual(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseTrustedKey(value: unknown): TrustedReleasePublicKey {
  if (!isRecord(value)) {
    throw new Error("Trusted renderer key must be an object.");
  }
  assertExactKeys(value, TRUSTED_KEY_KEYS, "Trusted renderer key");
  assertBoundedString(value.keyId, "Trusted renderer key ID", 128);
  if (!IDENTIFIER_PATTERN.test(value.keyId)) {
    throw new Error("Trusted renderer key ID has an invalid shape.");
  }
  if (value.algorithm !== "ed25519") {
    throw new Error("Only Ed25519 renderer keys are supported.");
  }
  if (
    typeof value.publicKeyPem !== "string" ||
    value.publicKeyPem.length === 0 ||
    value.publicKeyPem.length > MAX_PUBLIC_KEY_CHARACTERS ||
    value.publicKeyPem.includes("\0")
  ) {
    throw new Error("Trusted renderer public key is invalid or exceeds its limit.");
  }
  if (/PRIVATE KEY/iu.test(value.publicKeyPem) || !/BEGIN PUBLIC KEY/iu.test(value.publicKeyPem)) {
    throw new Error("Trusted renderer keys must contain public-key PEM only.");
  }
  assertSafeInteger(
    value.minimumReleaseSequence,
    "Trusted renderer key minimum sequence",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (value.maximumReleaseSequence !== null) {
    assertSafeInteger(
      value.maximumReleaseSequence,
      "Trusted renderer key maximum sequence",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (value.maximumReleaseSequence < value.minimumReleaseSequence) {
      throw new Error("Trusted renderer key sequence range is inverted.");
    }
  }
  if (
    !Array.isArray(value.allowedChannels) ||
    value.allowedChannels.length < 1 ||
    value.allowedChannels.length > 3
  ) {
    throw new Error("Trusted renderer key must allow one through three channels.");
  }
  const allowedChannels = [...new Set(value.allowedChannels)];
  if (
    allowedChannels.length !== value.allowedChannels.length ||
    allowedChannels.some(
      (channel) =>
        channel !== "stable" && channel !== "beta" && channel !== "development",
    )
  ) {
    throw new Error("Trusted renderer key channel policy is invalid.");
  }
  const key = createPublicKey(value.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Trusted renderer key is not Ed25519.");
  }
  const canonicalPem = key.export({ type: "spki", format: "pem" }).toString();
  const normalizedPem = value.publicKeyPem.replace(/\r\n/gu, "\n").trim();
  if (normalizedPem !== canonicalPem.trim()) {
    throw new Error(
      "Trusted renderer public key PEM must contain exactly one canonical SPKI key.",
    );
  }
  return {
    keyId: value.keyId,
    algorithm: "ed25519",
    publicKeyPem: canonicalPem,
    minimumReleaseSequence: value.minimumReleaseSequence,
    maximumReleaseSequence: value.maximumReleaseSequence,
    allowedChannels: allowedChannels as ReleaseChannel[],
  };
}

export function parseRendererTrustedKeyRegistry(value: unknown): RendererTrustedKeyRegistry {
  if (!isRecord(value)) {
    throw new Error("Renderer trusted-key registry must be an object.");
  }
  assertExactKeys(value, TRUST_REGISTRY_KEYS, "Renderer trusted-key registry");
  if (value.schemaVersion !== RENDERER_TRUSTED_KEYS_SCHEMA_VERSION) {
    throw new Error("Unsupported renderer trusted-key registry schema version.");
  }
  if (!Array.isArray(value.keys) || value.keys.length > MAX_TRUSTED_KEYS) {
    throw new Error(
      `Renderer trusted-key registry must contain zero through ${MAX_TRUSTED_KEYS} keys.`,
    );
  }
  const keyIds = new Set<string>();
  const keys = value.keys.map((candidate) => {
    const parsed = parseTrustedKey(candidate);
    if (keyIds.has(parsed.keyId)) {
      throw new Error(`Trusted renderer key ID is duplicated: ${parsed.keyId}`);
    }
    keyIds.add(parsed.keyId);
    return parsed;
  });
  return {
    schemaVersion: RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
    keys,
  };
}

export function verifySignedRendererReleaseEnvelope(
  value: unknown,
  trustedKeys: readonly TrustedReleasePublicKey[],
): VerifiedRendererReleaseEnvelope {
  if (!isRecord(value)) {
    throw new Error("Renderer signature envelope must be an object.");
  }
  if (value.schemaVersion !== RENDERER_SIGNATURE_SCHEMA_VERSION) {
    throw new Error("Unsigned or unsupported renderer signature envelope.");
  }
  assertExactKeys(value, ENVELOPE_KEYS, "Renderer signature envelope");
  if (value.algorithm !== "ed25519") {
    throw new Error("Only Ed25519 renderer signatures are supported.");
  }
  assertBoundedString(value.keyId, "Renderer signing key ID", 128);
  assertSha256(value.manifestSha256, "Renderer manifest SHA-256");
  assertBoundedString(value.signature, "Renderer signature", 256);
  if (!/^[A-Za-z0-9_-]+$/u.test(value.signature)) {
    throw new Error("Renderer signature is not canonical base64url.");
  }
  const signature = Buffer.from(value.signature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value.signature) {
    throw new Error(
      "Ed25519 renderer signature must use canonical 64-byte base64url encoding.",
    );
  }
  const manifest = parseRendererReleaseManifest(value.manifest);
  const manifestCanonicalJson = canonicalRendererJson(manifest);
  const manifestSha256 = rendererSha256(manifestCanonicalJson);
  if (!timingSafeDigestEqual(manifestSha256, value.manifestSha256)) {
    throw new Error("Renderer manifest digest does not match the signed envelope.");
  }
  if (
    !Array.isArray(trustedKeys) ||
    trustedKeys.length < 1 ||
    trustedKeys.length > MAX_TRUSTED_KEYS
  ) {
    throw new Error(
      `Trusted renderer key registry must contain 1 through ${MAX_TRUSTED_KEYS} keys.`,
    );
  }
  const keyIds = new Set<string>();
  const parsedKeys = trustedKeys.map((candidate) => {
    const parsed = parseTrustedKey(candidate);
    if (keyIds.has(parsed.keyId)) {
      throw new Error(`Trusted renderer key ID is duplicated: ${parsed.keyId}`);
    }
    keyIds.add(parsed.keyId);
    return parsed;
  });
  const trustedKey = parsedKeys.find((candidate) => candidate.keyId === value.keyId);
  if (trustedKey === undefined) {
    throw new Error("Renderer signing key is unknown.");
  }
  if (
    manifest.releaseSequence < trustedKey.minimumReleaseSequence ||
    (trustedKey.maximumReleaseSequence !== null &&
      manifest.releaseSequence > trustedKey.maximumReleaseSequence)
  ) {
    throw new Error("Renderer sequence is outside the trusted key's allowed range.");
  }
  if (!trustedKey.allowedChannels.includes(manifest.channel)) {
    throw new Error("Renderer channel is not allowed by the trusted signing key.");
  }
  const publicKey = createPublicKey(trustedKey.publicKeyPem);
  if (
    !verifySignature(
      null,
      rendererSignaturePayload(manifestSha256),
      publicKey,
      signature,
    )
  ) {
    throw new Error("Renderer signature verification failed.");
  }
  return {
    envelope: {
      schemaVersion: RENDERER_SIGNATURE_SCHEMA_VERSION,
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

export function verifyRendererInventory(
  manifest: RendererReleaseManifest,
  observed: readonly ObservedRendererComponent[],
): void {
  if (observed.length !== manifest.components.length) {
    throw new Error("Renderer payload inventory has missing or extra components.");
  }
  const observedByPath = new Map<string, ObservedRendererComponent>();
  for (const component of observed) {
    const path = validateRendererComponentPath(component.path);
    assertSha256(component.sha256, `Observed renderer component ${path} SHA-256`);
    assertSafeInteger(
      component.bytes,
      `Observed renderer component ${path} bytes`,
      1,
      MAX_COMPONENT_BYTES,
    );
    const key = path.toLowerCase();
    if (observedByPath.has(key)) {
      throw new Error(`Observed renderer component path is duplicated: ${path}`);
    }
    observedByPath.set(key, { path, sha256: component.sha256, bytes: component.bytes });
  }
  for (const expected of manifest.components) {
    const actual = observedByPath.get(expected.path.toLowerCase());
    if (actual === undefined || actual.path !== expected.path) {
      throw new Error(`Renderer component inventory path mismatch: ${expected.path}`);
    }
    if (!timingSafeDigestEqual(actual.sha256, expected.sha256)) {
      throw new Error(`Renderer component SHA-256 mismatch: ${expected.path}`);
    }
    if (actual.bytes !== expected.bytes) {
      throw new Error(`Renderer component byte length mismatch: ${expected.path}`);
    }
  }
}

export function assertRendererCompatibility(
  manifest: RendererReleaseManifest,
  host: RendererHostCompatibility,
): void {
  const shellVersion = parseStrictVersion(host.shellVersion, "Host shell version");
  assertSafeInteger(
    host.bridgeApiVersion,
    "Host renderer bridge API version",
    1,
    1_000_000,
  );
  assertSafeInteger(
    host.highestReleaseSequence,
    "Highest accepted renderer release sequence",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    compareStrictVersions(
      shellVersion,
      manifest.compatibility.minimumShellVersion,
    ) < 0
  ) {
    throw new Error("Renderer release requires a newer stable shell.");
  }
  if (
    manifest.compatibility.maximumShellVersion !== null &&
    compareStrictVersions(
      shellVersion,
      manifest.compatibility.maximumShellVersion,
    ) > 0
  ) {
    throw new Error("Renderer release does not support this stable shell version.");
  }
  if (manifest.compatibility.bridgeApiVersion !== host.bridgeApiVersion) {
    throw new Error("Renderer bridge API version is incompatible with the stable shell.");
  }
  if (manifest.releaseSequence <= host.highestReleaseSequence) {
    throw new Error("Renderer release sequence must be newer than every previously accepted renderer.");
  }
}

export function createRendererReleaseManifest(input: {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly createdAt: string;
  readonly components: readonly RendererReleaseComponent[];
  readonly minimumShellVersion: string;
  readonly maximumShellVersion: string | null;
  readonly bridgeApiVersion: number;
}): RendererReleaseManifest {
  return parseRendererReleaseManifest({
    schemaVersion: RENDERER_MANIFEST_SCHEMA_VERSION,
    releaseId: input.releaseId,
    releaseSequence: input.releaseSequence,
    version: input.version,
    channel: input.channel,
    createdAt: input.createdAt,
    entrypoint: "index.html",
    totalBytes: input.components.reduce((total, component) => total + component.bytes, 0),
    components: input.components,
    compatibility: {
      minimumShellVersion: input.minimumShellVersion,
      maximumShellVersion: input.maximumShellVersion,
      bridgeApiVersion: input.bridgeApiVersion,
    },
  });
}

export function rendererManifestDigest(manifest: RendererReleaseManifest): string {
  return rendererSha256(canonicalRendererJson(parseRendererReleaseManifest(manifest)));
}