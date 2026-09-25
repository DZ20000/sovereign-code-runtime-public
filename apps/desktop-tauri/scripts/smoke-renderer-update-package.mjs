import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  parseRendererTrustedKeyRegistry,
  verifyRendererInventory,
  verifySignedRendererReleaseEnvelope,
} from "@sovereign/update-core";

import { packageRendererUpdate } from "./package-renderer-update.mjs";

const root = await mkdtemp(resolve(tmpdir(), "scr-renderer-package-smoke-"));
try {
  const distRoot = resolve(root, "dist");
  const outputRoot = resolve(root, "renderer-smoke-0002");
  const privateKeyPath = resolve(root, "renderer-private.pem");
  const trustedKeysPath = resolve(root, "trusted-keys.json");
  await mkdir(resolve(distRoot, "assets"), { recursive: true });
  await writeFile(
    resolve(distRoot, "index.html"),
    '<!doctype html><html><body><div id="app"></div><script type="module" src="./assets/main.js"></script></body></html>',
    "utf8",
  );
  await writeFile(
    resolve(distRoot, "assets", "main.js"),
    'document.querySelector("#app").textContent = "renderer smoke";\n',
    "utf8",
  );

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { encoding: "utf8", mode: 0o600 },
  );
  const registry = {
    schemaVersion: "scr.renderer-trusted-keys/v1",
    keys: [
      {
        keyId: "renderer-smoke-key",
        algorithm: "ed25519",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        minimumReleaseSequence: 2,
        maximumReleaseSequence: 2,
        allowedChannels: ["development"],
      },
    ],
  };
  await writeFile(trustedKeysPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const packageOptions = {
    distRoot,
    outputRoot,
    privateKeyPath,
    trustedKeysPath,
    keyId: "renderer-smoke-key",
    releaseId: "renderer-smoke-0002",
    releaseSequence: 2,
    version: "0.1.1",
    channel: "development",
    createdAt: "2026-08-23T00:00:00.000Z",
    minimumShellVersion: "0.1.0",
    maximumShellVersion: null,
    bridgeApiVersion: 1,
  };
  const result = await packageRendererUpdate(packageOptions);

  assert.equal(result.releaseId, "renderer-smoke-0002");
  assert.equal(result.releaseSequence, 2);
  assert.equal(result.componentCount, 2);
  assert.equal(result.trustedRegistryVerified, true);

  const envelope = JSON.parse(await readFile(result.envelopePath, "utf8"));
  const trusted = parseRendererTrustedKeyRegistry(registry);
  const verified = verifySignedRendererReleaseEnvelope(envelope, trusted.keys);
  assert.equal(verified.envelope.manifest.releaseId, result.releaseId);

  const observed = [];
  for (const component of verified.envelope.manifest.components) {
    const bytes = await readFile(resolve(result.bundleRoot, ...component.path.split("/")));
    observed.push({
      path: component.path,
      bytes: bytes.length,
      sha256: component.sha256,
    });
  }
  assert.doesNotThrow(() =>
    verifyRendererInventory(verified.envelope.manifest, observed),
  );

  const tampered = structuredClone(envelope);
  tampered.manifest.version = "0.1.2";
  assert.throws(
    () => verifySignedRendererReleaseEnvelope(tampered, trusted.keys),
    /digest does not match/u,
  );

  const replaced = await packageRendererUpdate({
    ...packageOptions,
    replace: true,
  });
  assert.equal(replaced.manifestSha256, result.manifestSha256);

  const unsafeOutputRoot = resolve(root, "renderer-unsafe-0002");
  await mkdir(unsafeOutputRoot);
  await writeFile(resolve(unsafeOutputRoot, "unrelated.txt"), "do not delete", "utf8");
  await assert.rejects(
    packageRendererUpdate({
      ...packageOptions,
      outputRoot: unsafeOutputRoot,
      releaseId: "renderer-unsafe-0002",
      replace: true,
    }),
    /replace target/u,
  );
  assert.equal(
    await readFile(resolve(unsafeOutputRoot, "unrelated.txt"), "utf8"),
    "do not delete",
  );

  await assert.rejects(
    packageRendererUpdate({
      ...packageOptions,
      outputRoot: resolve(root, "renderer-workspace-key-0002"),
      releaseId: "renderer-workspace-key-0002",
      privateKeyPath: resolve("package.json"),
    }),
    /outside the source workspace/u,
  );

  console.log(
    JSON.stringify(
      {
        schemaVersion: "scr.renderer-package-smoke/v1",
        passed: true,
        releaseId: result.releaseId,
        componentCount: result.componentCount,
        totalBytes: result.totalBytes,
        manifestSha256: result.manifestSha256,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}