import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RENDERER_MANIFEST_SCHEMA_VERSION,
  RENDERER_SIGNATURE_SCHEMA_VERSION,
  RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
  rendererManifestDigest,
  rendererSignaturePayload,
  type RendererReleaseManifest,
  type RendererReleaseSignatureEnvelope,
} from "@sovereign/update-core";
import { afterEach, describe, expect, it } from "vitest";

import { readInstalledRendererState } from "../scripts/installed-renderer-state-audit.mjs";

const roots: string[] = [];

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, jsonBytes(value));
}

async function fixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "scr-installed-renderer-"));
  roots.push(fixtureRoot);
  const appDataPath = join(fixtureRoot, "AppData");
  await mkdir(appDataPath);

  const identifier = "com.sovereign.runtime";
  const releaseId = "renderer-fixture-42";
  const updatesRoot = join(appDataPath, identifier, "renderer-updates");
  const stateRoot = join(updatesRoot, "state");
  const slotRoot = join(updatesRoot, "slots", releaseId);
  const metadataRoot = join(slotRoot, ".scr-renderer");
  const assetsRoot = join(slotRoot, "assets");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(metadataRoot, { recursive: true });
  await mkdir(assetsRoot, { recursive: true });

  const entrypoint = "index.html";
  const entrypointBytes = Buffer.from(
    "<!doctype html><title>Sovereign</title>\n",
  );
  const assetBytes = Buffer.from("console.log('sovereign');\n");
  const entrypointPath = join(slotRoot, entrypoint);
  const assetPath = join(assetsRoot, "main.js");
  await writeFile(entrypointPath, entrypointBytes);
  await writeFile(assetPath, assetBytes);

  const component = (path: string, bytes: Buffer) => ({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
  const components = [
    component(entrypoint, entrypointBytes),
    component("assets/main.js", assetBytes),
  ];
  const manifest: RendererReleaseManifest = {
    schemaVersion: RENDERER_MANIFEST_SCHEMA_VERSION,
    releaseId,
    releaseSequence: 42,
    version: "0.1.10",
    channel: "development",
    createdAt: "2026-08-29T00:00:00.000Z",
    entrypoint,
    totalBytes: components.reduce((total, value) => total + value.bytes, 0),
    components,
    compatibility: {
      minimumShellVersion: "0.1.0",
      maximumShellVersion: null,
      bridgeApiVersion: 1,
    },
  };
  const manifestSha256 = rendererManifestDigest(manifest);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "renderer-fixture-key";
  const envelope: RendererReleaseSignatureEnvelope = {
    schemaVersion: RENDERER_SIGNATURE_SCHEMA_VERSION,
    algorithm: "ed25519",
    keyId,
    manifestSha256,
    signature: sign(
      null,
      rendererSignaturePayload(manifestSha256),
      privateKey,
    ).toString("base64url"),
    manifest,
  };
  const release = {
    releaseId,
    releaseSequence: manifest.releaseSequence,
    version: manifest.version,
    channel: manifest.channel,
    manifestSha256,
  };

  const trustedKeysPath = join(fixtureRoot, "renderer-trusted-keys.json");
  await writeJson(trustedKeysPath, {
    schemaVersion: RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
    keys: [
      {
        keyId,
        algorithm: "ed25519",
        publicKeyPem: publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
        minimumReleaseSequence: 1,
        maximumReleaseSequence: null,
        allowedChannels: ["development"],
      },
    ],
  });

  const readyPath = join(metadataRoot, "ready.json");
  const ready = {
    schemaVersion: "scr.renderer-slot-ready/v1",
    installedAtUnixMs: 1_787_000_000_000,
    release,
  };
  await writeJson(readyPath, ready);
  const envelopePath = join(metadataRoot, "envelope.json");
  await writeJson(envelopePath, envelope);

  const firstState = {
    activeRelease: null,
    highestReleaseSequence: 0,
    lastFailure: null,
    lastKnownGoodRelease: null,
    previousStateSha256: null,
    schemaVersion: "scr.renderer-state/v1",
    storageRevision: 1,
    updatedAtUnixMs: 1_787_000_000_000,
  };
  const firstStatePath = join(stateRoot, "revision-00000000000000000001.json");
  await writeJson(firstStatePath, firstState);

  const state = {
    activeRelease: release,
    highestReleaseSequence: 42,
    lastFailure: null,
    lastKnownGoodRelease: null,
    previousStateSha256: createHash("sha256")
      .update(jsonBytes(firstState))
      .digest("hex"),
    schemaVersion: "scr.renderer-state/v1",
    storageRevision: 2,
    updatedAtUnixMs: 1_787_000_000_100,
  };
  const statePath = join(stateRoot, "revision-00000000000000000002.json");
  await writeJson(statePath, state);

  return {
    appDataPath,
    identifier,
    updatesRoot,
    trustedKeysPath,
    keyId,
    privateKey,
    stateRoot,
    firstStatePath,
    firstState,
    statePath,
    state,
    slotRoot,
    metadataRoot,
    readyPath,
    ready,
    entrypointPath,
    entrypointBytes,
    assetPath,
    assetBytes,
    envelopePath,
    envelope,
  };
}

function auditOptions(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    appDataPath: value.appDataPath,
    identifier: value.identifier,
    trustedKeysPath: value.trustedKeysPath,
  };
}

