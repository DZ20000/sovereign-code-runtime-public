import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeCandidate } from "../scripts/create-runtime-candidate.mjs";
import { runRuntimeManagedUpdatePreflight } from "../scripts/runtime-update-preflight.mjs";
import {
  canonicalJson,
  RELEASE_INDEX_ENVELOPE_SCHEMA_VERSION,
  RELEASE_INDEX_SCHEMA_VERSION,
  RELEASE_INDEX_SIGNATURE_PAYLOAD_SCHEMA_VERSION,
  RELEASE_INDEX_TRUST_SCHEMA_VERSION,
  RUNTIME_TRUST_SCHEMA_VERSION,
  sha256,
} from "../scripts/runtime-host-release-index-format.mjs";
import {
  auditManagedRuntimeHostReleaseIndex,
  parseStageRuntimeHostReleaseIndexArguments,
  stageRuntimeHostReleaseIndex,
} from "../scripts/stage-runtime-host-release-index.mjs";

const NOW = 1_787_911_200_000;
const cleanupRoots: string[] = [];

type KeyMaterial = Readonly<{
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}>;

interface CandidateRecord {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly packagePath: string;
  readonly packageRoot: string;
  readonly envelopeSha256: string;
  readonly runtimeHostSha256: string;
}

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly managedRoot: string;
  readonly trustRoot: string;
  readonly runtimeKey: KeyMaterial;
  readonly indexKey: KeyMaterial;
  readonly runtimeTrustPath: string;
  readonly indexTrustPath: string;
  readonly runtimePrivateKeyPath: string;
  readonly indexPath: string;
}

function keyMaterial(keyId: string): KeyMaterial {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return {
    keyId,
    privateKeyPem: pair.privateKey,
    publicKeyPem: pair.publicKey,
  };
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await writeFile(path, canonicalJson(value), "utf8");
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "scr-release-index-import-"));
  cleanupRoots.push(root);
  const sourceRoot = join(root, "source", "feed");
  const managedRoot = join(root, "managed", "runtime-update");
  const trustRoot = join(root, "shell", "trust");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(managedRoot, { recursive: true }),
    mkdir(trustRoot, { recursive: true }),
  ]);
  const runtimeKey = keyMaterial("runtime-key-1");
  const indexKey = keyMaterial("index-key-1");
  const runtimePrivateKeyPath = join(trustRoot, "runtime-private.pem");
  const runtimeTrustPath = join(trustRoot, "runtime-trusted.json");
  const indexTrustPath = join(trustRoot, "index-trusted.json");
  await writeFile(runtimePrivateKeyPath, runtimeKey.privateKeyPem, "utf8");
  await writeCanonical(runtimeTrustPath, {
    schemaVersion: RUNTIME_TRUST_SCHEMA_VERSION,
    keys: [
      {
        keyId: runtimeKey.keyId,
        publicKeyPem: runtimeKey.publicKeyPem,
        minimumReleaseSequence: 1,
        maximumReleaseSequence: null,
      },
    ],
  });
  await writeCanonical(indexTrustPath, {
    schemaVersion: RELEASE_INDEX_TRUST_SCHEMA_VERSION,
    keys: [
      {
        keyId: indexKey.keyId,
        publicKeyPem: indexKey.publicKeyPem,
        minimumIndexSequence: 1,
        maximumIndexSequence: null,
      },
    ],
  });
  return {
    root,
    sourceRoot,
    managedRoot,
    trustRoot,
    runtimeKey,
    indexKey,
    runtimeTrustPath,
    indexTrustPath,
    runtimePrivateKeyPath,
    indexPath: join(sourceRoot, "release-index.json"),
  };
}

