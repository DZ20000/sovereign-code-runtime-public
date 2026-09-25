import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CandidateSlotError,
  canonicalReleaseJson,
  inspectCandidateSlot,
  materializeCandidateSlot,
  parseReleaseManifest,
  releaseSha256,
  releaseSignaturePayload,
  type CandidatePayloadSource,
  type ReleaseComponent,
  type ReleaseManifest,
  type ReleaseSignatureEnvelope,
  type TrustedReleasePublicKey,
} from "../src/index.js";

const cleanupPaths: string[] = [];
const payload = new Map<string, Buffer>([
  ["SovereignCodeRuntime.exe", Buffer.from("signed shell executable", "utf8")],
  ["runtime-host.cjs", Buffer.from("signed runtime host bundle", "utf8")],
  ["node/node.exe", Buffer.from("signed embedded node runtime", "utf8")],
]);

interface MemorySourceOptions {
  readonly listedPaths?: readonly string[];
  readonly replacements?: ReadonlyMap<string, Buffer>;
  readonly chunkSize?: number;
  readonly emptyChunkPath?: string;
  readonly throwPath?: string;
  readonly abortAfterFirstChunk?: AbortController;
}

class MemoryPayloadSource implements CandidatePayloadSource {
  readonly #options: MemorySourceOptions;

  constructor(options: MemorySourceOptions = {}) {
    this.#options = options;
  }

  async listComponents(): Promise<readonly string[]> {
    return this.#options.listedPaths ?? [...payload.keys()];
  }

  async openComponent(componentPath: string): Promise<AsyncIterable<Uint8Array>> {
    if (this.#options.throwPath === componentPath) {
      throw new Error("simulated source-open failure");
    }
    const value = this.#options.replacements?.get(componentPath) ?? payload.get(componentPath);
    if (value === undefined) {
      throw new Error(`missing memory component: ${componentPath}`);
    }
    const chunkSize = this.#options.chunkSize ?? Math.max(1, value.byteLength);
    const emptyChunk = this.#options.emptyChunkPath === componentPath;
    const abortController = this.#options.abortAfterFirstChunk;
    return (async function* (): AsyncGenerator<Uint8Array> {
      if (emptyChunk) {
        yield new Uint8Array();
        return;
      }
      let chunkIndex = 0;
      for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
        yield value.subarray(offset, Math.min(value.byteLength, offset + chunkSize));
        chunkIndex += 1;
        if (chunkIndex === 1) abortController?.abort();
      }
    })();
  }
}

function component(
  path: string,
  role: ReleaseComponent["role"],
): ReleaseComponent {
  const bytes = payload.get(path)!;
  return {
    path,
    role,
    bytes: bytes.byteLength,
    sha256: releaseSha256(bytes),
  };
}

function releaseManifest(): ReleaseManifest {
  const components = [
    component("SovereignCodeRuntime.exe", "shell"),
    component("runtime-host.cjs", "runtime-host"),
    component("node/node.exe", "node"),
  ];
  return parseReleaseManifest({
    schemaVersion: "scr.release/v1",
    releaseId: "release-0002",
    releaseSequence: 2,
    version: "0.2.0",
    channel: "stable",
    createdAt: "2026-08-14T00:00:00.000Z",
    entrypoint: "SovereignCodeRuntime.exe",
    totalBytes: components.reduce((sum, entry) => sum + entry.bytes, 0),
    components,
    compatibility: {
      minimumBootstrapVersion: "0.1.0",
      maximumBootstrapVersion: "0.9.0",
      runtimeHostProtocolVersion: 1,
      preCommitDataPolicy: "backward-compatible",
      dataSchemas: {
        settings: { readableMin: 1, readableMax: 1, writeVersion: 1 },
        audit: { readableMin: 1, readableMax: 1, writeVersion: 1 },
        runs: { readableMin: 1, readableMax: 1, writeVersion: 1 },
      },
    },
  });
}

function trustedKey(publicKey: KeyObject): TrustedReleasePublicKey {
  return {
    keyId: "release-key-1",
    algorithm: "ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    minimumReleaseSequence: 1,
    maximumReleaseSequence: null,
    allowedChannels: ["stable"],
  };
}

function signedEnvelope(
  privateKey: KeyObject,
  manifest = releaseManifest(),
): ReleaseSignatureEnvelope {
  const manifestSha256 = releaseSha256(canonicalReleaseJson(manifest));
  return {
    schemaVersion: "scr.release-signature/v1",
    algorithm: "ed25519",
    keyId: "release-key-1",
    manifestSha256,
    signature: sign(
      null,
      releaseSignaturePayload(manifestSha256),
      privateKey,
    ).toString("base64url"),
    manifest,
  };
}

