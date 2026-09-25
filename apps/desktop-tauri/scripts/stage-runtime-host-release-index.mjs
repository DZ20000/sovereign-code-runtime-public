#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  constants,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  containedPath,
  directDirectory,
  fail,
  isContained,
  loadReleaseIndexTrustedKeys,
  loadRuntimeCandidateTrustedKeys,
  readCanonicalJsonFile,
  sha256,
  verifyRuntimeCandidatePackage,
  verifyRuntimeHostReleaseIndex,
} from "./runtime-host-release-index-format.mjs";

const IMPORT_RECEIPT_SCHEMA_VERSION =
  "scr.runtime-host-release-index-import-receipt/v1";
const MANAGED_AUDIT_SCHEMA_VERSION =
  "scr.runtime-host-release-index-managed-audit/v1";
const LOCK_OWNER_SCHEMA_VERSION =
  "scr.runtime-host-release-index-import-lock/v1";
const RECEIPT_FILE_PATTERN = /^(\d{16})-([a-f0-9]{64})\.json$/u;
const RECEIPT_OUTCOMES = new Set(["staged", "adopted", "retained"]);
const MAX_RECEIPTS = 1_024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const OPTION_KEYS = new Set([
  "sourceRoot",
  "indexPath",
  "indexTrustedKeysPath",
  "runtimeTrustedKeysPath",
  "managedRoot",
  "shellVersion",
  "runtimeProtocolVersion",
  "nowUnixMs",
]);

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

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer.`);
  }
  return value;
}

function lowercaseSha256(value, label) {
  const normalized = boundedString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    fail(`${label} must be lowercase SHA-256.`);
  }
  return normalized;
}

function releaseId(value, label) {
  const normalized = boundedString(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    fail(`${label} is invalid.`);
  }
  return normalized;
}

function keyId(value, label) {
  const normalized = boundedString(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) {
    fail(`${label} is invalid.`);
  }
  return normalized;
}

function normalizeOptions(raw) {
  const value = plainObject(raw, "Runtime Host release-index import options");
  for (const key of Object.keys(value)) {
    if (!OPTION_KEYS.has(key)) {
      fail(
        `Runtime Host release-index import options contain an unknown field: ${key}`,
      );
    }
  }
  const nowUnixMs =
    value.nowUnixMs === undefined
      ? Date.now()
      : positiveSafeInteger(value.nowUnixMs, "Import clock");
  return Object.freeze({
    sourceRoot: boundedString(value.sourceRoot, "Source root"),
    indexPath: boundedString(value.indexPath, "Release-index path", 1_024),
    indexTrustedKeysPath: boundedString(
      value.indexTrustedKeysPath,
      "Release-index trusted-key path",
    ),
    runtimeTrustedKeysPath: boundedString(
      value.runtimeTrustedKeysPath,
      "Runtime candidate trusted-key path",
    ),
    managedRoot: boundedString(value.managedRoot, "Managed update root"),
    shellVersion: boundedString(
      value.shellVersion,
      "Current shell version",
      64,
    ),
    runtimeProtocolVersion: positiveSafeInteger(
      value.runtimeProtocolVersion,
      "Current Runtime protocol version",
    ),
    nowUnixMs,
  });
}

async function ensureDirectChildDirectory(root, name, label) {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(name)) {
    fail(`${label} child name is invalid.`);
  }
  const candidate = join(root.path, name);
  try {
    await mkdir(candidate);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      fail(`${label} could not be created: ${error?.code ?? "FS_ERROR"}`);
    }
  }
  const directory = await directDirectory(candidate, label);
  if (!isContained(root.canonical, directory.canonical)) {
    fail(`${label} escaped the managed update root.`);
  }
  return directory;
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function publishCanonicalFile(finalPath, document) {
  if (await pathExists(finalPath))
    fail(`Immutable file already exists: ${basename(finalPath)}`);
  const parent = dirname(finalPath);
  const nonce = randomBytes(12).toString("hex");
  const temporaryPath = join(
    parent,
    `.${basename(finalPath)}.${process.pid}.${nonce}.tmp`,
  );
  const bytes = Buffer.from(canonicalJson(document), "utf8");
  let published = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, finalPath);
    published = true;
    await unlink(temporaryPath);
    return bytes;
  } catch (error) {
    if (!published) {
      await unlink(temporaryPath).catch((cleanupError) => {
        if (cleanupError?.code !== "ENOENT") {
          fail(
            `Could not remove owned temporary file after publication failure: ${cleanupError.code ?? "FS_ERROR"}`,
          );
        }
      });
    }
    throw error;
  }
}

async function acquireImportLock(receiptRoot, operation) {
  const lockPath = join(receiptRoot.path, ".import-lock");
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        "Another Runtime Host release-index import is active or requires operator review.",
      );
    }
    fail(
      `Could not acquire the Runtime Host release-index import lock: ${error?.code ?? "FS_ERROR"}`,
    );
  }
  const ownerPath = join(lockPath, "owner.json");
  const owner = {
    schemaVersion: LOCK_OWNER_SCHEMA_VERSION,
    processId: process.pid,
    startedAtUnixMs: Date.now(),
    operation,
  };
  try {
    await writeFile(ownerPath, canonicalJson(owner), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await rmdir(lockPath).catch(() => undefined);
    fail(
      `Could not record the Runtime Host release-index import lock owner: ${error?.code ?? "FS_ERROR"}`,
    );
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(ownerPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await rmdir(lockPath).catch((error) => {
      fail(
        `Import completed but the reviewed lock could not be released: ${error?.code ?? "FS_ERROR"}`,
      );
    });
  };
}

function receiptFileName(indexSequence, receiptId) {
  return `${String(indexSequence).padStart(16, "0")}-${receiptId}.json`;
}

function receiptCore(document) {
  const { receiptId: _receiptId, ...core } = document;
  return core;
}

function validateReceiptRelease(raw, label) {
  const value = plainObject(raw, label);
  exactKeys(
    value,
    [
      "releaseId",
      "releaseSequence",
      "signingKeyId",
      "envelopeSha256",
      "runtimeHostSha256",
      "outcome",
    ],
    label,
  );
  if (!RECEIPT_OUTCOMES.has(value.outcome))
    fail(`${label} outcome is unsupported.`);
  return Object.freeze({
    releaseId: releaseId(value.releaseId, `${label} release ID`),
    releaseSequence: positiveSafeInteger(
      value.releaseSequence,
      `${label} release sequence`,
    ),
    signingKeyId: keyId(value.signingKeyId, `${label} signing key ID`),
    envelopeSha256: lowercaseSha256(
      value.envelopeSha256,
      `${label} envelope digest`,
    ),
    runtimeHostSha256: lowercaseSha256(
      value.runtimeHostSha256,
      `${label} Runtime Host digest`,
    ),
    outcome: value.outcome,
  });
}

function validateReceiptDocument(raw, fileName) {
  const value = plainObject(raw, `Import receipt ${fileName}`);
  exactKeys(
    value,
    [
      "schemaVersion",
      "receiptId",
      "previousReceiptSha256",
      "indexSequence",
      "indexSha256",
      "indexEnvelopeSha256",
      "indexSigningKeyId",
      "importedAtUnixMs",
      "releases",
    ],
    `Import receipt ${fileName}`,
  );
  if (value.schemaVersion !== IMPORT_RECEIPT_SCHEMA_VERSION) {
    fail(`Import receipt ${fileName} schema is unsupported.`);
  }
  const receiptId = lowercaseSha256(
    value.receiptId,
    `Import receipt ${fileName} ID`,
  );
  const previousReceiptSha256 =
    value.previousReceiptSha256 === null
      ? null
      : lowercaseSha256(
          value.previousReceiptSha256,
          `Import receipt ${fileName} previous digest`,
        );
  if (
    !Array.isArray(value.releases) ||
    value.releases.length < 1 ||
    value.releases.length > 128
  ) {
    fail(`Import receipt ${fileName} has an invalid release inventory.`);
  }
  const releases = value.releases.map((entry, index) =>
    validateReceiptRelease(
      entry,
      `Import receipt ${fileName} release ${index}`,
    ),
  );
  const normalized = Object.freeze({
    schemaVersion: IMPORT_RECEIPT_SCHEMA_VERSION,
    receiptId,
    previousReceiptSha256,
    indexSequence: positiveSafeInteger(
      value.indexSequence,
      `Import receipt ${fileName} index sequence`,
    ),
    indexSha256: lowercaseSha256(
      value.indexSha256,
      `Import receipt ${fileName} index digest`,
    ),
    indexEnvelopeSha256: lowercaseSha256(
      value.indexEnvelopeSha256,
      `Import receipt ${fileName} envelope digest`,
    ),
    indexSigningKeyId: keyId(
      value.indexSigningKeyId,
      `Import receipt ${fileName} index signing key ID`,
    ),
    importedAtUnixMs: positiveSafeInteger(
      value.importedAtUnixMs,
      `Import receipt ${fileName} import time`,
    ),
    releases,
  });
  if (
    sha256(Buffer.from(canonicalJson(receiptCore(normalized)), "utf8")) !==
    receiptId
  ) {
    fail(`Import receipt ${fileName} ID does not match its content.`);
  }
  if (fileName !== receiptFileName(normalized.indexSequence, receiptId)) {
    fail(`Import receipt ${fileName} name does not match its content.`);
  }
  return normalized;
}

async function loadReceiptChain(receiptRoot) {
  const entries = await readdir(receiptRoot.path, { withFileTypes: true });
  const receiptEntries = [];
  for (const entry of entries) {
    if (
      entry.name === ".import-lock" &&
      entry.isDirectory() &&
      !entry.isSymbolicLink()
    ) {
      continue;
    }
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !RECEIPT_FILE_PATTERN.test(entry.name)
    ) {
      fail(
        "Runtime Host release-index receipt directory contains an unexpected entry.",
      );
    }
    receiptEntries.push(entry.name);
  }
  if (receiptEntries.length > MAX_RECEIPTS) {
    fail("Runtime Host release-index receipt limit has been reached.");
  }
  receiptEntries.sort();
  const receipts = [];
  let previousRawSha256 = null;
  let previousIndexSequence = 0;
  const releases = new Map();
  for (const fileName of receiptEntries) {
    const receiptFile = await readCanonicalJsonFile(
      join(receiptRoot.path, fileName),
      `Runtime Host release-index import receipt ${fileName}`,
      MAX_RECEIPT_BYTES,
    );
    const receipt = validateReceiptDocument(receiptFile.document, fileName);
    if (receipt.indexSequence <= previousIndexSequence) {
      fail(
        "Runtime Host release-index receipt sequence did not increase strictly.",
      );
    }
    if (receipt.previousReceiptSha256 !== previousRawSha256) {
      fail("Runtime Host release-index receipt chain is broken.");
    }
    for (const release of receipt.releases) {
      const existing = releases.get(release.releaseId);
      if (
        existing !== undefined &&
        (existing.releaseSequence !== release.releaseSequence ||
          existing.envelopeSha256 !== release.envelopeSha256 ||
          existing.runtimeHostSha256 !== release.runtimeHostSha256 ||
          existing.signingKeyId !== release.signingKeyId)
      ) {
        fail(
          "Runtime Host release-index receipts disagree about a release identity.",
        );
      }
      releases.set(release.releaseId, release);
    }
    const rawSha256 = sha256(receiptFile.bytes);
    receipts.push(Object.freeze({ ...receipt, fileName, rawSha256 }));
    previousRawSha256 = rawSha256;
    previousIndexSequence = receipt.indexSequence;
  }
  return Object.freeze({
    receipts,
    releases,
    latest: receipts.at(-1) ?? null,
    highestReleaseSequence: Math.max(
      0,
      ...[...releases.values()].map((release) => release.releaseSequence),
    ),
  });
}

export async function auditManagedRuntimeHostReleaseIndex(rawOptions) {
  const value = plainObject(
    rawOptions,
    "Runtime Host release-index managed-audit options",
  );
  exactKeys(
    value,
    [
      "managedRoot",
      "runtimeTrustedKeysPath",
      "shellVersion",
      "runtimeProtocolVersion",
    ],
    "Runtime Host release-index managed-audit options",
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
  const directChild = async (name, label) => {
    const candidate = resolve(managedRoot.path, name);
    if (dirname(candidate) !== managedRoot.path) {
      fail(`${label} is not a direct child of the managed update root.`);
    }
    const directory = await directDirectory(candidate, label, {
      requireCanonicalPath: true,
    });
    if (!isContained(managedRoot.canonical, directory.canonical)) {
      fail(`${label} escaped the managed update root.`);
    }
    return directory;
  };
  const inboxRoot = await directChild(
    "inbox",
    "Managed Runtime candidate inbox",
  );
  const receiptRoot = await directChild(
    "import-receipts",
    "Managed Runtime release-index receipt directory",
  );
  if (await pathExists(join(receiptRoot.path, ".import-lock"))) {
    fail(
      "Runtime Host release-index managed audit is unavailable while an import lock exists.",
    );
  }
  const chain = await loadReceiptChain(receiptRoot);
  const trustedRuntimeKeys = await loadRuntimeCandidateTrustedKeys(
    options.runtimeTrustedKeysPath,
  );
  if (chain.releases.size > 0 && trustedRuntimeKeys.size === 0) {
    fail("No trusted Runtime candidate signing keys are provisioned.");
  }

  const inboxEntries = await readdir(inboxRoot.path, { withFileTypes: true });
  const inboxReleaseIds = new Set();
  for (const entry of inboxEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail("Managed Runtime candidate inbox contains an unexpected entry.");
    }
    const id = releaseId(
      entry.name,
      "Managed Runtime candidate inbox release ID",
    );
    if (inboxReleaseIds.has(id)) {
      fail("Managed Runtime candidate inbox duplicates a release ID.");
    }
    const recorded = chain.releases.get(id);
    if (recorded === undefined) {
      fail("Managed Runtime candidate inbox contains an unreceipted release.");
    }
    const candidate = await verifyRuntimeCandidatePackage({
      packageRoot: join(inboxRoot.path, id),
      trustedKeys: trustedRuntimeKeys,
      shellVersion: options.shellVersion,
      runtimeProtocolVersion: options.runtimeProtocolVersion,
      expected: {
        releaseId: recorded.releaseId,
        releaseSequence: recorded.releaseSequence,
        envelopeSha256: recorded.envelopeSha256,
        runtimeHostSha256: recorded.runtimeHostSha256,
      },
    });
    if (candidate.signingKeyId !== recorded.signingKeyId) {
      fail(
        "Managed Runtime candidate signing key does not match its import receipt.",
      );
    }
    inboxReleaseIds.add(id);
  }
  for (const release of chain.releases.values()) {
    if (!inboxReleaseIds.has(release.releaseId)) {
      fail(
        "Runtime Host release-index receipt references a missing inbox package.",
      );
    }
  }
  const releaseIds = [...inboxReleaseIds].sort();
  return Object.freeze({
    schemaVersion: MANAGED_AUDIT_SCHEMA_VERSION,
    consistent: true,
    receiptCount: chain.receipts.length,
    latestIndexSequence: chain.latest?.indexSequence ?? null,
    highestReleaseSequence: chain.highestReleaseSequence,
    releaseIds,
  });
}

async function cleanupOwnedStaging(stagingPath, inboxRoot) {
  if (
    !isContained(inboxRoot.path, stagingPath) ||
    dirname(stagingPath) !== inboxRoot.path
  ) {
    fail("Refusing to clean a staging directory outside the managed inbox.");
  }
  const name = basename(stagingPath);
  if (!/^\.import-[a-f0-9]{24}\.tmp$/u.test(name)) {
    fail("Refusing to clean an unrecognized staging directory.");
  }
  let entries;
  try {
    entries = await readdir(stagingPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const allowed = new Set(["envelope.json", "runtime-host.cjs"]);
  if (
    entries.some(
      (entry) =>
        !entry.isFile() || entry.isSymbolicLink() || !allowed.has(entry.name),
    )
  ) {
    fail(
      "Owned Runtime Host import staging contains an unexpected entry; it was not removed.",
    );
  }
  for (const entry of entries) await unlink(join(stagingPath, entry.name));
  await rmdir(stagingPath);
}

async function stagePackage({
  sourcePackage,
  inboxRoot,
  expected,
  trustedRuntimeKeys,
  shellVersion,
  runtimeProtocolVersion,
}) {
  const stagingPath = join(
    inboxRoot.path,
    `.import-${randomBytes(12).toString("hex")}.tmp`,
  );
  await mkdir(stagingPath);
  try {
    await copyFile(
      join(sourcePackage.path, "envelope.json"),
      join(stagingPath, "envelope.json"),
      constants.COPYFILE_EXCL,
    );
    await copyFile(
      join(sourcePackage.path, "runtime-host.cjs"),
      join(stagingPath, "runtime-host.cjs"),
      constants.COPYFILE_EXCL,
    );
    await verifyRuntimeCandidatePackage({
      packageRoot: stagingPath,
      trustedKeys: trustedRuntimeKeys,
      shellVersion,
      runtimeProtocolVersion,
      expected,
      requireDirectoryName: false,
    });
    return stagingPath;
  } catch (error) {
    await cleanupOwnedStaging(stagingPath, inboxRoot);
    throw error;
  }
}

async function verifyInboxPackage({
  packagePath,
  expected,
  trustedRuntimeKeys,
  shellVersion,
  runtimeProtocolVersion,
}) {
  return verifyRuntimeCandidatePackage({
    packageRoot: packagePath,
    trustedKeys: trustedRuntimeKeys,
    shellVersion,
    runtimeProtocolVersion,
    expected,
  });
}

export async function stageRuntimeHostReleaseIndex(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const sourceRoot = await directDirectory(
    options.sourceRoot,
    "Runtime Host release-index source root",
    { shallow: true, requireCanonicalPath: true },
  );
  const managedRoot = await directDirectory(
    options.managedRoot,
    "Managed Runtime candidate update root",
    { shallow: true, requireCanonicalPath: true },
  );
  if (
    isContained(sourceRoot.canonical, managedRoot.canonical) ||
    isContained(managedRoot.canonical, sourceRoot.canonical)
  ) {
    fail(
      "Release source and managed update root must be separate directory trees.",
    );
  }
  if (isAbsolute(options.indexPath)) {
    fail("Release-index path must be relative to its source root.");
  }
  const indexFile = await containedPath(
    sourceRoot,
    options.indexPath,
    "Runtime Host release-index file",
    "file",
    4 * 1024 * 1024,
  );
  const inboxRoot = await ensureDirectChildDirectory(
    managedRoot,
    "inbox",
    "Managed Runtime candidate inbox",
  );
  const receiptRoot = await ensureDirectChildDirectory(
    managedRoot,
    "import-receipts",
    "Managed Runtime release-index receipt directory",
  );
  const releaseImportLock = await acquireImportLock(
    receiptRoot,
    sha256(Buffer.from(indexFile.portable, "utf8")),
  );
  const stagingPaths = [];
  try {
    const indexTrustedKeys = await loadReleaseIndexTrustedKeys(
      options.indexTrustedKeysPath,
      sourceRoot,
    );
    const trustedRuntimeKeys = await loadRuntimeCandidateTrustedKeys(
      options.runtimeTrustedKeysPath,
      sourceRoot,
    );
    const index = await verifyRuntimeHostReleaseIndex({
      indexPath: indexFile.path,
      trustedKeys: indexTrustedKeys,
      nowUnixMs: options.nowUnixMs,
    });
    const verified = [];
    for (const entry of index.releases) {
      const sourcePackage = await containedPath(
        sourceRoot,
        entry.packagePath,
        `Runtime candidate package ${entry.releaseId}`,
        "directory",
      );
      const candidate = await verifyRuntimeCandidatePackage({
        packageRoot: sourcePackage.path,
        trustedKeys: trustedRuntimeKeys,
        shellVersion: options.shellVersion,
        runtimeProtocolVersion: options.runtimeProtocolVersion,
        expected: entry,
      });
      verified.push(Object.freeze({ entry, sourcePackage, candidate }));
    }

    const chain = await loadReceiptChain(receiptRoot);
    const latest = chain.latest;
    if (latest !== null && index.indexSequence === latest.indexSequence) {
      if (
        index.indexSha256 !== latest.indexSha256 ||
        index.envelopeSha256 !== latest.indexEnvelopeSha256
      ) {
        fail(
          "Runtime Host release-index sequence conflicts with an existing receipt.",
        );
      }
      for (const item of verified) {
        const finalPath = join(inboxRoot.path, item.entry.releaseId);
        if (!(await pathExists(finalPath))) {
          fail(
            "Idempotent Runtime Host release-index receipt references a missing inbox package.",
          );
        }
        await verifyInboxPackage({
          packagePath: finalPath,
          expected: item.entry,
          trustedRuntimeKeys,
          shellVersion: options.shellVersion,
          runtimeProtocolVersion: options.runtimeProtocolVersion,
        });
      }
      return Object.freeze({
        schemaVersion: IMPORT_RECEIPT_SCHEMA_VERSION,
        receiptId: latest.receiptId,
        indexSequence: latest.indexSequence,
        indexSha256: latest.indexSha256,
        idempotent: true,
        importedReleaseIds: [],
        retainedReleaseIds: latest.releases.map((release) => release.releaseId),
      });
    }
    if (latest !== null && index.indexSequence <= latest.indexSequence) {
      fail("Runtime Host release-index sequence is a replay.");
    }

    const releaseOutcomes = [];
    for (const item of verified) {
      const finalPath = resolve(inboxRoot.path, item.entry.releaseId);
      if (
        !isContained(inboxRoot.path, finalPath) ||
        dirname(finalPath) !== inboxRoot.path
      ) {
        fail("Runtime candidate inbox target escaped the managed inbox.");
      }
      const recorded = chain.releases.get(item.entry.releaseId);
      if (await pathExists(finalPath)) {
        await verifyInboxPackage({
          packagePath: finalPath,
          expected: item.entry,
          trustedRuntimeKeys,
          shellVersion: options.shellVersion,
          runtimeProtocolVersion: options.runtimeProtocolVersion,
        });
        releaseOutcomes.push({
          ...item,
          finalPath,
          outcome: recorded === undefined ? "adopted" : "retained",
        });
      } else {
        if (recorded !== undefined) {
          fail(
            "Runtime Host release-index receipt references a missing inbox package.",
          );
        }
        releaseOutcomes.push({ ...item, finalPath, outcome: "staged" });
      }
    }

    const advancing = releaseOutcomes.filter(
      (item) => item.outcome === "staged" || item.outcome === "adopted",
    );
    if (advancing.length === 0) {
      fail(
        "Runtime Host release index is equivalent to already imported content.",
      );
    }
    for (const item of advancing) {
      if (item.entry.releaseSequence <= chain.highestReleaseSequence) {
        fail("Runtime Host release sequence does not advance monotonically.");
      }
    }

    for (const item of releaseOutcomes) {
      if (item.outcome !== "staged") continue;
      const stagingPath = await stagePackage({
        sourcePackage: item.sourcePackage,
        inboxRoot,
        expected: item.entry,
        trustedRuntimeKeys,
        shellVersion: options.shellVersion,
        runtimeProtocolVersion: options.runtimeProtocolVersion,
      });
      stagingPaths.push(stagingPath);
      if (await pathExists(item.finalPath)) {
        fail("Runtime candidate inbox target appeared during import.");
      }
      await rename(stagingPath, item.finalPath);
      stagingPaths.splice(stagingPaths.indexOf(stagingPath), 1);
      await verifyInboxPackage({
        packagePath: item.finalPath,
        expected: item.entry,
        trustedRuntimeKeys,
        shellVersion: options.shellVersion,
        runtimeProtocolVersion: options.runtimeProtocolVersion,
      });
    }

    const receiptReleases = releaseOutcomes.map((item) => ({
      releaseId: item.candidate.releaseId,
      releaseSequence: item.candidate.releaseSequence,
      signingKeyId: item.candidate.signingKeyId,
      envelopeSha256: item.candidate.envelopeSha256,
      runtimeHostSha256: item.candidate.runtimeHostSha256,
      outcome: item.outcome,
    }));
    const core = {
      schemaVersion: IMPORT_RECEIPT_SCHEMA_VERSION,
      previousReceiptSha256: latest?.rawSha256 ?? null,
      indexSequence: index.indexSequence,
      indexSha256: index.indexSha256,
      indexEnvelopeSha256: index.envelopeSha256,
      indexSigningKeyId: index.keyId,
      importedAtUnixMs: options.nowUnixMs,
      releases: receiptReleases,
    };
    const receiptId = sha256(Buffer.from(canonicalJson(core), "utf8"));
    const receipt = { ...core, receiptId };
    const receiptPath = join(
      receiptRoot.path,
      receiptFileName(index.indexSequence, receiptId),
    );
    await publishCanonicalFile(receiptPath, receipt);
    return Object.freeze({
      schemaVersion: IMPORT_RECEIPT_SCHEMA_VERSION,
      receiptId,
      indexSequence: index.indexSequence,
      indexSha256: index.indexSha256,
      idempotent: false,
      importedReleaseIds: releaseOutcomes
        .filter((item) => item.outcome !== "retained")
        .map((item) => item.entry.releaseId),
      retainedReleaseIds: releaseOutcomes
        .filter((item) => item.outcome === "retained")
        .map((item) => item.entry.releaseId),
    });
  } finally {
    const finalizationFailures = [];
    for (const stagingPath of stagingPaths) {
      try {
        await cleanupOwnedStaging(stagingPath, inboxRoot);
      } catch (error) {
        finalizationFailures.push(error);
      }
    }
    try {
      await releaseImportLock();
    } catch (error) {
      finalizationFailures.push(error);
    }
    if (finalizationFailures.length === 1) throw finalizationFailures[0];
    if (finalizationFailures.length > 1) {
      throw new AggregateError(
        finalizationFailures,
        "Runtime Host release-index import cleanup and lock release both failed.",
      );
    }
  }
}

export function parseStageRuntimeHostReleaseIndexArguments(argv) {
  const values = new Map();
  const flags = new Set([
    "--source-root",
    "--index",
    "--index-trust",
    "--runtime-trust",
    "--managed-root",
    "--shell-version",
    "--runtime-protocol-version",
    "--now-unix-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.has(flag))
      fail(`Unknown Runtime Host release-index argument: ${flag}`);
    if (values.has(flag))
      fail(`Duplicate Runtime Host release-index argument: ${flag}`);
    const value = argv[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      fail(`Runtime Host release-index argument has no value: ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }
  const required = [
    "--source-root",
    "--index",
    "--index-trust",
    "--runtime-trust",
    "--managed-root",
    "--shell-version",
    "--runtime-protocol-version",
  ];
  for (const flag of required) {
    if (!values.has(flag))
      fail(`Missing Runtime Host release-index argument: ${flag}`);
  }
  const protocol = Number(values.get("--runtime-protocol-version"));
  const now = values.has("--now-unix-ms")
    ? Number(values.get("--now-unix-ms"))
    : undefined;
  return normalizeOptions({
    sourceRoot: values.get("--source-root"),
    indexPath: values.get("--index"),
    indexTrustedKeysPath: values.get("--index-trust"),
    runtimeTrustedKeysPath: values.get("--runtime-trust"),
    managedRoot: values.get("--managed-root"),
    shellVersion: values.get("--shell-version"),
    runtimeProtocolVersion: protocol,
    ...(now === undefined ? {} : { nowUnixMs: now }),
  });
}

export async function runStageRuntimeHostReleaseIndexCli(argv) {
  const result = await stageRuntimeHostReleaseIndex(
    parseStageRuntimeHostReleaseIndexArguments(argv),
  );
  process.stdout.write(`${canonicalJson(result)}\n`);
  return result;
}

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  runStageRuntimeHostReleaseIndexCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Runtime Host release-index import failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
