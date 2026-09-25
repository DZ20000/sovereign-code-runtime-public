import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_ENVELOPE_SCHEMA_VERSION =
  "scr.runtime-candidate-release-signature/v1";
const RELEASE_MANIFEST_SCHEMA_VERSION = "scr.runtime-candidate-manifest/v1";
const SIGNATURE_PAYLOAD_SCHEMA_VERSION = "scr.runtime-candidate-signature/v1";
const RUNTIME_HOST_FILE = "runtime-host.cjs";
const MAX_RUNTIME_HOST_BYTES = 256 * 1024 * 1024;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/u;

function fail(message) {
  throw new Error(message.replace(/[\0\r\n]+/gu, " ").slice(0, 1_000));
}

function parsePositiveInteger(value, label) {
  if (!/^[1-9]\d*$/u.test(value)) {
    fail(`${label} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${label} exceeds the safe integer range.`);
  }
  return parsed;
}

function requireBoundedString(value, label, maximumLength = 32_767) {
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

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer.`);
  }
  return value;
}

function normalizeCandidateOptions(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    fail("Runtime candidate options must be a plain object.");
  }
  const allowed = new Set([
    "releaseId",
    "releaseSequence",
    "runtimeHostPath",
    "privateKeyPath",
    "keyId",
    "outputPath",
    "minimumShellVersion",
    "runtimeProtocolVersion",
    "createdAtUnixMs",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail(`Unknown Runtime candidate option: ${key}`);
  }
  const releaseId = requireBoundedString(options.releaseId, "Release ID", 256);
  const keyId = requireBoundedString(options.keyId, "Signing key ID", 256);
  const minimumShellVersion = requireBoundedString(
    options.minimumShellVersion,
    "Minimum shell version",
    64,
  );
  if (!RELEASE_ID_PATTERN.test(releaseId))
    fail("Runtime candidate release ID is invalid.");
  if (!KEY_ID_PATTERN.test(keyId)) fail("Runtime candidate key ID is invalid.");
  if (!VERSION_PATTERN.test(minimumShellVersion)) {
    fail("Minimum shell version must be a stable numeric version.");
  }
  const outputPath = resolve(
    requireBoundedString(options.outputPath, "Output path"),
  );
  const outputRoot = parse(outputPath).root;
  if (outputPath === outputRoot || dirname(outputPath) === outputRoot) {
    fail(
      "Runtime candidate output may not be a filesystem root or a direct child of one.",
    );
  }
  return Object.freeze({
    releaseId,
    releaseSequence: requirePositiveSafeInteger(
      options.releaseSequence,
      "Release sequence",
    ),
    runtimeHostPath: resolve(
      requireBoundedString(options.runtimeHostPath, "Runtime Host path"),
    ),
    privateKeyPath: resolve(
      requireBoundedString(options.privateKeyPath, "Ed25519 private-key path"),
    ),
    keyId,
    outputPath,
    minimumShellVersion,
    runtimeProtocolVersion: requirePositiveSafeInteger(
      options.runtimeProtocolVersion,
      "Runtime protocol version",
    ),
    createdAtUnixMs: requirePositiveSafeInteger(
      options.createdAtUnixMs ?? Date.now(),
      "Creation timestamp",
    ),
  });
}

function parseArguments(argv) {
  const allowed = new Set([
    "--release-id",
    "--release-sequence",
    "--runtime-host",
    "--private-key",
    "--key-id",
    "--output",
    "--minimum-shell-version",
    "--runtime-protocol-version",
    "--created-at-unix-ms",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== "string" || !allowed.has(flag)) {
      fail(`Unknown Runtime candidate argument: ${String(flag)}`);
    }
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      fail(`Runtime candidate argument has no value: ${flag}`);
    }
    if (values.has(flag)) {
      fail(`Runtime candidate argument is duplicated: ${flag}`);
    }
    values.set(flag, value);
  }
  if (argv.length % 2 !== 0) {
    fail("Runtime candidate arguments must be flag/value pairs.");
  }
  const required = [
    "--release-id",
    "--release-sequence",
    "--runtime-host",
    "--private-key",
    "--key-id",
    "--output",
    "--minimum-shell-version",
    "--runtime-protocol-version",
  ];
  for (const flag of required) {
    if (!values.has(flag)) fail(`Missing Runtime candidate argument: ${flag}`);
  }
  const releaseId = values.get("--release-id");
  const keyId = values.get("--key-id");
  const minimumShellVersion = values.get("--minimum-shell-version");
  if (!RELEASE_ID_PATTERN.test(releaseId))
    fail("Runtime candidate release ID is invalid.");
  if (!KEY_ID_PATTERN.test(keyId)) fail("Runtime candidate key ID is invalid.");
  if (!VERSION_PATTERN.test(minimumShellVersion)) {
    fail("Minimum shell version must be a stable numeric version.");
  }
  return {
    releaseId,
    releaseSequence: parsePositiveInteger(
      values.get("--release-sequence"),
      "Release sequence",
    ),
    runtimeHostPath: resolve(values.get("--runtime-host")),
    privateKeyPath: resolve(values.get("--private-key")),
    keyId,
    outputPath: resolve(values.get("--output")),
    minimumShellVersion,
    runtimeProtocolVersion: parsePositiveInteger(
      values.get("--runtime-protocol-version"),
      "Runtime protocol version",
    ),
    createdAtUnixMs: values.has("--created-at-unix-ms")
      ? parsePositiveInteger(
          values.get("--created-at-unix-ms"),
          "Creation timestamp",
        )
      : Date.now(),
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function directFile(path, maximumBytes, label) {
  const metadata = await lstat(path).catch((error) => {
    fail(`${label} is unavailable: ${error.code ?? "FS_ERROR"}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a direct regular file.`);
  }
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    fail(`${label} is outside its size bound.`);
  }
  return metadata;
}

async function cleanupOwnedStaging(staging, outputPath) {
  const stagingName = basename(staging);
  const expectedPrefix = `.${basename(outputPath)}.${process.pid}.`;
  if (
    dirname(staging) !== dirname(outputPath) ||
    !stagingName.startsWith(expectedPrefix) ||
    !stagingName.endsWith(".tmp")
  ) {
    return;
  }
  const metadata = await lstat(staging).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink())
    return;
  await rm(staging, {
    recursive: true,
    force: true,
    maxRetries: 0,
    retryDelay: 0,
  });
}

async function loadPrivateKey(path) {
  const metadata = await directFile(path, 1024 * 1024, "Ed25519 private key");
  const bytes = await readFile(path);
  try {
    if (bytes.byteLength !== metadata.size)
      fail("Private key changed while reading.");
    let key;
    try {
      key = createPrivateKey(bytes);
    } catch {
      try {
        key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
      } catch {
        fail("Private key is not a supported PKCS#8 Ed25519 key.");
      }
    }
    if (key.asymmetricKeyType !== "ed25519") {
      fail("Private key must be Ed25519.");
    }
    return key;
  } finally {
    bytes.fill(0);
  }
}

export async function createRuntimeCandidate(options) {
  const candidate = normalizeCandidateOptions(options);
  const runtimeMetadata = await directFile(
    candidate.runtimeHostPath,
    MAX_RUNTIME_HOST_BYTES,
    "Runtime Host bundle",
  );
  const runtimeBytes = await readFile(candidate.runtimeHostPath);
  if (runtimeBytes.byteLength !== runtimeMetadata.size) {
    fail("Runtime Host bundle changed while reading.");
  }
  const key = await loadPrivateKey(candidate.privateKeyPath);
  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: candidate.releaseId,
    releaseSequence: candidate.releaseSequence,
    createdAtUnixMs: candidate.createdAtUnixMs,
    minimumShellVersion: candidate.minimumShellVersion,
    runtimeProtocolVersion: candidate.runtimeProtocolVersion,
    component: {
      path: RUNTIME_HOST_FILE,
      size: runtimeBytes.byteLength,
      sha256: sha256(runtimeBytes),
    },
  };
  const manifestCanonical = canonicalJson(manifest);
  const manifestSha256 = sha256(Buffer.from(manifestCanonical, "utf8"));
  const payload = Buffer.from(
    `${SIGNATURE_PAYLOAD_SCHEMA_VERSION}\n${manifestSha256}`,
    "utf8",
  );
  const signature = sign(null, payload, key).toString("base64url");
  const envelope = {
    schemaVersion: RELEASE_ENVELOPE_SCHEMA_VERSION,
    algorithm: "ed25519",
    keyId: candidate.keyId,
    manifestSha256,
    manifest,
    signature,
  };
  const parent = dirname(candidate.outputPath);
  await mkdir(parent, { recursive: true });
  const outputExists = await lstat(candidate.outputPath).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (outputExists) fail("Runtime candidate output path already exists.");
  const staging = resolve(
    parent,
    `.${basename(candidate.outputPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await mkdir(staging, { recursive: false });
    await copyFile(
      candidate.runtimeHostPath,
      resolve(staging, RUNTIME_HOST_FILE),
    );
    await writeFile(
      resolve(staging, "envelope.json"),
      Buffer.from(canonicalJson(envelope), "utf8"),
      { flag: "wx" },
    );
    const copied = await readFile(resolve(staging, RUNTIME_HOST_FILE));
    if (
      copied.byteLength !== runtimeBytes.byteLength ||
      sha256(copied) !== manifest.component.sha256
    ) {
      fail("Staged Runtime Host bundle did not preserve its signed digest.");
    }
    await rename(staging, candidate.outputPath);
  } catch (error) {
    await cleanupOwnedStaging(staging, candidate.outputPath).catch(
      () => undefined,
    );
    throw error;
  }
  return {
    releaseId: candidate.releaseId,
    releaseSequence: candidate.releaseSequence,
    outputPath: candidate.outputPath,
    runtimeHostBytes: runtimeBytes.byteLength,
    manifestSha256,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await createRuntimeCandidate(options);
  process.stdout.write(
    `${JSON.stringify({
      releaseId: result.releaseId,
      releaseSequence: result.releaseSequence,
      runtimeHostBytes: result.runtimeHostBytes,
      manifestSha256: result.manifestSha256,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `Runtime candidate packaging failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
