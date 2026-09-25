import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RENDERER_MANIFEST_SCHEMA_VERSION,
  RENDERER_SIGNATURE_SCHEMA_VERSION,
  RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
  assertRendererCompatibility,
  canonicalRendererJson,
  createRendererReleaseManifest,
  parseRendererReleaseManifest,
  parseRendererTrustedKeyRegistry,
  rendererManifestDigest,
  rendererSha256,
  rendererSignaturePayload,
  validateRendererComponentPath,
  verifyRendererInventory,
  verifySignedRendererReleaseEnvelope,
  type RendererHostCompatibility,
  type RendererReleaseManifest,
  type RendererReleaseSignatureEnvelope,
} from "../src/renderer.js";
import type { TrustedReleasePublicKey } from "../src/manifest.js";

const htmlSha = "a".repeat(64);
const scriptSha = "b".repeat(64);

function manifest(
  overrides: Partial<RendererReleaseManifest> = {},
): RendererReleaseManifest {
  return {
    schemaVersion: RENDERER_MANIFEST_SCHEMA_VERSION,
    releaseId: "renderer-0002",
    releaseSequence: 2,
    version: "0.2.0",
    channel: "stable",
    createdAt: "2026-08-23T00:00:00.000Z",
    entrypoint: "index.html",
    totalBytes: 300,
    components: [
      { path: "index.html", sha256: htmlSha, bytes: 100 },
      { path: "assets/main.js", sha256: scriptSha, bytes: 200 },
    ],
    compatibility: {
      minimumShellVersion: "0.1.0",
      maximumShellVersion: "0.9.0",
      bridgeApiVersion: 1,
    },
    ...overrides,
  };
}

function host(
  overrides: Partial<RendererHostCompatibility> = {},
): RendererHostCompatibility {
  return {
    shellVersion: "0.1.0",
    bridgeApiVersion: 1,
    highestReleaseSequence: 1,
    ...overrides,
  };
}

function trustedKey(
  publicKey: KeyObject,
  overrides: Partial<TrustedReleasePublicKey> = {},
): TrustedReleasePublicKey {
  return {
    keyId: "renderer-key-1",
    algorithm: "ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    minimumReleaseSequence: 1,
    maximumReleaseSequence: null,
    allowedChannels: ["stable"],
    ...overrides,
  };
}

function signedEnvelope(
  rendererManifest: RendererReleaseManifest,
  privateKey: KeyObject,
  keyId = "renderer-key-1",
): RendererReleaseSignatureEnvelope {
  const parsed = parseRendererReleaseManifest(rendererManifest);
  const digest = rendererManifestDigest(parsed);
  return {
    schemaVersion: RENDERER_SIGNATURE_SCHEMA_VERSION,
    algorithm: "ed25519",
    keyId,
    manifestSha256: digest,
    signature: sign(null, rendererSignaturePayload(digest), privateKey).toString(
      "base64url",
    ),
    manifest: parsed,
  };
}

