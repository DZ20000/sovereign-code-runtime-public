import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { auditManagedRuntimeCandidateState } from "../scripts/audit-runtime-candidate-state.mjs";
import { createRuntimeCandidate } from "../scripts/create-runtime-candidate.mjs";
import {
  canonicalJson,
  RUNTIME_TRUST_SCHEMA_VERSION,
} from "../scripts/runtime-host-release-index-format.mjs";

const NOW = 1_787_911_200_000;
const cleanupRoots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly managedRoot: string;
  readonly inboxRoot: string;
  readonly slotsRoot: string;
  readonly trustRoot: string;
  readonly trustPath: string;
  readonly privateKeyPath: string;
  readonly keyId: string;
}

interface PackageIdentity {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly signingKeyId: string;
  readonly manifestSha256: string;
  readonly runtimeHostSha256: string;
  readonly runtimeHostSize: number;
  readonly packageRoot: string;
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await writeFile(path, canonicalJson(value), "utf8");
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "scr-runtime-candidate-audit-"));
  cleanupRoots.push(root);
  const managedRoot = join(root, "managed", "runtime-updates");
  const inboxRoot = join(managedRoot, "inbox");
  const slotsRoot = join(managedRoot, "slots");
  const trustRoot = join(root, "shell", "trust");
  await Promise.all([
    mkdir(inboxRoot, { recursive: true }),
    mkdir(slotsRoot, { recursive: true }),
    mkdir(trustRoot, { recursive: true }),
  ]);
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const keyId = "runtime-key-1";
  const privateKeyPath = join(trustRoot, "runtime-private.pem");
  const trustPath = join(trustRoot, "runtime-trusted.json");
  await writeFile(privateKeyPath, pair.privateKey, "utf8");
  await writeCanonical(trustPath, {
    schemaVersion: RUNTIME_TRUST_SCHEMA_VERSION,
    keys: [
      {
        keyId,
        publicKeyPem: pair.publicKey,
        minimumReleaseSequence: 1,
        maximumReleaseSequence: null,
      },
    ],
  });
  return {
    root,
    managedRoot,
    inboxRoot,
    slotsRoot,
    trustRoot,
    trustPath,
    privateKeyPath,
    keyId,
  };
}

async function createPackage(
  value: Fixture,
  releaseId: string,
  releaseSequence: number,
  parent: string,
  runtimeText = `${releaseId}:${releaseSequence}`,
): Promise<PackageIdentity> {
  const sourceRoot = join(
    value.root,
    "sources",
    `${releaseId}-${releaseSequence}`,
  );
  const packageRoot = join(parent, releaseId);
  await mkdir(sourceRoot, { recursive: true });
  const runtimeBytes = Buffer.from(
    `console.log(${JSON.stringify(runtimeText)});\n`,
    "utf8",
  );
  const runtimePath = join(sourceRoot, "runtime-host.cjs");
  await writeFile(runtimePath, runtimeBytes);
  await createRuntimeCandidate({
    runtimeHostPath: runtimePath,
    outputPath: packageRoot,
    privateKeyPath: value.privateKeyPath,
    keyId: value.keyId,
    releaseId,
    releaseSequence,
    minimumShellVersion: "1.0.0",
    runtimeProtocolVersion: 1,
    createdAtUnixMs: NOW - 1_000 + releaseSequence,
  });
  const envelope = JSON.parse(
    await readFile(join(packageRoot, "envelope.json"), "utf8"),
  ) as {
    keyId: string;
    manifestSha256: string;
    manifest: {
      releaseId: string;
      releaseSequence: number;
      component: { sha256: string; size: number };
    };
  };
  return {
    releaseId: envelope.manifest.releaseId,
    releaseSequence: envelope.manifest.releaseSequence,
    signingKeyId: envelope.keyId,
    manifestSha256: envelope.manifestSha256,
    runtimeHostSha256: envelope.manifest.component.sha256,
    runtimeHostSize: envelope.manifest.component.size,
    packageRoot,
  };
}

async function writeState(
  value: Fixture,
  installed: readonly PackageIdentity[],
  activeReleaseId: string | null,
): Promise<void> {
  await writeCanonical(join(value.managedRoot, "state.json"), {
    schemaVersion: "scr.runtime-candidate-update-state/v1",
    highestReleaseSequence: Math.max(
      0,
      ...installed.map((entry) => entry.releaseSequence),
    ),
    activeReleaseId,
    installed: installed.map((entry) => ({
      releaseId: entry.releaseId,
      releaseSequence: entry.releaseSequence,
      signingKeyId: entry.signingKeyId,
      manifestSha256: entry.manifestSha256,
      runtimeHostSha256: entry.runtimeHostSha256,
      runtimeHostSize: entry.runtimeHostSize,
      installedAtUnixMs: NOW,
    })),
    lastFailure: null,
  });
}

function auditOptions(value: Fixture) {
  return {
    managedRoot: value.managedRoot,
    runtimeTrustedKeysPath: value.trustPath,
    shellVersion: "1.0.0",
    runtimeProtocolVersion: 1,
  } as const;
}

