#!/usr/bin/env node

import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  directDirectory,
  fail,
  isContained,
  loadRuntimeCandidateTrustedKeys,
  readCanonicalJsonFile,
  verifyRuntimeCandidatePackage,
} from "./runtime-host-release-index-format.mjs";

const STATE_SCHEMA_VERSION = "scr.runtime-candidate-update-state/v1";
const AUDIT_SCHEMA_VERSION = "scr.runtime-candidate-managed-audit/v1";
const MAX_STATE_BYTES = 512 * 1024;
const MAX_INSTALLED_RELEASES = 128;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a plain object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has an unsupported field set.`);
  }
}

function boundedString(value, label, maximumLength = 4_096) {
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

function identifier(value, label, pattern = IDENTIFIER_PATTERN) {
  const normalized = boundedString(value, label, 256);
  if (!pattern.test(normalized)) fail(`${label} is invalid.`);
  return normalized;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function digest(value, label) {
  const normalized = boundedString(value, label, 64);
  if (!SHA256_PATTERN.test(normalized))
    fail(`${label} must be lowercase SHA-256.`);
  return normalized;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function directChildDirectory(root, name, label) {
  const path = resolve(root.path, name);
  if (dirname(path) !== root.path)
    fail(`${label} is not a direct managed child.`);
  const directory = await directDirectory(path, label, {
    requireCanonicalPath: true,
  });
  if (!isContained(root.canonical, directory.canonical)) {
    fail(`${label} escaped the managed update root.`);
  }
  return directory;
}

function parseInstalled(raw, index) {
  const label = `Runtime candidate state installed entry ${index}`;
  const value = plainObject(raw, label);
  exactKeys(
    value,
    [
      "releaseId",
      "releaseSequence",
      "signingKeyId",
      "manifestSha256",
      "runtimeHostSha256",
      "runtimeHostSize",
      "installedAtUnixMs",
    ],
    label,
  );
  return Object.freeze({
    releaseId: identifier(
      value.releaseId,
      `${label} release ID`,
      RELEASE_ID_PATTERN,
    ),
    releaseSequence: positiveSafeInteger(
      value.releaseSequence,
      `${label} release sequence`,
    ),
    signingKeyId: identifier(value.signingKeyId, `${label} signing key ID`),
    manifestSha256: digest(value.manifestSha256, `${label} manifest digest`),
    runtimeHostSha256: digest(
      value.runtimeHostSha256,
      `${label} Runtime Host digest`,
    ),
    runtimeHostSize: positiveSafeInteger(
      value.runtimeHostSize,
      `${label} Runtime Host size`,
    ),
    installedAtUnixMs: positiveSafeInteger(
      value.installedAtUnixMs,
      `${label} install time`,
    ),
  });
}

function parseState(raw) {
  const value = plainObject(raw, "Runtime candidate managed state");
  exactKeys(
    value,
    [
      "schemaVersion",
      "highestReleaseSequence",
      "activeReleaseId",
      "installed",
      "lastFailure",
    ],
    "Runtime candidate managed state",
  );
  if (value.schemaVersion !== STATE_SCHEMA_VERSION)
    fail("Runtime candidate state schema is unsupported.");
  if (
    !Array.isArray(value.installed) ||
    value.installed.length > MAX_INSTALLED_RELEASES
  ) {
    fail("Runtime candidate state has an invalid installed inventory.");
  }
  const installed = value.installed.map(parseInstalled);
  const ids = new Set();
  let previousSequence = 0;
  for (const release of installed) {
    if (ids.has(release.releaseId))
      fail("Runtime candidate state duplicates a release ID.");
    if (release.releaseSequence <= previousSequence) {
      fail(
        "Runtime candidate state releases are not strictly sequence-sorted.",
      );
    }
    ids.add(release.releaseId);
    previousSequence = release.releaseSequence;
  }
  const highestReleaseSequence = nonNegativeSafeInteger(
    value.highestReleaseSequence,
    "Runtime candidate highest release sequence",
  );
  if (highestReleaseSequence < previousSequence)
    fail("Runtime candidate state sequence regressed.");
  const activeReleaseId =
    value.activeReleaseId === null
      ? null
      : identifier(
          value.activeReleaseId,
          "Runtime candidate active release ID",
          RELEASE_ID_PATTERN,
        );
  if (activeReleaseId !== null && !ids.has(activeReleaseId)) {
    fail("Runtime candidate active release is not installed.");
  }
  if (
    value.lastFailure !== null &&
    (typeof value.lastFailure !== "string" ||
      value.lastFailure.length === 0 ||
      value.lastFailure.length > 512 ||
      /[\0\r\n]/u.test(value.lastFailure))
  ) {
    fail("Runtime candidate last-failure fingerprint is invalid.");
  }
  return Object.freeze({
    highestReleaseSequence,
    activeReleaseId,
    installed,
    lastFailure: value.lastFailure,
  });
}

async function inventory(root, label) {
  const entries = await readdir(root.path, { withFileTypes: true });
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail(`${label} contains an unexpected entry.`);
    }
    ids.push(identifier(entry.name, `${label} release ID`, RELEASE_ID_PATTERN));
  }
  ids.sort();
  if (new Set(ids).size !== ids.length)
    fail(`${label} duplicates a release ID.`);
  return ids;
}

export async function auditManagedRuntimeCandidateState(rawOptions) {
  const value = plainObject(
    rawOptions,
    "Runtime candidate managed-audit options",
  );
  exactKeys(
    value,
    [
      "managedRoot",
      "runtimeTrustedKeysPath",
      "shellVersion",
      "runtimeProtocolVersion",
    ],
    "Runtime candidate managed-audit options",
  );
  const options = Object.freeze({
    managedRoot: boundedString(value.managedRoot, "Managed update root"),
    runtimeTrustedKeysPath: boundedString(
      value.runtimeTrustedKeysPath,
      "Runtime candidate trusted-key path",
    ),
    shellVersion: boundedString(
      value.shellVersion,
      "Current shell version",
      64,
    ),
    runtimeProtocolVersion: positiveSafeInteger(
      value.runtimeProtocolVersion,
      "Current Runtime protocol version",
    ),
  });
  const managedRoot = await directDirectory(
    options.managedRoot,
    "Managed Runtime candidate update root",
    { shallow: true, requireCanonicalPath: true },
  );
  const inboxRoot = await directChildDirectory(
    managedRoot,
    "inbox",
    "Managed Runtime candidate inbox",
  );
  const slotsRoot = await directChildDirectory(
    managedRoot,
    "slots",
    "Managed Runtime candidate slots",
  );
  const receiptRootPath = join(managedRoot.path, "import-receipts");
  if (
    (await exists(receiptRootPath)) &&
    (await exists(join(receiptRootPath, ".import-lock")))
  ) {
    fail(
      "Runtime candidate managed audit is unavailable while a release-index import lock exists.",
    );
  }
  const statePath = join(managedRoot.path, "state.json");
  const stateBackupPresent = await exists(`${statePath}.backup`);
  let state = Object.freeze({
    highestReleaseSequence: 0,
    activeReleaseId: null,
    installed: [],
    lastFailure: null,
  });
  if (await exists(statePath)) {
    const stateFile = await readCanonicalJsonFile(
      statePath,
      "Runtime candidate managed state",
      MAX_STATE_BYTES,
    );
    if (!isContained(managedRoot.canonical, stateFile.canonical)) {
      fail("Runtime candidate state escaped the managed update root.");
    }
    state = parseState(stateFile.document);
  } else if (stateBackupPresent) {
    fail("Runtime candidate primary state is missing while a backup exists.");
  }
  const trustedKeys = await loadRuntimeCandidateTrustedKeys(
    options.runtimeTrustedKeysPath,
  );
  if (state.installed.length > 0 && trustedKeys.size === 0) {
    fail("No trusted Runtime candidate signing keys are provisioned.");
  }

  const slotIds = await inventory(slotsRoot, "Managed Runtime candidate slots");
  const installedIds = state.installed
    .map((release) => release.releaseId)
    .sort();
  if (
    slotIds.length !== installedIds.length ||
    slotIds.some((id, index) => id !== installedIds[index])
  ) {
    fail("Runtime candidate state and slot inventory disagree.");
  }

  const verifiedSlots = new Map();
  for (const release of state.installed) {
    const candidate = await verifyRuntimeCandidatePackage({
      packageRoot: join(slotsRoot.path, release.releaseId),
      trustedKeys,
      shellVersion: options.shellVersion,
      runtimeProtocolVersion: options.runtimeProtocolVersion,
    });
    if (
      candidate.releaseId !== release.releaseId ||
      candidate.releaseSequence !== release.releaseSequence ||
      candidate.signingKeyId !== release.signingKeyId ||
      candidate.manifestSha256 !== release.manifestSha256 ||
      candidate.runtimeHostSha256 !== release.runtimeHostSha256 ||
      candidate.runtimeHostBytes !== release.runtimeHostSize
    ) {
      fail("Runtime candidate slot does not match its managed state entry.");
    }
    verifiedSlots.set(release.releaseId, candidate);
  }

  const inboxIds = await inventory(
    inboxRoot,
    "Managed Runtime candidate inbox",
  );
  for (const id of inboxIds) {
    const candidate = await verifyRuntimeCandidatePackage({
      packageRoot: join(inboxRoot.path, id),
      trustedKeys,
      shellVersion: options.shellVersion,
      runtimeProtocolVersion: options.runtimeProtocolVersion,
    });
    const installed = verifiedSlots.get(id);
    if (
      installed !== undefined &&
      (candidate.releaseSequence !== installed.releaseSequence ||
        candidate.signingKeyId !== installed.signingKeyId ||
        candidate.manifestSha256 !== installed.manifestSha256 ||
        candidate.runtimeHostSha256 !== installed.runtimeHostSha256 ||
        candidate.runtimeHostBytes !== installed.runtimeHostBytes)
    ) {
      fail("Runtime candidate inbox and installed slot identities disagree.");
    }
  }

  return Object.freeze({
    schemaVersion: AUDIT_SCHEMA_VERSION,
    consistent: true,
    highestReleaseSequence: state.highestReleaseSequence,
    activeReleaseId: state.activeReleaseId,
    installedReleaseIds: installedIds,
    inboxReleaseIds: inboxIds,
    stateBackupPresent,
  });
}

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set([
    "--managed-root",
    "--runtime-trust",
    "--shell-version",
    "--runtime-protocol-version",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.has(flag))
      fail(`Unknown Runtime candidate audit argument: ${flag}`);
    if (values.has(flag))
      fail(`Duplicate Runtime candidate audit argument: ${flag}`);
    const next = argv[index + 1];
    if (
      typeof next !== "string" ||
      next.length === 0 ||
      next.startsWith("--")
    ) {
      fail(`Runtime candidate audit argument has no value: ${flag}`);
    }
    values.set(flag, next);
    index += 1;
  }
  for (const flag of flags) {
    if (!values.has(flag))
      fail(`Missing Runtime candidate audit argument: ${flag}`);
  }
  return Object.freeze({
    managedRoot: values.get("--managed-root"),
    runtimeTrustedKeysPath: values.get("--runtime-trust"),
    shellVersion: values.get("--shell-version"),
    runtimeProtocolVersion: Number(values.get("--runtime-protocol-version")),
  });
}

export async function runAuditRuntimeCandidateStateCli(argv) {
  const result = await auditManagedRuntimeCandidateState(parseArguments(argv));
  process.stdout.write(`${canonicalJson(result)}\n`);
  return result;
}

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  runAuditRuntimeCandidateStateCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Runtime candidate managed audit failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