async function candidate(
  value: Fixture,
  releaseId: string,
  releaseSequence: number,
): Promise<CandidateRecord> {
  const source = join(value.root, "candidate-sources", releaseId);
  const packageRoot = join(value.sourceRoot, "packages", releaseId);
  await mkdir(source, { recursive: true });
  const runtimeBytes = Buffer.from(
    `console.log(${JSON.stringify(`${releaseId}:${releaseSequence}`)});\n`,
    "utf8",
  );
  await writeFile(join(source, "runtime-host.cjs"), runtimeBytes);
  await createRuntimeCandidate({
    runtimeHostPath: join(source, "runtime-host.cjs"),
    outputPath: packageRoot,
    privateKeyPath: value.runtimePrivateKeyPath,
    keyId: value.runtimeKey.keyId,
    releaseId,
    releaseSequence,
    minimumShellVersion: "1.0.0",
    runtimeProtocolVersion: 1,
    createdAtUnixMs: NOW - 10_000 + releaseSequence,
  });
  const envelopeBytes = await readFile(join(packageRoot, "envelope.json"));
  return {
    releaseId,
    releaseSequence,
    packagePath: `packages/${releaseId}`,
    packageRoot,
    envelopeSha256: sha256(envelopeBytes),
    runtimeHostSha256: sha256(runtimeBytes),
  };
}

async function writeIndex(
  value: Fixture,
  indexSequence: number,
  releases: readonly CandidateRecord[],
  options: {
    expiresAtUnixMs?: number;
    signingKey?: KeyMaterial;
    outputPath?: string;
  } = {},
): Promise<string> {
  const index = {
    schemaVersion: RELEASE_INDEX_SCHEMA_VERSION,
    indexSequence,
    generatedAtUnixMs: NOW - 1_000,
    expiresAtUnixMs: options.expiresAtUnixMs ?? NOW + 60_000,
    releases: releases.map((release) => ({
      releaseId: release.releaseId,
      releaseSequence: release.releaseSequence,
      packagePath: release.packagePath,
      envelopeSha256: release.envelopeSha256,
      runtimeHostSha256: release.runtimeHostSha256,
    })),
  };
  const indexSha256 = sha256(Buffer.from(canonicalJson(index), "utf8"));
  const signingKey = options.signingKey ?? value.indexKey;
  const signature = signPayload(
    null,
    Buffer.from(
      `${RELEASE_INDEX_SIGNATURE_PAYLOAD_SCHEMA_VERSION}\n${indexSha256}`,
      "utf8",
    ),
    signingKey.privateKeyPem,
  ).toString("base64url");
  const outputPath = options.outputPath ?? value.indexPath;
  await writeCanonical(outputPath, {
    schemaVersion: RELEASE_INDEX_ENVELOPE_SCHEMA_VERSION,
    algorithm: "ed25519",
    keyId: signingKey.keyId,
    indexSha256,
    index,
    signature,
  });
  return outputPath;
}

function stageOptions(value: Fixture) {
  return {
    sourceRoot: value.sourceRoot,
    indexPath: "release-index.json",
    indexTrustedKeysPath: value.indexTrustPath,
    runtimeTrustedKeysPath: value.runtimeTrustPath,
    managedRoot: value.managedRoot,
    shellVersion: "1.0.0",
    runtimeProtocolVersion: 1,
    nowUnixMs: NOW,
  } as const;
}

function auditOptions(value: Fixture) {
  return {
    managedRoot: value.managedRoot,
    runtimeTrustedKeysPath: value.runtimeTrustPath,
    shellVersion: "1.0.0",
    runtimeProtocolVersion: 1,
  } as const;
}

function stageArguments(value: Fixture): string[] {
  return [
    "--source-root",
    value.sourceRoot,
    "--index",
    "release-index.json",
    "--index-trust",
    value.indexTrustPath,
    "--runtime-trust",
    value.runtimeTrustPath,
    "--managed-root",
    value.managedRoot,
    "--shell-version",
    "1.0.0",
    "--runtime-protocol-version",
    "1",
    "--now-unix-ms",
    String(NOW),
  ];
}

