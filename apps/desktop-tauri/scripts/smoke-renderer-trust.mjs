import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { prepareRendererTrust } from "./prepare-renderer-trust.mjs";

const root = await mkdtemp(resolve(tmpdir(), "scr-renderer-trust-smoke-"));
try {
  const source = resolve(root, "trusted.json");
  const output = resolve(root, "generated", "renderer-trusted-keys.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const registry = {
    schemaVersion: "scr.renderer-trusted-keys/v1",
    keys: [
      {
        keyId: "renderer-smoke-key",
        algorithm: "ed25519",
        publicKeyPem: publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
        minimumReleaseSequence: 10,
        maximumReleaseSequence: 99,
        allowedChannels: ["stable", "beta"],
      },
    ],
  };
  await writeFile(source, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const enabled = await prepareRendererTrust({
    source,
    output,
    requireEnabled: true,
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.keyCount, 1);
  assert.deepEqual(enabled.keys, [
    {
      keyId: "renderer-smoke-key",
      minimumReleaseSequence: 10,
      maximumReleaseSequence: 99,
      allowedChannels: ["stable", "beta"],
    },
  ]);
  const generated = await readFile(output, "utf8");
  assert.doesNotMatch(generated, /PRIVATE KEY/u);
  assert.match(generated, /BEGIN PUBLIC KEY/u);

  await assert.rejects(
    prepareRendererTrust({ output: resolve(root, "missing.json") }),
    /source is required/u,
  );
  await assert.rejects(
    prepareRendererTrust({
      output: resolve(root, "required.json"),
      allowDisabled: true,
      requireEnabled: true,
    }),
    /contradictory/u,
  );
  await assert.rejects(
    prepareRendererTrust({
      source: resolve(root, "empty.json"),
      output: resolve(root, "empty-output.json"),
      requireEnabled: true,
    }),
    /Could not inspect/u,
  );

  const privateRegistryPath = resolve(root, "private.json");
  await writeFile(
    privateRegistryPath,
    `${JSON.stringify({
      schemaVersion: "scr.renderer-trusted-keys/v1",
      keys: [
        {
          ...registry.keys[0],
          publicKeyPem: privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
        },
      ],
    })}\n`,
    "utf8",
  );
  await assert.rejects(
    prepareRendererTrust({
      source: privateRegistryPath,
      output: resolve(root, "private-output.json"),
      requireEnabled: true,
    }),
    /public-key PEM only/u,
  );

  const disabled = await prepareRendererTrust({
    output,
    allowDisabled: true,
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.keyCount, 0);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    schemaVersion: "scr.renderer-trusted-keys/v1",
    keys: [],
  });

  console.log(
    JSON.stringify(
      {
        schemaVersion: "scr.renderer-trust-smoke/v1",
        passed: true,
        enabledKeyCount: enabled.keyCount,
        disabledKeyCount: disabled.keyCount,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 100,
  });
}
