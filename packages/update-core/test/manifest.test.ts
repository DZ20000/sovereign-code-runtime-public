import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertReleaseCompatibility,
  canonicalReleaseJson,
  parseReleaseManifest,
  releaseSignaturePayload,
  releaseSha256,
  resolveCandidateComponentPath,
  validateReleaseComponentPath,
  verifyReleaseInventory,
  verifySignedReleaseEnvelope,
  type ReleaseManifest,
  type ReleaseSignatureEnvelope,
  type TrustedReleasePublicKey,
  type UpdateHostCompatibility,
} from "../src/manifest.js";

const shellSha = "a".repeat(64);
const runtimeSha = "b".repeat(64);

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schemaVersion: "scr.release/v1",
    releaseId: "release-0002",
    releaseSequence: 2,
    version: "0.2.0",
    channel: "stable",
    createdAt: "2026-08-14T00:00:00.000Z",
    entrypoint: "SovereignCodeRuntime.exe",
    totalBytes: 300,
    components: [
      {
        path: "SovereignCodeRuntime.exe",
        sha256: shellSha,
        bytes: 100,
        role: "shell",
      },
      {
        path: "runtime-host.cjs",
        sha256: runtimeSha,
        bytes: 200,
        role: "runtime-host",
      },
    ],
    compatibility: {
      minimumBootstrapVersion: "0.1.0",
      maximumBootstrapVersion: "0.9.0",
      runtimeHostProtocolVersion: 1,
      preCommitDataPolicy: "backward-compatible",
      dataSchemas: {
        settings: { readableMin: 1, readableMax: 2, writeVersion: 2 },
        audit: { readableMin: 1, readableMax: 2, writeVersion: 1 },
        runs: { readableMin: 1, readableMax: 2, writeVersion: 1 },
      },
    },
    ...overrides,
  };
}

function host(overrides: Partial<UpdateHostCompatibility> = {}): UpdateHostCompatibility {
  return {
    bootstrapVersion: "0.1.0",
    runtimeHostProtocolVersion: 1,
    activeReleaseSequence: 1,
    currentDataSchemas: {
      settings: 1,
      audit: 1,
      runs: 1,
    },
    lastKnownGoodReadableSchemas: {
      settings: { min: 1, max: 2 },
      audit: { min: 1, max: 2 },
      runs: { min: 1, max: 2 },
    },
    ...overrides,
  };
}

function trustedKey(
  publicKey: KeyObject,
  overrides: Partial<TrustedReleasePublicKey> = {},
): TrustedReleasePublicKey {
  return {
    keyId: "release-key-1",
    algorithm: "ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    minimumReleaseSequence: 1,
    maximumReleaseSequence: null,
    allowedChannels: ["stable"],
    ...overrides,
  };
}

function signedEnvelope(
  releaseManifest: ReleaseManifest,
  privateKey: KeyObject,
  keyId = "release-key-1",
): ReleaseSignatureEnvelope {
  const parsed = parseReleaseManifest(releaseManifest);
  const digest = releaseSha256(canonicalReleaseJson(parsed));
  return {
    schemaVersion: "scr.release-signature/v1",
    algorithm: "ed25519",
    keyId,
    manifestSha256: digest,
    signature: sign(null, releaseSignaturePayload(digest), privateKey).toString("base64url"),
    manifest: parsed,
  };
}