async function addLastKnownGoodRelease(
  value: Awaited<ReturnType<typeof fixture>>,
) {
  const releaseId = "renderer-fixture-41";
  const slotRoot = join(value.updatesRoot, "slots", releaseId);
  const metadataRoot = join(slotRoot, ".scr-renderer");
  const assetsRoot = join(slotRoot, "assets");
  await mkdir(metadataRoot, { recursive: true });
  await mkdir(assetsRoot, { recursive: true });

  const entrypointBytes = Buffer.from(
    "<!doctype html><title>Rollback</title>\n",
  );
  const assetBytes = Buffer.from("console.log('rollback');\n");
  const entrypointPath = join(slotRoot, "index.html");
  const assetPath = join(assetsRoot, "main.js");
  await writeFile(entrypointPath, entrypointBytes);
  await writeFile(assetPath, assetBytes);
  const components = [
    {
      path: "index.html",
      sha256: createHash("sha256").update(entrypointBytes).digest("hex"),
      bytes: entrypointBytes.length,
    },
    {
      path: "assets/main.js",
      sha256: createHash("sha256").update(assetBytes).digest("hex"),
      bytes: assetBytes.length,
    },
  ];
  const manifest: RendererReleaseManifest = {
    schemaVersion: RENDERER_MANIFEST_SCHEMA_VERSION,
    releaseId,
    releaseSequence: 41,
    version: "0.1.9",
    channel: "development",
    createdAt: "2026-08-28T23:59:00.000Z",
    entrypoint: "index.html",
    totalBytes: components.reduce(
      (total, component) => total + component.bytes,
      0,
    ),
    components,
    compatibility: {
      minimumShellVersion: "0.1.0",
      maximumShellVersion: null,
      bridgeApiVersion: 1,
    },
  };
  const manifestSha256 = rendererManifestDigest(manifest);
  const envelope: RendererReleaseSignatureEnvelope = {
    schemaVersion: RENDERER_SIGNATURE_SCHEMA_VERSION,
    algorithm: "ed25519",
    keyId: value.keyId,
    manifestSha256,
    signature: sign(
      null,
      rendererSignaturePayload(manifestSha256),
      value.privateKey,
    ).toString("base64url"),
    manifest,
  };
  const release = {
    releaseId,
    releaseSequence: 41,
    version: "0.1.9",
    channel: "development",
    manifestSha256,
  };
  await writeJson(join(metadataRoot, "ready.json"), {
    schemaVersion: "scr.renderer-slot-ready/v1",
    installedAtUnixMs: 1_786_999_900_000,
    release,
  });
  await writeJson(join(metadataRoot, "envelope.json"), envelope);
  await writeJson(value.statePath, {
    ...value.state,
    lastKnownGoodRelease: release,
  });
  return { release, slotRoot, entrypointPath, assetPath, assetBytes };
}

