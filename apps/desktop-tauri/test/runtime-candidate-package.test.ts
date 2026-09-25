import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeCandidate } from "../scripts/create-runtime-candidate.mjs";

const cleanupPaths: string[] = [];
const SIGNATURE_PAYLOAD_SCHEMA_VERSION = "scr.runtime-candidate-signature/v1";

interface RuntimeCandidateEnvelope {
  readonly schemaVersion: string;
  readonly algorithm: string;
  readonly keyId: string;
  readonly manifestSha256: string;
  readonly manifest: {
    readonly schemaVersion: string;
    readonly releaseId: string;
    readonly releaseSequence: number;
    readonly createdAtUnixMs: number;
    readonly minimumShellVersion: string;
    readonly runtimeProtocolVersion: number;
    readonly component: {
      readonly path: string;
      readonly size: number;
      readonly sha256: string;
    };
  };
  readonly signature: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(keyType: "ed25519" | "rsa" = "ed25519") {
  const root = await mkdtemp(join(tmpdir(), "scr-runtime-candidate-package-"));
  cleanupPaths.push(root);
  const runtimeHostPath = join(root, "source-runtime-host.cjs");
  const privateKeyPath = join(root, "release-private-key.pem");
  const outputPath = join(root, "runtime-42");
  const runtimeBytes = Buffer.from(
    'module.exports = { releaseId: "runtime-42", ready: true };\n',
    "utf8",
  );
  await writeFile(runtimeHostPath, runtimeBytes);
  const pair =
    keyType === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("rsa", { modulusLength: 2_048 });
  await writeFile(
    privateKeyPath,
    pair.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  return {
    root,
    runtimeBytes,
    publicKey: pair.publicKey,
    options: {
      releaseId: "runtime-42",
      releaseSequence: 42,
      runtimeHostPath,
      privateKeyPath,
      keyId: "runtime-release-key-1",
      outputPath,
      minimumShellVersion: "1.0.0",
      runtimeProtocolVersion: 1,
      createdAtUnixMs: 1_788_000_000_000,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Runtime candidate package producer", () => {
  it("writes one immutable canonical Ed25519 package with an exact two-file inventory", async () => {
    const { root, runtimeBytes, publicKey, options } = await fixture();
    const result = await createRuntimeCandidate(options);

    expect(result).toMatchObject({
      releaseId: "runtime-42",
      releaseSequence: 42,
      outputPath: options.outputPath,
      runtimeHostBytes: runtimeBytes.byteLength,
    });
    expect((await readdir(options.outputPath)).sort()).toEqual([
      "envelope.json",
      "runtime-host.cjs",
    ]);
    expect(
      await readFile(join(options.outputPath, "runtime-host.cjs")),
    ).toEqual(runtimeBytes);

    const envelopeText = await readFile(
      join(options.outputPath, "envelope.json"),
      "utf8",
    );
    const envelope = JSON.parse(envelopeText) as RuntimeCandidateEnvelope;
    expect(envelopeText).toBe(canonicalJson(envelope));
    expect(envelope).toMatchObject({
      schemaVersion: "scr.runtime-candidate-release-signature/v1",
      algorithm: "ed25519",
      keyId: "runtime-release-key-1",
      manifest: {
        schemaVersion: "scr.runtime-candidate-manifest/v1",
        releaseId: "runtime-42",
        releaseSequence: 42,
        createdAtUnixMs: 1_788_000_000_000,
        minimumShellVersion: "1.0.0",
        runtimeProtocolVersion: 1,
        component: {
          path: "runtime-host.cjs",
          size: runtimeBytes.byteLength,
          sha256: sha256(runtimeBytes),
        },
      },
    });
    expect(envelope.manifestSha256).toBe(
      sha256(canonicalJson(envelope.manifest)),
    );
    const payload = Buffer.from(
      `${SIGNATURE_PAYLOAD_SCHEMA_VERSION}\n${envelope.manifestSha256}`,
      "utf8",
    );
    expect(
      verify(
        null,
        payload,
        publicKey,
        Buffer.from(envelope.signature, "base64url"),
      ),
    ).toBe(true);

    const beforeEnvelope = await readFile(
      join(options.outputPath, "envelope.json"),
    );
    const beforeRuntime = await readFile(
      join(options.outputPath, "runtime-host.cjs"),
    );
    await expect(createRuntimeCandidate(options)).rejects.toThrow(
      "output path already exists",
    );
    expect(await readFile(join(options.outputPath, "envelope.json"))).toEqual(
      beforeEnvelope,
    );
    expect(
      await readFile(join(options.outputPath, "runtime-host.cjs")),
    ).toEqual(beforeRuntime);
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".runtime-42.")),
    ).toEqual([]);
  });

  it("validates programmatic options instead of relying only on CLI parsing", async () => {
    const { options } = await fixture();
    for (const invalid of [
      { ...options, releaseId: "../escape" },
      { ...options, releaseSequence: 0 },
      { ...options, runtimeProtocolVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...options, createdAtUnixMs: 0 },
      { ...options, unexpectedOption: true },
    ]) {
      await expect(createRuntimeCandidate(invalid)).rejects.toThrow();
    }
  });

  it("rejects output at a filesystem root or directly beneath it", async () => {
    const { options } = await fixture();
    const volumeRoot = parse(options.outputPath).root;
    await expect(
      createRuntimeCandidate({
        ...options,
        outputPath: join(volumeRoot, "runtime-candidate-root-level"),
      }),
    ).rejects.toThrow("may not be a filesystem root or a direct child");
  });

  it("rejects a non-Ed25519 private key", async () => {
    const { options } = await fixture("rsa");
    await expect(createRuntimeCandidate(options)).rejects.toThrow(
      "Private key must be Ed25519",
    );
  });

  it("rejects a Runtime Host source reached through a symbolic link", async () => {
    const { root, options } = await fixture();
    const linkedRuntime = join(root, "linked-runtime-host.cjs");
    try {
      await symlink(options.runtimeHostPath, linkedRuntime, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
      throw error;
    }
    await expect(
      createRuntimeCandidate({
        ...options,
        runtimeHostPath: linkedRuntime,
      }),
    ).rejects.toThrow("direct regular file");
  });
});