describe("signed release manifest verification", () => {
  it("verifies a canonical Ed25519 release envelope", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const envelope = signedEnvelope(manifest(), privateKey);
    const verified = verifySignedReleaseEnvelope(envelope, [trustedKey(publicKey)]);

    expect(verified.signingKeyId).toBe("release-key-1");
    expect(verified.envelope.manifest.releaseSequence).toBe(2);
    expect(verified.envelope.manifest.components).toHaveLength(2);
  });

  it("canonicalizes object keys with ordinal ordering", () => {
    expect(canonicalReleaseJson({ z: 1, A: 2, a: 3 })).toBe('{"A":2,"a":3,"z":1}');
  });

  it("rejects unsigned, unknown-key, private-key, bad-digest, and bad-signature envelopes", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const envelope = signedEnvelope(manifest(), privateKey);
    const wrongSignature = signedEnvelope(manifest(), other.privateKey).signature;

    expect(() => verifySignedReleaseEnvelope({ manifest: envelope.manifest }, [trustedKey(publicKey)]))
      .toThrow(/Unsigned|unsupported/u);
    expect(() => verifySignedReleaseEnvelope({ ...envelope, keyId: "unknown-key" }, [trustedKey(publicKey)]))
      .toThrow(/unknown/u);
    expect(() => verifySignedReleaseEnvelope(envelope, [trustedKey(publicKey, {
      publicKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    })])).toThrow(/public-key PEM only/u);
    expect(() => verifySignedReleaseEnvelope({
      ...envelope,
      manifestSha256: "c".repeat(64),
    }, [trustedKey(publicKey)])).toThrow(/digest does not match/u);
    expect(() => verifySignedReleaseEnvelope({
      ...envelope,
      signature: wrongSignature,
    }, [trustedKey(publicKey)])).toThrow(/verification failed/u);
  });

  it("rejects noncanonical signature encoding and unknown signed fields", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const envelope = signedEnvelope(manifest(), privateKey);
    expect(() => verifySignedReleaseEnvelope({
      ...envelope,
      signature: `${envelope.signature}=`,
    }, [trustedKey(publicKey)])).toThrow(/canonical/u);
    expect(() => verifySignedReleaseEnvelope({
      ...envelope,
      unsignedComment: "not covered by the manifest digest",
    }, [trustedKey(publicKey)])).toThrow(/unknown field/u);
    expect(() => verifySignedReleaseEnvelope({
      ...envelope,
      manifest: { ...envelope.manifest, unexpected: true },
    }, [trustedKey(publicKey)])).toThrow(/unknown field/u);
  });

  it("enforces signing-key release-sequence and channel policies", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const envelope = signedEnvelope(manifest(), privateKey);
    expect(() => verifySignedReleaseEnvelope(envelope, [trustedKey(publicKey, {
      minimumReleaseSequence: 3,
    })])).toThrow(/outside the trusted key/u);
    expect(() => verifySignedReleaseEnvelope(envelope, [trustedKey(publicKey, {
      maximumReleaseSequence: 1,
    })])).toThrow(/outside the trusted key/u);
    expect(() => verifySignedReleaseEnvelope(envelope, [trustedKey(publicKey, {
      allowedChannels: ["beta"],
    })])).toThrow(/channel is not allowed/u);
    expect(() => verifySignedReleaseEnvelope(envelope, [
      trustedKey(publicKey),
      trustedKey(publicKey),
    ])).toThrow(/duplicated/u);
  });

  it("rejects public-key PEM containing multiple keys or appended text", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const envelope = signedEnvelope(manifest(), privateKey);
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const otherPem = other.publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(() => verifySignedReleaseEnvelope(envelope, [trustedKey(publicKey, {
      publicKeyPem: `${publicPem}${otherPem}`,
    })])).toThrow(/exactly one canonical SPKI/u);
    expect(() => verifySignedReleaseEnvelope(envelope, [trustedKey(publicKey, {
      publicKeyPem: `${publicPem}comment`,
    })])).toThrow(/exactly one canonical SPKI/u);
  });
});

