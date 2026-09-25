#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, fail } from "./runtime-host-release-index-format.mjs";
import { auditManagedRuntimeHostReleaseIndex } from "./stage-runtime-host-release-index.mjs";

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
      fail(`Unknown Runtime Host release-index audit argument: ${flag}`);
    if (values.has(flag))
      fail(`Duplicate Runtime Host release-index audit argument: ${flag}`);
    const value = argv[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      fail(`Runtime Host release-index audit argument has no value: ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }
  for (const flag of flags) {
    if (!values.has(flag))
      fail(`Missing Runtime Host release-index audit argument: ${flag}`);
  }
  return Object.freeze({
    managedRoot: values.get("--managed-root"),
    runtimeTrustedKeysPath: values.get("--runtime-trust"),
    shellVersion: values.get("--shell-version"),
    runtimeProtocolVersion: Number(values.get("--runtime-protocol-version")),
  });
}

export async function runAuditRuntimeHostReleaseIndexCli(argv) {
  const result = await auditManagedRuntimeHostReleaseIndex(
    parseArguments(argv),
  );
  process.stdout.write(`${canonicalJson(result)}\n`);
  return result;
}

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  runAuditRuntimeHostReleaseIndexCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Runtime Host release-index audit failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