function sameLengthTamper(bytes: Buffer): Buffer {
  const tampered = Buffer.from(bytes);
  tampered[0] = tampered[0] === 0 ? 1 : tampered[0]! ^ 1;
  return tampered;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("installed Renderer state audit", () => {
  it("accepts a verified built-in active state without custom-slot evidence", async () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const value = await fixture();
      await rm(value.statePath);
      await rm(value.slotRoot, { recursive: true, force: true });
      await rm(value.trustedKeysPath);

      const report = await readInstalledRendererState(auditOptions(value));
      expect(report).toMatchObject({
        available: true,
        consistent: true,
        stateFile: "revision-00000000000000000001.json",
        stateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        stateJournalVerified: true,
        stateRevisionCount: 1,
        stateJournalBytes: expect.any(Number),
        storageRevision: 1,
        activeRelease: null,
        readyRelease: null,
        readyMarkerVerified: false,
        readyInstalledAtUnixMs: null,
        envelopeRelease: null,
        highestReleaseSequence: 0,
        lastKnownGoodRelease: null,
        entrypoint: null,
        entrypointMatched: false,
        signingKeyId: null,
        signatureVerified: false,
        inventoryVerified: false,
        componentCount: 0,
        verifiedComponentCount: 0,
        problems: [],
      });
    }
  });

  it("verifies state, ready marker, Ed25519 envelope and every component", async () => {
    const value = await fixture();
    await expect(
      readInstalledRendererState(auditOptions(value)),
    ).resolves.toMatchObject({
      available: true,
      consistent: true,
      stateFile: "revision-00000000000000000002.json",
      stateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      stateJournalVerified: true,
      stateRevisionCount: 2,
      stateJournalBytes: expect.any(Number),
      storageRevision: 2,
      activeRelease: { releaseId: "renderer-fixture-42" },
      readyRelease: { releaseId: "renderer-fixture-42" },
      readyMarkerVerified: true,
      readyInstalledAtUnixMs: 1_787_000_000_000,
      envelopeRelease: { releaseId: "renderer-fixture-42" },
      entrypoint: "index.html",
      entrypointMatched: true,
      signingKeyId: "renderer-fixture-key",
      signatureVerified: true,
      inventoryVerified: true,
      componentCount: 2,
      verifiedComponentCount: 2,
      trustedKeysPath: value.trustedKeysPath,
      problems: [],
    });
  });

  it("verifies the last-known-good rollback slot before accepting it", async () => {
    const value = await fixture();
    const rollback = await addLastKnownGoodRelease(value);
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report).toMatchObject({
      consistent: true,
      lastKnownGoodRelease: { releaseId: rollback.release.releaseId },
      lastKnownGoodSlot: {
        verified: true,
        readyRelease: { releaseId: rollback.release.releaseId },
        readyMarkerVerified: true,
        signatureVerified: true,
        inventoryVerified: true,
        componentCount: 2,
        verifiedComponentCount: 2,
        entrypointMatched: true,
      },
      problems: [],
    });
  });

  it("fails closed when the last-known-good rollback slot is tampered", async () => {
    const value = await fixture();
    const rollback = await addLastKnownGoodRelease(value);
    await writeFile(rollback.assetPath, sameLengthTamper(rollback.assetBytes));
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report).toMatchObject({
      consistent: false,
      lastKnownGoodRelease: { releaseId: rollback.release.releaseId },
      lastKnownGoodSlot: {
        verified: false,
        signatureVerified: true,
        inventoryVerified: false,
        verifiedComponentCount: 1,
      },
    });
    expect(
      report.problems.some((problem) =>
        problem.includes(
          "Last-known-good Renderer inventory verification failed: Renderer component SHA-256 mismatch: assets/main.js",
        ),
      ),
    ).toBe(true);
  });

  it("reports a same-length entrypoint digest mismatch", async () => {
    const value = await fixture();
    await writeFile(
      value.entrypointPath,
      sameLengthTamper(value.entrypointBytes),
    );
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report).toMatchObject({
      consistent: false,
      signatureVerified: true,
      inventoryVerified: false,
      entrypointMatched: false,
      verifiedComponentCount: 1,
    });
    expect(report.problems).toContain(
      "Active Renderer entrypoint digest does not match its manifest.",
    );
    expect(
      report.problems.some((problem) =>
        problem.includes("Renderer component SHA-256 mismatch: index.html"),
      ),
    ).toBe(true);
  });

  it("detects tampering outside the entrypoint", async () => {
    const value = await fixture();
    await writeFile(value.assetPath, sameLengthTamper(value.assetBytes));
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report).toMatchObject({
      consistent: false,
      signatureVerified: true,
      inventoryVerified: false,
      entrypointMatched: true,
      verifiedComponentCount: 1,
    });
    expect(
      report.problems.some((problem) =>
        problem.includes("Renderer component SHA-256 mismatch: assets/main.js"),
      ),
    ).toBe(true);
  });

  it("rejects unmanifested slot content", async () => {
    const value = await fixture();
    await writeFile(join(value.slotRoot, "unexpected.txt"), "unexpected\n");
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report.consistent).toBe(false);
    expect(report.inventoryVerified).toBe(false);
    expect(report.problems).toContain(
      "Active Renderer slot contains an unmanifested component: unexpected.txt.",
    );
  });

  it("rejects executable content hidden in the unsigned metadata directory", async () => {
    const value = await fixture();
    await writeFile(
      join(value.metadataRoot, "unsigned-runtime.js"),
      "console.log('unsigned');\n",
    );
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report.consistent).toBe(false);
    expect(report.problems).toContain(
      "Active Renderer metadata contains an unexpected entry: unsigned-runtime.js.",
    );
  });

  it("rejects unknown ready-marker fields and invalid installation timestamps", async () => {
    const unknownField = await fixture();
    await writeJson(unknownField.readyPath, {
      ...unknownField.ready,
      untrustedField: true,
    });
    const unknownReport = await readInstalledRendererState(
      auditOptions(unknownField),
    );
    expect(unknownReport.readyMarkerVerified).toBe(false);
    expect(
      unknownReport.problems.some((problem) =>
        problem.includes(
          "ready marker fields do not match the persisted schema",
        ),
      ),
    ).toBe(true);

    const invalidTimestamp = await fixture();
    await writeJson(invalidTimestamp.readyPath, {
      ...invalidTimestamp.ready,
      installedAtUnixMs: 0,
    });
    const timestampReport = await readInstalledRendererState(
      auditOptions(invalidTimestamp),
    );
    expect(timestampReport.readyMarkerVerified).toBe(false);
    expect(
      timestampReport.problems.some((problem) =>
        problem.includes("ready marker installedAtUnixMs is invalid"),
      ),
    ).toBe(true);
  });

  it("rejects an envelope whose signature no longer verifies", async () => {
    const value = await fixture();
    const signature = value.envelope.signature;
    const replacement = signature.startsWith("A") ? "B" : "A";
    await writeJson(value.envelopePath, {
      ...value.envelope,
      signature: `${replacement}${signature.slice(1)}`,
    });
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report).toMatchObject({
      consistent: false,
      signatureVerified: false,
      inventoryVerified: false,
      componentCount: 0,
    });
    expect(report.problems).toContain(
      "Active Renderer signature verification failed: Renderer signature verification failed.",
    );
  });

  it("treats release channel drift as an identity mismatch", async () => {
    const value = await fixture();
    await writeJson(value.statePath, {
      ...value.state,
      activeRelease: { ...value.state.activeRelease, channel: "stable" },
    });
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report.consistent).toBe(false);
    expect(report.problems).toContain(
      "Active Renderer ready marker does not match state.",
    );
    expect(report.problems).toContain(
      "Active Renderer envelope does not match state.",
    );
  });

  it("rejects a broken immutable state hash chain", async () => {
    const value = await fixture();
    await writeJson(value.statePath, {
      ...value.state,
      previousStateSha256: "f".repeat(64),
    });
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report).toMatchObject({
      consistent: false,
      stateJournalVerified: false,
      stateRevisionCount: 2,
      storageRevision: null,
    });
    expect(
      report.problems.some((problem) =>
        problem.includes("hash chain is invalid"),
      ),
    ).toBe(true);
  });

  it("rejects missing or malformed revision sequences", async () => {
    const value = await fixture();
    await rm(value.firstStatePath);
    const report = await readInstalledRendererState(auditOptions(value));
    expect(report.stateJournalVerified).toBe(false);
    expect(
      report.problems.some((problem) =>
        problem.includes("missing or malformed revision"),
      ),
    ).toBe(true);
  });

  it("rejects unknown state fields and impossible release counters", async () => {
    const unknownField = await fixture();
    await writeJson(unknownField.statePath, {
      ...unknownField.state,
      untrustedField: true,
    });
    const unknownReport = await readInstalledRendererState(
      auditOptions(unknownField),
    );
    expect(unknownReport.stateJournalVerified).toBe(false);
    expect(
      unknownReport.problems.some((problem) =>
        problem.includes("fields do not match the persisted schema"),
      ),
    ).toBe(true);

    const badCounter = await fixture();
    await writeJson(badCounter.statePath, {
      ...badCounter.state,
      highestReleaseSequence: 41,
    });
    const counterReport = await readInstalledRendererState(
      auditOptions(badCounter),
    );
    expect(counterReport.stateJournalVerified).toBe(false);
    expect(
      counterReport.problems.some((problem) =>
        problem.includes("below a referenced release"),
      ),
    ).toBe(true);
  });

  it("reports incomplete or unexpected state-directory entries", async () => {
    const pending = await fixture();
    await writeFile(join(pending.stateRoot, ".pending-3.tmp"), "pending\n");
    const pendingReport = await readInstalledRendererState(
      auditOptions(pending),
    );
    expect(pendingReport).toMatchObject({
      consistent: false,
      stateJournalVerified: true,
      storageRevision: 2,
    });
    expect(pendingReport.problems).toContain(
      "Renderer state root contains an incomplete pending revision: .pending-3.tmp.",
    );

    const unexpected = await fixture();
    await writeFile(join(unexpected.stateRoot, "notes.txt"), "notes\n");
    const unexpectedReport = await readInstalledRendererState(
      auditOptions(unexpected),
    );
    expect(unexpectedReport.stateJournalVerified).toBe(true);
    expect(unexpectedReport.problems).toContain(
      "Renderer state root contains an unexpected entry: notes.txt.",
    );
  });

  it("refuses shared state and trust-registry files", async () => {
    const sharedState = await fixture();
    await link(sharedState.statePath, `${sharedState.statePath}.shared`);
    await expect(
      readInstalledRendererState(auditOptions(sharedState)),
    ).rejects.toThrow("one bounded direct regular file");

    const sharedTrust = await fixture();
    await link(
      sharedTrust.trustedKeysPath,
      `${sharedTrust.trustedKeysPath}.shared`,
    );
    const report = await readInstalledRendererState(auditOptions(sharedTrust));
    expect(report.consistent).toBe(false);
    expect(
      report.problems.some((problem) =>
        problem.includes("Installed Renderer trusted-key registry is invalid"),
      ),
    ).toBe(true);
  });

  it("requires an absolute trusted-key registry path", async () => {
    const value = await fixture();
    await expect(
      readInstalledRendererState({
        appDataPath: value.appDataPath,
        identifier: value.identifier,
        trustedKeysPath: "renderer-trusted-keys.json",
      }),
    ).rejects.toThrow("must be absolute");
  });

  it("reports a missing application data root without creating it", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "scr-renderer-missing-"));
    roots.push(fixtureRoot);
    const appDataPath = join(fixtureRoot, "AppData");
    await mkdir(appDataPath);
    await expect(
      readInstalledRendererState({
        appDataPath,
        identifier: "com.sovereign.runtime",
        trustedKeysPath: join(fixtureRoot, "renderer-trusted-keys.json"),
      }),
    ).resolves.toEqual({
      available: false,
      consistent: false,
      problems: ["Installed application data root is missing."],
    });
  });
});
