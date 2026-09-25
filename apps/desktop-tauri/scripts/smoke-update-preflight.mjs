import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { open, lstat, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalReleaseJson,
  materializeCandidateSlot,
  parseReleaseManifest,
  releaseSha256,
  releaseSignaturePayload,
  runCandidatePreflight,
} from "../../../packages/update-core/dist/index.js";
import {
  verifyPortablePackage,
  writeJsonAtomic,
} from "./release-metadata.mjs";

const REPORT_SCHEMA_VERSION = "scr.update-preflight-smoke/v1";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = resolve(projectRoot, "artifacts");
const latestPortablePath = (
  await readFile(resolve(artifactsRoot, "latest-portable.txt"), "utf8")
).trim();
if (latestPortablePath.length === 0) {
  throw new Error("No portable candidate package has been recorded.");
}

const portableRoot = resolve(latestPortablePath);
const portableManifestPath = resolve(portableRoot, "portable-package.json");
const reportPath = resolve(portableRoot, "update-preflight-report.json");
const portableManifest = JSON.parse(await readFile(portableManifestPath, "utf8"));
const packageVerification = await verifyPortablePackage(portableRoot, portableManifest);
if (!packageVerification.passed) {
  throw new Error(
    `Portable package failed verification before candidate preflight: ${packageVerification.problems.join("; ")}`,
  );
}

function assertContained(root, candidate, label) {
  const contained = relative(root, candidate);
  if (
    contained === "" ||
    contained === ".." ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    throw new Error(`${label} escapes its trusted package root.`);
  }
}