describe("signed renderer release verification", () => {
  it("verifies a canonical Ed25519 renderer envelope", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const envelope = signedEnvelope(manifest(), privateKey);

    const verified = verifySignedRendererReleaseEnvelope(envelope, [
      trustedKey(publicKey),
    ]);

    expect(verified.signingKeyId).toBe("renderer-key-1");
    expect(verified.envelope.manifest.releaseId).toBe("renderer-0002");
    expect(verified.envelope.manifest.components).toHaveLength(2);
    expect(rendererSha256(verified.manifestCanonicalJson)).toBe(
      envelope.manifestSha256,
    );
  });

  it("uses ordinal canonical JSON and a renderer-specific signature domain", () => {
    expect(canonicalRendererJson({ z: 1, A: 2, a: 3 })).toBe(
      '{"A":2,"a":3,"z":1}',
    );
    expect(rendererSignaturePayload("c".repeat(64)).toString("utf8")).toBe(
      `SCR-RENDERER-MANIFEST-V1\n${"c".repeat(64)}`,
    );
  });

  it("rejects unsigned, unknown-key, bad-digest, and bad-signature envelopes", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const envelope = signedEnvelope(manifest(), privateKey);

    expect(() =>
      verifySignedRendererReleaseEnvelope(
        { manifest: envelope.manifest },
        [trustedKey(publicKey)],
      ),
    ).toThrow(/Unsigned|unsupported/u);
    expect(() =>
      verifySignedRendererReleaseEnvelope(
        { ...envelope, keyId: "unknown-key" },
        [trustedKey(publicKey)],
      ),
    ).toThrow(/unknown/u);
    expect(() =>
      verifySignedRendererReleaseEnvelope(
        { ...envelope, manifestSha256: "d".repeat(64) },
        [trustedKey(publicKey)],
      ),
    ).toThrow(/digest does not match/u);
    expect(() =>
      verifySignedRendererReleaseEnvelope(
        {
          ...envelope,
          signature: signedEnvelope(manifest(), other.privateKey).signature,
        },
        [trustedKey(publicKey)],
      ),
    ).toThrow(/verification failed/u);
  });

  it("rejects noncanonical keys, signatures, and unknown signed fields", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const envelope = signedEnvelope(manifest(), privateKey);
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const otherPem = other.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    expect(() =>
      verifySignedRendererReleaseEnvelope(
        { ...envelope, signature: `${envelope.signature}=` },
        [trustedKey(publicKey)],
      ),
    ).toThrow(/canonical/u);
    expect(() =>
      verifySignedRendererReleaseEnvelope(
        { ...envelope, unsignedComment: "outside signed schema" },
        [trustedKey(publicKey)],
      ),
    ).toThrow(/unknown field/u);
    expect(() =>
      verifySignedRendererReleaseEnvelope(envelope, [
        trustedKey(publicKey, { publicKeyPem: `${publicPem}${otherPem}` }),
      ]),
    ).toThrow(/exactly one canonical SPKI/u);
    expect(() =>
      verifySignedRendererReleaseEnvelope(envelope, [
        trustedKey(publicKey, {
          publicKeyPem: privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
        }),
      ]),
    ).toThrow(/public-key PEM only/u);
  });

  it("enforces signing key sequence and channel policies", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const envelope = signedEnvelope(manifest(), privateKey);

    expect(() =>
      verifySignedRendererReleaseEnvelope(envelope, [
        trustedKey(publicKey, { minimumReleaseSequence: 3 }),
      ]),
    ).toThrow(/outside the trusted key/u);
    expect(() =>
      verifySignedRendererReleaseEnvelope(envelope, [
        trustedKey(publicKey, { maximumReleaseSequence: 1 }),
      ]),
    ).toThrow(/outside the trusted key/u);
    expect(() =>
      verifySignedRendererReleaseEnvelope(envelope, [
        trustedKey(publicKey, { allowedChannels: ["beta"] }),
      ]),
    ).toThrow(/channel is not allowed/u);
    expect(() =>
      verifySignedRendererReleaseEnvelope(envelope, [
        trustedKey(publicKey),
        trustedKey(publicKey),
      ]),
    ).toThrow(/duplicated/u);
  });
});