async function safeRemoveFixturePath(candidate: string): Promise<void> {
  const normalized = resolve(candidate);
  if (normalized === parse(normalized).root) {
    throw new Error(`Refusing to remove a filesystem root: ${normalized}`);
  }
  const authorized = cleanupRoots.some((root) => {
    const fixtureRoot = resolve(root);
    return (
      normalized === fixtureRoot ||
      normalized.startsWith(`${fixtureRoot}${sep}`)
    );
  });
  if (!authorized) {
    throw new Error(
      `Refusing to remove a path outside a Runtime audit fixture: ${normalized}`,
    );
  }
  await rm(normalized, { recursive: true, force: true });
}

afterEach(async () => {
  const roots = cleanupRoots.splice(0);
  cleanupRoots.push(...roots);
  try {
    await Promise.all(roots.map(safeRemoveFixturePath));
  } finally {
    cleanupRoots.splice(0);
  }
});

describe("managed Runtime candidate state audit", () => {
  it("accepts a pristine first-install store without state.json", async () => {
    const value = await fixture();
    await expect(
      auditManagedRuntimeCandidateState(auditOptions(value)),
    ).resolves.toEqual({
      schemaVersion: "scr.runtime-candidate-managed-audit/v1",
      consistent: true,
      highestReleaseSequence: 0,
      activeReleaseId: null,
      installedReleaseIds: [],
      inboxReleaseIds: [],
      stateBackupPresent: false,
    });
  });

  it("reverifies state, slots and matching inbox identities", async () => {
    const value = await fixture();
    const inbox = await createPackage(value, "runtime-1", 1, value.inboxRoot);
    await cp(inbox.packageRoot, join(value.slotsRoot, "runtime-1"), {
      recursive: true,
    });
    await writeState(value, [inbox], "runtime-1");

    await expect(
      auditManagedRuntimeCandidateState(auditOptions(value)),
    ).resolves.toEqual({
      schemaVersion: "scr.runtime-candidate-managed-audit/v1",
      consistent: true,
      highestReleaseSequence: 1,
      activeReleaseId: "runtime-1",
      installedReleaseIds: ["runtime-1"],
      inboxReleaseIds: ["runtime-1"],
      stateBackupPresent: false,
    });
  });

  it("fails closed when state and slot inventory disagree", async () => {
    const missing = await fixture();
    const packageIdentity = await createPackage(
      missing,
      "runtime-1",
      1,
      missing.inboxRoot,
    );
    await writeState(missing, [packageIdentity], null);
    await expect(
      auditManagedRuntimeCandidateState(auditOptions(missing)),
    ).rejects.toThrow("state and slot inventory disagree");

    const orphaned = await fixture();
    const orphanedIdentity = await createPackage(
      orphaned,
      "runtime-1",
      1,
      orphaned.inboxRoot,
    );
    await cp(
      orphanedIdentity.packageRoot,
      join(orphaned.slotsRoot, "runtime-1"),
      { recursive: true },
    );
    await cp(
      orphanedIdentity.packageRoot,
      join(orphaned.slotsRoot, "runtime-orphan"),
      { recursive: true },
    );
    await writeState(orphaned, [orphanedIdentity], null);
    await expect(
      auditManagedRuntimeCandidateState(auditOptions(orphaned)),
    ).rejects.toThrow("state and slot inventory disagree");
  });

  it("detects slot tampering and inbox-to-slot identity drift", async () => {
    const tampered = await fixture();
    const tamperedIdentity = await createPackage(
      tampered,
      "runtime-1",
      1,
      tampered.inboxRoot,
    );
    await cp(
      tamperedIdentity.packageRoot,
      join(tampered.slotsRoot, "runtime-1"),
      { recursive: true },
    );
    await writeState(tampered, [tamperedIdentity], null);
    await writeFile(
      join(tampered.slotsRoot, "runtime-1", "runtime-host.cjs"),
      "console.log('tampered');\n",
      "utf8",
    );
    await expect(
      auditManagedRuntimeCandidateState(auditOptions(tampered)),
    ).rejects.toThrow(/size or SHA-256/u);

    const drift = await fixture();
    const installedSource = join(drift.root, "installed-source");
    await mkdir(installedSource, { recursive: true });
    const installed = await createPackage(
      drift,
      "runtime-1",
      1,
      installedSource,
      "installed",
    );
    await cp(installed.packageRoot, join(drift.slotsRoot, "runtime-1"), {
      recursive: true,
    });
    const inbox = await createPackage(
      drift,
      "runtime-1",
      2,
      drift.inboxRoot,
      "different",
    );
    await writeState(drift, [installed], null);
    expect(inbox.releaseSequence).toBe(2);
    await expect(
      auditManagedRuntimeCandidateState(auditOptions(drift)),
    ).rejects.toThrow("inbox and installed slot identities disagree");
  });

  it("rejects active state drift and concurrent release-index import", async () => {
    const activeDrift = await fixture();
    await writeCanonical(join(activeDrift.managedRoot, "state.json"), {
      schemaVersion: "scr.runtime-candidate-update-state/v1",
      highestReleaseSequence: 1,
      activeReleaseId: "runtime-missing",
      installed: [],
      lastFailure: null,
    });
    await expect(
      auditManagedRuntimeCandidateState(auditOptions(activeDrift)),
    ).rejects.toThrow("active release is not installed");

    const locked = await fixture();
    await writeState(locked, [], null);
    await mkdir(join(locked.managedRoot, "import-receipts", ".import-lock"), {
      recursive: true,
    });
    await expect(
      auditManagedRuntimeCandidateState(auditOptions(locked)),
    ).rejects.toThrow("while a release-index import lock exists");
  });
});