function sameIdentity(left, right) {
  if (left.dev === 0 || left.ino === 0 || right.dev === 0 || right.ino === 0) {
    return true;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

class VerifiedPortableSource {
  #root;
  #realRoot;
  #components;

  constructor(root, realRoot, components) {
    this.#root = root;
    this.#realRoot = realRoot;
    this.#components = new Map(components.map((component) => [component.path, component]));
  }

  async listComponents() {
    return [...this.#components.keys()];
  }

  async openComponent(componentPath) {
    const component = this.#components.get(componentPath);
    if (component === undefined) {
      throw new Error(`Candidate source component is not in the verified package: ${componentPath}`);
    }
    const absolutePath = resolve(this.#root, ...componentPath.split("/"));
    assertContained(this.#root, absolutePath, "Candidate source component");
    const pathInfo = await lstat(absolutePath);
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink > 1) {
      throw new Error(`Candidate source component is not one unshared regular file: ${componentPath}`);
    }
    const realPath = await realpath(absolutePath);
    assertContained(this.#realRoot, realPath, "Candidate source component real path");

    return (async function* () {
      let handle;
      try {
        handle = await open(absolutePath, "r");
        const openedInfo = await handle.stat();
        if (
          !openedInfo.isFile() ||
          openedInfo.nlink > 1 ||
          !sameIdentity(pathInfo, openedInfo) ||
          openedInfo.size !== component.bytes
        ) {
          throw new Error(`Candidate source component changed while opening: ${componentPath}`);
        }
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0;
        const digest = createHash("sha256");
        while (offset < openedInfo.size) {
          const requested = Math.min(buffer.byteLength, openedInfo.size - offset);
          const result = await handle.read(buffer, 0, requested, offset);
          if (result.bytesRead < 1) {
            throw new Error(`Candidate source component ended unexpectedly: ${componentPath}`);
          }
          const chunk = Buffer.from(buffer.subarray(0, result.bytesRead));
          digest.update(chunk);
          offset += result.bytesRead;
          yield chunk;
        }
        const finalInfo = await handle.stat();
        if (
          finalInfo.size !== openedInfo.size ||
          finalInfo.mtimeMs !== openedInfo.mtimeMs ||
          finalInfo.ctimeMs !== openedInfo.ctimeMs ||
          !sameIdentity(openedInfo, finalInfo) ||
          digest.digest("hex") !== component.sha256
        ) {
          throw new Error(`Candidate source component changed while streaming: ${componentPath}`);
        }
      } finally {
        await handle?.close().catch(() => undefined);
      }
    })();
  }
}

function componentRole(path) {
  switch (path) {
    case "SovereignCodeRuntime.exe": return "shell";
    case "node/node.exe": return "node";
    case "runtime-host.cjs": return "runtime-host";
    case "host-guardian.mjs": return "host-guardian";
    case "native/bin/SovereignNativeAgent.exe": return "native-agent";
    default: return "resource";
  }
}

const sourceCommit = portableManifest?.source?.commit;
const sourceShortCommit = portableManifest?.source?.shortCommit;
const version = portableManifest?.product?.version;
if (
  typeof sourceCommit !== "string" ||
  !/^[a-f0-9]{40}$/u.test(sourceCommit) ||
  typeof sourceShortCommit !== "string" ||
  !/^[a-f0-9]{7,40}$/u.test(sourceShortCommit) ||
  typeof version !== "string"
) {
  throw new Error("Portable package source identity is incomplete.");
}

const releaseId = `preflight-${sourceShortCommit.slice(0, 12)}-${process.pid}`;
const releaseSequence = Date.now();
const components = portableManifest.components.map((component) => ({
  path: component.path,
  sha256: component.sha256,
  bytes: component.bytes,
  role: componentRole(component.path),
}));
const releaseManifest = parseReleaseManifest({
  schemaVersion: "scr.release/v1",
  releaseId,
  releaseSequence,
  version,
  channel: "development",
  createdAt: new Date().toISOString(),
  entrypoint: "SovereignCodeRuntime.exe",
  totalBytes: components.reduce((sum, component) => sum + component.bytes, 0),
  components,
  compatibility: {
    minimumBootstrapVersion: "0.1.0",
    maximumBootstrapVersion: null,
    runtimeHostProtocolVersion: 1,
    preCommitDataPolicy: "backward-compatible",
    dataSchemas: {
      settings: { readableMin: 1, readableMax: 1, writeVersion: 1 },
      audit: { readableMin: 1, readableMax: 1, writeVersion: 1 },
      runs: { readableMin: 1, readableMax: 1, writeVersion: 1 },
    },
  },
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const manifestCanonicalJson = canonicalReleaseJson(releaseManifest);
const manifestSha256 = releaseSha256(manifestCanonicalJson);
const signedEnvelope = {
  schemaVersion: "scr.release-signature/v1",
  algorithm: "ed25519",
  keyId: "ephemeral-preflight-key",
  manifestSha256,
  signature: sign(
    null,
    releaseSignaturePayload(manifestSha256),
    privateKey,
  ).toString("base64url"),
  manifest: releaseManifest,
};
const trustedKeys = [{
  keyId: "ephemeral-preflight-key",
  algorithm: "ed25519",
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  minimumReleaseSequence: releaseSequence,
  maximumReleaseSequence: releaseSequence,
  allowedChannels: ["development"],
}];

const temporaryRoot = await mkdtemp(resolve(tmpdir(), "sovereign-update-preflight-"));
const slotsDirectory = resolve(temporaryRoot, "slots");
const isolatedRootDirectory = resolve(temporaryRoot, "isolated");
await Promise.all([
  mkdir(slotsDirectory),
  mkdir(isolatedRootDirectory),
]);

const startedAt = new Date().toISOString();
let finalReport;
try {
  const realPortableRoot = await realpath(portableRoot);
  const source = new VerifiedPortableSource(
    portableRoot,
    realPortableRoot,
    portableManifest.components,
  );
  const materialization = await materializeCandidateSlot({
    slotsDirectory,
    signedEnvelope,
    trustedKeys,
    source,
  });
  const preflight = await runCandidatePreflight({
    slotsDirectory,
    releaseId,
    trustedKeys,
    isolatedRootDirectory,
    timeoutMs: 45_000,
  });
  finalReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    passed: true,
    source: {
      commit: sourceCommit,
      dirty: portableManifest.source.dirty,
      version,
    },
    packageVerification,
    ephemeralSigningKey: {
      keyId: trustedKeys[0].keyId,
      privateKeyPersisted: false,
    },
    materialization,
    preflight,
  };
} catch (error) {
  finalReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    passed: false,
    source: {
      commit: sourceCommit,
      dirty: portableManifest.source.dirty,
      version,
    },
    packageVerification,
    error: {
      name: error instanceof Error ? error.name : "Error",
      code: error && typeof error === "object" && "code" in error ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
      checks: error && typeof error === "object" && "checks" in error ? error.checks : null,
    },
  };
} finally {
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

await writeJsonAtomic(reportPath, finalReport);
if (!finalReport.passed) {
  throw new Error(`Candidate packaged preflight failed: ${JSON.stringify(finalReport.error)}`);
}
console.log(`Candidate packaged preflight passed: ${reportPath}`);
console.log(`Source ${sourceShortCommit}; elapsed from ${startedAt} to ${finalReport.generatedAt}.`);