async function createSlotsRoot(): Promise<{ readonly root: string; readonly slots: string }> {
  const root = await mkdtemp(join(tmpdir(), "scr-candidate-slot-"));
  cleanupPaths.push(root);
  const slots = join(root, "slots");
  await mkdir(slots);
  return { root, slots };
}

async function expectSlotCode(
  operation: () => Promise<unknown>,
  code: CandidateSlotError["code"],
): Promise<void> {
  try {
    await operation();
    throw new Error(`Expected CandidateSlotError(${code}).`);
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateSlotError);
    expect((error as CandidateSlotError).code).toBe(code);
  }
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("candidate slot materialization", () => {
  it("materializes, publishes, and re-inspects a verified side-by-side slot", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { slots } = await createSlotsRoot();
    const result = await materializeCandidateSlot({
      slotsDirectory: slots,
      signedEnvelope: signedEnvelope(privateKey),
      trustedKeys: [trustedKey(publicKey)],
      source: new MemoryPayloadSource({ chunkSize: 5 }),
    });

    expect(result).toMatchObject({
      releaseId: "release-0002",
      releaseSequence: 2,
      version: "0.2.0",
      signingKeyId: "release-key-1",
      componentCount: 3,
    });
    expect(typeof result.directorySyncCompleted).toBe("boolean");
    for (const [componentPath, bytes] of payload) {
      expect(await readFile(join(result.slotPath, ...componentPath.split("/"))))
        .toEqual(bytes);
    }
    const inspected = await inspectCandidateSlot({
      slotsDirectory: slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(publicKey)],
    });
    expect(inspected).toMatchObject({
      releaseId: result.releaseId,
      releaseSequence: result.releaseSequence,
      version: result.version,
      channel: "stable",
      createdAt: "2026-08-14T00:00:00.000Z",
      slotPath: result.slotPath,
      entrypoint: "SovereignCodeRuntime.exe",
      compatibility: {
        runtimeHostProtocolVersion: 1,
        preCommitDataPolicy: "backward-compatible",
      },
      manifestSha256: result.manifestSha256,
      envelopeSha256: result.envelopeSha256,
      signingKeyId: result.signingKeyId,
      componentCount: result.componentCount,
      totalBytes: result.totalBytes,
    });
    expect(typeof inspected.directorySyncCompleted).toBe("boolean");
  });

  it("rejects a source inventory mismatch before creating a slot", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    for (const listedPaths of [
      ["SovereignCodeRuntime.exe", "runtime-host.cjs"],
      [...payload.keys(), "extra.bin"],
      ["SovereignCodeRuntime.exe", "runtime-host.cjs", "Node/node.exe"],
      ["SovereignCodeRuntime.exe", "runtime-host.cjs", "../node.exe"],
    ]) {
      const { slots } = await createSlotsRoot();
      await expectSlotCode(() => materializeCandidateSlot({
        slotsDirectory: slots,
        signedEnvelope: signedEnvelope(privateKey),
        trustedKeys: [trustedKey(publicKey)],
        source: new MemoryPayloadSource({ listedPaths }),
      }), "PAYLOAD_INVENTORY_MISMATCH");
      await expect(access(join(slots, "release-0002"))).rejects.toThrow();
    }
  });

  it("rejects an untrusted signature before creating a slot", async () => {
    const signer = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const { slots } = await createSlotsRoot();
    await expectSlotCode(() => materializeCandidateSlot({
      slotsDirectory: slots,
      signedEnvelope: signedEnvelope(signer.privateKey),
      trustedKeys: [trustedKey(other.publicKey)],
      source: new MemoryPayloadSource(),
    }), "RELEASE_VERIFICATION_FAILED");
    await expect(access(join(slots, "release-0002"))).rejects.toThrow();
  });

  it("treats an existing release directory without metadata as incomplete", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const { slots } = await createSlotsRoot();
    await mkdir(join(slots, "release-0002"));

    await expectSlotCode(() => inspectCandidateSlot({
      slotsDirectory: slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(publicKey)],
    }), "SLOT_NOT_READY");
  });

  it("leaves a failed component write incomplete and never publishes ready", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { slots } = await createSlotsRoot();
    const replacements = new Map(payload);
    replacements.set("runtime-host.cjs", Buffer.from("tampered runtime host", "utf8"));
    await expectSlotCode(() => materializeCandidateSlot({
      slotsDirectory: slots,
      signedEnvelope: signedEnvelope(privateKey),
      trustedKeys: [trustedKey(publicKey)],
      source: new MemoryPayloadSource({ replacements }),
    }), "PAYLOAD_COMPONENT_INVALID");

    await expect(access(join(
      slots,
      "release-0002",
      ".scr-update",
      "ready.json",
    ))).rejects.toThrow();
    await expectSlotCode(() => inspectCandidateSlot({
      slotsDirectory: slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(publicKey)],
    }), "SLOT_NOT_READY");
  });

  it("rejects empty, oversized, excessive, and cancelled component streams", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const cases: Array<{
      readonly source: MemoryPayloadSource;
      readonly maximumChunkBytes?: number;
      readonly maximumChunksPerComponent?: number;
      readonly signal?: AbortSignal;
    }> = [
      {
        source: new MemoryPayloadSource({
          emptyChunkPath: "SovereignCodeRuntime.exe",
        }),
      },
      {
        source: new MemoryPayloadSource({ chunkSize: 5 }),
        maximumChunkBytes: 4,
      },
      {
        source: new MemoryPayloadSource({ chunkSize: 1 }),
        maximumChunksPerComponent: 2,
      },
    ];
    const cancelled = new AbortController();
    cancelled.abort();
    cases.push({ source: new MemoryPayloadSource(), signal: cancelled.signal });
    const midWrite = new AbortController();
    cases.push({
      source: new MemoryPayloadSource({
        chunkSize: 1,
        abortAfterFirstChunk: midWrite,
      }),
      signal: midWrite.signal,
    });

    for (const candidateCase of cases) {
      const { slots } = await createSlotsRoot();
      await expectSlotCode(() => materializeCandidateSlot({
        slotsDirectory: slots,
        signedEnvelope: signedEnvelope(privateKey),
        trustedKeys: [trustedKey(publicKey)],
        ...candidateCase,
      }), "PAYLOAD_COMPONENT_INVALID");
    }
  });

  it("does not overwrite an existing or concurrently created release slot", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { slots } = await createSlotsRoot();
    const baseInput = {
      slotsDirectory: slots,
      signedEnvelope: signedEnvelope(privateKey),
      trustedKeys: [trustedKey(publicKey)],
    } as const;

    const results = await Promise.allSettled([
      materializeCandidateSlot({
        ...baseInput,
        source: new MemoryPayloadSource({ chunkSize: 2 }),
      }),
      materializeCandidateSlot({
        ...baseInput,
        source: new MemoryPayloadSource({ chunkSize: 3 }),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(CandidateSlotError);
    expect((rejected!.reason as CandidateSlotError).code).toBe("SLOT_ALREADY_EXISTS");

    await expectSlotCode(() => materializeCandidateSlot({
      ...baseInput,
      source: new MemoryPayloadSource(),
    }), "SLOT_ALREADY_EXISTS");
  });

  it("does not delete a component file created by a racing writer", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { slots } = await createSlotsRoot();
    const racingBytes = Buffer.from("racing writer owns this file", "utf8");
    const racingPath = join(slots, "release-0002", "runtime-host.cjs");
    const source: CandidatePayloadSource = {
      listComponents: async () => [...payload.keys()],
      openComponent: async (componentPath) => {
        const value = payload.get(componentPath);
        if (value === undefined) {
          throw new Error(`missing memory component: ${componentPath}`);
        }
        if (componentPath === "runtime-host.cjs") {
          await writeFile(racingPath, racingBytes);
        }
        return (async function* (): AsyncGenerator<Uint8Array> {
          yield value;
        })();
      },
    };

    await expectSlotCode(() => materializeCandidateSlot({
      slotsDirectory: slots,
      signedEnvelope: signedEnvelope(privateKey),
      trustedKeys: [trustedKey(publicKey)],
      source,
    }), "SLOT_PUBLICATION_CONFLICT");
    expect(await readFile(racingPath)).toEqual(racingBytes);
  });

  it("detects component tampering and unexpected files during inspection", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { slots } = await createSlotsRoot();
    const result = await materializeCandidateSlot({
      slotsDirectory: slots,
      signedEnvelope: signedEnvelope(privateKey),
      trustedKeys: [trustedKey(publicKey)],
      source: new MemoryPayloadSource(),
    });
    const runtimePath = join(result.slotPath, "runtime-host.cjs");
    await chmod(runtimePath, 0o600).catch(() => undefined);
    await writeFile(runtimePath, "tampered runtime host", "utf8");
    await expectSlotCode(() => inspectCandidateSlot({
      slotsDirectory: slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(publicKey)],
    }), "SLOT_CORRUPT");

    const second = await createSlotsRoot();
    const secondResult = await materializeCandidateSlot({
      slotsDirectory: second.slots,
      signedEnvelope: signedEnvelope(privateKey),
      trustedKeys: [trustedKey(publicKey)],
      source: new MemoryPayloadSource(),
    });
    await writeFile(join(secondResult.slotPath, "unexpected.txt"), "extra", "utf8");
    await expectSlotCode(() => inspectCandidateSlot({
      slotsDirectory: second.slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(publicKey)],
    }), "SLOT_CORRUPT");
  });

  it("detects envelope tampering or an untrusted inspection key", async () => {
    const signer = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const first = await createSlotsRoot();
    const result = await materializeCandidateSlot({
      slotsDirectory: first.slots,
      signedEnvelope: signedEnvelope(signer.privateKey),
      trustedKeys: [trustedKey(signer.publicKey)],
      source: new MemoryPayloadSource(),
    });
    await expectSlotCode(() => inspectCandidateSlot({
      slotsDirectory: first.slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(other.publicKey)],
    }), "RELEASE_VERIFICATION_FAILED");

    const envelopePath = join(result.slotPath, ".scr-update", "envelope.json");
    await chmod(envelopePath, 0o600).catch(() => undefined);
    await writeFile(envelopePath, "{}\n", "utf8");
    await expectSlotCode(() => inspectCandidateSlot({
      slotsDirectory: first.slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(signer.publicKey)],
    }), "SLOT_CORRUPT");
  });

  it("rejects a component shared with an external path through a hard link", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { root, slots } = await createSlotsRoot();
    const result = await materializeCandidateSlot({
      slotsDirectory: slots,
      signedEnvelope: signedEnvelope(privateKey),
      trustedKeys: [trustedKey(publicKey)],
      source: new MemoryPayloadSource(),
    });
    const outside = join(root, "outside-runtime.cjs");
    await writeFile(outside, payload.get("runtime-host.cjs")!);
    const runtimePath = join(result.slotPath, "runtime-host.cjs");
    await chmod(runtimePath, 0o600).catch(() => undefined);
    await rm(runtimePath, { force: true });
    try {
      await link(outside, runtimePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOSYS"].includes(code ?? "")) return;
      throw error;
    }
    await expectSlotCode(() => inspectCandidateSlot({
      slotsDirectory: slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(publicKey)],
    }), "UNSAFE_SLOT_PATH");
  });

  it("rejects a symbolic-link component during inspection", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { root, slots } = await createSlotsRoot();
    const result = await materializeCandidateSlot({
      slotsDirectory: slots,
      signedEnvelope: signedEnvelope(privateKey),
      trustedKeys: [trustedKey(publicKey)],
      source: new MemoryPayloadSource(),
    });
    const target = join(root, "outside-runtime.cjs");
    await writeFile(target, payload.get("runtime-host.cjs")!);
    const runtimePath = join(result.slotPath, "runtime-host.cjs");
    await chmod(runtimePath, 0o600).catch(() => undefined);
    await rm(runtimePath, { force: true });
    try {
      await symlink(target, runtimePath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOSYS"].includes(code ?? "")) return;
      throw error;
    }
    await expectSlotCode(() => inspectCandidateSlot({
      slotsDirectory: slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(publicKey)],
    }), "UNSAFE_SLOT_PATH");
  });

  it("leaves source-open failure as an incomplete non-ready slot", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { slots } = await createSlotsRoot();
    await expectSlotCode(() => materializeCandidateSlot({
      slotsDirectory: slots,
      signedEnvelope: signedEnvelope(privateKey),
      trustedKeys: [trustedKey(publicKey)],
      source: new MemoryPayloadSource({ throwPath: "runtime-host.cjs" }),
    }), "PAYLOAD_COMPONENT_INVALID");
    await expectSlotCode(() => inspectCandidateSlot({
      slotsDirectory: slots,
      releaseId: "release-0002",
      trustedKeys: [trustedKey(publicKey)],
    }), "SLOT_NOT_READY");
  });
});
