import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PORTABLE_COMPONENTS, assertPublicBytes, assertReleasePath, validateReleaseManifest, writeVerifiedZip } from "./package-portable-zip.mjs";
import { releaseRustFlags } from "./build-portable-release.mjs";

const commit = "a".repeat(40);
const hash = "b".repeat(64);
function manifest() {
  return {
    schemaVersion: "scr.portable-package/v2", createdAt: "2026-01-01T00:00:00Z",
    product: { name: "Sovereign Code Runtime", version: "0.1.6", identifier: "com.sovereign.runtime", platform: "win32", architecture: "x64" },
    source: { commit, shortCommit: commit.slice(0, 12), branch: null, committedAt: "2026-01-01T00:00:00Z", dirty: false, changeCount: 0 },
    executable: { path: "SovereignCodeRuntime.exe", bytes: 1, sha256: hash }, totalBytes: PORTABLE_COMPONENTS.length,
    components: PORTABLE_COMPONENTS.map((path) => ({ path, bytes: 1, sha256: hash })),
    runtime: {
      schemaVersion: "scr.runtime-resources/v1", generatedAt: "2026-01-01T00:00:00Z",
      node: { version: "v24.22.1", executable: "node/node.exe", sha256: hash },
      runtimeHost: { path: "runtime-host.cjs", sha256: hash },
      hostGuardian: { path: "host-guardian.mjs", sha256: hash, restartWindowMs: 600000, maximumRestartsPerWindow: 5 },
      shellWatchdog: { path: "shell-watchdog.mjs", sha256: hash },
      nativeAgent: { path: "native/bin/SovereignNativeAgent.exe", sha256: hash },
      tunnelClientBundled: false,
    },
  };
}

test("accepts the exact public runtime manifest", () => validateReleaseManifest(manifest(), commit, "0.1.6"));

test("rejects dirty, mismatched, or private release metadata", () => {
  for (const mutate of [
    (value) => { value.source.dirty = true; },
    (value) => { value.source.commit = "c".repeat(40); },
    (value) => { value.source.localPath = "private"; },
    (value) => { value.source.branch = "C:\\Users\\fixture\\source"; },
    (value) => { value.product.architecture = "arm64"; },
    (value) => { value.runtime.runtimeHost.sha256 = "c".repeat(64); },
    (value) => { value.runtime.extraConfig = {}; },
  ]) {
    const value = manifest(); mutate(value);
    assert.throws(() => validateReleaseManifest(value, commit, "0.1.6"));
  }
});

test("reports, credentials, duplicate and absolute component paths cannot enter the manifest", () => {
  for (const path of ["smoke-report.json", ".env", "C:/private/config.json", "../outside", "node/node.exe"]) {
    const value = manifest(); value.components.push({ path, bytes: 1, sha256: hash });
    assert.throws(() => validateReleaseManifest(value, commit, "0.1.6"));
  }
});

test("release entry names reject traversal, backslashes and Windows drive paths", () => {
  for (const path of ["../secret", "/absolute", "C:/secret", "a\\b", "a//b", "a/./b", "a/../b"]) {
    assert.throws(() => assertReleasePath(path));
  }
});

test("privacy scanning detects known values in UTF-8 and UTF-16LE without echoing them", () => {
  const privateValue = "C:\\Users\\private-fixture\\source";
  for (const encoding of ["utf8", "utf16le"]) {
    assert.throws(() => assertPublicBytes(Buffer.from("prefix " + privateValue, encoding), "app.exe", [privateValue]),
      (error) => !error.message.includes(privateValue));
  }
  assert.doesNotThrow(() => assertPublicBytes(Buffer.from("generic public bytes"), "app.exe", [privateValue]));
});

test("generic hosted-runner paths are rejected", () => {
  for (const value of ["D:\\a\\project\\project\\src.rs", "C:\\Users\\runneradmin\\.cargo\\registry\\source", "/home/runner/work/source"]) {
    assert.throws(() => assertPublicBytes(Buffer.from(value), "app.exe"));
    assert.throws(() => assertPublicBytes(Buffer.from(value, "utf16le"), "app.exe"));
  }
});

test("Rust path remapping preserves Windows spaces and backslashes as one encoded argument", () => {
  const root = "C:\\source fixture\\repo";
  const flags = releaseRustFlags(root, "C:\\user fixture\\.cargo", "C:\\user fixture").split("\x1f");
  assert.ok(flags.includes("--remap-path-prefix=" + root + "=/source"));
  assert.ok(flags.includes("--remap-path-prefix=C:/source fixture/repo=/source"));
  assert.ok(flags.includes("--remap-path-prefix=C:\\user fixture\\.cargo=/cargo"));
});

test("actual ZIP round-trip includes only selected files and writes a matching checksum", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-release-test-"));
  try {
    const source = join(root, "payload with spaces-测试.bin");
    await writeFile(source, Buffer.from([0, 1, 2, 3, 255]));
    await writeFile(join(root, "smoke-report.json"), "private report must stay outside the ZIP");
    const output = join(root, "public.zip");
    const result = await writeVerifiedZip([{ path: "node/payload.bin", source }], output);
    const bytes = await readFile(output);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    assert.equal(result.entries, 1);
    assert.equal(result.sha256, checksum);
    assert.equal(await readFile(output + ".sha256", "utf8"), checksum + "  public.zip\n");
    assert.equal(bytes.includes(Buffer.from("smoke-report.json")), false);
    await assert.rejects(writeVerifiedZip([{ path: "node/payload.bin", source }], output));
    assert.deepEqual(await readFile(output), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public archive scanner rejects credential material before an asset is written", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-private-test-"));
  try {
    const source = join(root, "payload.txt");
    await writeFile(source, ["-----BEGIN ", "PRIVATE KEY-----"].join(""));
    const output = join(root, "rejected.zip");
    await assert.rejects(writeVerifiedZip([{ path: "payload.txt", source }], output), /Public archive scan failed/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
