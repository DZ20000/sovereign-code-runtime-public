#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { auditManagedRuntimeCandidateState } from "./audit-runtime-candidate-state.mjs";
import { canonicalJson, fail } from "./runtime-host-release-index-format.mjs";
import { auditManagedRuntimeHostReleaseIndex } from "./stage-runtime-host-release-index.mjs";

const PREFLIGHT_SCHEMA_VERSION = "scr.runtime-managed-update-preflight/v1";
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPERATIONS = new Set(["audit", "install", "activate"]);
const BASE_FLAGS = [
  "--managed-root",
  "--runtime-trust",
  "--shell-version",
  "--runtime-protocol-version",
];

function validReleaseId(value) {
  return typeof value === "string" && RELEASE_ID_PATTERN.test(value);
}

function validateOperationTarget(operation, releaseId) {
  if (!OPERATIONS.has(operation))
    fail(`Unsupported Runtime managed preflight operation: ${operation}`);
  if (operation === "audit") {
    if (releaseId !== null)
      fail("Runtime managed audit may not select a release ID.");
    return;
  }
  if (!validReleaseId(releaseId)) {
    fail(`Runtime managed ${operation} preflight requires a valid release ID.`);
  }
}

function normalizedInventory(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  const ids = value.map((id) => {
    if (!validReleaseId(id)) fail(`${label} contains an invalid release ID.`);
    return id;
  });
  if (new Set(ids).size !== ids.length)
    fail(`${label} duplicates a release ID.`);
  return ids.slice().sort();
}

function sameInventory(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function assessRuntimeUpdateReadiness({
  operation,
  releaseId,
  releaseIndex,
  candidate,
}) {
  validateOperationTarget(operation, releaseId);
  if (releaseIndex?.consistent !== true || candidate?.consistent !== true) {
    fail("Runtime managed preflight requires two consistent audit results.");
  }
  const releaseIndexIds = normalizedInventory(
    releaseIndex.releaseIds,
    "Runtime release-index inbox",
  );
  const candidateInboxIds = normalizedInventory(
    candidate.inboxReleaseIds,
    "Runtime candidate inbox",
  );
  if (operation === "audit") {
    if (!sameInventory(releaseIndexIds, candidateInboxIds)) {
      fail("Runtime release-index and candidate inbox inventories disagree.");
    }
    return Object.freeze({ operation, releaseId: null, ready: true });
  }

  if (!releaseIndexIds.includes(releaseId)) {
    fail(
      "Target Runtime release is absent from the verified release-index inbox.",
    );
  }
  if (!candidateInboxIds.includes(releaseId)) {
    fail("Target Runtime release is absent from the verified candidate inbox.");
  }
  if (!sameInventory(releaseIndexIds, candidateInboxIds)) {
    fail("Runtime release-index and candidate inbox inventories disagree.");
  }
  const installed = normalizedInventory(
    candidate.installedReleaseIds,
    "Runtime installed candidates",
  );
  if (operation === "install") {
    if (installed.includes(releaseId))
      fail("Target Runtime release is already installed.");
  } else {
    if (!installed.includes(releaseId))
      fail("Target Runtime release is not installed.");
    if (candidate.activeReleaseId === releaseId)
      fail("Target Runtime release is already active.");
  }
  return Object.freeze({ operation, releaseId, ready: true });
}

export function parseRuntimeManagedUpdatePreflightArguments(argv) {
  const values = new Map();
  const flags = new Set([...BASE_FLAGS, "--operation", "--release-id"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.has(flag))
      fail(`Unknown Runtime managed preflight argument: ${flag}`);
    if (values.has(flag))
      fail(`Duplicate Runtime managed preflight argument: ${flag}`);
    const next = argv[index + 1];
    if (
      typeof next !== "string" ||
      next.length === 0 ||
      next.startsWith("--")
    ) {
      fail(`Runtime managed preflight argument has no value: ${flag}`);
    }
    values.set(flag, next);
    index += 1;
  }
  for (const flag of BASE_FLAGS) {
    if (!values.has(flag))
      fail(`Missing Runtime managed preflight argument: ${flag}`);
  }
  const runtimeProtocolVersion = Number(
    values.get("--runtime-protocol-version"),
  );
  if (
    !Number.isSafeInteger(runtimeProtocolVersion) ||
    runtimeProtocolVersion < 1
  ) {
    fail(
      "Runtime managed preflight protocol version must be a positive safe integer.",
    );
  }
  const operation = values.get("--operation") ?? "audit";
  const releaseId = values.get("--release-id") ?? null;
  validateOperationTarget(operation, releaseId);
  return Object.freeze({
    managedRoot: values.get("--managed-root"),
    runtimeTrustedKeysPath: values.get("--runtime-trust"),
    shellVersion: values.get("--shell-version"),
    runtimeProtocolVersion,
    operation,
    releaseId,
  });
}

export async function runRuntimeManagedUpdatePreflight(options) {
  const operation = options.operation ?? "audit";
  const releaseId = options.releaseId ?? null;
  validateOperationTarget(operation, releaseId);
  const auditOptions = Object.freeze({
    managedRoot: options.managedRoot,
    runtimeTrustedKeysPath: options.runtimeTrustedKeysPath,
    shellVersion: options.shellVersion,
    runtimeProtocolVersion: options.runtimeProtocolVersion,
  });
  const releaseIndex = await auditManagedRuntimeHostReleaseIndex(auditOptions);
  const candidate = await auditManagedRuntimeCandidateState(auditOptions);
  const readiness = assessRuntimeUpdateReadiness({
    operation,
    releaseId,
    releaseIndex,
    candidate,
  });
  return Object.freeze({
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    consistent: true,
    ...readiness,
    releaseIndex,
    candidate,
  });
}

export async function runRuntimeManagedUpdatePreflightCli(argv) {
  const result = await runRuntimeManagedUpdatePreflight(
    parseRuntimeManagedUpdatePreflightArguments(argv),
  );
  process.stdout.write(`${canonicalJson(result)}\n`);
  return result;
}

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  runRuntimeManagedUpdatePreflightCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Runtime managed update preflight failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