describe("release schema, path, and inventory validation", () => {
  it("requires canonical UTC creation time and strict release versions", () => {
    expect(() => parseReleaseManifest(manifest({
      createdAt: "2026-08-14T08:00:00+08:00",
    }))).toThrow(/canonical UTC/u);
    expect(() => parseReleaseManifest(manifest({
      createdAt: "2026-02-30T00:00:00.000Z",
    }))).toThrow(/real canonical/u);
    expect(() => parseReleaseManifest(manifest({ version: "01.2.3" })))
      .toThrow(/leading zeros/u);
    expect(() => parseReleaseManifest(manifest({ version: "1.2.3-01" })))
      .toThrow(/leading zeros/u);
    expect(() => parseReleaseManifest(manifest({ version: "1.2.3-rc-good?bad" })))
      .toThrow(/invalid characters/u);
    expect(() => parseReleaseManifest(manifest({ version: "1.2.3-rc.1" }))).not.toThrow();
  });

  for (const invalid of [
    "../escape.exe",
    "/absolute.exe",
    "C:/drive.exe",
    "\\\\server\\share\\file.exe",
    "folder\\file.exe",
    "folder//file.exe",
    "folder/./file.exe",
    "folder/../file.exe",
    "CON",
    "folder/NUL.txt",
    "folder/trailing.",
  ]) {
    it(`rejects invalid component path ${JSON.stringify(invalid)}`, () => {
      expect(() => validateReleaseComponentPath(invalid)).toThrow();
    });
  }

  it("rejects unknown component and compatibility fields", () => {
    const release = manifest();
    expect(() => parseReleaseManifest({
      ...release,
      components: [
        { ...release.components[0], optional: true },
        release.components[1],
      ],
    })).toThrow(/unknown field/u);
    expect(() => parseReleaseManifest({
      ...release,
      compatibility: {
        ...release.compatibility,
        dataSchemas: {
          ...release.compatibility.dataSchemas,
          settings: {
            ...release.compatibility.dataSchemas.settings,
            migrationScript: "do-not-accept-unsigned-semantics",
          },
        },
      },
    })).toThrow(/unknown field/u);
  });

  it("reserves the update-slot metadata directory", () => {
    expect(() => validateReleaseComponentPath(".scr-update/ready.json"))
      .toThrow(/reserved update-slot metadata/u);
    expect(() => validateReleaseComponentPath(".SCR-UPDATE/envelope.json"))
      .toThrow(/reserved update-slot metadata/u);
  });

  it("rejects a component path used as another component's directory", () => {
    expect(() => parseReleaseManifest(manifest({
      totalBytes: 301,
      components: [
        ...manifest().components,
        {
          path: "runtime-host.cjs/source.map",
          sha256: "d".repeat(64),
          bytes: 1,
          role: "resource",
        },
      ],
    }))).toThrow(/used as a directory/u);
  });

  it("rejects case-insensitive duplicate component paths", () => {
    expect(() => parseReleaseManifest(manifest({
      totalBytes: 400,
      components: [
        ...manifest().components,
        {
          path: "runtime-HOST.cjs",
          sha256: "d".repeat(64),
          bytes: 100,
          role: "resource",
        },
      ],
    }))).toThrow(/duplicated/u);
  });

  it("resolves components only below an absolute local slot root", () => {
    expect(resolveCandidateComponentPath(
      "C:\\Users\\Example\\AppData\\Local\\Sovereign\\slots\\release-0002",
      "native/bin/SovereignNativeAgent.exe",
    )).toBe(
      "C:\\Users\\Example\\AppData\\Local\\Sovereign\\slots\\release-0002\\native\\bin\\SovereignNativeAgent.exe",
    );
    expect(() => resolveCandidateComponentPath("relative\\slot", "runtime-host.cjs"))
      .toThrow(/absolute local Windows drive/u);
    expect(() => resolveCandidateComponentPath("C:\\safe\\slot", "../escape.exe"))
      .toThrow(/traversal/u);
  });

  it("rejects missing, extra, path-case, hash, and size inventory mismatches", () => {
    const releaseManifest = manifest();
    const validInventory = [
      { path: "SovereignCodeRuntime.exe", sha256: shellSha, bytes: 100 },
      { path: "runtime-host.cjs", sha256: runtimeSha, bytes: 200 },
    ];
    expect(() => verifyReleaseInventory(releaseManifest, validInventory)).not.toThrow();
    expect(() => verifyReleaseInventory(releaseManifest, validInventory.slice(0, 1)))
      .toThrow(/missing or extra/u);
    expect(() => verifyReleaseInventory(releaseManifest, [
      ...validInventory,
      { path: "extra.txt", sha256: "e".repeat(64), bytes: 1 },
    ])).toThrow(/missing or extra/u);
    expect(() => verifyReleaseInventory(releaseManifest, [
      validInventory[0]!,
      { ...validInventory[1]!, path: "Runtime-Host.cjs" },
    ])).toThrow(/path casing/u);
    expect(() => verifyReleaseInventory(releaseManifest, [
      { ...validInventory[0]!, sha256: "f".repeat(64) },
      validInventory[1]!,
    ])).toThrow(/SHA-256 mismatch/u);
    expect(() => verifyReleaseInventory(releaseManifest, [
      { ...validInventory[0]!, bytes: 101 },
      validInventory[1]!,
    ])).toThrow(/byte length mismatch/u);
  });
});

describe("release compatibility", () => {
  it("accepts a newer rollback-safe candidate", () => {
    expect(() => assertReleaseCompatibility(manifest(), host())).not.toThrow();
  });

  it("blocks downgrade, bootstrap, protocol, candidate-read, and rollback-read incompatibility", () => {
    expect(() => assertReleaseCompatibility(manifest({ releaseSequence: 1 }), host()))
      .toThrow(/greater than the active/u);
    expect(() => assertReleaseCompatibility(manifest(), host({ bootstrapVersion: "0.0.9" })))
      .toThrow(/newer stable bootstrap/u);
    expect(() => assertReleaseCompatibility(manifest(), host({ runtimeHostProtocolVersion: 2 })))
      .toThrow(/protocol version/u);
    expect(() => assertReleaseCompatibility(manifest({
      compatibility: {
        ...manifest().compatibility,
        dataSchemas: {
          ...manifest().compatibility.dataSchemas,
          settings: { readableMin: 2, readableMax: 3, writeVersion: 2 },
        },
      },
    }), host())).toThrow(/cannot read the current settings/u);
    expect(() => assertReleaseCompatibility(manifest(), host({
      lastKnownGoodReadableSchemas: {
        ...host().lastKnownGoodReadableSchemas,
        settings: { min: 1, max: 1 },
      },
    }))).toThrow(/Last-known-good cannot read the candidate/u);
  });

  it("validates host schema ranges before comparing the candidate", () => {
    expect(() => assertReleaseCompatibility(manifest(), host({
      currentDataSchemas: { settings: -1, audit: 1, runs: 1 },
    }))).toThrow(/Current settings schema/u);
    expect(() => assertReleaseCompatibility(manifest(), host({
      lastKnownGoodReadableSchemas: {
        ...host().lastKnownGoodReadableSchemas,
        settings: { min: 3, max: 2 },
      },
    }))).toThrow(/inverted/u);
    expect(() => assertReleaseCompatibility(manifest(), host({
      currentDataSchemas: { settings: 2, audit: 1, runs: 1 },
      lastKnownGoodReadableSchemas: {
        ...host().lastKnownGoodReadableSchemas,
        settings: { min: 1, max: 1 },
      },
    }))).toThrow(/current settings/u);
  });
});
