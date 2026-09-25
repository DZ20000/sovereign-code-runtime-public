import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, link, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, relative } from "node:path";
import { test } from "node:test";
import { collectApplicationProducts, collectProducts, containedFile, sortProducts } from "./products.mjs";
import { describeFile, sha256File, verifyPortablePackage } from "../apps/desktop-tauri/scripts/release-metadata.mjs";
import { findInstalledApplications } from "../apps/desktop-tauri/scripts/installed-application.mjs";

test("finds a stopped registered installation and combines a running instance by Windows path", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "so-products-"));
  try {
    const executable = resolve(fixture, "sovereign-desktop-tauri.exe");
    await writeFile(executable, "installed fixture");
    const canonicalExecutable = await realpath(executable);
    const record = { DisplayName: "Sovereign Code Runtime", DisplayVersion: "0.1.0", InstallLocation: `"${fixture}"` };
    const installed = await findInstalledApplications([record, record,
      { ...record, InstallLocation: resolve(fixture, "missing") },
      { ...record, InstallLocation: "relative-path" },
      { ...record, DisplayName: "Another application" },
    ]);
    assert.deepEqual(installed, [{ executable: canonicalExecutable, version: "0.1.0" }]);
    const stopped = await collectApplicationProducts(installed, []);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].kind, "installed");
    assert.equal(stopped[0].running, false);
    assert.equal(stopped[0].verification, "windows-registration");
    const runningPath = process.platform === "win32" ? canonicalExecutable.toUpperCase() : canonicalExecutable;
    const running = await collectApplicationProducts(installed, [runningPath, canonicalExecutable]);
    assert.equal(running.length, 1);
    assert.equal(running[0].path, canonicalExecutable);
    assert.equal(running[0].kind, "installed");
    assert.equal(running[0].running, true);
    assert.equal(running[0].version, "0.1.0");
    const portable = resolve(fixture, "SovereignCodeRuntime.exe");
    await writeFile(portable, "portable fixture");
    assert.equal((await collectApplicationProducts([], [portable]))[0].kind, "running");
    assert.deepEqual(await collectApplicationProducts([], [resolve(fixture, "missing.exe")]), []);
    await link(executable, resolve(fixture, "shared.exe"));
    assert.deepEqual(await findInstalledApplications([record]), []);
    assert.equal(await readFile(executable, "utf8"), "installed fixture");
  } finally {
    assert.equal(dirname(fixture), resolve(tmpdir()));
    assert.ok(relative(tmpdir(), fixture).startsWith("so-products-"));
    await rm(fixture, { recursive: true });
  }
});

test("finds actual APKs and reports stale or escaping records without changing files", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "so-products-"));
  try {
    const output = resolve(fixture, "apps/android-agent/app/build/outputs/apk/debug");
    await mkdir(output, { recursive: true });
    const apk = resolve(output, "app-debug.apk");
    await writeFile(apk, "fixture");
    const manifest = resolve(output, "output-metadata.json");
    const value = { applicationId: "com.sovereign.runtime.android.debug", elements: [
      { outputFile: "app-debug.apk", versionCode: 40, versionName: "0.40.0-debug" },
    ] };
    await writeFile(manifest, JSON.stringify(value));
    const result = await collectProducts([fixture]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].path, apk);
    assert.equal(result.items[0].verification, "build-metadata-only");
    assert.deepEqual(result.warnings, []);
    assert.equal(await readFile(apk, "utf8"), "fixture");
    value.elements[0].outputFile = "../escape.apk";
    await writeFile(resolve(dirname(output), "escape.apk"), "outside");
    await writeFile(manifest, JSON.stringify(value));
    const escaped = await collectProducts([fixture]);
    assert.equal(escaped.items.length, 0);
    assert.match(escaped.warnings[0].error, /escapes/);
    await assert.rejects(containedFile(output, resolve(dirname(output), "escape.apk")), /escapes/);
    value.elements[0].outputFile = "missing.apk";
    await writeFile(manifest, JSON.stringify(value));
    const stale = await collectProducts([fixture]);
    assert.equal(stale.items.length, 0);
    assert.equal(stale.warnings.length, 1);
    assert.equal(await readFile(resolve(dirname(output), "escape.apk"), "utf8"), "outside");
  } finally {
    assert.equal(dirname(fixture), resolve(tmpdir()));
    assert.ok(relative(tmpdir(), fixture).startsWith("so-products-"));
    await rm(fixture, { recursive: true });
  }
});