async function receiptFiles(value: Fixture): Promise<string[]> {
  const root = join(value.managedRoot, "import-receipts");
  try {
    return (await readdir(root)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function managedText(value: Fixture): Promise<string> {
  const files: string[] = [];
  async function walk(root: string): Promise<void> {
    for (const name of await readdir(root, { withFileTypes: true })) {
      const path = join(root, name.name);
      if (name.isDirectory()) await walk(path);
      else files.push((await readFile(path)).toString("utf8"));
    }
  }
  await walk(value.managedRoot);
  return files.join("\n");
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
      `Refusing to remove a path outside a release-index fixture: ${normalized}`,
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

describe("managed Runtime Host release-index import", () => {
  it("parses only the closed local staging CLI surface", async () => {
    const value = await fixture();
    expect(
      parseStageRuntimeHostReleaseIndexArguments(stageArguments(value)),
    ).toEqual(stageOptions(value));
    expect(() =>
      parseStageRuntimeHostReleaseIndexArguments([
        ...stageArguments(value),
        "--download",
        "https://example.invalid/feed.json",
      ]),
    ).toThrow("Unknown Runtime Host release-index argument");
    expect(() =>
      parseStageRuntimeHostReleaseIndexArguments([
        ...stageArguments(value),
        "--index",
        "other.json",
      ]),
    ).toThrow("Duplicate Runtime Host release-index argument");
    const invalidProtocol = stageArguments(value);
    invalidProtocol[invalidProtocol.indexOf("--runtime-protocol-version") + 1] =
      "0";
    expect(() =>
      parseStageRuntimeHostReleaseIndexArguments(invalidProtocol),
    ).toThrow("positive safe integer");
  });

  it("verifies, stages and idempotently reuses a signed local release index", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    await writeIndex(value, 1, [first]);

    const imported = await stageRuntimeHostReleaseIndex(stageOptions(value));
    const repeated = await stageRuntimeHostReleaseIndex(stageOptions(value));

    expect(imported).toMatchObject({
      idempotent: false,
      indexSequence: 1,
      importedReleaseIds: ["runtime-1"],
      retainedReleaseIds: [],
    });
    expect(repeated).toMatchObject({
      idempotent: true,
      receiptId: imported.receiptId,
      importedReleaseIds: [],
      retainedReleaseIds: ["runtime-1"],
    });
    expect(
      await readFile(
        join(value.managedRoot, "inbox", "runtime-1", "runtime-host.cjs"),
        "utf8",
      ),
    ).toContain("runtime-1:1");
    expect(await receiptFiles(value)).toHaveLength(1);
    expect(await managedText(value)).not.toContain("PRIVATE KEY");
  });

  it("audits the receipt chain against every managed inbox package", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    const second = await candidate(value, "runtime-2", 2);
    await writeIndex(value, 1, [first, second]);
    await stageRuntimeHostReleaseIndex(stageOptions(value));

    await expect(
      auditManagedRuntimeHostReleaseIndex(auditOptions(value)),
    ).resolves.toEqual({
      schemaVersion: "scr.runtime-host-release-index-managed-audit/v1",
      consistent: true,
      receiptCount: 1,
      latestIndexSequence: 1,
      highestReleaseSequence: 2,
      releaseIds: ["runtime-1", "runtime-2"],
    });
  });

  it("runs the unified Runtime preflight across release-index and candidate state", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    await writeIndex(value, 1, [first]);
    await stageRuntimeHostReleaseIndex(stageOptions(value));
    await mkdir(join(value.managedRoot, "slots"));
    await writeCanonical(join(value.managedRoot, "state.json"), {
      schemaVersion: "scr.runtime-candidate-update-state/v1",
      highestReleaseSequence: 0,
      activeReleaseId: null,
      installed: [],
      lastFailure: null,
    });

    await expect(
      runRuntimeManagedUpdatePreflight(auditOptions(value)),
    ).resolves.toMatchObject({
      schemaVersion: "scr.runtime-managed-update-preflight/v1",
      consistent: true,
      releaseIndex: {
        consistent: true,
        releaseIds: ["runtime-1"],
      },
      candidate: {
        consistent: true,
        installedReleaseIds: [],
        inboxReleaseIds: ["runtime-1"],
      },
    });
  });

  it("fails the managed audit on missing, tampered and unreceipted inbox content", async () => {
    const missing = await fixture();
    const missingRelease = await candidate(missing, "runtime-1", 1);
    await writeIndex(missing, 1, [missingRelease]);
    await stageRuntimeHostReleaseIndex(stageOptions(missing));
    await safeRemoveFixturePath(
      join(missing.managedRoot, "inbox", "runtime-1"),
    );
    await expect(
      auditManagedRuntimeHostReleaseIndex(auditOptions(missing)),
    ).rejects.toThrow("missing inbox package");

    const tampered = await fixture();
    const tamperedRelease = await candidate(tampered, "runtime-1", 1);
    await writeIndex(tampered, 1, [tamperedRelease]);
    await stageRuntimeHostReleaseIndex(stageOptions(tampered));
    await writeFile(
      join(tampered.managedRoot, "inbox", "runtime-1", "runtime-host.cjs"),
      "console.log('tampered');\n",
      "utf8",
    );
    await expect(
      auditManagedRuntimeHostReleaseIndex(auditOptions(tampered)),
    ).rejects.toThrow(/size or SHA-256/u);

    const orphaned = await fixture();
    const orphanedRelease = await candidate(orphaned, "runtime-1", 1);
    await writeIndex(orphaned, 1, [orphanedRelease]);
    await stageRuntimeHostReleaseIndex(stageOptions(orphaned));
    await cp(
      join(orphaned.managedRoot, "inbox", "runtime-1"),
      join(orphaned.managedRoot, "inbox", "runtime-orphan"),
      { recursive: true },
    );
    await expect(
      auditManagedRuntimeHostReleaseIndex(auditOptions(orphaned)),
    ).rejects.toThrow("unreceipted release");
  });

  it("refuses to audit a managed inbox while an import lock exists", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    await writeIndex(value, 1, [first]);
    await stageRuntimeHostReleaseIndex(stageOptions(value));
    await mkdir(join(value.managedRoot, "import-receipts", ".import-lock"));

    await expect(
      auditManagedRuntimeHostReleaseIndex(auditOptions(value)),
    ).rejects.toThrow("while an import lock exists");
  });

  it("appends a hash-chained receipt while retaining a previously imported release", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    await writeIndex(value, 1, [first]);
    await stageRuntimeHostReleaseIndex(stageOptions(value));
    const second = await candidate(value, "runtime-2", 2);
    await writeIndex(value, 2, [first, second]);

    const result = await stageRuntimeHostReleaseIndex(stageOptions(value));
    const names = await receiptFiles(value);
    const receipts = await Promise.all(
      names
        .sort()
        .map(
          async (name) =>
            JSON.parse(
              await readFile(
                join(value.managedRoot, "import-receipts", name),
                "utf8",
              ),
            ) as { previousReceiptSha256: string | null; releases: unknown[] },
        ),
    );

    expect(result).toMatchObject({
      importedReleaseIds: ["runtime-2"],
      retainedReleaseIds: ["runtime-1"],
    });
    expect(names).toHaveLength(2);
    expect(receipts[0]?.previousReceiptSha256).toBeNull();
    expect(receipts[1]?.previousReceiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipts[1]?.releases).toHaveLength(2);
  });

  it("rejects equivalent publication, conflicting sequence and replay", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    await writeIndex(value, 1, [first]);
    await stageRuntimeHostReleaseIndex(stageOptions(value));

    await writeIndex(value, 2, [first]);
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("equivalent");

    const second = await candidate(value, "runtime-2", 2);
    await writeIndex(value, 1, [second]);
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("conflicts");

    await writeIndex(value, 2, [first, second]);
    await stageRuntimeHostReleaseIndex(stageOptions(value));
    await writeIndex(value, 1, [first]);
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("replay");
  });

  it("rejects expired, wrongly signed and tampered sources before publication", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    await writeIndex(value, 1, [first], { expiresAtUnixMs: NOW - 1 });
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("expired");

    const wrongKey = keyMaterial("wrong-index-key");
    await writeIndex(value, 1, [first], { signingKey: wrongKey });
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("not trusted");

    await writeIndex(value, 1, [first]);
    await writeFile(
      join(first.packageRoot, "runtime-host.cjs"),
      "console.log('tampered');\n",
    );
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("size or SHA-256");
    expect(await receiptFiles(value)).toHaveLength(0);
    expect(await readdir(join(value.managedRoot, "inbox"))).toHaveLength(0);
  });

  it("rejects filesystem roots and overlapping release/managed trees", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    await writeIndex(value, 1, [first]);

    await expect(
      stageRuntimeHostReleaseIndex({
        ...stageOptions(value),
        sourceRoot: parse(value.sourceRoot).root,
      }),
    ).rejects.toThrow("filesystem root");
    await expect(
      stageRuntimeHostReleaseIndex({
        ...stageOptions(value),
        managedRoot: value.sourceRoot,
      }),
    ).rejects.toThrow("must be separate directory trees");
  });

  it("rejects unsafe package paths, source-root trust and junction escapes", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    const unsafe = { ...first, packagePath: "packages/../runtime-1" };
    await writeIndex(value, 1, [unsafe]);
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("unsafe path segment");

    await writeIndex(value, 1, [first]);
    const copiedTrust = join(value.sourceRoot, "runtime-trusted.json");
    await cp(value.runtimeTrustPath, copiedTrust);
    await expect(
      stageRuntimeHostReleaseIndex({
        ...stageOptions(value),
        runtimeTrustedKeysPath: copiedTrust,
      }),
    ).rejects.toThrow("untrusted release source");

    const outside = join(value.root, "outside", "runtime-junction");
    await mkdir(outside, { recursive: true });
    await cp(
      join(first.packageRoot, "envelope.json"),
      join(outside, "envelope.json"),
    );
    await cp(
      join(first.packageRoot, "runtime-host.cjs"),
      join(outside, "runtime-host.cjs"),
    );
    await safeRemoveFixturePath(first.packageRoot);
    await symlink(
      outside,
      first.packageRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("symbolic link or junction");
  });

  it("rejects hard-linked trust registries before accepting release authority", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    await writeIndex(value, 1, [first]);
    const hardLinkPath = join(value.trustRoot, "index-trusted-hardlink.json");
    await link(value.indexTrustPath, hardLinkPath);

    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("unshared regular file");
    expect(await receiptFiles(value)).toHaveLength(0);
  });

  it("fails closed on an active lock and a broken receipt chain", async () => {
    const value = await fixture();
    const first = await candidate(value, "runtime-1", 1);
    await writeIndex(value, 1, [first]);
    const receiptRoot = join(value.managedRoot, "import-receipts");
    await mkdir(receiptRoot);
    await mkdir(join(receiptRoot, ".import-lock"));
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow("active or requires operator review");
    await rm(join(receiptRoot, ".import-lock"), {
      recursive: true,
      force: true,
    });

    await stageRuntimeHostReleaseIndex(stageOptions(value));
    const [receiptName] = await receiptFiles(value);
    if (receiptName === undefined)
      throw new Error("Receipt fixture is missing");
    const receiptPath = join(receiptRoot, receiptName);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      importedAtUnixMs: number;
    };
    receipt.importedAtUnixMs += 1;
    await writeCanonical(receiptPath, receipt);
    const second = await candidate(value, "runtime-2", 2);
    await writeIndex(value, 2, [first, second]);
    await expect(
      stageRuntimeHostReleaseIndex(stageOptions(value)),
    ).rejects.toThrow(/ID does not match|chain is broken/u);
  });
});