describe("renderer manifest, path, and inventory validation", () => {
  it("requires canonical identity, time, entrypoint, and compatibility", () => {
    expect(() =>
      parseRendererReleaseManifest(
        manifest({ createdAt: "2026-08-23T08:00:00+08:00" }),
      ),
    ).toThrow(/canonical UTC/u);
    expect(() =>
      parseRendererReleaseManifest(
        manifest({ createdAt: "2026-02-30T00:00:00.000Z" }),
      ),
    ).toThrow(/real canonical/u);
    expect(() => parseRendererReleaseManifest(manifest({ version: "01.2.3" })))
      .toThrow(/canonical major.minor.patch/u);
    expect(() =>
      parseRendererReleaseManifest({ ...manifest(), entrypoint: "main.html" }),
    ).toThrow(/index.html/u);
    expect(() =>
      parseRendererReleaseManifest(
        manifest({
          compatibility: {
            minimumShellVersion: "0.9.0",
            maximumShellVersion: "0.1.0",
            bridgeApiVersion: 1,
          },
        }),
      ),
    ).toThrow(/inverted/u);
  });

  for (const invalid of [
    "../escape.js",
    "/absolute.js",
    "C:/drive.js",
    "folder\\file.js",
    "folder//file.js",
    "folder/../file.js",
    "CON",
    ".scr-renderer/envelope.json",
  ]) {
    it(`rejects renderer component path ${JSON.stringify(invalid)}`, () => {
      expect(() => validateRendererComponentPath(invalid)).toThrow();
    });
  }

  it("rejects duplicate paths, file-directory conflicts, missing entrypoint, and bad totals", () => {
    expect(() =>
      parseRendererReleaseManifest(
        manifest({
          totalBytes: 400,
          components: [
            { path: "index.html", sha256: htmlSha, bytes: 100 },
            { path: "INDEX.HTML", sha256: scriptSha, bytes: 300 },
          ],
        }),
      ),
    ).toThrow(/duplicated/u);
    expect(() =>
      parseRendererReleaseManifest(
        manifest({
          totalBytes: 300,
          components: [
            { path: "index.html", sha256: htmlSha, bytes: 100 },
            { path: "assets", sha256: scriptSha, bytes: 100 },
            { path: "assets/main.js", sha256: scriptSha, bytes: 100 },
          ],
        }),
      ),
    ).toThrow(/used as a directory/u);
    expect(() =>
      parseRendererReleaseManifest(
        manifest({
          totalBytes: 200,
          components: [{ path: "assets/main.js", sha256: scriptSha, bytes: 200 }],
        }),
      ),
    ).toThrow(/entrypoint/u);
    expect(() => parseRendererReleaseManifest(manifest({ totalBytes: 301 })))
      .toThrow(/does not match/u);
  });

  it("verifies exact renderer component inventory", () => {
    const parsed = parseRendererReleaseManifest(manifest());
    expect(() =>
      verifyRendererInventory(parsed, [
        { path: "index.html", sha256: htmlSha, bytes: 100 },
        { path: "assets/main.js", sha256: scriptSha, bytes: 200 },
      ]),
    ).not.toThrow();
    expect(() =>
      verifyRendererInventory(parsed, [
        { path: "index.html", sha256: htmlSha, bytes: 100 },
      ]),
    ).toThrow(/missing or extra/u);
    expect(() =>
      verifyRendererInventory(parsed, [
        { path: "index.html", sha256: htmlSha, bytes: 100 },
        { path: "assets/Main.js", sha256: scriptSha, bytes: 200 },
      ]),
    ).toThrow(/path mismatch/u);
    expect(() =>
      verifyRendererInventory(parsed, [
        { path: "index.html", sha256: "f".repeat(64), bytes: 100 },
        { path: "assets/main.js", sha256: scriptSha, bytes: 200 },
      ]),
    ).toThrow(/SHA-256 mismatch/u);
  });

  it("creates a validated renderer manifest from observed components", () => {
    const created = createRendererReleaseManifest({
      releaseId: "renderer-0003",
      releaseSequence: 3,
      version: "0.3.0",
      channel: "beta",
      createdAt: "2026-08-23T01:00:00.000Z",
      components: [
        { path: "index.html", sha256: htmlSha, bytes: 100 },
        { path: "assets/main.js", sha256: scriptSha, bytes: 200 },
      ],
      minimumShellVersion: "0.1.0",
      maximumShellVersion: null,
      bridgeApiVersion: 1,
    });

    expect(created.totalBytes).toBe(300);
    expect(created.entrypoint).toBe("index.html");
  });
});

describe("renderer host compatibility", () => {
  it("accepts a newer compatible renderer", () => {
    expect(() => assertRendererCompatibility(manifest(), host())).not.toThrow();
  });

  it("blocks shell, bridge, and sequence incompatibility", () => {
    expect(() =>
      assertRendererCompatibility(manifest(), host({ shellVersion: "0.0.9" })),
    ).toThrow(/newer stable shell/u);
    expect(() =>
      assertRendererCompatibility(manifest(), host({ shellVersion: "1.0.0" })),
    ).toThrow(/does not support/u);
    expect(() =>
      assertRendererCompatibility(manifest(), host({ bridgeApiVersion: 2 })),
    ).toThrow(/bridge API/u);
    expect(() =>
      assertRendererCompatibility(manifest(), host({ highestReleaseSequence: 2 })),
    ).toThrow(/previously accepted/u);
  });
});

describe("renderer trusted-key registry", () => {
  it("accepts a bounded empty registry so updates can be disabled", () => {
    expect(
      parseRendererTrustedKeyRegistry({
        schemaVersion: RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
        keys: [],
      }),
    ).toEqual({
      schemaVersion: RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
      keys: [],
    });
  });

  it("canonicalizes keys and rejects duplicates or unknown fields", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const key = trustedKey(publicKey);
    const parsed = parseRendererTrustedKeyRegistry({
      schemaVersion: RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
      keys: [key],
    });
    expect(parsed.keys[0]?.publicKeyPem).toBe(key.publicKeyPem);
    expect(() =>
      parseRendererTrustedKeyRegistry({
        schemaVersion: RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
        keys: [key, key],
      }),
    ).toThrow(/duplicated/u);
    expect(() =>
      parseRendererTrustedKeyRegistry({
        schemaVersion: RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
        keys: [],
        source: "workspace",
      }),
    ).toThrow(/unknown field/u);
  });
});