test("keeps the running build first and distinguishes same-version Windows builds", () => {
  const items = [
    { kind: "installer", path: "old", version: "0.1.0", createdAt: "2026-09-16" },
    { kind: "android", path: "v3", versionCode: 3, createdAt: "2026-09-19" },
    { kind: "installed", path: "running" },
    { kind: "installer", path: "new", version: "0.1.0", createdAt: "2026-09-19" },
    { kind: "android", path: "v40", versionCode: 40, createdAt: "2026-09-12" },
  ];
  assert.deepEqual(sortProducts(items).map(item => item.path), ["running", "new", "old", "v40", "v3"]);
  assert.equal(items[0].path, "old");
});

test("only labels the displayed portable executable verified when its bytes are in the manifest", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "so-products-"));
  try {
    const artifacts = resolve(fixture, "apps/desktop-tauri/artifacts");
    const portable = resolve(artifacts, "portable-fixture");
    await mkdir(portable, { recursive: true });
    const components = [];
    for (const name of ["other.exe", "renderer-trusted-keys.json", "SovereignCodeRuntime.exe"]) {
      await writeFile(resolve(portable, name), name);
      if (name !== "SovereignCodeRuntime.exe") components.push(await describeFile(resolve(portable, name), name));
    }
    const manifest = { schemaVersion: "scr.portable-package/v2", source: { commit: "a".repeat(40), dirty: false },
      product: { version: "0.1.0" }, components, executable: components[0], totalBytes: components.reduce((sum, c) => sum + c.bytes, 0) };
    const manifestPath = resolve(portable, "portable-package.json");
    const writeMetadata = async () => {
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(resolve(artifacts, "latest-portable.json"), JSON.stringify({ schemaVersion: "scr.portable-pointer/v1",
        portableRoot: portable, manifestSha256: await sha256File(manifestPath), updatedAt: "2026-09-19T00:00:00Z" }));
    };
    await writeMetadata();
    assert.equal((await verifyPortablePackage(portable)).passed, true);
    const rejected = await collectProducts([fixture]);
    assert.equal(rejected.items.length, 0);
    assert.match(rejected.warnings[0].error, /displayed executable/);
    const executable = await describeFile(resolve(portable, "SovereignCodeRuntime.exe"), "SovereignCodeRuntime.exe");
    manifest.components.push(executable);
    manifest.executable = executable;
    manifest.totalBytes += executable.bytes;
    await writeMetadata();
    const accepted = await collectProducts([fixture]);
    assert.deepEqual(accepted.warnings, []);
    assert.equal(accepted.items[0].path, resolve(portable, "SovereignCodeRuntime.exe"));
    assert.equal(accepted.items[0].verification, "manifest-verified");
    assert.equal(accepted.items[0].sourceDirty, false);
    const running = await collectApplicationProducts([], [resolve(portable, "SovereignCodeRuntime.exe")], accepted.items);
    assert.equal(running.length, 1);
    assert.equal(running[0].running, true);
    assert.equal(running[0].verification, "manifest-verified");
    assert.equal(running[0].sourceCommit, manifest.source.commit);
    assert.equal(running[0].version, "0.1.0");
    const installedPath = resolve(fixture, "sovereign-desktop-tauri.exe");
    await writeFile(installedPath, "SovereignCodeRuntime.exe");
    const installerRecord = { ...accepted.items[0], kind: "installer", path: resolve(fixture, "setup.exe"), installedExecutable: executable };
    const installation = { executable: installedPath, version: "registry-version" };
    const matched = await collectApplicationProducts([installation], [installedPath], [installerRecord]);
    assert.equal(matched.find(item => item.kind === "installed").verification, "executable-verified");
    assert.equal(matched.find(item => item.kind === "installed").sourceCommit, manifest.source.commit);
    await writeFile(installedPath, "changed");
    const mismatched = await collectApplicationProducts([installation], [], [installerRecord]);
    assert.equal(mismatched.find(item => item.kind === "installed").verification, "windows-registration");
    assert.equal(mismatched.find(item => item.kind === "installed").sourceCommit, undefined);
    manifest.source.dirty = true;
    await writeMetadata();
    assert.equal((await collectProducts([fixture])).items[0].sourceDirty, true);
  } finally {
    assert.equal(dirname(fixture), resolve(tmpdir()));
    assert.ok(relative(tmpdir(), fixture).startsWith("so-products-"));
    await rm(fixture, { recursive: true });
  }
});
